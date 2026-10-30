// 全应用唯一图标表：24×24 网格、内容安全区 4–20、圆头圆角、单色 currentColor。
// 笔画按显示尺寸换算，保证 14–36px 的光学重量一致：小图标略粗、大图标略细。
// 视图文件只能从这里取图标：icon() 产出节点，iconMarkup()/taskIcon()/planGlyphMarkup()
// 产出字符串（供 innerHTML 模板使用），searchGlobeMarkup() 提供 web-search 的旋转地球。
export const ICON_PATHS = {
  compose: "M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V12 M17.2 3.9a1.9 1.9 0 0 1 2.7 2.7l-7.9 7.9-3.5.8.8-3.5z",
  search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M20 20l-4.2-4.2",
  skill: "M12 3.2l7.3 4.2v9.2L12 20.8l-7.3-4.2V7.4z M12 9v3.4 M12 12.4l-2.6 1.5 M12 12.4l2.6 1.5",
  check: "M5.5 12.5l4 4 9-9",
  help: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M9.6 9.4a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1.1 1-1.1 1.9 M12 17.2h.01",
  folder: "M3.5 7.5A1.5 1.5 0 0 1 5 6h3.8l2 2H19a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5z",
  book: "M4.5 5.6c2.7-.3 5.6.3 7.5 1.8 1.9-1.5 4.8-2.1 7.5-1.8v12.2c-2.7-.3-5.6.3-7.5 1.8-1.9-1.5-4.8-2.1-7.5-1.8z M12 7.4v12.2",
  coin: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z M8.8 8.4l3.2 3.7 3.2-3.7 M12 12.1v5.3",
  settings: "M4 7h6.2 M13.8 7H20 M4 12h3.2 M10.8 12H20 M4 17h8.2 M15.8 17H20 M12 5.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4 M9 10.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4 M14 15.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4",
  doc: "M7 3.5h6.5L18.5 8.5v12H7z M13.5 3.5v5h5",
  chevR: "M9.5 5.5L16 12l-6.5 6.5",
  arrowUp: "M12 19V5.5 M5.5 12L12 5.5 18.5 12",
  bolt: "M13.2 3.5L5 13.5h5.6L10.8 20.5 19 10.5h-5.6z",
  eye: "M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z",
  eyeOff: "M4 4l16 16 M10.6 6.1A9.7 9.7 0 0 1 12 6c5.8 0 9.2 6 9.2 6a15 15 0 0 1-3.4 4 M6.4 8.2A15.3 15.3 0 0 0 2.8 12S6.2 18 12 18c1.2 0 2.3-.3 3.3-.7 M9.9 9.9a3 3 0 0 0 4.2 4.2",
  copy: "M9.5 9h8A1.5 1.5 0 0 1 19 10.5v8A1.5 1.5 0 0 1 17.5 20h-8A1.5 1.5 0 0 1 8 18.5v-8A1.5 1.5 0 0 1 9.5 9z M6 15H5.5A1.5 1.5 0 0 1 4 13.5v-8A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V6",
  branch: "M6 3v12 M18 9a9 9 0 0 1-9 9 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  trash: "M4.5 7h15 M9.5 7V4.5h5V7 M6.8 7l.7 11.8A2 2 0 0 0 9.5 20.5h5A2 2 0 0 0 16.5 18.8L17.2 7 M10.2 10.8v6 M13.8 10.8v6",
  plus: "M12 5v14 M5 12h14",
  stop: "M8 6.5h8A1.5 1.5 0 0 1 17.5 8v8A1.5 1.5 0 0 1 16 17.5H8A1.5 1.5 0 0 1 6.5 16V8A1.5 1.5 0 0 1 8 6.5z",
  // D9（round22）：目录厂商只读连接行的锁标。
  lock: "M7.5 10.5h9A1.5 1.5 0 0 1 18 12v7A1.5 1.5 0 0 1 16.5 20.5h-9A1.5 1.5 0 0 1 6 19v-7a1.5 1.5 0 0 1 1.5-1.5z M9 10.5V8a3 3 0 0 1 6 0v2.5",
  // 2026-10-30：把原先散在 index.html 里的静态图标收进本表。
  refresh: "M20 12a8 8 0 1 1-2.4-5.7 M20 4.6V9h-4.4",
  menu: "M4 7h16 M4 12h16 M4 17h16",
  more: "M6 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2 M12 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2 M18 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2",
  x: "M6 6l12 12 M18 6L6 18",
  moon: "M20.5 13.5A8.5 8.5 0 0 1 10.5 3.5 8.5 8.5 0 1 0 20.5 13.5z"
};

// 任务三态（列表/计划共用）：勾、箭头、虚线圈。
const STATUS_PATHS = {
  completed: "M8.8 12.6L11 14.9 15.4 9.6 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  in_progress: "M12.6 15L15.6 12 12.6 9 M15.6 12H8.2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  pending: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z"
};

// 实心图标：不描边，直接填充（点阵类）。
const FILLED = new Set(["more"]);

// 24 网格上的笔画值；换算到屏幕上约 1.0–1.2px，避免 14px 太细、36px 太粗。
export function strokeWidthFor(size) {
  if (size <= 14) return 1.9;
  if (size <= 18) return 1.7;
  if (size <= 28) return 1.5;
  return 1.2;
}

