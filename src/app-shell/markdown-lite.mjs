// src/app-shell/markdown-lite.mjs
// 安全 GFM 渲染（Task 8）：marked 单解析器路径。
// 安全顺序：自定义 renderer 拦截 html/链接/图片——
//   - <script> 显示为文本（html renderer 整体转义）；
//   - javascript:/data:/file: href 不出现（只放行显式 http:/https:）；
//   - 图片不发起远程加载（image renderer 只输出转义后的 alt 文本）。
// 链接交给系统默认浏览器：view.js 对 [data-external-link] 事件委托 + preventDefault，
// Electron 走 preload 的 openExternalUrl（main 二次校验），普通浏览器回退 window.open。
// 保留行为（不另走第二个 parser，全部落在 marked 单解析器内）：
//   - 稿/prose fenced block → manuscript-block block extension（含 peek class，
//     隐私模式 [data-privacy="on"] .peek 必须能模糊对话里的正文）；
//   - countProseWords() 字数标；cleanAssistantContent() 工具调用泄漏清洗。
// 流式未闭合 fence：稿块按纯文本段落回退（延续旧渲染器行为）；普通围栏按 GFM
// 语义渲染为进行中的代码块。

import { marked } from "marked";

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 属性值转义与 escapeHtml 同一套（引号已覆盖）。
function escapeAttr(value) {
  return escapeHtml(value);
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

// 只放行显式 http:/https: 的绝对链接；相对链接、协议缺失、其他 scheme
// （javascript:/data:/file:/mailto: 等）一律不渲染为 <a>。
function safeHttpUrl(href) {
  const raw = String(href ?? "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (!scheme) return null;
  const protocol = scheme[1].toLowerCase();
  return protocol === "http" || protocol === "https" ? raw : null;
}

const renderer = new marked.Renderer();
renderer.html = ({ text }) => escapeHtml(text);
renderer.link = function ({ href, title, tokens }) {
  const safeHref = safeHttpUrl(href);
  const label = this.parser.parseInline(tokens);
  return safeHref ? `<a href="${escapeAttr(safeHref)}" data-external-link>${label}</a>` : label;
};
renderer.image = ({ text }) => escapeHtml(text);
// 保留旧渲染器的 pre.md-fence 结构（CSS 只认这个 class，fence 内容已转义）。
renderer.code = ({ text }) => `<pre class="md-fence"><code>${escapeHtml(text)}</code></pre>`;

// ---------------------------------------------------------------------------
// 稿/prose fenced block（marked block extension，单解析器路径）
// ---------------------------------------------------------------------------
// tokenizer 在核心 fences 之前被调用：闭合围栏产出 manuscript token（渲染为
// 衬线文稿块 + peek + 字数标）；未闭合（流式进行中）产出同样 type 但 closed=false
// 的 token，渲染为纯文本段落回退——旧渲染器对未闭合围栏的既有行为。

const PROSE_FENCE_RE = /^```(稿|prose)[ \t]*\n/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;

function manuscriptFenceToken(src) {
  const match = PROSE_FENCE_RE.exec(src);
  if (!match) return false;
  const afterOpen = src.slice(match[0].length);
  const lines = afterOpen.split("\n");
  const bodyLines = [];
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_CLOSE_RE.test(lines[i])) {
      end = i;
      break;
    }
    bodyLines.push(lines[i]);
  }
  const body = bodyLines.join("\n");
  const closed = end >= 0;
  // 闭合：raw 精确到闭合围栏行；未闭合：吞噬到文档末尾（流式期间不回退到核心 fences）。
  const raw = closed ? match[0] + body + "\n```\n" : src;
  return { type: "manuscriptFence", raw, body, closed };
}

function manuscriptFenceRender(token) {
  if (!token.closed) {
    // 流式未闭合：按纯文本段落回退（延续旧渲染器行为），内容转义。
    const lines = token.body.split("\n").filter((line) => line.trim());
    return `<p>${lines.map(escapeHtml).join("<br>")}</p>`;
  }
  const paras = token.body
    .split(/\n{2,}/u)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div class="manuscript-block peek">${paras}<span class="manuscript-words">${countProseWords(token.body)} 字</span></div>`;
}

export function renderMarkdown(source) {
  // trimEnd：marked 输出末尾的换行会污染 textContent/innerHTML 的等值断言
  // （旧渲染器无尾随换行），真实 DOM 中尾随空白也不可见。
  return marked.parse(String(source ?? ""), {
    gfm: true,
    breaks: true,
    renderer,
    extensions: {
      block: [manuscriptFenceToken],
      renderers: { manuscriptFence: manuscriptFenceRender }
    }
  }).trimEnd();
}
