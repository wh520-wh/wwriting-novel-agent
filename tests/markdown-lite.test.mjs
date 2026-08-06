// tests/markdown-lite.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown, escapeHtml, countProseWords, cleanAssistantContent } from "../src/app-shell/markdown-lite.mjs";

test("escapeHtml 转义五种字符", () => {
  assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});

test("countProseWords 去空白计数", () => {
  assert.equal(countProseWords("他走了。\n\n  她哭了。"), 8);
});

test("段落 + 粗体 + 行内代码（回归既有行为）", () => {
  assert.equal(
    renderMarkdown("第一段 **重点** 和 `代码`。\n\n第二段。"),
    "<p>第一段 <strong>重点</strong> 和 <code>代码</code>。</p><p>第二段。</p>"
  );
});

test("段内单换行渲染为 <br>", () => {
  assert.equal(renderMarkdown("行一\n行二"), "<p>行一<br>行二</p>");
});

test("## 与 ### 标题降级为 h4/h5", () => {
  assert.equal(renderMarkdown("## 大纲\n\n### 第一幕"), "<h4>大纲</h4><h5>第一幕</h5>");
});

test("无序列表", () => {
  assert.equal(renderMarkdown("- 甲\n- 乙"), "<ul><li>甲</li><li>乙</li></ul>");
});

test("有序列表（1. 与 1、 两种写法）", () => {
  assert.equal(renderMarkdown("1. 甲\n2. 乙"), "<ol><li>甲</li><li>乙</li></ol>");
  assert.equal(renderMarkdown("1、甲\n2、乙"), "<ol><li>甲</li><li>乙</li></ol>");
});

test("引用块", () => {
  assert.equal(renderMarkdown("> 引文一\n> 引文二"), "<blockquote>引文一<br>引文二</blockquote>");
});

test("分隔线", () => {
  assert.equal(renderMarkdown("上\n\n---\n\n下"), "<p>上</p><hr><p>下</p>");
});

test("普通围栏渲染为 pre/code 且内容已转义", () => {
  assert.equal(
    renderMarkdown("```\n<b>原样</b>\n```"),
    `<pre class="md-fence"><code>&lt;b&gt;原样&lt;/b&gt;</code></pre>`
  );
});

test("稿块：衬线容器 + peek + 字数标（稿 与 prose 别名等价）", () => {
  const expected = `<div class="manuscript-block peek"><p>夜雨敲窗。</p><p>他点了灯。</p><span class="manuscript-words">10 字</span></div>`;
  assert.equal(renderMarkdown("```稿\n夜雨敲窗。\n\n他点了灯。\n```"), expected);
  assert.equal(renderMarkdown("```prose\n夜雨敲窗。\n\n他点了灯。\n```"), expected);
});

test("未闭合围栏按纯文本段落回退，不抛错", () => {
  const html = renderMarkdown("```稿\n只有开头");
  assert.ok(html.startsWith("<p>"), html);
  assert.ok(html.includes("只有开头"));
  assert.ok(!html.includes("manuscript-block"));
});

test("注入文本始终被转义（含稿块内）", () => {
  const html = renderMarkdown("```稿\n<script>alert(1)</script>\n```");
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("cleanAssistantContent removes leaked XML tool-call protocol but keeps prose", () => {
  const content = [
    "我会先安排第一章。",
    "<tool_call>",
    '{"tool_calls":[{"tool":"start_writing","args":{"instruction":"开始写第1章"}}]}',
    "</tool_call>"
  ].join("\n");
  assert.equal(cleanAssistantContent(content), "我会先安排第一章。");
});

test("混合文档整体顺序正确", () => {
  const html = renderMarkdown("说明文字。\n\n```稿\n正文段。\n```\n\n- 要点");
  const iText = html.indexOf("<p>说明文字。</p>");
  const iMs = html.indexOf("manuscript-block");
  const iUl = html.indexOf("<ul>");
  assert.ok(iText >= 0 && iMs > iText && iUl > iMs, html);
});
