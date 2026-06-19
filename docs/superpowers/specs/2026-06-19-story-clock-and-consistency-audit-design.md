# 故事时钟规范化 + 一致性审计设计

日期：2026-06-19
状态：头脑风暴已逐项对齐（方向＝全书记忆·可靠与自我修正；打法＝在已交付地基上加深真实空白；交付＝Part A 先行、Part B 跟进；B1 波及判定＝简单不漏 + 成本护栏）
关联：`2026-06-12-s2-memory-and-quality-gates-design.md`（S2a 记忆链路）、`2026-06-12-chat-agent-paradigm-design.md`（S3 对话提案通道、确认卡、标价）、`2026-06-12-software-maturity-roadmap-v3-design.md`（路线图）

外部参照（避免闭门造车，调研于 2026-06-19）：
- `YfengJ/novel-studio-ai`（同品类 local-first 写作台）——"草稿不动正典 / 定稿才写记忆 / 查连贯是流水线一道工序"的范式。
- `virgilianshailer/story-tracker`（SillyTavern 扩展）——时间/地点/人物位置的字段表与"抽取→回喂"机制，用便宜模型跑分析趟。
- `madaan/self-refine`、`noahshinn/reflexion`——自检/失败记忆机制（本设计只取"确定性优先、LLM 兜底"的精神，不引入多轮自动改写）。

## 1. 问题与定位（先取证）

S2a/S3 已落地的部分（本设计**不重复造**，经代码核实）：

- 记忆已是结构化 JSON：`continuity.json = { facts[], timeline[], characters[] }`（`continuity-store.mjs:6`），markdown 仅为渲染视图。
- 时间线数组已存在：`timeline:[{chapter_no, story_time, events[]}]`，由 `memory-extractor.mjs` 每章增量抽取，水位线 `continuity_state.json.last_extracted_chapter`。
- "查连贯"已接进流水线：起草后跑 `runFactCheck`（`agent-engine.mjs:506`），把**事实+时间线**一起喂 LLM 查客观冲突（`quality-gates.mjs:217`），含闪回/撒谎/隐喻豁免、`severity`、`suggestion`、`replace_with`（一键替换）。
- 对话提案已是活的：发现冲突主动发 agent 消息 + `proactive:"fact_check"`（`agent-engine.mjs:766`），并有 hard 模式打回修订。
- 回归语料已备：`tests/fixtures/s2-corpus/` 含 `a2-time-conflict`、`good-flashback/liar/metaphor`。
- 全书重抽骨架已备：`scripts/rebuild-memory.mjs` 遍历所有完成章逐章重抽。

**真实空白（本设计要补的）**：

1. **`story_time` 是不可比较的自由文本**：时间线是"按章号排的流水账"，不是"按故事时间排的模型"。跨章的相对时间矛盾（"第7章过了三天，第9章又说当晚"）**完全靠 LLM 每章肉眼比字符串**，没有本地确定性检查兜底，也没有"过了多久 / 人物几岁"的算术。`a2` 能过仅因同章号下"午间 vs 深夜"字面就撞。
2. **检查只"前向、单章、起草时"**：`runFactCheck` 只在新章起草后跑、只比"本章 vs 既往"。对话里 `edit_chapter` 改了早章，**不会回头重查下游**——改前面、后面静默不一致。也没有"通审全书"的按需入口。

**定位**：把时间线从"日志"升级成"可确定性校验的故事时钟"（Part A），再补"回溯波及重检 + 全书按需审计"（Part B）。一句话——**确定性本地检查优先（零成本、可校验），LLM 只兜底模糊判断**，与本项目"字数本地算、不信模型自报"的哲学同源。

## 2. 设计原则（继承 + 本次强调）

- 花钱的功能必须标价：新增的 LLM 审计/重检每轮成本可见、超阈值先问。
- 本地可校验优先：能用确定性本地逻辑判的，绝不调模型。
- 先取证后开发：本设计已对现有模块逐一取证（见 §1）。
- 交互以对话为先：审计/重检的用户触点是 agent 对话行为（提案消息 + 确认卡），命令/按钮是快捷方式。
- 向后兼容：旧项目 `continuity.json` 平滑迁移，不丢数据。

## 3. 数据模型：时间线节点升级（schema v1 → v2）

`continuity.json.timeline` 节点从：

