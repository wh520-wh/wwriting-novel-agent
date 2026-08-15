# AICSS 组件移植 · 设计规格书

> 用途:本文件是"aicss.dev 组件视觉/状态机移植轮"的唯一设计约束,供实现者 1:1 复刻。基座为《写作Agent对话样式规格书》(下称**基座**),两文件冲突处以本规格书为准(修订点见 §5)。
> 状态:已实施(2026-08-15,实施计划 `docs/superpowers/plans/2026-08-15-aicss-components-port.md`)。
> 依据:`docs/research/2026-08-15-aicss-components-research.md`(含 ledger);aicss 源码本地副本 `.research/aicss-extracted/<组件>/`(行为与参数唯一来源);`docs/design/写作Agent对话样式规格书.md`。

---

## 1. 定位与边界

- **目标**:把 aicss.dev 6 个组件的视觉与状态机细节融进现有对话面,**只做前端 UI 美化**。
- **范围**:streaming-text / thinking-state / thinking-reasoning / inline-citations / web-search / task-list,外加 ai-agent-input 纯视觉。
- **不做**:附件 / 增强提示 / 技能 pill 三块新功能;9ms×2 字打字缓冲;React/Vue/Svelte 依赖;agent 后端任何改动。
- **归属**:不新增独立组件层——每个移植落到现有 UI 元素(工作组思考项 / 活动行 / 任务计划悬浮层 / 正文渲染 / composer)。

## 2. 设计原则(约束级)

| # | 原则 | 说明 |
|---|------|------|
| P-A | 融汇不照搬 | aicss 只作视觉/状态机参照,归属现有 UI 元素,不复制其 React/Vue 组件结构 |
| P-B | 现有功能不减 | 模型/权限/思考强度三菜单、斜杠菜单、发送、上下文圆环、工作组、任务计划、状态行全保留,行为不变 |
| P-C | 数据接现有事件流 | 只消费 journal 已有事件(`assistant_message_delta/completed`、`reasoning_delta/completed`、`plan_updated`、活动事件);不新增事件类型 |
| P-D | 颜色走令牌 | 一律从既有令牌派生(`--agent-*` 与 styles.css primitive/semantic),保持低饱和纸感;不得引入第三种错误色 |
| P-E | 无障碍补齐 | aicss 无 ARIA,移植时补齐 `aria-expanded` / `aria-label` / `role="tooltip"` |
| P-F | 动效降级 | 循环动效必须支持 `prefers-reduced-motion`(减弱后静态)、`prefers-reduced-transparency`、`prefers-contrast: more`;状态变化不改变行高 |

## 3. 组件规格

### 3.1 streaming-text — 流式正文光标

- **位置**:assistant 流式消息的正文末尾(最后一段文本之后)。
- **状态机**:`assistant_message_completed` 未到 → 光标**实心常亮**(`animation: none; opacity: 1`);`assistant_message_completed` 到达 → 光标节点移除。**无闪烁态**:WWriting 没有"播完未定稿"的中间态,光标永不进入 blink(aicss 的 `caret-blink` 仅作参考)。
- **视觉参数**(取 `StreamingText.module.css`):`display: inline-block`;`width: 8px`;`height: 1.05em`;`margin-left: 2px`;`vertical-align: text-bottom`;颜色 `--agent-ink`(禁用 aicss 的 `#0b0d12`)。
- **正文渲染不变**:维持现有 `assistant_message_delta` 增量 + rAF 合帧 Markdown 渲染,不引入打字缓冲。
- **验收**:流式期间光标实心可见、定稿后 DOM 无光标残留;reduced-motion 无影响(实心态无动画);`sim:user-flow` 真实端到端通过。

### 3.2 thinking-state — shimmer 思考标签

- **位置**:工作组思考项标签(`reasoning:<turn_id>`,work-items.mjs),仅运行中。
- **视觉**:文案「思考中」+ shimmer 扫光:渐变 90deg 三档(0–30% 实色 / 45–55% 半透明低谷 / 70–100% 实色),`background-size: 300% 100%`,`background-clip: text`;动画 `2.25s cubic-bezier(0.25,0.1,0.25,1) infinite`,关键帧 `0%,18% → background-position 100% 0`、`82%,100% → 0% 0`(参数取 `ThinkingState.module.css`,颜色换 `--agent-muted`)。
- **完成**:`reasoning_completed` → shimmer 停,标签变「思考 N 秒」(见 §3.3)。
- **状态行不动**:保持基座 §4.1 状态点+文案。
- **降级**:reduced-motion → `animation: none`,常规文字色。
- **验收**:思考项出现即 shimmer(<0.5s),完成即停;状态行无变化。

### 3.3 thinking-reasoning — 思考项三段式

