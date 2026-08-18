# 2026-08-18 前后端显示一致性审计（只记录，不修复）

- 性质：**只记录，不修复**（用户明确指示）。关联：[[2026-08-18-compaction-audit]]、[[2026-08-18-real-api-stress-check]]。
- 方法：后端主链路人工通读（模型解析/网关分发/设置落盘）+ Explore 子代理 app-shell/desktop/http 全量 inventory + 高优先级发现逐条人工复核。
- 起因问题：「UI 显示的模型 = 后端实际使用的模型」这一类一致性是否成立。

## 元发现 0【流程风险，最高优先级】：工具输出显示层污染，字符串级审计必须码点校验

审计中出现一次「三方工具一致看到源码损坏、但运行时与测试全部正常」的悖论，最终用**码点转储 + 运行时求值**双重证实：

- `src/app-shell/model-settings-page.js:163/220` 的真实字节是正常的模板插值（对函数参数 `id` 的插值，码点序列 `36 123 105 100 125` 即 `$`+`{`+`i`+`d`+`}`）；
- 但所有工具输出（Read / sed / node readFileSync 回显）把它**渲染成了一个带模型名的字面量**（`$glm-5.3_common` 形态）；决定性证据：对该模板求值抛出 `ReferenceError: id is not defined`（解析器读到真插值），而同一错误信息里的源码行仍显示污染形态；
- 运行时实测 PATCH URL 正确（`/api/settings/providers/deepseek`），`tests/app-shell/model-settings-page.test.mjs` 38/38 通过，与全量 1862/1862 一致。

**后果**：本轮 Explore 子代理报告的「1 号缺陷：供应商 PATCH URL 损坏（model-settings-page.js:163/220）」**撤回**--那是显示层假象，同样骗过了子代理的 `git show` 复核。代码无此缺陷。

**教训（对以后所有轮次生效）**：
1. 源码中字符串级结论（URL/插值/字面量）必须码点转储复核，不能信任任何渲染输出；
2. 子代理的「已验证」字符串级断言与主代理同通道，同样可被污染；
3. 「工具显示的源码」与「运行时行为」矛盾时，先怀疑显示层，再用求值实验裁决。

## 模型一致性主链路（后端侧，本人复核）

链路：设置/切换 -> `<stateRoot>/workspaces/<id>/settings.json`（应用私有，POST `/api/settings/model-switch`）-> `loadEffectiveWorkspaceConfig`（FALLBACK -> 旧 project.yaml 只读 -> 私有 settings 优先 + 模型引用解析）-> 运行时每轮 `modelConfigOf`（剥尾标得 provider 基础 ID；`[1m]` 尾标 -> 1M 窗口）-> dispatchAdapter 每次调用重读有效配置分发端点/密钥。

| # | 发现 | 位置 | 严重度 |
|---|---|---|---|
| M1 | `resolution_note` 后端产出、**前端零消费**（app-shell/desktop 无任何引用）：工作区模型引用悬空/停用时静默换成全局默认模型，UI 无任何提示--「UI 显示 A、后端跑 B」的实锤形状 | `config-runtime.mjs:47-58`、`app-server.mjs:241`（注释自称"供界面提示"） | 中 |
| M2 | `active_model: null` 时静默兜底**全局默认模型且 note 为 null**：未配置模型的工作区实际可跑默认模型，UI 却可能显示"未配置/请选择"（反向不一致） | `model-reference.mjs:46-49` | 中 |
| M3 | 双次解析竞态：同一轮调用中 runtime 的 `modelConfigOf(project)` 与 dispatchAdapter 内部重读有效配置是**两次独立读取**；模型切换瞬间可能端点（新配置）与请求内模型名（旧解析）错配 | `runtime.mjs:569/1523` vs `app-server.mjs:271-289` | 低（窗口极小） |
| M4 | 连接测试是独立链路：`testModelConnection` 用表单值直连探测，**不经过** `resolveActiveModel`/store 解析--测试通过 ≠ 运行时解析结果可用（引用形态工作区） | `model-connection-test.mjs` | 低 |
| M5 | 显示口径两套并存：持久层存显示串（可带 `[1m]` 尾标），请求与 `context_usage_updated` 事件用剥尾标基础 ID；composer（走 dashboard effective）、抽屉模型面板（buildModelProfile）、设置页（providers store）三个面取数路径不同 | `model-identity.mjs`、`runtime.mjs:569-587` | 低（口径提示即可） |

