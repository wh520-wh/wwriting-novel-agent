# WWriting Bug Hunt Report (whfind-bugs, 2026-08-24)

流程：本人通读核心源码提出候选 → 每个候选交由**全新怀疑者子代理**（无共享上下文、被要求默认反驳）独立验证 → 主循环复核。搜索持续约两小时后按停止条件收尾（未达 30 个确认项）。

- **确认（经受反驳）：7 个**（2 major / 3 moderate / 2 low-边缘）
- **驳回（怀疑者击杀）：3 个**（驳回记录在文末，作为过滤器有效的证据）

只读分析，未改动任何核心代码。

---

## 确认的 Bug

### 1.（MAJOR）journal 四个查询助手读的是“最旧 100k 条”事件，超过 10 万事件后会话被永久卡死

- **位置**：`src/core/agent/journal.mjs:1035-1134`（`hasTerminalEvent` / `findInputMeta` / `isIdleInitiatedRun` / `findTerminalInputId`）
- **现象**：四处均为 `read({ afterSeq: 0, limit: 100000 })`，注释声称“逆序扫描**最近** 100k 条事件”；但 `journal-segments.mjs readAfter`（:733-755）从 segments[0] 开始取前 `limit` 条——实际返回**最旧** 100k 条。
- **影响**：会话事件数超过 100k 后（流式 delta 每 ~24ms 落一条，正常使用数小时内可达；`journal-segments.mjs` 文件头明确以“百万事件 journal”为设计目标，且事件永不清理），每个新输入的 `input_queued` 都在窗口之外 → `findInputMeta` 返回 `text:null` → `run-lifecycle.mjs:363-370` 把每个活动输入立即 `input_interrupted` —— 该会话核心对话功能永久失效，唯一自愈手段是毁灭性的 clear-history。`hasTerminalEvent`/`isIdleInitiatedRun`/`findTerminalInputId` 同样基于过期窗口判断。
- **证据链**：journal.mjs:1036 + 注释 1030-1034；journal-segments.mjs:738-750（从 0 号段顺序取）；run-lifecycle.mjs:363-370；无任何 >100k 的测试覆盖。
- **怀疑者判定**：confirmed (major)——注释与代码的窗口方向相反被逐行证实；无事件修剪路径使 100k 必然可达。

### 2.（MAJOR）UI 保存的 API key 不注入运行中进程的环境变量：连接测试通过、正式运行必失败，且新密钥不进脱敏名单

- **位置**：`src/core/http/providers-routes.mjs:84-107`（PATCH provider 存 key）+ `src/core/app-server.mjs:82,119-121` + `src/core/model/openai-compatible.mjs:458-470`
- **现象**：`applyLocalSecretsToEnv` 全仓库只在 `createAppShellServer` 启动时调用一次（app-server.mjs:82，grep 证实）。UI 保存密钥只写 secrets.json；模型调用路径 `resolveApiKey` 只查 `process.env[envName]`。
- **影响**：首次配置流程“添加供应商 → 保存密钥 → 测试连接（绿，因为 test-connection 直接读 secrets.json）→ 开始写作 → 首次模型调用抛 `Missing API key environment variable`，重启前无法使用”。次要：启动时固化的 `secrets` 脱敏名单不含新密钥，新密钥若出现在工具输出/journal 中不会被脱敏。
- **证据链**：grep `applyLocalSecretsToEnv` 仅 app-server.mjs:82；providers-routes.mjs:97-103 只调 `saveLocalSecrets`；openai-compatible.mjs:465-467 抛错。
- **怀疑者判定**：confirmed——命中默认首次运行流程，无任何“需重启”文档或测试覆盖。

### 3.（MODERATE）手动 in-run /compact 取消时把整个排队队列一并取消，与收敛矩阵三处文档矛盾

