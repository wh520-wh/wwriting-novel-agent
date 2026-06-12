// src/app-shell/diff-view.js
// 行级 LCS diff（零依赖）。确认卡 preview 的呈现层——批准执行仍走 edit_chapter 原校验链。

/**
 * Compute a line-level LCS diff between two strings.
 * Returns an array of { type: "keep"|"del"|"add", text: string }.
 */
export function diffLines(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: "keep", text: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i += 1; }
    else { out.push({ type: "add", text: b[j] }); j += 1; }
  }
  while (i < m) { out.push({ type: "del", text: a[i] }); i += 1; }
  while (j < n) { out.push({ type: "add", text: b[j] }); j += 1; }
  return out;
}

/**
 * Render a line-level diff into a DOM element.
 * Returns a <div class="chat-diff"> with styled diff lines.
 */
export function renderDiff(before, after) {
  const wrap = document.createElement("div");
  wrap.className = "chat-diff";
  for (const row of diffLines(before, after)) {
    const line = document.createElement("div");
    line.className = `chat-diff-line chat-diff-${row.type}`;
    line.textContent = `${row.type === "del" ? "− " : row.type === "add" ? "+ " : "  "}${row.text}`;
    wrap.append(line);
  }
  return wrap;
}
