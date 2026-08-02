# 2026-08-02 agent 稳定性与可用性加固落地

- 关联：[[writing-agent-reflection-loop-done]]、[[parallel-tool-calls-400-root-cause]]、[[agent-runtime-refactor-done]]
- 计划：[[2026-08-02-agent-stability-and-usability-hardening]]（docs/superpowers/plans/）
- 提交：`de9cbf5^..f139ead` 共 12 commits（含前置在途提交 de9cbf5，11 个任务提交），35 files，+1250/-152
- 测试基线：1029 → **1052 全绿**（+23 测试）；verify:app-shell / verify:desktop-shell / verify:app-clickability 三件套全绿

## 落地内容

1. **字数门禁防注水（Task 1）**（`quality-gates.mjs`）
   - `runWordCountGate` 新增 `padding_risk`（shortfall/minWords < 15% 时 true）+ `word_count@v1` schema 注册（对齐 `fact_check@v1` 先例）
   - `targetWords` 预留未参与判定（软目标不锚定）；`status`/`shortfall` 向后兼容（agent-engine 340/376/521 零改动）
   - 防注水指令用中文（计划代码草稿是英文，但测试正则 `/不要.*(重复|堆砌|注水|凑)/u` 要求中文——按测试为准）

2. **fact-check 停滞提前终止（Task 2）**（`agent-engine.mjs`）
   - 新增 `fact_check_stall_count_by_chapter`：冲突数连续 2 轮未减少 → 提前 block（`reason: "stalled"`），`fact_check_rounds_by_chapter` 停在 2，第 3 轮修订不应用（原 4 次 review 才打满硬上限 → 现在 3 次）
   - `blockFactCheckUnresolved` 第 6 可选参数 `{ reason }`；**reason 优先级**：`fcRounds >= max` 时归因 `rounds_exhausted`（硬上限触发时不能谎称"提前终止"，评审发现并修正）
   - 现有"3 轮打满"测试的 mock 从恒定冲突改为递减（2→1），断言逐字节不变

3. **工具异常计入失败计数（Task 3）**（`agent-engine.mjs`）
   - `dispatchSingleToolCall` catch 块追加 `rejectOutput("tool_error", ...)`：连续 8 次工具异常 → `model_output_invalid` 提早止损（原空转 24 轮）
   - 复用既有 `WRITING_AGENT_COMMIT_FAILURES` 计数，无新计数器；成功路径 `commitFailures = 0` 重置不变
   - 测试注入：chapter index 的 draft_path 指向目录（fs.readFile 抛 EISDIR/EPERM）；损坏 index JSON 方案不可行（planning 入口就抛）

4. **停止信号单一入口固化（Task 4）**（`writing-agent-session.mjs`）
   - 纯测试 + 文档：外部 signal → `onExternalAbort` → 内部 abortController 单向同步链路本就通（`agent-engine.mjs:1847` `session.start({signal})`）
   - 固化测试：外部 abort 感知（outcome aborted）、`session.abort()` 编程接口等价、**反向断言**（内部 abort 不反向影响外部 controller）
   - `abort()` 前文档注释明确"生产唯一停止入口是外部 signal"

5. **capability 判断泛化为注册表（Task 5）**（`provider-adapters.mjs`）
   - `registerProviderCapabilityResolver(matcher, resolver)` + `PROVIDER_CAPABILITY_RESOLVERS` 按注册顺序先匹配先生效；DeepSeek 判据改为模块加载时默认注册
   - 返回结构与旧逻辑**逐字节一致**（评审用 374 组合 sweep 验证）；L3 缓存 cacheKey 锚点（deepseek-detection/cache-prefix-stability/auxiliary-response-cache）全绿
   - 演进史注释压缩保留（修正了 v4-flash "L3 缓存生效" 的过时表述——实际不走 L3、tool_choice 走 auto）

6. **loop-exhausted 高风险选项（Task 6）**（`derive-failure-card.mjs` + `failure-actions.mjs`）
   - 追加 `skip-segment`（destructive）+ 条件性 `lower-target-words`（`last_gate === 'word-count-gate' && target_words` 时，lowered = max(min_words ?? 300, round(0.7×target))）
   - **计划缺口修复（评审发现）**：计划文件清单漏了生产链路——(a) `failWritingAgentLoop` 现在从 `state.last_quality_gate_results` 倒序取最近 word-count 失败，无则草稿兜底（readDraft + runWordCountGate），把 `last_gate`/`min_words`/`target_words` 附进故障卡 data；(b) `lower-target-words` 注册进 `FAILURE_COMMANDS`（`failure-commands.mjs`，缺则 web UI 400）
   - `updateProjectSettings` 必须用 `project_profile` 包装（顶层键被 normalizeSettingsPatch 静默丢弃）；min<=target clamp 由 settings-runtime 既有约束兜底（只降软目标、硬门禁不破）
   - `failure-card-render.test.mjs` 命令计数 13→14 同步更新

7. **前端子步骤可见性（Task 7）**（`thread-renderer.js` + `styles.css`）
   - `computeSteps`/`writingStepLabel` 提升到模块级并导出（纯函数风格）；新增 `deriveSubstep`：drafting → `第 N 段`（current_segment_no + 1，后端在段 N 完成后才持久化 N，故 +1 正确）；reviewing → `事实核对 第 X/Y 轮`
   - `.step-substep` 渲染在 meta 之后 + `grid-column: 2`（`.step` 是 3 列 grid，按计划"meta 前追加"会错位）；零后端改动（`data.state` 已暴露全部字段）

## 已知注意点

- **计划文档与实现的三处偏差**（均在代码评审中确认合理）：Task 2 测试断言 `<=2` 与实现 3 次调用 off-by-one（block 发生在第 3 次 review 进入，第 3 轮修订不应用）；Task 6 生产链路（data 契约 + 命令注册表）计划未指定但必须接，否则选项是死代码/400；Task 7 计划接口写 `substeps:[{label,done}]` 数组、实际实现为单 `substep` 字符串（按计划代码草图）
- side 段（并行 tool_calls）工具异常**不计** commitFailures——设计故意（单轮多工具失败不应触发全局 stopRun），有注释说明
- `session.start()` 对外部 signal 已提前 abort 的场景无 guard（监听注册前 disconnect 可能漏停）——未来可加固，本轮未做
- `--ink-soft` 未定义（CSS 兜底 `var(--ink)` 生效）；`.step-substep` 在 needs_revision/revising 阶段显示的是上一轮 fact-check 轮数（计划级限制）
- 未推送远端；`verify:local` 未跑（仅打包交付桌面 exe 时需要）
