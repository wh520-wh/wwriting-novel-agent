// 工具结果的「一行摘要」：从活动事件的数据里挤出用户与模型都用得上的那一句客观事实。
//
// 为什么单独成一个模块：这段逻辑有两个消费者，而且分属不同层——
//   - 终端渲染层（`renderer.mjs`）：把摘要画进活动行（`✓ 统计字数 第一章.md · 3210 字`）；
//   - Agent 历史投影（`history.mjs`）：把摘要写进回放给模型的对话上下文。
// agent 层不得反向依赖终端层（会让「会话与循环」绑上 stdout 概念），所以纯逻辑放在这里，
// 两侧都 import 它。**绝不允许各写一份** —— 项目里已经因为 `isInside` 逐字重复吃过一次亏。
//
// 认不出来就返回 null：宁可什么都不说，也不要编一个数字出来（铁律 3 与铁律 6 的交汇点）。

// 字节数 → 人读的大小。只用到 KB 一级：工具结果上千字节就足够说明问题了。
export function formatSize(chars) {
  if (!Number.isFinite(chars)) return null;
  if (chars < 1024) return `${chars} 字符`;
  const kb = chars / 1024;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

// 活动事件的数据 → 一行摘要，或 null。
//
// 输入的 data 形状由 agent 循环的 resultPreview 决定：
//   小的结果原样序列化进 `result`（JSON 字符串）；超过上限只带 `resultChars`（字符数）。
export function summarizeToolResult(data = {}) {
  if (typeof data.result === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(data.result);
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === 'object') {
      // 顺序有意为之：字数最有用（铁律 6 要按它决定接着写还是收尾），排在最前；
      // 但「有比字数更独特的事实的工具」先说那个事实。
      if (Array.isArray(parsed.plan)) return `计划 ${parsed.done ?? 0}/${parsed.total ?? '?'}`;
      if (Number.isFinite(parsed.charsNoSpace)) return `${parsed.charsNoSpace} 字`;
      if (typeof parsed.text === 'string') return `${parsed.text.split('\n').length} 行`;
      if (Array.isArray(parsed.matches)) return `${parsed.matches.length} 处`;
      if (Array.isArray(parsed.entries)) return `${parsed.entries.length} 项`;
      if (Number.isFinite(parsed.replacements)) return `${parsed.replacements} 处替换`;
    }
  }
  // 结果太大没带过来：给个量级，比什么都不说强。
  if (Number.isFinite(data.resultChars)) return `约 ${formatSize(data.resultChars)}`;
  return null;
}