```json
{ "chapter_no": 7, "story_time": "三天后的傍晚", "events": ["…"] }
```

升级为：

```json
{
  "chapter_no": 7,
  "events": ["…"],
  "story_time_raw": "三天后的傍晚",
  "time": {
    "kind": "scene",
    "elapsed": "+3d",
    "anchor": null,
    "confidence": "high"
  }
}
```

字段语义：

- `story_time_raw`：模型原话，保留——给人看、向后兼容、确定性判不了时的兜底。
- `time.kind`：`scene`（推进主时间轴）｜`flashback`（回忆，倒向过去）｜`parallel`（同时/另一视角）｜`dream`（梦境/虚构）。**非 scene 不进主时间轴的单调性计算**，从根上避免把闪回误判成"时间倒流"。这是模型擅长的语言判断，由抽取产出。
- `time.elapsed`：相对**上一个 scene 事件**过了多久，规范成可解析 token：`+0`（同时/当日）｜`+<n>h|d|w|mo|y`（如 `+3d`、`+12h`、`+2y`）｜`null`（未言明）。
- `time.anchor`：绝对锚点，原文给了才填：`{ "type": "date|age|named", "raw": "3月15日 / 主角20岁 / 建安五年", "value": 可解析时给规范值否则 null }`。
- `time.confidence`：`high|low`。抽取没把握 / 纯模糊表达 → `low`，审计里只提示不硬判。

**关键设计：全局时序结论由本地检查器"算"出来，不向模型要。** 抽取只产出局部、好判断的字段（这是不是闪回？距上一幕多久？有无绝对日期/年龄？）；"是否时间倒流 / 跨度是否自洽 / 年龄是否打架"这些全局判断，由确定性检查器沿链累加 `elapsed`、比对 `anchor` 算出来。故不设"模型自报的全局序号"——避免模型在只看局部时给出漂移的全局序。

## 4. Part A：`story_time` 规范化（地基）

### 4.1 抽取改造（`memory-extractor.mjs`）

- 改 `SYSTEM_PROMPT`：timeline 项要求吐 `story_time_raw` + 结构化 `time`（kind/elapsed/anchor/confidence），给出 `elapsed` 规范 token 的说明与示例（含闪回应标 `kind:"flashback"` 而非负 elapsed）。
- 改 `parseMemoryExtraction`：解析并规范化 `time`；非法/缺失字段降级（`kind` 缺省 `scene`，`elapsed` 非法→null，`confidence` 缺省 `low`）；保留既有截断与 `normalizeArray` 上限。
- 不增加模型调用次数：原本就在产 `story_time`，只是改产结构。

### 4.2 合并改造（`continuity-store.mjs`）

- `mergeExtraction` 的 timeline 去重键从 `(chapter_no, story_time)` 改为 `(chapter_no, events 指纹)`；写入新结构（含 `story_time_raw`、`time`）。
- `renderContinuityMarkdown` 时间线行优先显示 `story_time_raw`，附 `time` 摘要（如 `[+3d·scene]`），保证既有 markdown/`read_continuity` 视图不破。
- `EMPTY()`/`loadContinuity` 兼容 v1：读到 v1 节点（有 `story_time`、无 `time`）→ 迁移成 `story_time_raw=story_time`、`time={kind:"scene",elapsed:null,anchor:null,confidence:"low"}`。

### 4.3 新增确定性本地检查器（新模块 `src/core/timeline-check.mjs`，纯函数、零模型调用）

输入：`timeline[]`（v2）。输出：`{ violations:[{type, chapter_no, prior_chapter, detail, severity, suggestion}] }`。

检查项（只判 `confidence:"high"` 且字段可解析的；判不了的跳过留给 LLM）：

- **单调性**：仅对 `kind:"scene"` 事件，沿章号顺序累加 `elapsed` 得"运行故事钟"；若某 scene 章的钟值早于更早章的钟值且无 flashback/parallel 标记 → `time_reversal`。
- **跨度自洽**：两处对同一对相邻幕的 `elapsed`/`anchor` 推出的间隔互相矛盾（如累加得 +3d，却有 anchor 指向同日）→ `span_conflict`。
- **锚点自洽**：`anchor.type:"age"` 沿时间倒退（后面更年轻）或 `anchor.type:"date"` 与运行钟方向相悖 → `anchor_conflict`。中文数/日期解析复用 `parseChineseChapterNo` 同款思路。

