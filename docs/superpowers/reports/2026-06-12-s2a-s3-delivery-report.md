# S2a 记忆链路 + S3 对话范式 交付报告

> 日期：2026-06-12 | 全量防线：519/519 tests | verify:local ok:true

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
| npm test | 519/519 pass |
| verify:mvp | ok:true (3 chapters) |
| verify:longrun | ok:true (20 chapters, stableChanged=false) |
| verify:app-shell | ok:true |
| verify:app-clickability | ok:true (44 probes) |
| verify:local | ok:true (12 sub-steps) |

---

## 3. Spec 验收 10 条逐条核对

| # | Spec 条目 | 证据 | 状态 |
|---|-----------|------|------|
| 1 | S2a spec 组件 1 — memory-extractor | Task 1-3：纯函数解析 + continuity-store + 引擎集成 summarizing | ✅ |
| 2 | continuity 契约 | Task 2：conflict marking、entity cap、watermark 持久化 | ✅ |
| 3 | prompt 集成 project_memory | Task 4：book_summary + continuity 拼接，recent excerpts 截至 2 条 | ✅ |
| 4 | rebuild 脚本 | Task 5：rebuild-memory 为存量项目补齐记忆文件 | ✅ |
| 5 | S3 spec §3 loop | Task 13：chat agent loop，read auto-exec、write confirmation、round cap | ✅ |
| 6 | §4 协议 | Task 10：agent-protocol，tolerant reply parser + system prompt builder | ✅ |
| 7 | §5 工具 15 个 | Task 7(6 read) + Task 8(6 write) + Task 9(3 control) = 15 tools | ✅ |
| 8 | §5 权限 | Task 6 (tool-registry permissions) + Task 20 (permission precheck) | ✅ |
| 9 | §6 并发 | Task 20 用例 4 — chapter_busy 保护 | ✅ |
| 10 | §7 时间线/门禁对话化 | Task 15 (title/word-cap gate) + Task 16 (fact-check gate) + Task 17 (chat UI rendering) | ✅ |

---

## 4. 已知范围裁剪

- **SSE 流式**：降级为 v1 JSON 整段返回（Task 14 spec 已记录理由）。
- **对话摘要模型化**：v1 用前 80 字拼接（零成本），候补。
- **hard 模式 fact-check needs_revision**：v1 只发 warning 事件，候补。

---

## 5. 已知问题与后续建议

1. **SSE 流式文本**（候补）— 当前整段返回，后续可切换为 SSE chunked。
2. **对话摘要模型化**（候补）— 当前前 80 字截断，后续可调用 LLM 生成摘要。
3. **多 pending 候补**（候补）— 当前单 pending 设计，后续可扩展队列。
4. **Task 3 follow-up** — I-2 (enabled 测试)、I-3 (error.message 敏感)。
5. **Task 12 follow-up** — memory 无 cap，book_summary.md 有增长风险，需加限幅。
6. **Task 21** — verify:chat-online 需真实 API key 后手动跑。