正面结论：模型名进入事件流（`context_usage_updated.usage.model`）供圆环/成本显示，是正确的"实际使用值"来源；每轮 fresh 解析保证切换从下一条输入生效；未配置时宁可报 `ProviderConfigurationError` 不回落 mock（`app-server.mjs:268-283`）。

## 结构性 UI 失一致（按暴露面排序）

前 3 项本人逐条复核（读源码/grep 三文件确认），D-H 为子代理报告（结构性接线判断，未逐一复核，置信中高）：

- **A【复核确认】composer 内切换模型不触发 loadDashboard**：切换成功只本地 apply `composerOptions`（`agent/index.js:644-653`），抽屉"模型配置"面板、顶栏"模型未配置"提示、项目列表 model_label 均不知情--同屏出现两个互相矛盾的"当前模型"，直到下一次 dashboard 刷新（手动/切项目/Run 终态）。
- **B【复核确认】任务计划 chip 无清空路径**：`agent/index.js:191` `if (state.plan) onPlanUpdated(state.plan)` 只在真值时回调；切到无 plan 的会话/项目后，常驻顶栏的 chip 残留上一会话的"任务计划 N/M"。
- **C【复核确认】version-panel 的 agentRunning 三处调用方均未传**（app.js 阅读器 / drawer-panels 章节、记忆），恒 false：Run 进行中"恢复此版"可点击，依赖后端 409 `agent_running` 兜底（点击后才报错）。
- **D** `lastDashboard`（app.js:92）快照缓存驱动 5 个显示面（模型面板/章节列表/字数/成本/记忆分区），刷新触发点只有 4 类：Run 进行中章节入账、成本累计、WORKLOG 重写期间，打开的抽屉持续旧数据，与同屏事件驱动的圆环/对话流新旧并存。
- **E** 侧边栏其他项目的会话列表整应用会话期不重拉（session-sidebar.mjs sessionCache）+ 后端把 waiting_user 折叠为 running（runtime.mjs:2895-2901）-> 状态点长期陈旧且"待命"文案不可达。
- **F** 成本数据源 cost.json 仅 idle/关停落盘：Run 中显示旧金额、崩溃丢增量、Windows 路径大小写不同可分裂 per-project 累计器（app-server entries Map 按 `path.resolve` 原样大小写做键）。
- **G** SSE 无显式 sessionId 的边缘（`openProject(root, null)`）：后端每次 poll 重新解析"最近活跃"，活跃会话中途切换 seq 空间错位（agent-routes.mjs:409-413 自述）；前端靠 event_key 去重 + 重连补快照兜底。
- **H** 阅读器路径恢复成功后只重读正文不刷 dashboard（app.js:476-481）：顶栏进度/章节列表短暂与磁盘不一致。

## 风险排序（修复优先级建议，本轮不动手）

1. 元发现 0（流程性：决定此后一切审计结论的可信度）
2. A（用户例子的直接形状，且每次 composer 切模型必现）
3. M1/M2（低频但完全静默的模型错配）
4. B（常驻顶栏残留）
5. D/F（Run 期间抽屉旧数据，作者可感知）
6. C/E/G/H（低频或已有后端兜底）

## 复查锚点

- 模型解析：`config-runtime.mjs:48-73`、`model-reference.mjs:46-`、`app-server.mjs:245-297`、`runtime.mjs:569-587`
- 刷新接线：`agent/index.js:123-135/191/644-653`、`app.js:92/127-134/723-738`、`settings-modal.js:294-296`
- 状态折叠：`runtime.mjs:2873-2905`、`session-sidebar.mjs:62/544-565`
- 元发现复现方法：对 `model-settings-page.js` 第 163 行做码点转储（`[...line].map(c=>c.codePointAt(0))`），对照 Read/sed 渲染输出差异；运行时求值实验见本轮会话记录。
