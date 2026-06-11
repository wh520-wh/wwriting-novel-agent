# S2 设计：连贯性记忆 + 质量门禁 v2

日期：2026-06-12
状态：已与用户对齐（方向、范围、方案 A、七节设计均经确认）
前置：S1 已闭环（含真实 MiMo API 验证，见 `../reports/2026-06-11-s1-real-api-verification.md`）

## 背景与证据

路线图 v2 给 S2 的定义是"质量门禁 v2"，并假设连贯性检查可以"基于 `memory/continuity.md` 与角色档案"。2026-06-11 的真实项目审计（存量 8 章 DeepSeek + 新跑 2 章 MiMo）推翻了这个假设并固定了缺口清单：

**记忆链路半残（根因层）**：

- `book_summary.md` 只在 `project-store.mjs` 创建时写入标题，引擎只读不写——跑完 10 章仍是空文件。
- `chapter_memory.json` 仅存每章头尾原文摘录，章节中段的设定（楼层、时间、人物状态）不进任何记忆。
- `memory/continuity.md` 不存在。门禁无据可查。

**真实坏样本（语料层）**：

| 编号 | 类型 | 证据 |
|------|------|------|
| A1 | 跨章事实矛盾 | 刘康坠楼楼层：第 1 章"六楼" vs 第 2 章"十二楼" |
| A2 | 跨章事实矛盾 | 死亡时间：第 1 章午间（午间新闻/食堂）vs 第 2 章"前天晚上十一点" |
| A3 | 章内时间跳跃 | 第 1 章 segment 1"十月" → segment 2"十二月、期末周"，第 3 章又回到"十月" |
| B1 | 结构错乱 | 第 1 章 segment 2 出现"## 第二章（第1章续）"标题 |
| B2 | 字数失控 | 目标 3300 字，实际 4850/5147 字；超出部分全是 6 元/M 的输出 token |
| C1 | 角色特征污染 | 刘康的标志性细节"叼着没点的烟"在第 8 章迁移到老马身上；疑似头尾摘录反复入 prompt 所致 |
| C2 | 题材漂移 | story_seed"校园爽文" → 实际产出心理惊悚（无任何机制提示） |

现有门禁仅 word-count-gate（且真实项目 `enabled_skills: []` 连 suspense-ending 都未启用）。A 类矛盾任何现有机制都拦不住。

## 总目标

1. 把连贯性记忆建成写作闭环的一部分：每章产出滚动全书摘要 + 结构化设定档案。
2. 用三个新门禁拦住 A/B 类坏样本：事实核对（模型）、标题结构（本地）、字数上限（本地）。
3. 全部接入既有机制：skill-runtime `check` hook、故障卡、设置页、clickability 防线。
4. 花钱的功能明码标价、独立开关、默认软门禁。

## 范围内 / 范围外

**做**：memory-extractor、continuity.md 契约、fact-check gate、title gate、word-cap gate、设置页质量门禁分区、故障卡 fact_conflict 类型、回归语料 + `verify:s2-gates-online`、旧项目补建脚本 `audit:rebuild-memory`。

**不做**（防膨胀，多数已在路线图"明确不做"或另案）：跨章缓存块重排（S1.5 另案）、重复度检测（本次审计未实锤，候补）、角色档案 UI 编辑器、记忆向量检索、EPUB、题材漂移门禁（C2 仅记录，本期不拦——题材漂移可能是用户乐见的创作演化，缺误杀数据前不做）。

## 组件设计

### 1. memory-extractor（引擎层新模块 `src/core/memory-extractor.mjs`）

**触发**：章节 finalize 完成后、下一章 planning 前（`chapter_completed` 事件之后的引擎步骤）。

**调用**：一次模型调用，stage 标签 `memory_extract`（cost.json 的 byStage 由此独立归因）。输入 = 本章正文 + 现有 `continuity.md` + 现有 `book_summary.md`；输出 = 结构化 JSON：

```json
{
  "summary": "全书滚动摘要全文（≤2000 字）",
  "facts": [{ "entity": "刘康", "attribute": "坠楼楼层", "value": "六楼", "chapter_no": 1, "quote": "原文短引" }],
  "timeline": [{ "chapter_no": 1, "story_time": "十月某周一", "events": ["刘康坠楼身亡"] }],
  "characters": [{ "name": "刘康", "traits": ["叼着不点的烟"], "status": "已死亡", "chapter_no": 1 }]
}
```

**落盘**（原子写，复用 writeFileAtomic）：

- `memory/book_summary.md`：整体重写为新摘要，有界 ≤2000 字。
- `memory/continuity.md`：结构化 Markdown，按实体分区，每条带章节出处；同实体同属性值冲突时保留两条并标记 `conflict`（供门禁与人工裁决）；每实体条目上限 N=20，超出按章节最旧归档到 `memory/continuity-archive.md`。
- 水位：`memory/continuity_state.json` 记 `last_extracted_chapter`，提取失败下章补提。

**prompt 集成**：`project_memory` 块改为 `book_summary + continuity` 组合，chapter_memory 头尾摘录只保留最近 2 章（文风参照）。块内容只追加/有界重写，预期附带改善跨章缓存前缀稳定性（不承诺指标，由 cache_report 实测）。

**失败语义**：软依赖。调用失败/JSON 解析失败（重试 1 次）→ 记 run_log（`memory_extract_failed`），写作继续，下章按水位补提。