- **位置**：`src/core/agent/run-lifecycle.mjs:229-272`（`convergeCompactionCancelled`）
- **现象**：`inputIds` 由活动输入 + **全部** `queued_inputs` 组成（:243-244），两条分支（自动/手动 in-run）都会给每个排队输入追加 `input_cancelled`；而手动 in-run 分支随后只恢复 running（:252-258），注释与计划矩阵（docs/superpowers/plans/2026-08-08-journal-context-compaction-runtime-ui.md:824）都写明“手动 → 恢复 running（**队列继续消费**）”。
- **影响**：用户在 /compact 后排队的消息 B、C，在取消压缩时被静默取消（reason `compaction_run_cancelled`），Run 却“恢复运行”且队列为空立即 run_completed。文档 3:1 支持队列应存活。
- **怀疑者判定**：confirmed，降为 moderate——可见的取消（非静默消失）、可重发，无数据损坏；`compaction_run_cancelled` 在 0 个测试中出现。

### 4.（MODERATE）cost.json 的“idle 时写回”承诺未实现：整个进程生命周期内陈旧，崩溃即丢失

- **位置**：`src/core/app-server.mjs:13-15（头注释）, 216-231, 323-328`
- **现象**：头注释承诺“当会话回到 idle 且 tracker 有新增调用时写回 cost.json”，但 `writeCostReportIfDirty` 唯一调用链是 `server.close()` 覆写里的 `flushAllCostReports`（grep 证实无 idle 钩子；`lastWrittenCalls` 脏跟踪机制是无调用者的增量冲刷管道）。
- **影响**：dashboard 读 cost.json（app-dashboard.mjs:79）——整个会话期间成本/token 面板滞后；崩溃/被杀丢失自进程启动以来的全部记账（正常退出路径 Electron before-quit 会冲刷）。
- **怀疑者判定**：confirmed，降为 moderate——丢失的是派生遥测而非用户内容，可部分从 journal 事件重建。

### 5.（MODERATE，API 层）压缩 failed 期间 submit 仍接受排队输入，但没有任何消费者

- **位置**：`src/core/agent/runtime.mjs:559-601`（submit）+ `run-lifecycle.mjs:387-389`
- **现象**：压缩处于 `failed`（COMPACTION_SEND_BLOCKED_STATES 含 failed）时不重启循环（:564-566 守卫），但仍走“运行中 FIFO”分支排队（:596-601）并返回 `queued:true`；循环已因 compaction_blocked 退出，只有用户显式 retry/cancel 压缩才会复活。
- **影响**：HTTP `/api/agent/input` 对永远不会被处理的输入返回无保留的 "queued" 成功；随后若用户取消压缩，该输入被 `convergeCompactionCancelled` 整批取消且无草稿恢复。前端 composer 在这些状态下禁用发送（composer.mjs:363-367），故仅 API/非 composer 客户端可达。测试只覆盖 `cancelled`（不阻塞）状态。
- **怀疑者判定**：confirmed (moderate)。

### 6.（LOW，边缘）段尾修复的 64KB 窗口在超长残行上截断到行中间，后续 append 拼出永久坏行 → 整段（至多 25k 事件）被隔离为缺口

- **位置**：`src/core/agent/journal-segments.mjs:300-327`（truncateTrailingPartial）、:573-626（append）
- **现象**：崩溃残行 > 64KB 时尾部窗口找不到换行（lastNewline=-1），truncateAt = size-65536 落在残行**中间**，留下无换行的非法前缀；下一次 append 直接把新记录拼在该前缀后面（append 假定文件以换行结尾），融合成一条非法行；下次 load 时该行是“非末尾非法行” → 整段 rename .corrupt 记为 gap（≤25,000 条事件丢失）。
- **可达性**：submit 文本无长度限制（HTTP body 200KB 上限），tool_output_delta 切片可达 1MiB，>64KB 事件行合法存在；但触发还需要崩溃恰好撕裂在 >64KB 行的 >64KB 处（断电/ENOSPC 几何），常规 kill 路径均正确截断。测试只覆盖短残行。
- **怀疑者判定**：downgraded——真实缺陷但触发概率低；一旦触发是大规模事件丢失（数据损失）。

