# 模型高级配置与模型信息统一规格（2026-08-22）

- 状态：已实现并收口（2026-08-22，F1-F6 全部落地，全量回归 1921/1921；执行记录见 docs/superpowers/plans/2026-08-22-model-config-advanced.md 勾选与提交历史）
- 输入：[[2026-08-22-model-config-advanced-decisions]]（决策 D1-D5）、[[模型配置供应商两级重构规格草案]]（store schema 出处，高级配置项当年明列延期）、[[统一 Journal、上下文窗口与自动压缩规格草案]]（[1m] 尾标机制与压缩门禁出处）、[[2026-08-18-ui-backend-consistency-audit]]（M5 母账）、ADR [[0004-model-window-comes-from-config-field]]、ADR [[0005-current-model-display-single-source]]
- 一句话：把「模型能装多少、最多吐多少」从模型名尾巴的黑话升级为明面上的预设配置字段，并让所有「当前模型」显示同源同格式。

## 术语

- **标识符（model_name）**：用户填写的模型名，原样发给提供方。淘汰尾标机制后不再承载任何配置语义（用户填 `foo[bar]` 就发 `foo[bar]`）。
- **上下文窗口（context_window）**：模型记录的数据字段，单位 token。唯一决定用量圆环分母、压缩预检与硬窗口判断。
- **最大输出（max_output_tokens）**：模型记录的数据字段，单位 token，作为 `max_tokens` 随请求发送。
- **当前模型显示面**：composer 模型按钮 + 抽屉「模型配置」面板。设置页模型行是编辑器，不算显示面。
- **压缩阈值（compaction_threshold）**：自动压缩的触发点 = 上下文窗口 × 0.8。

## 目标

- F1 设置页模型行新增「高级 ▸」折叠项：上下文窗口与最大输出两个预设下拉。
- F2 上下文/最大输出字段成为运行时唯一权威（缺省 256k / 64k）。
- F3 `[1m]` 尾标机制整条淘汰（含一次性迁移）。
- F4 压缩阈值从两档硬编码改为窗口八成推导。
- F5 最大输出缺省 64k 随请求发送。
- F6 当前模型显示统一为「厂商 / 模型名」单源，抽屉增加参数行。

## 非目标（明确不做）

- M3（runtime/app-server 双重解析竞态）、M4（连接测试旁路网关）等模型层挂账，不进本轮。
- 预设之外的自由数值输入（含小数 k）；预设集合扩展属后续小改。
- 拉取候选不查真实窗口表（维持现状：不带窗口 = 落缺省 256k）。
- 设置页模型行编辑器不套「厂商 / 模型名」显示格式。
- 项目级字面 active_model 兼容路径不做新迁移（真实数据零命中，见风险）。
- 温度/超时/价格等其余 store 字段不进高级项，本轮只有两个下拉。

## F1 高级展开项（设置页模型行）

- 位置：设置页（模型设置）每个模型行的操作行尾加「高级 ▸」折叠按钮，展开内容渲染在通栏结果行之前；交互与样式复用「拉取候选 ▸/▾」先例（`model-settings-page.js` candidate-toggle 模式与现有样式 token）。
- 展开后两个下拉（label + select，行内错误模式与模型名一致）：
  - **上下文窗口**：选项 `128k / 256k / 400k / 512k / 1000k`，缺省选中 `256k`；
  - **最大输出**：选项 `128k / 64k / 32k / 16k / 8k`（降序），缺省选中 `64k`。
- 保存：与模型名同款自动保存（change 即提交，走现有 `commitModelPatch` 路径），落库为 token 绝对值（如 256000、64000）。
- 存储：`context_window` / `max_output_tokens`，schema 已存在，无新字段。
- 存量值不在预设内（如 API 手写的 192000）：下拉额外显示一项「当前 192k」，不静默改写；用户一旦选择预设即覆盖。
- 测试锚点：预设值落库正确；非预设存量值展示为「当前」项；自动保存走 commitModelPatch。

## F2 上下文/最大输出成为运行时唯一权威

- `model-identity.mjs` 重塑为唯一解析点：删除 `parseModelIdentity` 尾标剥离与窗口推导，导出 `resolveModelLimits({ context_window, max_output_tokens })` -> `{ effective_context_window, effective_max_output_tokens, window_source }`，常量 `DEFAULT_CONTEXT_WINDOW = 256_000`、`DEFAULT_MAX_OUTPUT_TOKENS = 64_000`、`COMPACTION_THRESHOLD_RATIO = 0.8`。字段缺省/非法一律回退缺省，`window_source` 取 `configured` / `default`。
- `runtime.modelConfigOf`（runtime.mjs:566-584）改读字段：`effective_context_window`、`compaction_threshold`、`window_source` 由 resolveModelLimits 推导；`max_output_tokens` 直接填入解析后的缺省值（运行时副本，遵守既有「不写回持久配置」约定）。模型名不再剥离，原样透传。
- adapter 零改动：`openai-compatible.mjs:118` 继续读 `modelConfig.max_output_tokens ?? modelConfig.max_tokens`（现在恒有值）。gateway 的 `max_tokens` 事件字段随之从 null 变为真实值，属预期。
- 测试锚点：modelConfigOf 读字段不读名字；两字段缺省时输出 256_000/64_000；`foo[bar]` 名字原样出现在请求。

## F3 `[1m]` 尾标机制淘汰与迁移

