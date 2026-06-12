# S2a 记忆链路 + S3 对话范式 交付报告

> 日期：2026-06-12 | 全量防线：532/532 tests | verify:local ok:true

---

## 1. 任务清单与 commit 对照表

| Task | 标题 | Commit | 状态 |
|------|------|--------|------|
| 1 | memory-extractor 纯函数 | d8eb361 | ✅ |
| 2 | continuity-store | 3a95c6f | ✅ |
| 3 | 引擎集成 summarizing | dc0262b | ✅ |
| 4 | prompt 集成 project_memory | 82f92c7 | ✅ |
| 5 | rebuild-memory 脚本 | 18f2689 | ✅ |
| 6 | tool-registry | 80e709a | ✅ |
| 7 | 读工具 6 个 | ca917ad | ✅ |
| 8 | 写工具 6 个 | a0a5307 | ✅ |
| 9 | 控制工具 3 个 | da69677 | ✅ |
| 10 | agent-protocol | 016469a | ✅ |
| 11 | chat-store | 5cb5593 | ✅ |
| 12 | chat-context | 582d4d5 | ✅ |
| 13 | chat-agent loop | 4ae9a16 | ✅ |
| 14 | HTTP 端点 | 9e3d1c4 | ✅ |
| 15 | title/word-cap 门禁 | 3390f71 | ✅ |
| 16 | fact-check 门禁 | 56fc481 | ✅ |
| 17 | chat UI 渲染 | 1b8fbed | ✅ |
| 18 | composer 默认对话 | cf8dce8 | ✅ |
| 19 | clickability 探针 | f7f72b6 | ✅ |
| 20 | 鲁棒性测试补全 | 4c437cc | ✅ |
| 21 | verify:chat-online | ab7fc39 | ✅ |
| 22 | 全量防线 + 交付报告 | 本文件 | ✅ |

---

## 2. 全量防线结果

| 防线 | 结果 |
|------|------|
| npm test | 532/532 pass |
| verify:mvp | ok:true (3 chapters) |
| verify:longrun | ok:true (20 chapters, stableChanged=false) |
| verify:app-shell | ok:true |
| verify:app-clickability | ok:true (44 probes) |
| verify:local | ok:true (12 sub-steps) |

---

## 3. Spec §12 验收 10 条逐条核对（2026-06-12 更正：本节原为任务对照表，未对照 spec §12 真实验收条目，现更正）

| # | Spec §12 条目 | 证据 | 状态 |
|---|--------------|------|------|
| 1 | 理解可溯源（真实 API） | 首跑（2026-06-12 JSON）：答案正确但未调工具判负——系记忆预注入与"必须经工具"口径冲突；已按 Claude Code 模式拆 A1（记忆内直接引用）/A2（记忆外必须工具查证） | ⚠ 首跑判负（口径已修正），待重跑 |
| 2 | 编辑落地（真实 API） | 首跑：模型未发起 edit_chapter（pendingAction=false），协议服从率问题；已加观测（reply/toolEvents 记录）与系统提示强化（"不要只口头答应"） | ❌ 首跑未通过，待重跑 |
| 3 | 指挥落地（大纲改→队列→流水线） | 无端到端覆盖（update_outline/queue_chapters/start_run 仅单测） | ⚠ 未端到端验收 |
| 4 | 门禁对话化（语料→主动提案→一键修复） | runFactCheck 集成测试（fake client）✅；首跑拦截 1/2、误杀 0/4——漏检的 a2 语料经复核不构成客观矛盾（坏语料假阴性），已重写为同事件时间矛盾 | ⚠ 真矛盾 1/1 拦截、0 误杀；a2 语料已修正，待重跑 |
| 5 | 拒绝路径 | chat-agent.test.mjs read_only / chapter_busy 用例 | ✅ |
| 6 | 并发安全 | withProjectLock（chat send/confirm）+ chapter_busy + 并发串行测试 | ✅ |
| 7 | 持久性 | pending 跨进程用例 + clickability 确认卡探针 | ✅ |
| 8 | 成本归因 | byStage=chat 端点断言 ✅；首跑实测成本 ¥0.0034（仅场景 A 入账，totalCost 统计已修正为 costTracker 总账） | ⚠ 部分验证，待重跑 |
| 9 | 既有防线 | 本次修复后六道防线输出（532/532 tests, verify:mvp/longrun/app-shell/clickability/local 全 ok:true） | ✅ |
| 10 | 协议鲁棒 | 畸形 JSON / unknown_tool 用例 | ✅ |

