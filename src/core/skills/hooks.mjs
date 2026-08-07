// src/core/skills/hooks.mjs —— 确定性技能钩子（计划 Task 12 Step 4）。
//
// runSkillChecks() / runPostProcessHooks() 只对 active catalog 中声明
// metadata.wwriting.hooks 的技能执行（catalog 由 service seam 解析，本模块只接收
// 技能列表）。保持旧 skill-runtime 的 checker / post-process 结果契约：
//
//   - check 结果：{ gate: "skill:<name>", status, skill, hook, checked_chars,
//     instruction, ...checker 专属字段 }；未知 checker id 返回 status="skipped"。
//   - post-process 结果：{ content, results: [{ gate, status, skill, hook, mode }],
//     hooks: hookSummary[] }。
//
// Task 10 carry-forward：check prompt 与 post-process 内容一律从 SKILL.md 正文
// 提取（## Review checklist 的 `- **<check-id>**：<prompt>` 行、## Post-process
// 小节）；metadata.wwriting.hooks 只携带 stage/action/check/conditions/priority
// 结构字段，本模块绝不从 metadata 取 prompt/content。
//
// 本模块是 src/core/skills 的底层文件：只允许被 src/core/skills/index.mjs（唯一
// service seam）与 tests/skills/ 使用；生产调用方经 index.mjs 导入。
import { stripMarkdown } from "../word-count.mjs";

// ---------------------------------------------------------------------------
// 正文章节提取（## 二级标题分节）
// ---------------------------------------------------------------------------

