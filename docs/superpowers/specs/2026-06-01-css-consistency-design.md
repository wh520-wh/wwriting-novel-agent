# CSS 一致性微调设计规格

## 背景

`src/app-shell/styles.css` 定义了 4 个圆角变量和多种 transition timing，但实际使用中存在硬编码值和时长不统一的问题。本次优化目标是纯值替换，零行为变更。

## 目标

- border-radius 硬编码 `8px` 替换为 `var(--r-sm)`
- 修复 `failure-card` 的 `var(--r, 12px)` 语法错误
- transition timing 归并为 3 个标准档位

## 非目标

- 不改变视觉效果（除 failure-card 圆角从 12px fallback 改为 11px）
- 不改动 HTML 或 JS
- 不引入新依赖或新 CSS 变量
- 不改变动画关键帧时长

## 设计

### A. border-radius 变量化

**规则：**

| 硬编码值 | 替换为 | 原因 |
|---------|--------|------|
| `8px` | `var(--r-sm)` | 精确匹配 `--r-sm: 8px` |
| `7px` | 保持原值 | 与 `--r-sm` 差 1px，强行统一会改变视觉 |
| `9px` | 保持原值 | 与 `--r-sm` 差 1px |
| `10px` | 保持原值 | 与 `--r: 11px` 差 1px |
| `99px` | 保持原值 | 完全圆角，语义不同 |

**failure-card 修复：**

```css
/* 修复前 */
border-radius: var(--r, 12px);

/* 修复后 */
border-radius: var(--r);
```

`--r` 已定义为 `11px`，fallback `12px` 永远不会生效，属于语法噪音。

### B. transition timing 归一化

**标准档位：**

| 档位 | 时长 | 用途 |
|------|------|------|
| 快 | `.12s` | hover 背景/颜色/微交互 |
| 中 | `.2s` | 状态切换/focus/border |
| 慢 | 保持原值 | 动画关键帧（不改） |

**替换规则：**

| 原值 | 替换为 | 差值 |
|------|--------|------|
| `.13s` | `.12s` | 1ms |
| `.14s` | `.2s` | 60ms |
| `.15s` | `.2s` | 50ms |
| `.16s` | `.2s` | 40ms |
| `.18s` | `.2s` | 20ms |

**不改的值：**

- `.08s` — `:active` 压感，刻意要快
- `.2s` — 已经是标准档位
- `.22s`、`.24s`、`.26s`、`.28s`、`.32s` — 动画关键帧时长，不是 transition

## 验收

- `npm run verify:app-shell` PASS
- `npm run verify:app-clickability` PASS
- 视觉对比：除 failure-card 圆角从 12px 改为 11px 外，无可见差异
