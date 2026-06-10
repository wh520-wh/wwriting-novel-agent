# 模型设置与入口重叠修复设计规格

## 背景

本规格针对当前桌面壳的三个可见问题：

1. 设置弹窗里“模型”使用下拉框，用户只能选择预设模型，无法直接编辑真实模型 ID。
2. 右侧 Quick Rail 的信息气泡在鼠标移开、点击打开面板、窗口失焦或组件重渲染后可能继续停留，形成“已完成 0/10”“资料 0 条”“暂无报告”等黑色提示残影。
3. “新建小说”和“打开本地文件夹”共用同一个创建弹窗入口，缺少来源上下文；同时左侧 rail 需要有明确的空间约束，防止小窗口下两个入口在视觉或点击命中上互相挤压。

## 目标

- 用户可以在模型设置中输入任意模型 ID，同时保留 DeepSeek、小米 MiMo、自定义预设建议。
- Quick Rail 只保留一个活跃信息气泡，并在离开、点击、滚动、窗口失焦、重渲染和打开抽屉时立刻清理。
- “新建小说”和“打开本地文件夹/初始化此文件夹”在文案、状态提示、焦点和验证路径上可区分；左侧入口在 720px 以上桌面高度内不重叠、不遮挡、不互抢点击。

## 非目标

- 不新增模型供应商在线拉取接口。
- 不改后端 settings schema；仍然保存 `active_model.model_name`。
- 不重写左侧导航和项目列表结构。
- 不引入新依赖。

## 现状诊断

### 模型 ID 无法编辑

`src/app-shell/app.js` 中 `renderSettingsDetail()` 调用：

```js
settingsFields.model = settingField("模型", "select", {
  options: preset.models.includes(active.model_name) ? preset.models : (usingThisPreset && active.model_name ? [active.model_name, ...preset.models] : preset.models),
  value: usingThisPreset ? active.model_name : preset.models[0]
});
```

这导致 UI 只能从 `<select>` 选项中取值。对 OpenAI 兼容服务来说，真实模型 ID 经常需要手输，例如 `deepseek-v4.1`、`mimo-v3-preview`、私有中转模型名等。

### 信息异常停留

`src/app-shell/components/quick-rail.js` 的 `attachHoverPreview()` 每个按钮内部维护自己的 `pop`，只在 `mouseleave` 时移除。组件重渲染时旧按钮被 `root.innerHTML = ''` 删除，但旧的 `document.body` popover 不会被该按钮的 `mouseleave` 清理。点击按钮打开抽屉、窗口失焦、滚动或尺寸变化也不会清理。

### 新建与打开本地文件夹重合

`openFromFolder()` 在预览环境或打开到非项目目录时会调用 `openCreateModal()`，与用户主动点击“新建小说”进入同一个无差异弹窗。用户无法判断当前是在“新建到某个目录”还是“把刚选的目录初始化为小说项目”。

左侧 rail 使用 grid 分区，但缺少显式的入口间距与回归断言。后续 UI 调整容易让 `.rail-new`、`.rail-scroll`、`.rail-foot` 在小高度窗口中发生视觉拥挤或点击中心被其他层覆盖。

## 设计方案

### 1. 模型 ID 输入控件

将“模型”从固定下拉框改为文本输入 + `datalist` 建议：

- `settingField()` 增加 `type === "model-id"` 分支。
- 渲染 `<input class="spd-input" list="settings-model-suggestions">`。
- 同时渲染 `<datalist id="settings-model-suggestions">`，选项来自当前 provider preset。
- `value` 优先使用当前项目保存的 `active_model.model_name`；没有当前值时使用 preset 第一项。
- `saveSettings()` 继续读取 `settingsFields.model.input.value.trim()`，不需要改后端。

验收：

- 打开设置 -> OpenAI 兼容/自定义 -> 模型字段可以键入 `writer-custom-2026`。
- 保存后 `/api/dashboard` 返回 `project.active_model.model_name === "writer-custom-2026"`。
- 预设模型仍可通过输入框建议选中。

### 2. Quick Rail 信息气泡生命周期

将 popover 从按钮局部状态提升为模块级单例：

- `clearQuickRailPopover()` 负责清理当前 popover 和延迟 timer。
- `renderQuickRail()` 开头先调用 `clearQuickRailPopover()`，避免重渲染遗留。
- `attachHoverPreview()` 支持 `mouseenter`/`focus` 显示，`mouseleave`/`blur`/`click`/`pointerdown` 清理。
- 全局监听 `scroll`、`resize`、`blur`、`pointerdown`，当交互目标不在当前按钮内时清理。
- 移除 `btn.title`，避免浏览器原生 tooltip 与自定义 popover 叠加；保留 `aria-label`。
- `previewText()` 返回空字符串时不创建 popover。

验收：

- 快速扫过多个 Quick Rail 按钮时，页面里最多只有一个 `.qr-popover`。
- 点击任意 Quick Rail 按钮打开抽屉后，`.qr-popover` 数量为 0。
- 窗口失焦、滚动主内容、抽屉打开/关闭后，不存在残留气泡。

### 3. 新建与打开文件夹入口分离

扩展创建弹窗的来源模式：

```js
let createModalMode = "new"; // "new" | "init-folder" | "preview"

function openCreateModal(prefillPath, options = {}) {
  createModalMode = options.mode ?? (prefillPath ? "init-folder" : "new");
  renderCreateModalCopy();
  ...
}
```

不同模式对应文案：

- `new`：标题“开始一部新小说”，按钮“开始创作”。
- `init-folder`：标题“初始化此文件夹为小说”，按钮“初始化并打开”，状态提示包含所选路径。
- `preview`：标题“手动填写本地文件夹”，按钮“创建并打开”，状态提示说明当前环境不能打开系统文件选择器。

入口调用规则：

- `#new-novel` 和左侧“新对话/新建”入口调用 `openCreateModal(null, { mode: "new" })`。
- `openFromFolder()` 没有桌面选择器时调用 `openCreateModal(null, { mode: "preview" })`。
- `openProject()` 发现所选文件夹不是有效 WWriting 项目时调用 `openCreateModal(projectRoot, { mode: "init-folder" })`。
- `browseForCreatePath()` 只填入路径，不改变模式；用户仍能看出当前弹窗来源。

布局要求：

- `.rail` 保持 `grid-template-rows: auto auto auto minmax(0, 1fr) auto`。
- `.rail-new` 与 `.rail-foot` 使用稳定 padding 和 `z-index: 1`，只负责自身行，不浮动覆盖项目列表。
- `.rail-scroll` 只能在自己的 grid 行滚动，不能覆盖 foot。
- 点击验证读取 `#new-novel` 和 `#open-folder` 的 bounding rect，确保两者没有相交，且中心点命中对应按钮。

验收：

- 点击“新建小说”打开的是新建文案。
- 点击“打开本地文件夹”在预览环境打开的是手动路径文案。
- 选择非项目目录后打开的是“初始化此文件夹”文案，并预填路径。
- 在 Electron 1320x860 和小高度 1000x720 下，新建入口与打开文件夹入口不重叠，且都可被 trusted pointer click 触发。

## 测试矩阵

- `npm test`
- `npm run verify:app-shell`
- `npm run verify:app-clickability`
- `npm run verify:desktop-shell`

完成桌面交付前再运行：

- `npm run verify:local`

