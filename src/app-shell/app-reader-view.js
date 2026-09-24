// src/app-shell/app-reader-view.js —— 阅读器展示层（第二十轮审计 Task 20 从
// app.js 下沉，为 50 KiB 字节红线腾出余量）。
//
// 单一职责：阅读器的**展示投影**——字号四档与 localStorage 持久化、正文段落
// 渲染（加载中/正文/空章/失败）、章节导航启停与相邻章计算。纯 DOM 读写，不发
// 请求、不持项目作用域、不碰事件绑定。
//
// 调用边界（app.js 组合根在 bootApp 内构造一次）：
//   const readerView = createReaderView({
//     refs: readerRefs,                                 // 既有四桶 refs 的 reader 桶
//     getChapterNo: () => readerChapterNo,              // 读 app.js 的当前章状态
//     getChapters: () => lastDashboard?.chapters        // 读 app.js 的 dashboard 快照
//   });
// 返回面只有 renderLoading / renderChapter / renderError / applyFont / nudgeFont /
// updateNav / adjacentChapterNo 七个方法：openReader 仍留在 app.js 并独占「捕获
// scope token → await → 校验 scope/chapterNo」的防竞态守卫（静态契约见
// tests/app-shell/app-shell-project-switch.test.mjs:343），本模块只在守卫通过后
// 被调用来写 DOM；openAdjacentChapter 也只借本模块算出相邻章号，实际跳转回
// app.js 的 openReader。
//
// 状态所有权：fontIndex 是本模块私有状态（唯一真源仍是 localStorage）；章节号与
// dashboard 由 app.js 持有，本模块只经 getter 读取——避免复制状态。
import { formatNumber, translateStage } from "./utils.js";

const STORAGE_KEY = "ww:reader:fontsize";

// 阅读器字号四档（行高随档位），持久化 localStorage。
// Round10：默认档 = 17px/1.95（正文神圣基线），全档整数像素（去掉 15.5px 非整档）。
const READER_FONT_STEPS = [
  { size: 14, lh: 1.9 },
  { size: 17, lh: 1.95 },
  { size: 19, lh: 2.0 },
  { size: 21, lh: 2.0 }
];

function emptyNode(text) {
  return Object.assign(document.createElement("p"), { className: "reader-empty", textContent: text });
}

export function createReaderView({ refs, getChapterNo, getChapters }) {
  let fontIndex = 1;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    // 首次使用无存储值（null）：保持默认档，不能 Number(null)→0 落到最小档。
    if (stored != null) {
      const value = Number(stored);
      if (Number.isInteger(value) && value >= 0 && value < READER_FONT_STEPS.length) fontIndex = value;
    }
  } catch { /* localStorage 不可用则用默认档 */ }

  function applyFont() {
    const step = READER_FONT_STEPS[fontIndex];
    refs.readerBody.style.fontSize = `${step.size}px`;
    refs.readerBody.style.lineHeight = String(step.lh);
    refs.readerFontMinus.disabled = fontIndex === 0;
    refs.readerFontPlus.disabled = fontIndex === READER_FONT_STEPS.length - 1;
  }

  function nudgeFont(delta) {
    fontIndex = Math.max(0, Math.min(READER_FONT_STEPS.length - 1, fontIndex + delta));
    try { window.localStorage.setItem(STORAGE_KEY, String(fontIndex)); } catch { /* 忽略 */ }
    applyFont();
  }

  function readableChapters() {
    return [...(getChapters() ?? [])]
      .filter((c) => Number(c.actual_words ?? 0) > 0)
      .sort((a, b) => a.chapter_no - b.chapter_no);
  }

  function updateNav() {
    const list = readableChapters();
    const idx = list.findIndex((c) => c.chapter_no === getChapterNo());
    refs.readerPrev.disabled = idx <= 0;
    refs.readerNext.disabled = idx < 0 || idx >= list.length - 1;
  }

  function adjacentChapterNo(delta) {
    const list = readableChapters();
    const idx = list.findIndex((c) => c.chapter_no === getChapterNo());
    const next = list[idx + delta];
    return next ? next.chapter_no : null;
  }

  // 打开/切章瞬间的占位态：标题 + 元信息 + 正文占位（字号与导航复位由调用方在
  // openOverlay 之后按原顺序调 applyFont / updateNav，保持既有 DOM 写序不变）。
  function renderLoading(chapterNo) {
    refs.readerTitle.textContent = `第 ${chapterNo} 章`;
    refs.readerMeta.textContent = "正在读取本章正文...";
    refs.readerBody.replaceChildren(emptyNode("读取中..."));
  }

  function renderChapter(data, chapterNo) {
    refs.readerTitle.textContent = data.title ?? `第 ${chapterNo} 章`;
    refs.readerMeta.textContent = `${data.is_draft ? "草稿" : "正式章节"} · ${translateStage(data.status)} · ${formatNumber(data.actual_words)} 字`;
    const paragraphs = String(data.content ?? "").split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean);
    if (paragraphs.length === 0) {
      refs.readerBody.replaceChildren(emptyNode("本章正文为空。"));
      return;
    }
    refs.readerBody.replaceChildren(...paragraphs.map((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      return p;
    }));
    refs.readerBody.scrollTop = 0;
  }

  function renderError(message) {
    refs.readerBody.replaceChildren(emptyNode(message));
    refs.readerMeta.textContent = "读取失败";
  }

  return { renderLoading, renderChapter, renderError, applyFont, nudgeFont, updateNav, adjacentChapterNo };
}