- **运行中内容**:思考项内容区只显示**最近 1–2 行推理片段**,随 `reasoning_delta` 增量拼接、滚动替换(新片段滚入、旧片段滚出);高度 2 行封顶(参照 aicss 行高 20px×2 + gap 4px),不推动对话滚动;滚动过渡参照 aicss stream `transform 560ms`。
- **完成标签**:`reasoning_completed` → 「思考 N 秒」;N = 该 turn 从 `model_turn_started` 到 `reasoning_completed` 的事件时间戳差,秒,四舍五入,最小 1;**无时间戳可算时回退「已完成思考」**。
- **展开详情**:保留基座 §4.9 三态——`available` → 显示思考全文 / `unsupported` → `当前模型不支持查看` / `empty` → `本次没有可查看的思考内容`。
- **工作组 summary「工作了 X 秒」不变**(`active_elapsed_ms` 口径)。
- **验收**:思考中内容区最多 2 行片段滚动替换;完成标签耗时与真实 ±1s;三态文案不变;工作组 summary 不变。

### 3.4 inline-citations — 引用

- **协议**:正文 `[^1]` 脚注语法 → 行内上标编号;来源数据形状与 aicss `CiteRef` 同构 `{n, title, host, url}`,由搜索工具输出提供。
- **渲染**(取 `InlineCitations.module.css`):行内编号上标 chip,hover tooltip(`role="tooltip"`)显示 `title`;消息末尾来源条 footer,每行 `[n]` + 标题 · 域名 + 外链箭头。
- **安全**(沿用基座 §4.10):url 仅放行 `http:`/`https:`,带 `data-external-link`,view.js 委托 `openExternalUrl`;其余 scheme 不生成链接;tooltip 不参与正文流。
- **空态**:无引用数据 / `[^n]` 无匹配来源 → 渲染纯文本编号,footer 不出现。
- **数据后接**:本轮无数据源,协议与渲染先行;验收用种子事件/单测。
- **验收**:`[^1]` 渲染为上标且不破坏安全链接规则;无数据时组件不出现;其余 GFM 语法无回归。

### 3.5 web-search — 搜索状态(活动行特化)

- **位置**:活动行——工具名 `web_search` 的活动行改为特化渲染(基座 §4.3 表格新增一行);其他工具走通用渲染不变。
- **结构**(取 `WebSearch.tsx`):行头 = 搜索图标 + shimmer 查询头「搜索 “query”」(运行中 shimmer,全部来源完成后停);明细 = 来源列表,每行 状态标 + 标题 · 域名 + 外链箭头;状态标三态——pending 虚线圆 → loading 旋转 globe(6 条经线路径 `d` 动画,7.2s 周期、相位偏移 1/6,路径参数取 aicss `M` 常量)→ done 勾。
- **数据绑定**:查询词取活动事件参数(query),来源列表取工具输出(sources);来源**逐个按工具事件** resolve(不做 aicss 的定时演示循环)。
- **生命周期**:工具上线前该渲染不触发;触发即随活动行合并/20 行上限规则(基座 §4.3)。
- **动效**:多个来源 loading 并行 = 多个循环动效,由 §5.1 修订放行;终态/折叠立即清零。
- **验收**:种子事件验证逐个 resolve 与终态勾;非 web_search 活动行不受影响;reduced-motion 下 globe 静态呈现 pending/done 图标。

### 3.6 task-list — 任务计划视觉升级

- **位置**:任务计划悬浮层;**结构 / 折叠行为(3 项智能选取、展开全部)/ 生命周期(`plan_updated` 驱动、Run 结束保留)保持基座 §4.2 不变**。
- **头部**(取 `TodoList.tsx`):图标三态——未开始 列表图标 / 进行中 pie 进度环(circle `r=10.5`、`strokeWidth=2.2`、`strokeDasharray="2.2 4.4"`,完成比例驱动)/ 全部完成 实心勾;计数滚动(每位数字独立上滚替换,380ms,参数取 aicss `RollDigit`)。
- **条目**:三态图标升级——pending 虚线圆 / in_progress 箭头圆 / completed 实心勾 + 完成项删除线(替换基座 ✓/•/○ 标记)。
- **颜色**:沿用 `--agent-plan-rest-fg` / `--agent-plan-current-fg` / `--agent-plan-complete-fg` 三档。
- **无障碍**:头部 `aria-expanded`;装饰图标 `aria-hidden`,状态语义保留。
- **验收**:计划项实时流转三态;折叠仅剩标题+计数;悬浮层结构/生命周期不变;`verify:app-clickability` 全绿。

### 3.7 ai-agent-input — composer 纯视觉

- **范围**:仅视觉对齐(取 `PromptInput` 的外观语言),融进现有 composer 元素——三菜单信息卡(选项图标 + 标题/描述布局)、composer 边框与焦点动效、发送按钮进行态(idle/激活/加载)。
- **不做(硬边界)**:附件 chips;增强提示(enhance 四态及其模型调用);技能 pill;斜杠菜单内容改动(仍固定 `/init` `/write` `/model` `/settings`)。
- **现有功能不减**:模型/权限/思考强度三菜单、斜杠菜单、发送、上下文圆环全保留,行为不变。
- **参考参数**:边框 conic 扫描 `1.1s linear infinite`(`@property --pi-angle`,渐变取项目 accent 系令牌)、pill/菜单进出 180–260ms、按下反馈 80–100ms(基座 §7)。
- **验收**:composer 视觉对齐 aicss 语言;三菜单与发送行为不变(`verify:app-clickability` 全绿);无新增功能入口。

