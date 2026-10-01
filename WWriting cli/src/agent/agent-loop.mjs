// Agent 循环：请求模型 → 消费可见 delta / 工具调用 → 权限判定 → 执行工具 → 回传工具结果 → 继续。
//
// 终态只有三种，循环必定结束，绝不无限转：
//   run_completed   模型不再要工具（正常收敛）；
//   run_interrupted 被取消（停止 / Ctrl+C / 立即打断当前轮）；
//   run_failed      出错或撞上硬限制。
// 两条硬限制：单 Run 最大工具轮数（maxToolRounds）与 AbortSignal。
//
// 事件是过程的唯一真相：可见过程全部按发生顺序追加进事件日志，供渲染、回放与重启恢复使用。
// 私有 reasoning 经 `onReasoning` 收进来，只落一条 `reasoning_completed` 事件供屏幕使用；
// 它**绝不进** `messages`，因此没有任何路径能回喂给模型（P22）。
//
// 取消语义（沿用 Task 4 的 D7）：模型客户端 abort 时抛 code === 'MODEL_ABORTED' 的错误，
// 文件工具 abort 时抛 TOOL_ABORTED（name = 'AbortError'）；两者都归为「被取消」，不是故障。
// 铁律 3：RunResult 只带一条用户能看懂的中文事实，错误码与细节进 details。
import { randomUUID } from 'node:crypto';

import { fact } from '../fact.mjs';
import { DEFAULT_HISTORY_BUDGET_CHARS, estimateChars } from './history.mjs';
import { PROJECT_MEMORY_SKELETON } from './project-memory.mjs';

// 单 Run 最多执行多少轮工具：超过即停，绝不无限转。
export const DEFAULT_MAX_TOOL_ROUNDS = 12;

// 下发给模型的工具声明（OpenAI-compatible function calling）。
export const TOOL_SCHEMAS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出创作目录里的文件和子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对创作目录的路径，缺省为根目录。' },
          recursive: { type: 'boolean', description: '是否递归子目录，缺省 false。' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取创作目录里的一个文本文件内容。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对创作目录的文件路径。' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在创作目录里按字面内容搜索，返回命中行。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要搜索的文本。' },
          path: { type: 'string', description: '搜索起点，缺省为根目录。' },
          maxResults: { type: 'number', description: '最多返回多少条，缺省 50。' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '整篇写入创作目录里的一个文件，需要用户确认。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对创作目录的文件路径。' },
          content: { type: 'string', description: '完整文件内容。' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '替换文件里的一段原文，需要用户确认。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对创作目录的文件路径。' },
          oldText: { type: 'string', description: '要被替换的原文，必须唯一命中。' },
          newText: { type: 'string', description: '替换后的内容。' },
          replaceAll: { type: 'boolean', description: '多处命中时是否全部替换。' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_text',
      description: '客观统计一段文本的字数；篇幅只以这里的数字为准，不要自己估算。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要统计的文本。' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description: '读取已发现 Agent Skill 的 SKILL.md 或其安全资源。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          resource: { type: 'string', description: '默认 SKILL.md；也可为 references/...、scripts/...、assets/...' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
]);

const BASE_SYSTEM_PROMPT = [
  '你是 WWriting 的写作 Agent，在用户的创作目录里工作，全部回答使用简体中文。',
  '规则：只使用给定的工具读写文件；读取自动放行，写入与修改需要用户确认；',
  '篇幅一律先用 count_text 统计再判断，绝不凭自己的估计报字数；',
  '删除、项目外访问等极端操作不在你的能力范围内，不要尝试。',
].join('');