**开关与标价**：设置页"连贯性记忆"开关，默认开，标注"每章 +1 次调用（约 ¥0.03，按当前模型价格折算）"。

### 2. fact-check gate（skill-runtime check hook）

**触发**：drafting 产出草稿后，与 suspense-ending 同一 hook 点。

**调用**：一次模型调用，stage 标签 `fact_check`。输入 = 本章草稿 + `continuity.md` 的 facts/timeline 分区；输出 = JSON：

```json
{ "conflicts": [{ "draft_quote": "从十二楼坠落", "conflicts_with": "第 1 章：坠楼楼层=六楼", "severity": "high", "suggestion": "统一为六楼或在文中解释差异" }] }
```

**判定**：

- `conflicts` 空 → pass。
- 非空 → 默认**软门禁**：放行 + 章节 `quality_gate_results` 记 `warning` + 故障卡风格提示卡（fact_conflict 类型，人话解释 + "去修订 / 忽略"动作）。
- 硬门禁模式（用户可配）：矛盾清单注入修订 prompt，走既有 revision 循环（计入 `max_revision_rounds_per_chapter`）。
- 调用失败 → 门禁记 `skipped`，写作不阻塞。

**开关与标价**：设置页"事实核对门禁"开关，默认开（软），标注"每章 +1 次调用（约 ¥0.025）"。软/硬切换独立配置项。

### 3. title gate（本地，硬门禁）

segment 文本按行扫描"第X章/Chapter N"标题模式（中文数字与阿拉伯数字均解析），X ≠ 当前章号 → fail，错误信息给出错误标题原文与所在行。确定性结构错误，直接进 revision（既有 `revision_quality_gate` 路径，不计补写）。零模型成本。

### 4. word-cap gate（本地，软门禁）

新配置 `max_words_per_chapter`（默认 `target_words_per_chapter × 1.5`，用户可改/可关）。超标 → warning，信息中标出超出字数与折算成本（按 active_model.pricing 的输出价；未配价格时只报字数）。不拦截、不触发修订。

### 5. 设置页"质量门禁"分区

- 连贯性记忆开关（标价）
- 事实核对开关 + 软/硬选择（标价）
- 字数上限输入框
- 复用 settings-runtime 校验链路；新控件全部加入 clickability 探针。

### 6. 旧项目补建：`audit:rebuild-memory` 脚本

`node scripts/rebuild-memory.mjs <projectRoot>`：按章顺序对已完成章节逐章跑 memory-extractor（报价确认后执行：N 章 ≈ N 次调用），产出完整 continuity.md + book_summary.md。脚本级交付，不做 UI。

## 成本汇总（明码标价）

| 项 | 每章增量 | 默认 |
|----|---------|------|
| 连贯性记忆 | +1 次调用 ≈ ¥0.03 | 开 |
| 事实核对 | +1 次调用 ≈ ¥0.025 | 开（软） |
| 标题/字数门禁 | 0 | 开 |

实测写作本体约 ¥0.04/章（MiMo，S1 报告口径）：全开后每章总成本约翻倍。两开关独立可关；关闭即回到现状成本。

## 回归语料与验收

**语料** `tests/fixtures/s2-corpus/`：A1/A2/A3/B1 真实片段（本地项目内容，直接固化）+ 好样本（不应误杀的正常续写片段、合法的章内回忆/闪回片段）。

**验收标准**：

1. 本地门禁单元测试：B1 标题样本必拦、好样本必放（零调用）。
2. `verify:s2-gates-online`（新增脚本，真实 API）：A1/A2 楼层与时间矛盾对至少拦截 2/2，好样本（含合法闪回，≥4 条）误杀 0；输出拦截率/误杀率 JSON 报告落 `docs/superpowers/reports/`。
3. 跑通一章端到端：记忆提取落盘 `book_summary.md` 非空 + `continuity.md` 含本章事实。
4. 门禁失败在 UI 有人话解释与下一步动作（fact_conflict 卡 + 章节徽章）。
5. 既有防线全过：`npm test`、`verify:mvp`、`verify:app-shell`、`verify:app-clickability`（含新控件探针）、`verify:local`。
6. 成本可见：开满跑一章，cost.json 的 byStage 能区分出 memory/gate 调用（新增 stage 标签 `memory_extract` / `fact_check`）。

## 风险与控制

| 风险 | 控制 |
|------|------|
| 事实门禁误杀（把合法闪回当矛盾） | 默认软门禁只警告；语料含闪回好样本；有误杀数据前不升硬 |
| 记忆提取的 JSON 不稳定 | 重试 1 次 + 失败软跳过 + 水位补提；解析用宽容模式（剥 markdown 围栏） |
| project_memory 块改动影响缓存/质量 | cache_report 前后对比；chapter_memory 摘录保留最近 2 章过渡 |
| 每章 +2 次调用成本不可接受 | 两开关独立、明码标价、可全关回退现状 |
| 新 UI 控件引发点不动回归 | clickability 探针随控件同步扩展（CLAUDE.md 既有防线） |

## 阶段产物

1. 本 spec（已与用户对齐后落盘）。
2. writing-plans 实施计划：`docs/superpowers/plans/2026-06-12-s2-memory-and-quality-gates.md`。
3. 交付后报告：拦截率/误杀率 + 成本实测 + 缓存前后对比。