`elapsed` token → 小时数的解析器内置于本模块，便于累加比较。

### 4.4 接入提案通道（复用 S3，不新建 UI）

- 抽取/合并后调用 `timeline-check`；`violations` 非空时，**走 `agent-engine.mjs` 既有那条 proactive 提案路径**（同 `runFactCheck` 出口）：发一条 agent 消息 + 预填 `edit_chapter` 的 `replace_with`（确定性命中可给确定建议）。
- `buildFactCheckMessages` 喂时间线时，从喂 `story_time` 升级为喂"`story_time_raw` + `time`（序/elapsed/anchor）"，让 LLM 兜底判断也更有据。
- 确定性命中 `severity` 默认 `high`；与 LLM 命中合流，去重（同章同 draft_quote 只报一次）。

### 4.5 迁移

- `CONTINUITY_SCHEMA_VERSION` → 2。
- 读时惰性迁移（§4.2）保证旧项目不报错、可显示。
- 想要新结构的完整收益：跑 `npm run audit:rebuild-memory <root>`（重置水位线后重抽）——已有脚本，仅因抽取产出结构变化而自动产出 v2。

## 5. Part B：回溯波及 + 全书审计（地基之上）

### 5.1 B1 回溯波及重检（自动，对话内）

触发：对话里 `edit_chapter` / `update_continuity` / `update_outline` 改了第 N 章并落盘后。

流程：

1. **重抽第 N 章记忆**（正文变了，其 `time`/facts 可能变）→ 更新 timeline。
2. **跑确定性 `timeline-check` 全链**（零成本、秒级）：改第 N 章导致的运行钟漂移会立刻暴露下游矛盾。能本地判的，直接出提案。
3. **波及集 = 章号 > N 的所有 `scene` 章节**（"简单不漏"口径——按写作顺序取全部下游章，不依赖故事钟是否完整，宁可多检不漏）。本地查不出、需 LLM 复核的部分：
   - 波及集 ≤ K（默认 5）：直接逐章 `runFactCheck` 复核。
   - 波及集 > K：**不自动跑**，发一条 agent 消息标价——"改了第 N 章，可能波及第 a、b、c… 共 m 章，LLM 复核约 ¥X，要不要审"——走 S3 确认卡，用户批准再跑。

K 与是否启用走 `project.yaml`（默认开、K=5）。每次重检写 `run_log` 事件 `ripple_recheck`（含改动章、波及集、成本）。

### 5.2 B2 全书一致性审计（按需）

- 新增对话工具 `audit_consistency`（read/control 类）+ 命令快捷方式 `/audit`。
- 流程：先跑确定性 `timeline-check` 扫全量 timeline（零成本秒出）→ 给"确定性报告"；本地查不出的可疑区间（low-confidence、解析不了、相邻 scene 间 elapsed 缺失处）列为"建议 LLM 深审"，预估成本，用户确认后复用 `rebuild-memory` 的遍历骨架逐章 `runFactCheck`。
- 产出"全书一致性报告"对象（落盘 `memory/consistency_report.json` + 时间线里若干提案消息）：硬矛盾数、存疑数，每条带一键修复。
- 标价：确定性结果免费即出；LLM 深审预估成本后确认再跑。写 `run_log` 事件 `consistency_audit`。

## 6. 与现有机制的关系（复用清单）

| 复用 | 来自 | 本设计如何用 |
|------|------|-------------|
| 提案消息 + `replace_with` 一键修复 | S3 `agent-engine.mjs:766` | 确定性命中与 B1/B2 命中统一从此出口 |
| 确认卡 + 标价 | S3 | B1 超阈值、B2 LLM 深审的"先问后跑" |
| `runFactCheck` | S3 `agent-engine.mjs:687` | B1/B2 的 LLM 兜底复核直接调用 |
| `rebuild-memory` 遍历骨架 | S2a `scripts/rebuild-memory.mjs` | 迁移重抽 + B2 全书逐章复核 |
| `continuity_state` 水位线 | S2a | 迁移重抽的增量控制 |
| `parseChineseChapterNo` 中文数解析 | `quality-gates.mjs` | `anchor` 年龄/日期解析 |
| s2-corpus 回归语料 | S2a/S3 | 扩充时间线确定性用例（§8） |