// 项目记忆的职责说明（Q1 / Q4 / Q8 / Q11 / D5(a)，出处：统一行为规格书:371-376）。
//
// 为什么写在 prompt 里而不是程序里：ADR-0007 规定 WWRITING.md **只能**由模型经
// write_file / edit_file 写入，应用代码不得自动生成或修改它。于是「谨慎合并、不整体覆盖」
// 这件事只有两道防线可站：这里的 prompt 职责，与写入确认卡。
// 确认卡显示 diff 那一道本次推迟（P8），已在 docs/adr/0007 里补记，不悄悄改掉那条 Consequence。
//
// 骨架原文照抄上游 renderInitialProjectMemory 的六小节结构，作为**文本**交给模型：
// 程序不拿它创建文件，模型拿它经用户确认后写出去。铁律 7 的「不生成固定蓝图」
// 指的是不预填内容——小节固定、里面留空是允许的。
//
// 最后那一段是 **Q8**：草案把「与 AGENTS.md 的分工写清楚」定为已决（不做运行时防御），
// 但没写落在哪里。落点就是这里 + README + ADR-0012——**分工是靠文字说清的，不是靠代码判的**。
const PROJECT_MEMORY_PROMPT = [
  '项目记忆：创作目录根的 WWRITING.md 是这部作品的记忆入口，跨会话保留「现在是什么状态」。',
  '用户输入 /init、或你判断这个项目还没有记忆时，用 write_file 建立它（写入需要用户确认）。',
  '新建时使用下面这份骨架，小节固定、内容留空即可，不要预填题材、章节数或字数：',
  PROJECT_MEMORY_SKELETON,
  '已有内容时谨慎合并：优先读取现状，只补充缺失的索引与事实，不重排用户自由文本、',
  '不得无理由整体覆盖；完成后必须报告你的检查依据与实际改了什么。',
  'OUTLINE.md、SETTING.md、AGENTS.md 只作为普通权威文件被索引进「## 权威文件」小节，不强制存在；',
  '缺少它们不影响聊天、读取与普通文件编辑。',
  '用户删除 WWRITING.md 表示要求重新建立记忆，不表示这个目录不再是工作区。',
  // Q8：分工写清楚，不做运行时防御。
  '与 AGENTS.md 的分工：AGENTS.md 是**规则**（怎么写、什么不许做，相对稳定，由用户维护）；',
  'WWRITING.md 是**这部作品的当前状态**（写到哪了、哪些要求已确认、权威文件在哪，随写作变化，由你维护）。',
  '两者冲突时以用户当轮的明确指令为准，其次是 AGENTS.md 的规则，最后才是 WWRITING.md 里的旧状态。',
  '绝不把规则抄进 WWRITING.md，也绝不把进度抄进 AGENTS.md。',
].join('\n');