function pathData(source) {
  return (source ?? "")
    .split(" M")
    .map((seg) => (seg.startsWith("M") ? seg : `M${seg}`.replace(/^MM/u, "M")))
    .filter(Boolean);
}

function pathMarkup(source) {
  return pathData(source).map((d) => `<path d="${d}"/>`).join("");
}

export function iconMarkup(name, size = 16, cls = "") {
  const filled = FILLED.has(name);
  return `<svg class="icon${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="${filled ? "currentColor" : "none"}" stroke="${filled ? "none" : "currentColor"}" stroke-width="${strokeWidthFor(size)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathMarkup(ICON_PATHS[name])}</svg>`;
}

export function icon(name, size = 16, cls, doc = globalThis.document) {
  const ns = "http://www.w3.org/2000/svg";
  if (typeof doc?.createElementNS !== "function") throw new TypeError("icon() requires a document with createElementNS().");
  const svg = doc.createElementNS(ns, "svg");
  const filled = FILLED.has(name);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", filled ? "currentColor" : "none");
  svg.setAttribute("stroke", filled ? "none" : "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidthFor(size)));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls ? `icon ${cls}` : "icon");
  for (const d of pathData(ICON_PATHS[name])) {
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// 把 index.html 里 <span data-icon="x" data-icon-size="18"> 占位换成真实 SVG，
// 保证静态界面与动态渲染共用同一份几何。
export function hydrateIcons(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  for (const slot of [...root.querySelectorAll("[data-icon]")]) {
    const name = slot.getAttribute("data-icon");
    if (!name) continue;
    const size = Number(slot.getAttribute("data-icon-size") ?? 16) || 16;
    const cls = slot.getAttribute("data-icon-class") ?? "";
    slot.replaceWith(icon(name, size, cls, slot.ownerDocument ?? globalThis.document));
  }
}

// 任务三态图标（HTML 字符串；plan-panel 与工作组共用）。
export function taskIcon(status, size = 14) {
  const source = STATUS_PATHS[status] ?? STATUS_PATHS.pending;
  const dash = status === "pending" ? ' stroke-dasharray="1.8 3.6"' : "";
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidthFor(size)}" stroke-linecap="round" stroke-linejoin="round"${dash} aria-hidden="true">${pathMarkup(source)}</svg>`;
}

// 计划 chip 头部三态图标。
export function planGlyphMarkup(name) {
  if (name === "list") {
    return `<svg class="plan-chip-list" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M9 6.5h11 M9 12h11 M9 17.5h11"/><circle cx="4.6" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="17.5" r="1.1" fill="currentColor" stroke="none"/></svg>`;
  }
  if (name === "check") {
    return `<svg class="plan-chip-check" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" fill="currentColor"/></svg>`;
  }
  return "";
}

// 进度环：弧长 = 2πr ≈ 66，按完成比例绘制；进度色由 CSS 决定。
export function planPieMarkup(pct) {
  return `<svg class="plan-chip-pie" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="2.2 4.4" stroke-linecap="round"/><circle class="plan-chip-pie-arc" cx="12" cy="12" r="10.5" fill="none" stroke-width="2.2" stroke-dasharray="${(pct / 100) * 66} 66" stroke-linecap="round" transform="rotate(-90 12 12)"/></svg>`;
}

// web-search 的旋转地球：12 网格内容统一 scale(2) 到 24 网格，描边仍为 1.7。
export function searchGlobeMarkup() {
  const values = [
    "M6.057 11.565 C2.081 11.565 0.371 8.159 0.371 5.964 C0.371 3.642 2.152 0.329 6.05 0.329",
    "M6.012 11.55 C4.575 10.496 3.333 8.116 3.321 5.964 C3.307 3.399 4.974 0.977 6.012 0.329",
    "M6.012 11.55 C7.211 10.781 8.715 8.287 8.715 5.964 C8.715 3.399 7.24 1.233 6.012 0.329",
    "M6.012 11.55 C9.677 11.55 11.65 8.487 11.65 5.964 C11.65 3.499 9.748 0.329 6.012 0.329",
    "M6.057 11.565 C2.081 11.565 0.371 8.159 0.371 5.964 C0.371 3.642 2.152 0.329 6.05 0.329"
  ].join(";");
  const begins = ["0s", "-1.2s", "-2.4s", "-3.6s", "-4.8s", "-6s"];
  const first = values.split(";")[0];
  const paths = begins.map((begin) =>
    `<path d="${first}" opacity="0"><animate attributeName="d" dur="7.2s" begin="${begin}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.25;0.5;0.75;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1" values="${values}"/><animate attributeName="opacity" dur="7.2s" begin="${begin}" repeatCount="indefinite" calcMode="linear" keyTimes="0;0.05;0.7;0.75;1" values="0;0.9;0.9;0;0"/></path>`
  ).join("");
  return `<svg class="agent-search-globe" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" style="overflow: visible" aria-hidden="true"><g transform="scale(2)"><circle cx="6" cy="6" r="5.7" opacity="0.9"/><line x1="0.3" y1="6" x2="11.7" y2="6" opacity="0.9"/>${paths}</g></svg>`;
}
