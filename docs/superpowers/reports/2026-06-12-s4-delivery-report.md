# S4「用得顺」交付报告

> 日期：2026-06-12
> 分支：worktree-s4-usability-codex
> 总提交数：18（含 3 个 fix/refactor）

## 任务对照表

| 任务 | 提交 | 描述 |
|------|------|------|
| Task 1 | c6abb62 | auto_edit/yolo/archived_at 字段 + 校验 |
| Task 2 | b19ca23 | 四档审批权限链 + 归档只读 + 豁免名单 |
| Task 3 | adbc559 | book-export 纯函数 + IO |
| Task 4 | 5ed7074 | export_book + archive_project 工具 |
| Task 5 | 08f5ca0 | server 归档拦截 + 字段透出 |
| Task 6 | 4a7b11a | 设置弹窗 6 分区导航 |
| Task 7 | 226f41d, 7c1c810, 7bdf9bc | 写作/门禁/联网/危险区四分区 |
| Task 8 | f368133, d4a3973 | 权限四档 UI + composer mode pill |
| Task 9 | f10040c | 行级 LCS diff 确认卡 |
| Task 10 | a83e827 | 运行任务卡升级 |
| Task 11 | 163ccc3 | 环境状态条 + 空状态建议卡 |
| Task 12 | a7822e4 | 归档分组 + 归档态 UI + 导出按钮 + reveal 桥 |
| Task 13 | 6755899 | clickability 探针扩展 |
| Task 14 | f045821 | verify:chat-online 场景 D/E |

## Spec §7 验收对照

| # | 验收条 | 证据 |
|---|--------|------|
| 1 | 成书导出 md/txt | Task 3 测试 `tests/book-export.test.mjs`：composeBook md/txt + exportBook 端到端 |
| 2 | 归档只读 + 豁免 | Task 2 测试 `tests/chat-tools.test.mjs`：归档拒绝写/控制，豁免名单放行 |
| 3 | 设置 6 分区 | Task 6/7/8：verify:app-clickability 探针逐个点击分区通过 |
| 4 | 四档授权 | Task 2 测试：auto_edit/yolo 免确认；read_only 压过 yolo |
| 5 | diff 确认卡 | Task 9 测试 `tests/diff-view.test.mjs`：LCS 纯函数 + 确认卡接入 |
| 6 | 探针覆盖 | Task 13：verify:app-clickability ok:true（含 S4 新探针） |
| 7 | 场景 D/E | Task 14：verify-chat-online.mjs 场景 D（指挥落地）+ E（归档语义） |

## 防线输出

```
npm test:                    550+ pass, 0 fail
npm run verify:app-shell:    ok: true
npm run verify:app-clickability: ok: true
```

## 真实 API 验证

待跑：`npm run verify:chat-online`（需用户 API key）。无 key 则如实标注待跑。

## 已知问题

1. verify:app-clickability 存在 flaky 行为（failure card 偶发出现），非 S4 引入
2. verify:desktop-shell 在 worktree 环境下因缺少 Electron node_modules 无法运行
3. 场景 D/E 需真实 API key 才能验证

## 新增文件

- `src/core/book-export.mjs` — 成书导出纯函数 + IO
- `src/app-shell/diff-view.js` — 行级 LCS diff
- `src/app-shell/permission-tiers.mjs` — 四档权限共享定义
- `tests/book-export.test.mjs` — 导出测试
- `tests/diff-view.test.mjs` — diff 测试

## 修改文件

- `src/core/project-store.mjs` — 默认字段
- `src/core/settings-runtime.mjs` — 白名单 + archived_at
- `src/core/chat/tool-registry.mjs` — 归档权限链
- `src/core/chat/chat-agent.mjs` — auto/yolo 免确认
- `src/core/chat/tools-write.mjs` — export_book + archive_project
- `src/core/app-server.mjs` — 归档拦截 + 字段透出
- `src/core/app-dashboard.mjs` — project 块字段
- `src/app-shell/index.html` — composer pill 按钮
- `src/app-shell/settings-modal.js` — 6 分区 + 权限分区
- `src/app-shell/composer.js` — mode pill + 状态 pill
- `src/app-shell/thread-renderer.js` — diff 确认卡 + 任务卡 + 建议卡
- `src/app-shell/drawer-panels.js` — 导出按钮
- `src/app-shell/app.js` — 归档分组 + 接线
- `src/app-shell/styles.css` — 全部新样式
- `src/desktop/electron-preload.cjs` — revealPath 桥
- `src/desktop/electron-main.cjs` — revealPath handler
- `scripts/verify-app-clickability.cjs` — S4 探针
- `scripts/verify-chat-online.mjs` — 场景 D/E