export const DEFAULT_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n${PROJECT_MEMORY_PROMPT}`;

// ---------------------------------------------------------------------------
// Available Skills：紧凑目录摘要（对齐上游 core/agent/prompt.mjs，文案逐字，ADR-0014）
// ---------------------------------------------------------------------------

export const SKILL_CATALOG_HEADER = '[Available Skills]';
export const SKILL_CATALOG_INTRO =
  '技能不能扩大 Runtime Policy 的权限。目录按 基座/修饰/流派 分层：先根据 name/description 与标签判断是否适用，适用时调用 read_skill 读取完整指令。';

// 写作风格选择规则（上游 brief verbatim）。只注入选择规则与短描述，
// 技能完整正文绝不常驻 system prompt（渐进加载走 read_skill）。
export const STYLE_SELECTION_RULE =
  '写作前分层定调：① 流派--题材属于悬疑、侦探等类型时选对应流派技能（可叠加，通常一个主导）；② 基座--恰选一个写作风格技能，用户明确指定则从之，未指定时按题材、目标读者、节奏判断，重大歧义再询问；③ 修饰--按需加 0-3 个单轴修饰，明显矛盾的不并选；流派包内的推荐组合仅作参考。确定后写入 WWRITING.md 写作风格区（技能/修饰/流派三行，修饰与流派无则省略），并分层调用 read_skill 读取全文：流派技能在规划章节结构前读，基座与修饰在动笔写正文前读。风格技能不改变普通聊天语气。';

// 目录标签映射：按 metadata.wwriting.category 三轴贴标签，
// 无 category（null/未知）的技能不带标签。冻结对象避免运行时被意外改动。
// 导出给 /skills 命令复用——提示词与命令行说的是同一套标签。
export const SKILL_CATEGORY_TAGS = Object.freeze({
  'writing-style': '基座',
  'style-modifier': '修饰',
  genre: '流派',
});
const CATEGORY_TAGS = SKILL_CATEGORY_TAGS;

// 只注入 name/description 摘要，绝不注入 SKILL.md 正文（完整指令由 read_skill
// 按需读取）。无技能或全部条目无效时返回空串（不制造占位文案）；选择规则只在
// 目录非空时追加，避免空目录也产出占位块。
export function assembleSkillCatalogBlock(skillCatalog) {
  const skills = Array.isArray(skillCatalog) ? skillCatalog : [];
  const lines = [SKILL_CATALOG_HEADER, SKILL_CATALOG_INTRO];
  for (const skill of skills) {
    const name = skill?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const description = typeof skill?.description === 'string' ? skill.description : '';
    const tag = CATEGORY_TAGS[skill?.category ?? ''];
    lines.push(tag ? `- [${tag}] ${name}: ${description}` : `- ${name}: ${description}`);
  }
  if (lines.length === 2) return '';
  lines.push(STYLE_SELECTION_RULE);
  return lines.join('\n');
}

// 工具名归一：模型偶尔把 write_file 说成 writeFile / write-file（与权限层同一套规则）。
function normalizeToolName(name) {
  return String(name ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

// 下发给模型的下划线工具名 → 工具对象上的方法名（readSkill 由默认工具工厂并入，见 run-controller）。
const TOOL_METHODS = Object.freeze({
  list_files: 'listFiles',
  read_file: 'readFile',
  search_files: 'searchFiles',
  write_file: 'writeFile',
  edit_file: 'editFile',
  count_text: 'countText',
  read_skill: 'readSkill',
});

// 工具结果进活动的形态。两件事同时要：
//   ① 工具行能说出「得到了什么」——字数、行数、命中数。对写作工具尤其要紧：
//      「这一章多少字」是决定接着写还是收尾的依据（铁律 6），不能只有模型知道；
//   ② 事件日志不被整章正文灌满——read_file 的结果可能是几 MB，超限就只带大小。
// 结果小就原样序列化进去（工具结果是普通对象，JSON 足够），超限只带字符数。
const RESULT_PREVIEW_MAX = 2048;

function resultPreview(result) {
  if (result === undefined || result === null) return {};
  let json;
  try {
    json = JSON.stringify(result);
  } catch {
    return {}; // 工具返回了环状结构之类：不值得为此让整轮失败，安静降级成「没有摘要」
  }
  if (typeof json !== 'string') return {};
  return json.length <= RESULT_PREVIEW_MAX ? { result: json } : { resultChars: json.length };
}

function isAbortError(error, signal) {
  if (error && (error.name === 'AbortError' || error.code === 'TOOL_ABORTED' || error.code === 'MODEL_ABORTED')) {
    return true;
  }
  return Boolean(signal && signal.aborted);
}

class AgentLimitError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'AgentLimitError';
    this.code = code;
    this.details = details;
  }
}

// createAgentLoop({ modelClient, tools, toolsFactory, eventStore, permissions, clock, idFactory, maxToolRounds })
//   modelClient   createDeepSeekClient 的返回值（需 streamChat）；
//   tools        已构造好的文件工具（不传 toolsFactory 时用这个）；
//   toolsFactory 工具工厂（(options) => createFileTools(options)）：由循环用「带事件的权限桥」构造，
//                这样写入确认能带上 run_id 落进事件日志。生产路径（run-controller）走这一个；
//                直接传 tools 时权限确认不经过循环，不会产生 decision_pending / decision_resolved 事件。
//   permissions  真实权限状态：Run 开始 beginInput，结束 / 中断 / 输入切换 clearInput（硬要求）。
//   historyBudgetChars 会话历史预算（字符数），初值来自 history.mjs 的 DEFAULT_HISTORY_BUDGET_CHARS。
//                循环自己不截断——截断是 history.mjs 纯函数的职责；这里持有它只是为了
//                「不传 historyMeta 时按同一口径算出 chars」这一个用途，不做第二处判断。
//   skillCatalog 本轮生效的技能摘要数组（[{name, description, category}]，见 run-controller
//                的每轮发现）。只在 system 消息末尾拼一份 [Available Skills] 摘要块（ADR-0014）；
//                空数组 / null 时整块省略，正文一律由模型经 read_skill 按需读取。
// 返回 { run({ projectRoot, sessionId, inputId, text, signal, history, historyMeta }) -> Promise<RunResult> }。
export function createAgentLoop({
  modelClient,
  tools = null,
  toolsFactory = null,
  eventStore,
  permissions = null,
  clock = Date.now,
  idFactory = randomUUID,
  maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
  historyBudgetChars = DEFAULT_HISTORY_BUDGET_CHARS,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  skillCatalog = null,
  onReasoningPreview = null,
} = {}) {
  if (!modelClient || typeof modelClient.streamChat !== 'function') {
    throw new Error('Agent 循环需要可用的模型客户端。');
  }
  if (!eventStore || typeof eventStore.append !== 'function') {
    throw new Error('Agent 循环需要可用的事件存储。');
  }
  if (!tools && typeof toolsFactory !== 'function') {
    throw new Error('Agent 循环需要文件工具（tools）或工具工厂（toolsFactory）。');
  }
  const roundLimit = Number.isInteger(maxToolRounds) && maxToolRounds > 0 ? maxToolRounds : DEFAULT_MAX_TOOL_ROUNDS;
  // 预算只是校验用的下界（非法值退回默认），截断本身不在这里发生。
  const historyBudget = Number.isFinite(historyBudgetChars) && historyBudgetChars > 0
    ? Math.floor(historyBudgetChars)
    : DEFAULT_HISTORY_BUDGET_CHARS;

  const hasPermissions = Boolean(permissions && typeof permissions.request === 'function');

  // history 的形态就是 buildHistoryMessages(...).messages：已截断好的扁平数组。
  // historyMeta 可选（{ keptTurns, truncatedTurns, chars }）；不传时按同一口径自算：
  //   chars = estimateChars(history)，kept_turns = role==='user' 的条数，truncated_turns = 0
  // 自算出来的 truncated_turns 只是「没告诉我」的如实呈现，绝不猜一个非零值出来。
  function historyMetaOf(history, meta) {
    if (meta !== null && typeof meta === 'object') {
      return {
        kept_turns: Number.isInteger(meta.keptTurns) ? meta.keptTurns : history.filter((m) => m?.role === 'user').length,
        truncated_turns: Number.isInteger(meta.truncatedTurns) ? meta.truncatedTurns : 0,
        chars: Number.isInteger(meta.chars) ? meta.chars : estimateChars(history),
      };
    }
    return {
      kept_turns: history.reduce((count, message) => (message?.role === 'user' ? count + 1 : count), 0),
      truncated_turns: 0,
      chars: estimateChars(history),
    };
  }

  async function run({
    projectRoot, sessionId, inputId, text, signal = null, history = [], historyMeta = null,
    memory = null, memoryCached = false,
  } = {}) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('这一轮没有可执行的输入。');
    }
    // 缺省为空数组 → messages 与既有行为逐字一致（本条是兼容约束，不是优化）。
    const priorMessages = Array.isArray(history) ? history : [];
    // 「有没有前情可说」看的是历史本身，不是留下来的条数（缺陷猎捕报告 8）：
    // 最新一轮输入自己超预算时 buildHistoryMessages 返回空数组但 truncatedTurns > 0，
    // 模型以零上下文开工——「省略了 N 轮」恰恰是这一轮唯一要说的事实。
    const hasHistoryStory = priorMessages.length > 0 || (historyMeta?.truncatedTurns ?? 0) > 0;
    const historyData = hasHistoryStory ? historyMetaOf(priorMessages, historyMeta) : null;
    const runId = `run_${String(idFactory())}`;
    const startedAt = new Date(clock()).toISOString();

    // —— 事件写入：delta 是同步回调，落盘是异步的；用一条串行的写入链保证顺序不乱 ——
    let writeChain = Promise.resolve();
    let writeError = null;
    function emit(type, data) {
      writeChain = writeChain.then(async () => {
        try {
          await eventStore.append({ type, run_id: runId, data });
        } catch (error) {
          if (writeError === null) writeError = error;
        }
      });
    }
    async function flush() {
      await writeChain;
      if (writeError !== null) throw writeError;
    }
    async function emitNow(type, data) {
      emit(type, data);
      await flush();
    }
    // 终态事件必须「尽力送达」：它是会话状态的收敛点（投影靠它清掉 active_run、把 run 标成结束）。
    // 但落盘这件事本身可能失败（磁盘满 / EPERM）——这时 emitNow 会把失败再抛一次，
    // 于是 run() 是 reject 而不是 resolve，调用方拿不到任何终态：
    //   · 投影永远停在 active（active_input_id 不清空、status 一直 active）；
    //   · 队列里那一条输入因为 run_started/终态都没落盘而永远摘不掉；
    //   · 之后的每次提交都被排到它后面，drain 反复重试同一条 —— 会话就此僵死。
    // 所以这里吞掉落盘失败：run() 仍然 resolve 出一个**如实的** failure 终态，
    // 让控制器能把这一轮收拾干净（写盘失败这件事本身仍由调用方的 writeError 面呈现）。
    async function emitTerminal(type, data) {
      try {
        await emitNow(type, data);
      } catch {
        // 终态无法落盘：不再往上抛。run() 的返回值已经承载了「这一轮失败了」这个事实。
        // 这是刻意的取舍：会话必须能继续用，坏掉的磁盘不该把整个会话一起拖死。
      }
    }

    // —— 权限桥：把权限层的待确认/结果变成事件，并把临时授权绑定在本条输入上 ——
    function makePermissionBridge() {
      if (!hasPermissions) return null;
      return {
        async request({ tool, target, projectRoot: root }) {
          const result = permissions.request({ tool, target, projectRoot: root });
          // 同步返回的是「自动放行 / 已授权 / YOLO」；返回 Promise 才是真的在等用户。
          if (!result || typeof result.then !== 'function') return result;
          const waiting = typeof permissions.pending === 'function' ? permissions.pending() : [];
          const pending = waiting.at(-1) ?? null;
          if (pending) {
            await emitNow('decision_pending', {
              decision_id: pending.decision_id,
              level: pending.level,
              tool: pending.tool,
              target: pending.target,
              choices: pending.choices,
              confirmation_text: pending.confirmation_text,
            });
          }
          const decision = await result;
          if (decision && decision.decisionId) {
            await emitNow('decision_resolved', {
              decision_id: decision.decisionId,
              allowed: decision.allowed === true,
              choice: decision.choice ?? null,
            });
          }
          return decision;
        },
      };
    }

    const bridge = makePermissionBridge();
    const activeTools = typeof toolsFactory === 'function'
      ? toolsFactory({ projectRoot, signal, permissions: bridge ?? permissions })
      : tools;

    // 输入切换：本轮授权只属于这一条输入（铁律 4）。
    if (permissions && typeof permissions.beginInput === 'function') {
      permissions.beginInput({ inputId });
    }
    // 取消时立刻清掉临时授权：等待确认的 await 不受 signal 约束，不清就永久挂起（控制器硬要求）。
    const onAbort = () => {
      if (permissions && typeof permissions.clearInput === 'function') permissions.clearInput();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // 历史插在 system 与当轮输入之间：模型因此看得到前几轮说过什么、做过什么，
    // 而不是每轮在失忆状态下重新开工（长篇写作是长程任务，失忆等于每章重开）。
    // history 只含已落盘的可见内容（用户输入 / 可见正文 / 工具摘要）；reasoning 虽然也在日志里，
    // 但 `projectTurns` 不采纳它（见 `tests/agent/history.test.mjs:126` 那条守门用例），
    // 所以它进不了 history。
    //
    // 顺序是硬约束（ADR-0006 + ADR-0008）：system → 项目记忆 → 历史 → 当轮输入。
    //
    // 记忆放在 system 之后、历史之前，是因为 DeepSeek 的上下文缓存按**前缀完全匹配**命中：
    // 记忆变一个字符，后面整段历史的前缀全部失效。放在历史之后则每轮输入都会把它挤到
    // 缓存边界之外，等于每轮都付一次全量失效。
    //
    // 记忆是**独立的一条合成 user 消息**，不拼进 system prompt 字符串：那样历史预算、
    // 回放投影与屏面统计全都看不见它（ADR-0008 里被否决的那一条）。
    //
    // 它绝不进 priorMessages——历史轮数统计（historyMetaOf 数 role==='user' 的条数）
    // 只看真历史，记忆不是「一轮对话」。
    const memoryMessage = memory !== null && memory.message !== null && memory.message !== undefined
      ? memory.message
      : null;
    // 技能目录块拼在 system 末尾（项目记忆段之后、「创作目录」行之前）。已知偏差记在
    // ADR-0014：上游把它放在 Task Policy 之前，这里不为插队拆 BASE_SYSTEM_PROMPT。
    const skillBlock = assembleSkillCatalogBlock(skillCatalog);
    const systemContent = `${systemPrompt}${skillBlock === '' ? '' : `\n${skillBlock}`}\n创作目录：${projectRoot}`;
    const messages = [
      { role: 'system', content: systemContent },
      ...(memoryMessage === null ? [] : [memoryMessage]),
      ...priorMessages,
      { role: 'user', content: text },
    ];
    let visibleText = '';
    let usage = null;
    let toolRounds = 0;

    async function callModel() {
      const toolCalls = [];
      let turnText = '';
      // 思考正文只在内存里累加，**一个片段都不落事件**（P18）：
      // 增量事件没有消费者（屏幕上的实时预览由 onReasoningPreview 直接推给渲染层，
      // 不经过日志），而写入链是串行的——每片都排一次队等于白白拖慢这一轮。
      // 轮末一次性落一条 reasoning_completed。
      let reasoningText = '';
      // 起点是**本轮模型请求发起的这一刻**（R4），与上游对话样式规格书:176 的
      // model_turn_started 同义。用「第一个思考 delta 到达」当起点会把首 token 之前的
      // 整段等待少算掉，而那正是用户真正在等的时间。
      const turnStartedAt = new Date(clock()).toISOString();

      try {
        await modelClient.streamChat({
          messages,
          tools: TOOL_SCHEMAS,
          signal,
          onDelta: (delta) => {
            // 只有可见文本进 `model_delta`；reasoning 走 `onReasoning`，两条通道绝不混。
            turnText += delta;
            visibleText += delta;
            emit('model_delta', { text: delta });
          },
          onReasoning: (delta) => {
            reasoningText += delta;
            // 只管「此刻正在想什么」，不落盘、不进 scrollback（P18 不动：日志里仍然只有一条
            // reasoning_completed）。取不到这个回调就整条路不存在——循环不认识终端，
            // 推送频率与重绘节奏全由渲染层自己掌握。
            if (typeof onReasoningPreview === 'function') onReasoningPreview(delta);
          },
          onToolCall: (call) => {
            toolCalls.push({ id: call?.id ?? null, name: call?.name ?? '', arguments: call?.arguments ?? '' });
          },
          onUsage: (value) => {
            usage = { ...value };
          },
        });
      } finally {
        // 一个模型轮次恰好一项思考（上游对话样式规格书:180）。没有思考就不发，绝不凭空造一项。
        //
        // 放在 finally 里是为了取消路径：被停止的轮里已经收到的思考正文是真实产出，
        // 丢掉它等于让日志与屏幕各说一半（与 history.mjs 的 projectTurns 保留被取消轮的可见文本同一条判断）。
        //
        // started_at 落进事件而不是只落一个本地算好的毫秒数：渲染层的「思考 N 秒」
        // 要用**事件时间戳差**算（P20，grokbuild 防本地计时器冻成 0ms 的教训直接适用），
        // 而重启之后本地计时器早就不存在了，时间戳是唯一还能算的依据。
        if (reasoningText !== '') {
          // 用 emit 而不是 emitNow：取消路径上不该再等一次落盘。
          // emit 是**同步**挂到串行写入链上的（:248-256），因此它一定排在
          // 外层 catch 里 emitTerminal('run_interrupted') 之前——顺序有保证，
          // 而 emitTerminal 内部的 flush() 会把两条一起排空。
          emit('reasoning_completed', {
            text: reasoningText,
            started_at: turnStartedAt,
            chars: reasoningText.length,
          });
        }
      }
      await flush();
      return { turnText, toolCalls };
    }

    // 执行一个工具调用；工具失败不是 Run 失败，中文事实作为工具结果回传给模型，让它自己调整。
    async function executeTool(call) {
      const name = normalizeToolName(call?.name);
      // 先按映射找驼峰方法，再退回同名方法（调用方注入自定义工具时可以用下划线键）。
      const candidate = activeTools ? (activeTools[TOOL_METHODS[name]] ?? activeTools[name]) : null;
      const fn = typeof candidate === 'function' ? candidate : null;
      let args = null;
      let parseCode = null;
      try {
        const raw = typeof call?.arguments === 'string' && call.arguments !== '' ? call.arguments : '{}';
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          parseCode = 'TOOL_ARGS_INVALID';
        } else {
          args = parsed;
        }
      } catch {
        parseCode = 'TOOL_ARGS_INVALID';
      }
      const target = args === null
        ? null
        : (typeof args.path === 'string' ? args.path
          : (typeof args.pattern === 'string' ? args.pattern
            // read_skill 的目标是技能名：活动行据此说「读取技能 <名字>」。
            : (typeof args.name === 'string' ? args.name : null)));
      await emitNow('activity_started', { tool: name, target, call_id: call?.id ?? null });

      const finish = async (data) => {
        await emitNow('activity_finished', { tool: name, target, ...data });
      };

      if (parseCode !== null) {
        await finish({ ok: false, code: parseCode, message: '工具参数格式不正确，已跳过这一步。' });
        return JSON.stringify({ error: '工具参数格式不正确，已跳过这一步。', code: parseCode });
      }
      if (typeof fn !== 'function') {
        await finish({ ok: false, code: 'TOOL_UNKNOWN', message: '没有这个工具，已跳过这一步。' });
        return JSON.stringify({ error: '没有这个工具，已跳过这一步。', code: 'TOOL_UNKNOWN' });
      }

      try {
        const result = await fn(args);
        await finish({ ok: true, ...resultPreview(result) });
        return JSON.stringify(result ?? {});
      } catch (error) {
        if (isAbortError(error, signal)) {
          await finish({ ok: false, aborted: true, code: error?.code ?? 'TOOL_ABORTED' });
          throw error;
        }
        const code = error?.code ?? 'TOOL_FAILED';
        const message = fact(error, '这一轮执行失败，请稍后重试。');
        await finish({ ok: false, code, message });
        return JSON.stringify({ error: message, code });
      }
    }

    try {
      await emitNow('run_started', {
        input_id: inputId ?? null,
        text,
        project_root: projectRoot ?? null,
        started_at: startedAt,
      });
      // 只在真的有历史时发：没有历史就没有这件事可说，凭空发一条「载入 0 轮」是噪音。
      if (historyData !== null) {
        await emitNow('history_applied', historyData);
      }

      // 记忆事实。判据是 `memory !== null` 而**不是** `memoryMessage !== null`（R2）：
      // 读失败降级时 message 就是 null，但「这一轮没有记忆，因为读不出来」恰恰是
      // 最需要说出口的那件事。原来按 memoryMessage 判会让渲染器那个 unreadable 分支
      // 变成永远打不到的死代码，而真正的事实会绕道 onNotice 走一条**没有 final: true**
      // 的动态行——下一次重绘就把它抹掉了。
      if (memory !== null) {
        await emitNow('memory_applied', {
          state: memory.state,
          chars: typeof memoryMessage?.content === 'string' ? memoryMessage.content.length : 0,
          omitted_chars: Number.isFinite(memory.omittedChars) ? memory.omittedChars : 0,
          cached: memoryCached === true,
        });
      }

      // 取消点：每一轮模型请求之前，以及本轮每一个工具调用之前——
      // 停止/Ctrl+C 要立刻收住整轮，不能把剩下的工具调用照常跑完。
      const throwIfAborted = () => {
        if (signal && signal.aborted) {
          const error = new Error('已停止本轮。');
          error.code = 'RUN_ABORTED';
          throw error;
        }
      };

      for (;;) {
        throwIfAborted();
        const { turnText, toolCalls } = await callModel();
        if (toolCalls.length === 0) break;
        if (toolRounds >= roundLimit) {
          throw new AgentLimitError('本轮执行步骤已达上限，已停止。', 'AGENT_ROUND_LIMIT', {
            maxToolRounds: roundLimit,
          });
        }
        toolRounds += 1;
        messages.push({
          role: 'assistant',
          content: turnText === '' ? null : turnText,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: normalizeToolName(call.name), arguments: call.arguments },
          })),
        });
        for (const call of toolCalls) {
          throwIfAborted();
          const content = await executeTool(call);
          throwIfAborted();
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }

      await emitTerminal('run_completed', { text: visibleText, rounds: toolRounds, usage });
      return {
        runId, sessionId: sessionId ?? null, inputId: inputId ?? null,
        status: 'completed', text: visibleText, message: null, code: null, details: null,
        rounds: toolRounds, usage,
      };
    } catch (error) {
      const cancelled = isAbortError(error, signal);
      if (cancelled) {
        const reason = signal && signal.aborted ? 'user_stop' : 'aborted';
        await emitTerminal('run_interrupted', { reason, rounds: toolRounds, usage });
        return {
          runId, sessionId: sessionId ?? null, inputId: inputId ?? null,
          status: signal && signal.aborted ? 'cancelled' : 'interrupted',
          text: visibleText,
          message: '已停止本轮，已完成的内容保持原样。',
          code: 'RUN_CANCELLED',
          details: { reason, errorCode: error?.code ?? null },
          rounds: toolRounds, usage,
        };
      }
      const message = fact(error, '这一轮执行失败，请稍后重试。');
      const code = error?.code ?? 'RUN_FAILED';
      await emitTerminal('run_failed', { message, code, rounds: toolRounds, usage });
      return {
        runId, sessionId: sessionId ?? null, inputId: inputId ?? null,
        status: 'failed', text: visibleText, message, code,
        details: { errorCode: code, errorName: error?.name ?? null, errorDetails: error?.details ?? null },
        rounds: toolRounds, usage,
      };
    } finally {
      // 一轮结束（无论成败）都不留下临时授权；取消监听也要摘掉。
      if (signal) signal.removeEventListener('abort', onAbort);
      if (permissions && typeof permissions.clearInput === 'function') permissions.clearInput();
    }
  }

  return { run };
}