## 4. 全局动效与降级约束

- **曲线**:界面过渡统一 `cubic-bezier(0.22,1,0.36,1)` 家族;循环动效(shimmer/globe/pie)参数取 aicss 原值,**颜色一律换项目令牌**。
- **降级**:reduced-motion → 循环动效全停、静态呈现(shimmer 退常规文字色,globe 退 pending/done 图标);reduced-transparency / contrast:more → 实色表面与明确边界(基座 §7)。
- **状态稳定**:状态变化不改变行高,按钮/标记尺寸不随状态抖动(基座 §7)。
- **动效唯一性**:按 §5.1 修订执行。

## 5. 基座规格书修订(实施时同步写回基座)

| # | 基座条款 | 新条款 |
|---|---------|--------|
| 5.1 | §7 动效唯一性:同一时刻最多 1 个循环动效 | 并发动效上限 = 同时存在的**真实活动源数量**(思考 shimmer、实心光标、搜索来源逐个 resolve 可并存);终态/折叠立即清零;其余不变 |
| 5.2 | §7「思考中」用三点闪烁,不得展示私有推理文本 | 工作组思考项标签用 shimmer「思考中」,内容区显示最近 1–2 行推理片段(状态行保持状态点+文案);reduced-motion 静态降级 |
| 5.3 | §4.9 思考项:运行中标签「思考中」,完成变「已完成思考」 | 运行中标签 shimmer「思考中」+ 最近 1–2 行片段滚动替换;完成标签「思考 N 秒」(N=真实思考耗时,无时间戳回退「已完成思考」);展开详情三态不变 |
| 5.4 | §4.10 正文神圣:UI 元素不得与正文混排 | 增补:引用上标(`[^n]` 脚注)属正文排版;引用链接沿用既有安全规则 |
| 5.5 | §4.3 活动行标签表 | 新增一行:`web_search` → 搜索状态渲染(shimmer 查询头 + 来源逐个 resolve) |
| 5.6 | §4.2 任务计划 ✓/•/○ 标记 | 三态图标升级(虚线圆/箭头圆/实心勾+完成删除线)、头部进度环、计数滚动;折叠/生命周期不变 |
| 5.7 | §4.7 composer;§6.3 流式渲染 | composer 纯视觉对齐 ai-agent-input(不新增功能);流式正文光标状态机(实心 → 定稿移除) |

## 6. 实现约束(给其他模型)

1. **文件边界**:`src/app-shell/agent/**`(view.js / state.js / work-items.mjs / agent.css 等)、`tests/app-shell/**`、`docs/design/**`;不得改动 `src/core/**`(journal / agent-engine / tool-registry / stream-writer 等)。
2. **不新增 journal 事件类型**;未知事件一律忽略(基座 §9.6)。
3. CSS 并入 agent.css 令牌体系,类名沿用 `agent-*` 前缀;不得整块粘贴 aicss CSS Module 类名与色值。
4. 参考源码 `.research/aicss-extracted/<组件>/` 是行为/参数唯一来源;与 §3 冲突时以 §3 为准。
5. 无 ARIA 的移植补齐 `aria-expanded` / `aria-label` / `role="tooltip"`。
6. 测试:视觉契约测试随动(`tests/app-shell/codex-visual-contract.test.mjs` 等);无数据源组件(引用/搜索)以种子事件单测验收。

## 7. 验证门与遗留

- **硬验证门(项目约定)**:`npm run verify:app-clickability` / `verify:app-shell` / `verify:desktop-shell` + `npm test` + 真实 key 的 `npm run sim:user-flow`;对照本规格书与基座逐条核对(正文神圣 / 折叠态即终态 / 错误分级不回归)。
- **遗留**:引用/搜索真实数据源等搜索工具上线(UI 先行,种子事件验收);光标无闪烁态(有意为之,见 §3.1);基座修订在实施时写回。

---

# 附录 A:参考源码对照表

| 组件 | aicss 参考文件(`.research/aicss-extracted/`) |
|---|---|
| streaming-text | `streaming-text/react__StreamingText.module.css` |
| thinking-state | `thinking-state/react__ThinkingState.module.css` |
| thinking-reasoning | `thinking-reasoning/react__ThinkingReasoning.{tsx,module.css}` |
| inline-citations | `inline-citations/react__InlineCitations.{tsx,module.css}` |
| web-search | `web-search/react__WebSearch.{tsx,module.css}` |
| task-list | `task-list/react__TodoList.{tsx,module.css}` |
| ai-agent-input | `ai-agent-input/react__PromptInput.{tsx,module.css}` |