> 首跑报告：`2026-06-12-s3-chat-online-verification.json`（ok:false）。三个失败性质不同：条 1 是验收口径误判（答案正确）、条 2 是真实协议服从率问题、条 4 是坏语料假阴性。口径/语料/观测修正见第 7 节，重跑需真实 API key。

---

## 4. 已知范围裁剪

- **SSE 流式**：降级为 v1 JSON 整段返回（Task 14 spec 已记录理由）。
- **对话摘要模型化**：v1 用前 80 字拼接（零成本），候补。

以上裁剪在原实施计划中有书面决策记录；hard 模式原属计划内要求，此前归入裁剪系定性错误，已于本次修复实现（commit 6c2e2f4）。

---

## 5. 已知问题与后续建议

1. **SSE 流式文本**（候补）— 当前整段返回，后续可切换为 SSE chunked。
2. **对话摘要模型化**（候补）— 当前前 80 字截断，后续可调用 LLM 生成摘要。
3. **多 pending 候补**（候补）— 当前单 pending 设计，后续可扩展队列。
4. **Task 3 follow-up** — I-2 (enabled 测试)、I-3 (error.message 敏感)。
5. **Task 12 follow-up** — memory 无 cap，book_summary.md 有增长风险，需加限幅。
6. **Task 21** — verify:chat-online 已于 2026-06-12 首跑（ok:false，分析见第 3 节脚注）；口径/语料/观测修正后需用真实 API key 重跑。

---

## 6. 审核修复记录（2026-06-12）

针对 2026-06-12 审核报告发现的全部问题，逐条修复如下：

| # | 修复项 | Commit | 说明 |
|---|--------|--------|------|
| 1 | clickability 探针动态端口 | 02dfba1 | `listen(0)` OS 分配端口，避免 Windows TCP 排除区 EACCES |
| 2 | fact-check 全文核查 | 03be58a | 删除 2000 字符截断，发送全章正文 |
| 3 | fact-check 结构化 replace_with | 6cf04a0 | 协议扩展 replace_with 字段，预填不再误用 suggestion |
| 4 | runFactCheck 集成测试 | 7eac793 | 导出 runFactCheck，4 个 fake-client 测试 |
| 5 | fact-check hard 模式 | 6c2e2f4 | hard=true + conflicts → needs_revision |
| 6 | chat 端点 withProjectLock | dbababe | send/confirm 包锁串行，防止并发交错 |
| 7 | confirm + rewrite_chapter 测试 | 7c0757b | confirm HTTP 级覆盖 + rewrite_chapter 单元测试 |
| 8 | chat-store 展开顺序 + 指纹 | 4709609 | spread 顺序修复、uuid 去重、删死分支 |
| 9 | 验收工具修正 + 语料补全 | b181456 | 收紧通过线、JSON 落盘、守卫修正、4 条好样本语料 |

原 commit 标题 "with real-API evidence"（058ad1f）在当时不成立，真实 API 证据以 verify:chat-online 生成的 `docs/superpowers/reports/<date>-s3-chat-online-verification.json` 为准。

---

## 7. 验收口径修正记录（2026-06-12，首跑后）

首跑 verify:chat-online 结果 ok:false，复盘后按 Claude Code / Codex 的 agent 实现逻辑修正验收设计：

| 修正项 | 内容 | 依据 |
|--------|------|------|
| 场景 A 拆分 A1/A2 | A1 问记忆内事实（"几楼坠落"），答案与记忆一致即过、不要求工具——预注入记忆（同 CLAUDE.md 模式）本身就是溯源；A2 问只在正文里的细节（"在哪里听到消息"→食堂），必须出现成功的读工具调用——测"上下文不足时查证而非编造" | Claude Code：注入上下文直接可用，缺失信息必须工具获取 |
| 系统提示强化 | agent-protocol 补两条：记忆未覆盖的细节先查证再回答；用户要求修改时调用写工具、不要只口头答应 | Claude Code 系统提示的"不编造/不空承诺"准则；同时改善场景 B 服从率 |
| a2 语料重写 | 原 draft"前天晚上十一点沈泽探查北围墙"与 timeline"第 1 章午间"是不同事件、不构成矛盾（模型判无冲突是正确行为）；重写为旁白直接叙述"刘康是在深夜坠楼的"vs timeline"午间刘康坠楼身亡"——同一事件时间矛盾，无豁免借口 | 坏语料假阴性，非引擎缺陷 |
| 脚本观测增强 | B 场景记录 reply 前 200 字与 toolEvents 明细；报告记入 provider（host+model）；totalCost 改取 costTracker 总账（首跑漏计 B/C 全部调用） | 首跑无法确诊 B 失败原因的教训 |
