// tests/markdown-lite.test.mjs
// 安全 GFM 渲染契约（Task 8）：marked 单解析器路径。
// 覆盖 GFM 特性（表格、task list、链接、删除线、嵌套列表、引用、标题、fenced
// code、流式未闭合 fence）与安全断言（<script> 显示为文本；javascript:/data:/file:
// href 不出现；图片不发起远程加载）。
// 保留行为：稿/prose fenced block（manuscript-block + peek + 字数标）、
// countProseWords()、cleanAssistantContent()。
import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown, escapeHtml, countProseWords, cleanAssistantContent } from "../src/app-shell/markdown-lite.mjs";

test("escapeHtml 转义五种字符", () => {
  assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});

test("countProseWords 去空白计数", () => {
  assert.equal(countProseWords("他走了。\n\n  她哭了。"), 8);
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

// ---------------------------------------------------------------------------
// GFM 特性
// ---------------------------------------------------------------------------

test("段落 + 粗体 + 行内代码", () => {
  assert.equal(
    renderMarkdown("第一段 **重点** 和 `代码`。\n\n第二段。"),
    "<p>第一段 <strong>重点</strong> 和 <code>代码</code>。</p>\n<p>第二段。</p>"
  );
});

test("段内单换行渲染为 <br>（breaks: true）", () => {
  assert.equal(renderMarkdown("行一\n行二"), "<p>行一<br>行二</p>");
});

test("标题 h1–h6 原样渲染（不再降级）", () => {
  assert.equal(renderMarkdown("# 标题一"), "<h1>标题一</h1>");
  assert.equal(renderMarkdown("## 大纲"), "<h2>大纲</h2>");
  assert.equal(renderMarkdown("### 第一幕"), "<h3>第一幕</h3>");
  assert.equal(renderMarkdown("#### 小节"), "<h4>小节</h4>");
  assert.equal(renderMarkdown("##### 细节"), "<h5>细节</h5>");
  assert.equal(renderMarkdown("###### 尾注"), "<h6>尾注</h6>");
});

test("分隔线", () => {
  assert.equal(renderMarkdown("上\n\n---\n\n下"), "<p>上</p>\n<hr>\n<p>下</p>");
});

test("无序列表", () => {
  assert.equal(renderMarkdown("- 甲\n- 乙"), "<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>");
});

test("有序列表（GFM 1. 写法）", () => {
  assert.equal(renderMarkdown("1. 甲\n2. 乙"), "<ol>\n<li>甲</li>\n<li>乙</li>\n</ol>");
});

test("非 GFM 中文序号 1、 不误判为列表（GFM 单一口径）", () => {
  const html = renderMarkdown("1、甲\n2、乙");
  assert.ok(!html.includes("<ol>"), html);
  assert.ok(html.includes("1、甲"), html);
});

test("嵌套列表", () => {
  const html = renderMarkdown("- 甲\n  - 乙\n- 丙");
  assert.ok(html.includes("<ul>"), html);
  assert.ok(html.includes("<li>甲<ul>"), html);
  assert.ok(html.includes("<li>乙</li>"), html);
});

test("引用块", () => {
  assert.equal(
    renderMarkdown("> 引文一\n> 引文二"),
    "<blockquote>\n<p>引文一<br>引文二</p>\n</blockquote>"
  );
});

test("删除线", () => {
  assert.ok(renderMarkdown("~~删除~~").includes("<del>删除</del>"), renderMarkdown("~~删除~~"));
});

test("GFM 表格产生 <table> 与 th/td", () => {
  const html = renderMarkdown("| 标题 | 值 |\n| --- | --- |\n| 甲 | 1 |");
  assert.ok(html.includes("<table>"), html);
  assert.ok(html.includes("<th>标题</th>"), html);
  assert.ok(html.includes("<td>甲</td>"), html);
});

test("GFM task list 渲染为只读 checkbox", () => {
  const html = renderMarkdown("- [x] 完成\n- [ ] 待办");
  assert.ok(html.includes('<input checked="" disabled="" type="checkbox">'), html);
  assert.ok(html.includes('<input disabled="" type="checkbox">'), html);
});

test("普通围栏渲染为 pre.md-fence/code 且内容已转义", () => {
  assert.equal(
    renderMarkdown("```\n<b>原样</b>\n```"),
    `<pre class="md-fence"><code>&lt;b&gt;原样&lt;/b&gt;</code></pre>`
  );
});

test("流式未闭合普通围栏：不抛错，按 GFM 渲染为进行中的代码块", () => {
  const html = renderMarkdown("```json\n{\"a\": 1}");
  assert.ok(html.startsWith("<pre class=\"md-fence\">"), html);
  assert.ok(html.includes("{&quot;a&quot;: 1}"), html);
});

// ---------------------------------------------------------------------------
// 保留行为：稿/prose fenced block（marked block extension，单解析器路径）
// ---------------------------------------------------------------------------

test("稿块：衬线容器 + peek + 字数标（稿 与 prose 别名等价）", () => {
  const expected = `<div class="manuscript-block peek"><p>夜雨敲窗。</p><p>他点了灯。</p><span class="manuscript-words">10 字</span></div>`;
  assert.equal(renderMarkdown("```稿\n夜雨敲窗。\n\n他点了灯。\n```"), expected);
  assert.equal(renderMarkdown("```prose\n夜雨敲窗。\n\n他点了灯。\n```"), expected);
});

test("流式未闭合稿围栏按纯文本段落回退，不抛错（延续旧渲染器行为）", () => {
  const html = renderMarkdown("```稿\n只有开头");
  assert.ok(html.startsWith("<p>"), html);
  assert.ok(html.includes("只有开头"));
  assert.ok(!html.includes("manuscript-block"));
});

test("混合文档整体顺序正确：说明 → 稿块 → 列表", () => {
  const html = renderMarkdown("说明文字。\n\n```稿\n正文段。\n```\n\n- 要点");
  const iText = html.indexOf("<p>说明文字。</p>");
  const iMs = html.indexOf("manuscript-block");
  const iUl = html.indexOf("<ul>");
  assert.ok(iText >= 0 && iMs > iText && iUl > iMs, html);
});

// ---------------------------------------------------------------------------
// 安全：<script> 显示为文本；危险协议 href 不出现；图片不发起远程加载
// ---------------------------------------------------------------------------

test("<script> 显示为文本（block 级与 inline 级）", () => {
  const block = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!block.includes("<script>"), block);
  assert.ok(block.includes("&lt;script&gt;"), block);
  const inline = renderMarkdown("before <script>x</script> after");
  assert.ok(!inline.includes("<script>"), inline);
  assert.ok(inline.includes("&lt;script&gt;"), inline);
});

test("稿块内的注入同样被转义", () => {
  const html = renderMarkdown("```稿\n<script>alert(1)</script>\n```");
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"), html);
});

test("javascript: href 不出现（链接退化为纯文本标签）", () => {
  const html = renderMarkdown("[点击](javascript:alert(1))");
  assert.ok(!html.includes("<a"), html);
  assert.ok(!html.includes("javascript:"), html);
  assert.ok(html.includes("点击"), html);
});

test("data: href 不出现", () => {
  const html = renderMarkdown("[x](data:text/html,x)");
  assert.ok(!html.includes("<a"), html);
  assert.ok(!html.includes("data:"), html);
});

test("file: href 不出现", () => {
  const html = renderMarkdown("[x](file:///C:/secret)");
  assert.ok(!html.includes("<a"), html);
  assert.ok(!html.includes("file:"), html);
});

test("相对链接不渲染为 <a>（仅显式 http/https 链接可点）", () => {
  const html = renderMarkdown("[x](../foo)");
  assert.ok(!html.includes("<a"), html);
});

test("安全 http/https 链接带 data-external-link 交给系统浏览器", () => {
  assert.equal(
    renderMarkdown("[文档](https://example.com/doc)"),
    `<p><a href="https://example.com/doc" data-external-link>文档</a></p>`
  );
});

test("裸 URL 自动链接同样走安全出口", () => {
  assert.ok(
    renderMarkdown("https://example.com/x").includes(
      `<a href="https://example.com/x" data-external-link>`
    ),
    renderMarkdown("https://example.com/x")
  );
});

test("链接文本中的 HTML 与图片均被中和", () => {
  const html = renderMarkdown("[<b>bold</b>](https://example.com)");
  assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"), html);
  assert.ok(!html.includes("<b>bold</b>"), html);
});

test("图片不发起远程加载：输出无 <img>，仅保留转义后的 alt 文本", () => {
  const html = renderMarkdown("![图](https://evil.example/x.png)");
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("图"), html);
});

test("链接内的图片同样不产生 <img>", () => {
  const html = renderMarkdown("[![图](https://evil.example/x.png)](https://ok.example)");
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes('<a href="https://ok.example" data-external-link>图</a>'), html);
});
