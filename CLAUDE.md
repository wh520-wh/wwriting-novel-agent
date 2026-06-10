# WWriting Claude 记忆

## 高频回归：按钮看得到但点不动

这个项目反复出现过“设置”“新建小说”等按钮无法点击的问题。不要把它当成单个按钮漏绑事件处理；先按模块启动和点击命中链路排查。

已确认过的根因类型：

- 前端模块没有执行：`app.js` 的 ESM 依赖加载失败会导致动态导航不渲染、事件监听不绑定。典型案例是 `components/failure-card.js` import `../../shared/failure-commands.mjs`，但静态服务器没有服务 `/shared/*.mjs`。
- 静态资源 MIME 错误：`.mjs` 必须以 `text/javascript` 返回，否则浏览器/Electron 会拒绝模块。
- 原生标题栏或拖拽区域覆盖：`titleBarOverlay`、整块 `.topbar`/`.rail-top` 的 drag region 会吃掉点击。
- 浮层拦截：toast、scrim、隐藏 modal 如果保留 `pointer-events: auto`，会挡住后面的按钮。
- 测试选择器漂移：UI 改版后不要只改测试绕开问题；真实可见按钮必须能收到 trusted pointer click，并产生预期 UI 状态。

修 UI、Electron、静态服务、打包配置后，必须至少跑：

```powershell
npm run verify:app-clickability
npm run verify:app-shell
npm run verify:desktop-shell
```

准备交付给桌面快捷方式使用前，必须跑：

```powershell
npm run verify:local
```

`verify:app-clickability` 是关键防线：它会启动真实 Electron 窗口，逐个点击刷新、隐私、左侧导航、新建小说、创建弹窗、设置弹窗、API Key 控件、联网开关、章节抽屉、阅读器、资料按钮、命令栏等路径。不要用“代码看起来绑了事件”替代这项验证。

桌面快捷方式通常指向：

```text
D:\WWriting\dist-desktop\win-unpacked\WWriting Novel Agent.exe
```

源码修复后如果没有重新打包，桌面快捷方式打开的仍可能是旧 exe。
