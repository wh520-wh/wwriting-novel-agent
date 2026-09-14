// src/app-shell/markdown-lite.mjs
// 安全 GFM 渲染（Task 8）：marked 单解析器路径。
// 安全顺序：自定义 renderer 拦截 html/链接/图片——
//   - <script> 显示为文本（html renderer 整体转义）；
//   - javascript:/data:/file: href 不出现（只放行显式 http:/https:）；
//   - 图片不发起远程加载（image renderer 只输出转义后的 alt 文本）。
// 链接交给系统默认浏览器：view.js 对 [data-external-link] 事件委托 + preventDefault，
// Electron 走 preload 的 openExternalUrl（main 二次校验），普通浏览器回退 window.open。
// 保留行为（不另走第二个 parser，全部落在 marked 单解析器内）：
//   - 稿/prose fenced block → manuscript-block block extension（round17 已随隐私
//     模式删除 peek class）；
//   - countProseWords() 字数标；cleanAssistantContent() 工具调用泄漏清洗。
// 流式未闭合 fence：稿块按纯文本段落回退（延续旧渲染器行为）；普通围栏按 GFM
// 语义渲染为进行中的代码块。

import { marked } from "marked";

// Round10：外部链接公共委托（原 view.js 内部实现上移，对话与抽屉共用）——
// 对 [data-external-link] preventDefault：Electron 走 preload 暴露的
// openExternalUrl（main 进程二次校验协议），普通浏览器开发模式回退
// window.open(url, "_blank", "noopener,noreferrer")。
export function bindExternalLinks(container) {
  container?.addEventListener?.("click", (event) => {
    const anchor = event.target?.closest?.("[data-external-link]");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (!href) return;
    const desktop = globalThis.wwritingDesktop;
    if (desktop?.openExternalUrl) {
      Promise.resolve(desktop.openExternalUrl(href)).catch(() => {});
      return;
    }
    globalThis.open?.(href, "_blank", "noopener,noreferrer");
  });
}

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
// ---------------------------------------------------------------------------
// AICSS inline-citations：正文 [^1] 脚注式引用 → 行内上标（数据后接搜索工具）。
// 以 marked 内联扩展注册：集成进 inline lexer 走查，代码围栏/行内代码由核心
// token 先消费，代码里的 [^1] 永远不会变成上标。
// ---------------------------------------------------------------------------
const citeRefExtension = {
  name: "citeRef",
  level: "inline",
  start(src) {
    return src.indexOf("[^");
  },
  tokenizer(src) {
    const match = /^\[\^(\d+)\]/u.exec(src);
    if (!match) return undefined;
    return { type: "citeRef", raw: match[0], text: match[1] };
  },
  renderer(token) {
    return `<sup class="agent-cite-mark" data-cite-n="${token.text}">${token.text}</sup>`;
  }
};
marked.use({ extensions: [citeRefExtension] });
// 保留旧渲染器的 pre.md-fence 结构（CSS 只认这个 class，fence 内容已转义）。
renderer.code = ({ text }) => `<pre class="md-fence"><code>${escapeHtml(text)}</code></pre>`;
// marked 18：`marked.parse` 里传 `extensions` 键会整体替换 `marked.use` 注册的扩展
// （连带内联 citeRef 一起清掉，[^1] 退化为纯文本），因此稿围栏的 block 扩展也必须
// 在 global `use` 里与 citeRef 同处注册，parse 不再传 `extensions`。
marked.use({ extensions: [{ name: "manuscriptFence", level: "block", start(src) { return src.indexOf("```"); }, tokenizer(src) { return manuscriptFenceToken(src); }, renderer: manuscriptFenceRender }] });

// ---------------------------------------------------------------------------
// 稿/prose fenced block（marked block extension，单解析器路径）
// ---------------------------------------------------------------------------
// tokenizer 在核心 fences 之前被调用：闭合围栏产出 manuscript token（渲染为
// 衬线文稿块 + 字数标）；未闭合（流式进行中）产出同样 type 但 closed=false
// 的 token，渲染为纯文本段落回退——旧渲染器对未闭合围栏的既有行为。

const PROSE_FENCE_RE = /^```(稿|prose)[ \t]*(?:\r?\n)/;
const FENCE_CLOSE_RE = /^```[ \t]*(?:\r?$)/;

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
  return `<div class="manuscript-block">${paras}<span class="manuscript-words">${countProseWords(token.body)} 字</span></div>`;
}

export function renderMarkdown(source, { refs = null } = {}) {
  // trimEnd：marked 输出末尾的换行会污染 textContent/innerHTML 的等值断言
  // （旧渲染器无尾随换行），真实 DOM 中尾随空白也不可见。
  const html = marked.parse(String(source ?? ""), {
    gfm: true,
    breaks: true,
    renderer
  });
  const wrapped = html.replace(/<table>([\s\S]*?)<\/table>/gu, '<div class="agent-markdown-table-scroll"><table>$1</table></div>');
  const list = Array.isArray(refs) ? refs : [];
  if (list.length === 0) return wrapped.trimEnd();
  // AICSS：有来源数据时——上标升级为可点链接（沿用安全规则与 data-external-link
  // 委托），消息末尾追加紧凑来源条；非法来源（无 http/https 或无编号）跳过。
  const withLinks = list.reduce((acc, ref) => {
    const n = String(ref?.n ?? "");
    const safe = safeHttpUrl(ref?.url);
    if (!safe || n === "") return acc;
    const label = escapeHtml(String(ref?.title ?? ref?.host ?? ""));
    // needle/linked 均对 n 转义：渲染器输出侧 data-cite-n 来自 tokenizer 的 \d+
    // 捕获恒为数字，escapeHtml 对数字无影响，故匹配不受影响；非数字 n 的 needle
    // 不会命中任何上标（期望的防御行为），且 n 无法注入 HTML。
    const needle = `<sup class="agent-cite-mark" data-cite-n="${escapeHtml(n)}">${escapeHtml(n)}</sup>`;
    const linked = `<sup class="agent-cite-mark" data-cite-n="${escapeHtml(n)}"><a href="${escapeAttr(safe)}" data-external-link title="${escapeAttr(label)}">${escapeHtml(n)}</a></sup>`;
    return acc.split(needle).join(linked);
  }, wrapped);
  const rows = list
    .map((ref) => {
      const n = String(ref?.n ?? "");
      const safe = safeHttpUrl(ref?.url);
      if (!safe || n === "") return "";
      const host = /^https?:\/\/([^/?#]+)/u.exec(String(ref?.url ?? ""))?.[1] ?? "";
      // n 来自来源数据（外部信任边界），与同行的 title/host 一致走 escapeHtml，
      // 防 `n` 注入闭合 span 的 HTML 注入。
      return `<a class="agent-cite-ref" href="${escapeAttr(safe)}" data-external-link><span class="agent-cite-n">${escapeHtml(n)}</span><span class="agent-cite-ref-label">${escapeHtml(String(ref?.title ?? ""))}</span><span class="agent-cite-sep">·</span><span class="agent-cite-ref-host">${escapeHtml(host)}</span></a>`;
    })
    .filter(Boolean)
    .join("");
  const footer = rows === "" ? "" : `<div class="agent-cite-footer">${rows}</div>`;
  return `${withLinks}${footer}`.trimEnd();
}