function extractSections(body) {
  const lines = String(body ?? "").split(/\r?\n/u);
  const sections = [];
  let current = null;
  for (const raw of lines) {
    const match = /^##\s+(.+?)\s*$/u.exec(raw);
    if (match) {
      current = { heading: match[1].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(raw);
    }
  }
  return sections;
}

// 返回指定 ## 小节的文本；小节存在但为空（或缺失）返回 null。
function sectionText(body, heading) {
  const section = extractSections(body).find((item) => item.heading === heading);
  if (!section) return null;
  const text = section.lines.join("\n").trim();
  return text.length > 0 ? text : null;
}

// 从 ## Review checklist 取 `- **<check-id>**：<prompt>` 行的 prompt（checker id
// 逐字出现在正文，Task 10 转换规则保证；兼容英文冒号与全角冒号）。
function checkPromptFromBody(body, checkId) {
  const section = sectionText(body, "Review checklist");
  if (section === null) return null;
  const escaped = String(checkId ?? "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const re = new RegExp(`^[-*]\\s*\\*\\*${escaped}\\*\\*\\s*[：:]\\s*(.+)$`, "u");
  for (const line of section.split("\n")) {
    const match = re.exec(line.trim());
    if (match) return match[1].trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// metadata.wwriting.hooks 读取
// ---------------------------------------------------------------------------

// 技能对象（readSkillFile 产物）里声明 metadata.wwriting.hooks 的结构钩子。
function hooksOf(skill) {
  const hooks = skill?.metadata?.wwriting?.hooks;
  if (!Array.isArray(hooks)) return [];
  return hooks.filter((hook) => hook && typeof hook === "object");
}

// 旧契约的 hookSummary：{ skill, stage, action, priority }。优先级取 hook.priority
// 或技能 metadata.wwriting.priority（缺省 100，与旧 normalizeHook 一致）。
function hookSummary(skill, hook) {
  return {
    skill: skill.name,
    stage: hook.stage,
    action: hook.action,
    priority: hook.priority ?? skill?.metadata?.wwriting?.priority ?? 100
  };
}

function matchesConditions(conditions, context) {
  if (!conditions || typeof conditions !== "object") {
    return true;
  }
  if (conditions.min_chapter_no !== undefined && Number(context.chapter_no ?? 0) < conditions.min_chapter_no) {
    return false;
  }
  if (conditions.max_chapter_no !== undefined && Number(context.chapter_no ?? 0) > conditions.max_chapter_no) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 确定性 checkers（从旧 skill-runtime 逐字迁移，保持结果契约）
// ---------------------------------------------------------------------------

function checkSuspenseEnding(content, skill, hook) {
  const visible = stripMarkdown(content ?? "");
  const tail = visible.slice(-500);
  const hasHook = /[?？!！]|突然|真相|危险|秘密|震惊|消失|线索|命运|敲门|身后|倒计时|secret|danger|clue|suddenly|vanished|truth/iu.test(tail);
  return {
    gate: `skill:${skill.name}`,
    status: hasHook ? "passed" : "failed",
    skill: skill.name,
    hook: hookSummary(skill, hook),
    checked_chars: Math.min(500, visible.length),
    instruction: hasHook
      ? null
      : "The final 500 visible characters do not contain a clear suspense hook. Append a concise ending beat with a new danger, reversal, secret, or unresolved question."
  };
}

function checkChapterOpening(content, skill, hook) {
  const visible = stripMarkdown(content ?? "");
  const head = visible.slice(0, 150);
  const hasHook = /突然|猛然|骤然|撞|摔倒|跌|喊|吼|尖叫|枪|刀|剑|血|杀|死|逃|追|夺|抓|打|踢|砸|跪|耳光|疼|痛|冷汗|颤抖|危险|秘密|真相|消失|失踪|线索|阴谋|威胁|求救|救命|来不及|难道|怎么回事|震惊|愣住|呆住|脸色|[?？!！]/iu.test(head);
  return {
    gate: `skill:${skill.name}`,
    status: hasHook ? "passed" : "failed",
    skill: skill.name,
    hook: hookSummary(skill, hook),
    checked_chars: head.length,
    instruction: hasHook
      ? null
      : "开头约 150 字没有正在发生的事件。把章节开头改成人物正在进行的动作或冲突：第一句就进入场面（一个动作、一句对话、一处异动），天气与背景说明移到正文中段。"
  };
}

const AI_VOICE_WORDS = ["仿佛", "似乎", "不禁", "不由得", "莫名", "悄然", "缓缓", "微微", "瞬间", "顿时", "一股莫名的", "一种说不出的"];

function checkAiVoice(content, skill, hook) {
  const visible = stripMarkdown(content ?? "");
  const counts = [];
  let total = 0;
  for (const word of AI_VOICE_WORDS) {
    const matches = visible.split(word).length - 1;
    if (matches > 0) {
      total += matches;
      counts.push(`${word}×${matches}`);
    }
  }
  // 3000 字章节允许约 8 处；密度上限 = 每 350 字 1 处。取两者中更宽松者，避免短章节误杀。
  const threshold = Math.max(8, Math.floor(visible.length / 350));
  const over = total > threshold;
  return {
    gate: `skill:${skill.name}`,
    status: over ? "failed" : "passed",
    skill: skill.name,
    hook: hookSummary(skill, hook),
    checked_chars: visible.length,
    ai_voice_total: total,
    ai_voice_detail: counts.join("，"),
    instruction: over
      ? `模糊修饰词超标（共 ${total} 处：${counts.join("，")}）。改写：这类词多数直接删去不损语义；“不禁/不由得”改成具体的动作反应；“瞬间/顿时”用时间与动作的先后顺序替代。`
      : null
  };
}

function checkDialogueRatio(content, skill, hook) {
  const visible = stripMarkdown(content ?? "");
  const quoteRe = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/gu;
  const dialogueChars = [...visible.matchAll(quoteRe)].reduce((sum, match) => sum + match[0].length, 0);
  const ratio = visible.length > 0 ? dialogueChars / visible.length : 0;
  const percent = Math.round(ratio * 100);
  const tooFew = ratio < 0.08;
  const tooMany = ratio > 0.7;
  const status = tooFew || tooMany ? "failed" : "passed";
  let instruction = null;
  if (tooFew) {
    instruction = `本章对话占比过低（约 ${percent}%）：情节全靠叙述推进。补一段有目的的对话——让人物当面发生冲突、讨价还价或交换秘密，把信息放进对话与动作里。`;
  } else if (tooMany) {
    instruction = `本章几乎全是对话（约 ${percent}%）：缺动作与场景描写。给关键对话配表情、停顿、动作反应和周围环境，让场面立体。`;
  }
  return {
    gate: `skill:${skill.name}`,
    status,
    skill: skill.name,
    hook: hookSummary(skill, hook),
    checked_chars: visible.length,
    dialogue_ratio: Math.round(ratio * 1000) / 10,
    instruction
  };
}

// checker id → 实现（与旧 BUILTIN_SKILLS 的 check 字段一一对应）。
const SKILL_CHECKERS = {
  "suspense-ending": checkSuspenseEnding,
  "chapter-opening": checkChapterOpening,
  "ai-voice": checkAiVoice,
  "dialogue-ratio": checkDialogueRatio
};

// ---------------------------------------------------------------------------
// 对外实现（skills 列表由 service seam 注入；见 index.mjs 包装）
// ---------------------------------------------------------------------------

// 对给定技能列表执行 stage 上的全部 check 钩子（旧 runSkillChecks 结果契约）。
// context: { chapter_no, content, ... }；context.skills 已是 active 列表时直接用。
export async function runSkillChecksWithSkills(skills, stage, context = {}) {
  const results = [];
  for (const skill of skills) {
    for (const hook of hooksOf(skill)) {
      if (hook.stage !== stage || hook.action !== "check") continue;
      if (!matchesConditions(hook.conditions, context)) continue;
      const checker = SKILL_CHECKERS[hook.check ?? ""];
      if (checker) {
        const result = checker(context.content, skill, hook);
        // check prompt 从正文 Review checklist 提取（metadata 只携带 checker id）。
        const prompt = checkPromptFromBody(skill.body, hook.check);
        if (prompt !== null) result.prompt = prompt;
        results.push(result);
      } else {
        results.push({
          gate: `skill:${skill.name}`,
          status: "skipped",
          skill: skill.name,
          hook: hookSummary(skill, hook),
          message: `No local checker is implemented for ${hook.check ?? "unnamed-check"}.`
        });
      }
    }
  }
  results.sort((a, b) => (a.hook?.priority ?? 100) - (b.hook?.priority ?? 100) || a.skill.localeCompare(b.skill));
  return results;
}

// 对给定技能列表执行 post_process 钩子：内容从正文 ## Post-process 提取并追加
// 到 content（旧 runPostProcessHooks 结果契约：{ content, results, hooks }）。
export async function runPostProcessHooksWithSkills(skills, context = {}) {
  let content = String(context.content ?? "");
  const results = [];
  const hooks = [];
  for (const skill of skills) {
    const postHooks = hooksOf(skill).filter(
      (hook) => hook.stage === "post_process" && hook.action === "post_process"
    );
    if (postHooks.length === 0) continue;
    // post_process 内容从正文提取（Task 10 转换规则：post_process.content 移入
    // 正文 "Post-process" 小节；metadata 不携带 content）。
    const bodyContent = sectionText(skill.body, "Post-process");
    for (const hook of postHooks) {
      if (bodyContent !== null) {
        const separator = content.endsWith("\n") ? "\n" : "\n\n";
        content = `${content}${separator}${String(bodyContent).trim()}\n`;
        results.push({
          gate: `skill:${skill.name}:post_process`,
          status: "applied",
          skill: skill.name,
          hook: hookSummary(skill, hook),
          mode: "append"
        });
      } else {
        results.push({
          gate: `skill:${skill.name}:post_process`,
          status: "skipped",
          skill: skill.name,
          hook: hookSummary(skill, hook),
          message: "No local post_process content was provided."
        });
      }
      hooks.push(hookSummary(skill, hook));
    }
  }
  return { content, results, hooks };
}