- 迁移并入 `loadProviderStore` 的 `normalizeModel`（一次性、幂等）：**先**按原始名判尾标（尾部连续 `[..]` 中含 `1m`/`1M` 且未显式提供 `context_window` -> 写 1_000_000），**再**剥全部尾部连续 `[..]` 写回 `model_name`。顺序不可反（先剥会丢信号）。同时 `normalizeModel` 停止对 `context_window` 回填 256k（存储改稀疏：未选 = 缺省，由 F2 解析点兜底；`max_output_tokens` 本就稀疏）。
- 迁移后名字与此前后端实际发出的基础 ID 逐字节一致（尾标今天也不上线），线上行为零变化。已验证真实 store（model-profiles.json）5 个模型名全部干净、零命中。
- 证明死亡清单（实现完成后全库 grep 清零，源码侧）：`model-identity.mjs` 尾标解析、`runtime.mjs` 尾标推导、`model-connection-test.mjs:94/167` 的 `identity.provider_model_id` 剥离（probe 直接用原名）、`model-reference.mjs` `stripWindowMarkers`（note 文案直接用原名）、`context-window.mjs` 的 `window_source` 两值口径与两档阈值。相关 `[1m]` 断言散布 4 源码 + 9 测试文件，改写为迁移/新口径用例（model-identity.test.mjs 的尾标用例改写为迁移剥尾标用例，含 `[1m][foo]` 组合与名字中间带括号不剥的边界）。
- 测试锚点：迁移幂等（二次加载不再变）；`model[1m][foo]` -> 名 `model` + 窗口 1_000_000；`mo[del]name` 中间括号不剥。

## F4 压缩阈值 = 窗口八成

- `context-window.mjs` `compactionThresholdOf(window)` 从两档硬编码（256k->204_800 / 1M->967_000）改为 `floor(window * 0.8)`。256k 档数值不变（204,800 恰为八成）；1M 档 967,000 -> 800,000（用户拍板早触发：超长上下文后半段性能下降，七八十万后已明显；线上无 1M 配置，零命中）。
- 双触发规则不动（`shouldCompact` / `exceedsHardWindow` 原样）：达八成，或估算 + 32k 输出余量撞窗口，先压缩。窗口 ≤160k 时余量规则先于八成生效，属预期。
- `context_usage_updated` 事件与快照中的 `compaction_threshold`、`window_source` 随新口径；旧事件不回填。
- 测试锚点：128k->102,400、256k->204,800、1,000k->800,000；≤160k 窗口余量先触发。

## F5 最大输出缺省 64k

- 未配置最大输出的模型，每个请求带 `max_tokens = 64000`（经 F2 解析点填充；此前行为是「不发送该字段」）。存量 5 个模型全部未配，升级后即生效。
- 连接测试不受影响：probe 自带极小 max_tokens（思考型模型探测的既有设计，注释保留）。
- 已知风险（用户知情拍板）：硬上限低于 64k 的提供方可能拒绝或钳制该请求；当前存量模型无此问题，出问题时在高级项调小（预设 8–128）。

## F6 当前模型显示统一

- 格式统一为「厂商 / 模型名」（buildModelProfile 既有 `display`/`model_label`，如 `DeepSeek 官方 / deepseek-v4-flash`）。
- 单源：composer 模型按钮的**当前选中显示**改从 dashboard 模型档案（model_profile）取，不再从供应商清单另推显示串；模型选择器的**选项标签**统一同格式（现 `模型名（厂商）`，settings-connection.mjs:34）。抽屉面板本就是该格式与路径，不动。
- 抽屉「模型配置」面板加一行参数显示：`上下文 256k · 最大输出 64k`（buildModelProfile 经 F2 同一解析函数补 `context_window` / `max_output_tokens` 两字段，k 单位显示；未配置口径与运行时一致）。
- 设置页模型行不套显示格式（编辑器），高级展开项里看得见当前选择。
- 测试锚点：composer 按钮与抽屉同串同源；档案带两字段及缺省值。

## 任务拆分（建议实现序）

1. `model-identity.mjs` 重塑（resolveModelLimits + 常量；parseModelIdentity 删除）。
2. `normalizeModel` 迁移（判标->写 1M->剥标->停止回填），model-provider-store 测试先行。
3. `runtime.modelConfigOf` 改读字段；runtime/project-agent 测试更新。
4. `context-window.mjs` 阈值 0.8 推导 + window_source 口径；context-window/compaction 测试更新。
5. `buildModelProfile` 补两字段；composer/抽屉统一显示与参数行（drawer-panels / agent view）。
6. 设置页高级展开项 UI（两个预设下拉 + 自动保存）。
7. 全库 prove-dead 清理（4 源码 + 9 测试文件的尾标痕迹清零或改写）。
8. 回归收口：verify 三件套 + sim:user-flow（断言更新）+ npm test 全量。

## 验收策略

- UI 改动触发 CLAUDE.md 三件套：`verify:app-clickability` / `verify:app-shell` / `verify:desktop-shell`。
- modelConfigOf 与压缩门禁属核心管线：`sim:user-flow` 必须更新断言并跑通（mock 全链路；真实 API 不在本轮验收内）。
- `npm test` 全量绿。
- prove-dead：`grep -rn "parseModelIdentity\|stripWindowMarkers\|1m\]" src/` 清零（tests/ 中仅存迁移用例的历史名 fixture）。

## 风险与权衡

- **64k 缺省 max_tokens**：低上限模型可能被拒（见 F5；用户拍板，预设可调小）。
- **1M 档阈值 967k->800k**：行为变化但线上零命中（用户拍板早触发）。
- **字面 active_model 残留**：resolveActiveModel 的字面透传路径（model-reference.mjs:83）下，带尾标的极旧配置名字将原样发送（今天会剥）。已验证真实 workspace 全部为引用形式，零命中；不做额外代码，留此记录。
- **预设外存量值**：显示为「当前值」选项，不静默改写（用户一旦选择预设才覆盖）。
