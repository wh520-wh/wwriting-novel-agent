// src/app-shell/markdown-lite.mjs
// 极简 markdown 渲染（零依赖纯函数）。安全顺序：先整体 escape，再做结构转换。
// 支持：段落、**粗体**、`行内代码`、##/### 标题（降级 h4/h5）、-/1. 列表、> 引用、
// --- 分隔线、``` 普通围栏、```稿（别名 prose）文稿块。不识别的结构按纯文本段落回退。
// 稿块带 peek class：隐私模式（[data-privacy="on"] .peek）必须能模糊对话里的正文。

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 仅用于 UI 字数标（与 core/word-count 的口径无需一致；这里是展示性计数）。
export function countProseWords(text) {
  return String(text ?? "").replace(/\s+/gu, "").length;
}

export function cleanAssistantContent(text) {
  let content = String(text ?? "");
  content = content.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/giu, "");
  content = content.replace(/<\/?tool_call\b[^>]*>/giu, "");
  content = content.replace(/```(?:json)?\s*([\s\S]*?)```/giu, (full, body) => {
    return /["']?tool_calls["']?\s*:/u.test(body) ? "" : full;
  });
  const trimmed = content.trim();
  if (/^\{[\s\S]*["']?tool_calls["']?\s*:/u.test(trimmed)) return "";
  return trimmed;
}

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

const ORDERED_RE = /^\d+(\.\s+|、\s*)/;
const BLOCK_BOUNDARY_RE = /^(```|---+\s*$|#{2,3}\s|[-*]\s|\d+(\.\s+|、\s*)|&gt;)/;

export function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        if (/^```\s*$/.test(lines[i])) { closed = true; i += 1; break; }
        buf.push(lines[i]);
        i += 1;
      }
      const body = buf.join("\n");
      if (!closed) {
        // 未闭合：连同围栏行按纯文本段落回退。
        const fallback = [line, ...buf].filter((l) => l.trim());
        out.push(`<p>${fallback.map(inline).join("<br>")}</p>`);
        continue;
      }
      if (lang === "稿" || lang === "prose") {
        const paras = body.split(/\n{2,}/u)
          .map((p) => p.trim()).filter(Boolean)
          .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
          .join("");
        out.push(`<div class="manuscript-block peek">${paras}<span class="manuscript-words">${countProseWords(body)} 字</span></div>`);
      } else {
        out.push(`<pre class="md-fence"><code>${body}</code></pre>`);
      }
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i += 1; continue; }
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      const tag = heading[1].length === 2 ? "h4" : "h5";
      out.push(`<${tag}>${inline(heading[2])}</${tag}>`);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (ORDERED_RE.test(line)) {
      const items = [];
      while (i < lines.length && ORDERED_RE.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(ORDERED_RE, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        buf.push(inline(lines[i].replace(/^&gt;\s?/, "")));
        i += 1;
      }
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !BLOCK_BOUNDARY_RE.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}