### 7.（LOW，潜在）run_log.jsonl 尾部读取按 64KB 字节块解码 UTF-8，块边界拆开多字节字符

- **位置**：`src/core/event-log.mjs:57-99`
- **现象**：limit 路径反向按 64KiB 块 `buffer.toString("utf8")` 解码，不做字节边界对齐（对比 journal-segments.mjs splitBufferLines 的正确做法）。多块读取时块边界两侧产生 U+FFFD。
- **可达性**：需要最后 64KiB 内完整行数 < limit（dashboard limit:80 → 平均行长 > ~819B）；仓库内所有 run_log 写入方产出行 ~300-450B，当前实际不可达；损坏只落在 JSON 字符串内部，不会导致 parse 失败丢行。
- **怀疑者判定**：downgraded——潜在缺陷、当前写入方下实际不可见；一行块对齐即可修复。

---

## 驳回的候选（过滤器证据）

| 候选 | 驳回理由（怀疑者击杀点） |
|---|---|
| workspace settings 白名单丢弃 `safe_edit`/`test_allowed`（settings patch 却接受并校验） | `workspaces/migration.mjs:71-77` 有显式裁决：“只有 read_only/auto_edit/network_allowed/yolo 有私有 settings 等价字段，safe_edit/test_allowed/dangerous 无等价字段，**不得发明映射**”；safe_edit 的权威通道是 project.yaml；test_allowed 全仓库零消费者；无任何已发布客户端发送这两个键。文档化的设计边界，非 bug。 |
| gateway `onRecovered` 用实例级 retryMax 而非 per-call requestRetryMax（gateway.mjs:242） | 不一致属实，但**不可达**：全仓库 per-call 覆盖只有 `retryMax: 0`（compaction.mjs:461、model-connection-test.mjs:149），该值下 retried 永不为 true、onRecovered 永不触发；主写作循环不传覆盖 → 两个值恒等。潜在笔误级问题，非缺陷。 |
| `mergeExtraction` 对缺 `traits` 的存量角色抛 TypeError（continuity-store.mjs:63,106） | 机制属实，但触发条件不可达：git 全历史（回到首版 983bff3）所有写入方都写 `traits: ch.traits ?? []`，入口双归一化（normalizeMemoryUpdateArgs + `?? []`）；仅手改 JSON 可构造，而读路径（chapter-memory.mjs:125）已有 `?? []` 防御。归为两字符加固项，非 bug。 |

---

## 覆盖范围与方法说明

- **通读**：journal / journal-segments / journal-handlers / runtime / run-pipeline / run-lifecycle / compaction / compaction-prompt / context-checkpoints / history-assembly / stream-writer / tools/index + 四个 definitions / runtime-helpers / openai-compatible / gateway / capabilities / model-identity / context-window / prompt / shell runtime+risk+redaction / fs-utils / event-log / cost-tracker / usage-report / settings-runtime / config-runtime / model-provider-store / model-reference / workspaces store / session-registry / session-manager / chapter / versions / continuity-store / memory-extractor / timeline-check / word-count / simple-yaml / ledger-drift / app-server / router / agent-routes / settings-routes / providers-routes / app-dashboard(部分) / local-secrets / project-lock / skills(skill-file/importer/index)。
- **未覆盖**：app-shell 前端大部（app.js / agent/ 视图 / settings-modal 等 ~9k 行）、desktop Electron 壳、scripts/ 验证脚本、research-tools、book-export、部分 project-operations——时间预算耗尽，留待下一轮。
- 每批候选由独立怀疑者子代理（默认反驳立场、5 问验证、三步结构）审核，共 3 批 10 个候选：7 确认 / 3 驳回（70% 存活率偏低的原因是本轮只提交了高置信候选；按技能预期约半数驳回属于健康范围的下沿）。
