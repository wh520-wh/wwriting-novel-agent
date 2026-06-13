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

function splitParagraphs(text) {
  return String(text ?? "").split(/\n{2,}/u).map((p) => p.trim()).filter(Boolean);
}

/**
 * Paragraph-level LCS diff. Same row shape as diffLines.
 */
export function diffParagraphs(before, after) {
  const a = splitParagraphs(before);
  const b = splitParagraphs(after);
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

export function summarizeDiff(rows) {
  let del = 0, add = 0, addedChars = 0, removedChars = 0;
  for (const row of rows ?? []) {
    if (row.type === "del") { del += 1; removedChars += row.text.replace(/\s+/gu, "").length; }
    if (row.type === "add") { add += 1; addedChars += row.text.replace(/\s+/gu, "").length; }
  }
  return { changedParagraphs: Math.max(del, add), addedChars, removedChars };
}

/**
 * 段落对照视图：摘要行 + 删红/增绿段（衬线、peek）+ 未变段折叠。
 */
export function renderParagraphDiff(before, after) {
  const rows = diffParagraphs(before, after);
  const stats = summarizeDiff(rows);
  const wrap = document.createElement("div");
  wrap.className = "para-diff";
  const summary = document.createElement("div");
  summary.className = "para-diff-summary";
  summary.textContent = `改动 ${stats.changedParagraphs} 段 · −${stats.removedChars} 字 / +${stats.addedChars} 字`;
  wrap.append(summary);
  let keepCount = 0;
  const flushKeep = () => {
    if (keepCount === 0) return;
    const fold = document.createElement("div");
    fold.className = "para-diff-fold";
    fold.textContent = `…未改动的 ${keepCount} 段…`;
    wrap.append(fold);
    keepCount = 0;
  };
  for (const row of rows) {
    if (row.type === "keep") { keepCount += 1; continue; }
    flushKeep();
    const p = document.createElement("div");
    p.className = `para-diff-para para-diff-${row.type} peek`;
    p.textContent = row.text;
    wrap.append(p);
  }
  flushKeep();
  return wrap;
}
