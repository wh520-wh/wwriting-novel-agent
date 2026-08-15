// src/app-shell/components/task-icons.mjs —— AICSS task-list：任务三态图标单源。
// plan-panel.js（顶栏 chip 下拉）与 agent/view.js（工作组计划子项）共用同一组
// 状态图标，保证「同一概念一处定义」。返回 HTML 字符串（两处渲染均走 innerHTML，
// 与既有测试桩的 innerHTML 属性兼容）。
const ICON_SVG = {
  completed:
    '<svg viewBox="0 0 24 24" width="{s}" height="{s}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>',
  in_progress:
    '<svg viewBox="0 0 24 24" width="{s}" height="{s}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12.75 15 3-3m0 0-3-3m3 3h-7.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>',
  pending:
    '<svg viewBox="0 0 24 24" width="{s}" height="{s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="1.8 3.6"/></svg>'
};

export function taskIcon(status, size = 14) {
  const svg = ICON_SVG[status] ?? ICON_SVG.pending;
  return svg.replaceAll("{s}", String(size));
}