## 7. 交付切分与顺序

**Part A 先行、单独验收；Part B 跟进。** A 是 B 的地基：B 的回溯/审计要跑在规范化后的时间钟上才"又准又省"，否则只是把弱 LLM 检查重跑一遍。每刀含真实 API 短跑（继承项目铁律）。本 spec 之后先用 writing-plans 为 **Part A** 出实施计划。

## 8. 验收标准

Part A：

1. **结构正确**（单测）：抽取吐 v2 `time` 字段；非法字段降级不崩；merge 写入与渲染兼容。
2. **确定性检查**（单测，新增 s2-corpus 用例）：
   - 时间倒流：scene 累加 +3d 后又置同日 → `time_reversal`（新 fixture `b1-time-reversal`）。
   - 闪回豁免：`kind:"flashback"` 不触发倒流（新 fixture `b1-flashback-ok`）。
   - 年龄倒退：anchor age 20→19 → `anchor_conflict`（新 fixture `b1-age-regression`）。
   - 纯模糊：`confidence:"low"`/elapsed=null → 本地不判、无误报（新 fixture `b1-fuzzy-defer`）。
3. **提案落地**（真实 API）：构造跨章时间矛盾 → agent 主动发提案消息 + 一键修复执行成功、文件实际变更。
4. **迁移**：v1 项目读取不报错、markdown 正常；`audit:rebuild-memory` 后产出 v2。
5. **不增调用**：抽取调用次数与改造前一致（成本回归）。

Part B：

6. **回溯（≤K）**（真实 API）：改第 2 章引入下游矛盾 → 自动重检命中 → 提案出现。
7. **回溯（>K）标价**：波及 > K 章 → 出"是否审 m 章·约 ¥X"确认卡，不自动烧钱。
8. **全书审计**：`/audit` 先出免费确定性报告；确认后 LLM 深审产出完整报告 + 提案。
9. **成本归因**：`byStage` 出现 `fact_check`/审计相关金额；提案/报告显示成本。

通用（继承铁律）：

10. `npm test`、`verify:mvp`、`verify:longrun`、`verify:app-shell`、`verify:app-clickability`、`verify:local` 全过；新对话/报告控件纳入 clickability 探针。

## 9. 成本与标价

- Part A 净省：确定性检查零模型调用，本地抓掉的硬矛盾不再劳 LLM；抽取不增调用。
- Part B 增量：B1/B2 的 LLM 复核 = 每章一次 `fact_check` 调用，独立归因；超阈值/深审一律先标价后用户确认，不静默烧钱。
- 长书护栏：波及集 > K 与全书 LLM 深审都强制走确认，杜绝"改一章触发四十章自动复核"。

## 10. 风险与控制

| 风险 | 控制 |
|------|------|
| 台账（LLM 抽取）本身错 → 误报/漏报 | 保留 `story_time_raw`；`confidence:"low"` 只提示不硬判；确定性检查只判 high+可解析 |
| 模型 `time` 字段输出不稳 | 宽容解析 + 字段降级（缺省 scene/low/null），不崩 |
| 把闪回/并叙误判成时间倒流 | `kind` 分轴：非 scene 不进单调性计算；扩 corpus 防误报 |
| 回溯重检烧钱（长书） | 波及 > K 强制确认 + 标价；确定性检查先免费过滤 |
| 改 timeline 结构破坏既有消费方 | 消费方仅四处（抽取/merge/渲染/fact-check），逐一改 + 回归；markdown 优先显示 raw |
| 迁移丢数据 | 惰性迁移保 raw；schema 版本号；rebuild 可重生成 |

## 11. 明确不做（本期）

- 绝对世界历法/精确日期推演（只做相对时序 + 可解析锚点的自洽校验，不强行把模糊时间钉成绝对时间）。
- 多轮自动改写（self-refine loop 全自动）：维持"检测 → 提案 → 用户一键"，不让 agent 无人值守改正文。
- Reflexion 式失败记忆：列为后续候补，本期不做。
- 伏笔/关系图谱等"模糊一致性"维度：本期只做"客观时序一致性"；模糊维度待范式验证后另议。
- 向量检索：时间线为结构化小集合，全量可入上下文，无需检索（继承路线图"不做向量检索"）。
