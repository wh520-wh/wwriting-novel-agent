// tests/tool-labels.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { toolLabel, toolSourceChip, parseArgsSummary, READ_TOOLS } from "../src/app-shell/tool-labels.mjs";

test("parseArgsSummary：完整 JSON / 截断 JSON 抢救 / 非法输入", () => {
  assert.deepEqual(parseArgsSummary('{"chapter_no":3}'), { chapter_no: 3 });
  assert.deepEqual(parseArgsSummary({ chapter_no: 3 }), { chapter_no: 3 });
  const truncated = '{"chapter_no":7,"find":"' + "甲".repeat(300);
  assert.equal(parseArgsSummary(truncated).chapter_no, 7);
  const q = '{"query":"灯笼","other":"' + "x".repeat(300);
  assert.equal(parseArgsSummary(q).query, "灯笼");
  assert.equal(parseArgsSummary("not json at all"), null);
  assert.equal(parseArgsSummary(null), null);
});

test("17 个工具全部有非回退人话标签", () => {
  const cases = [
    ["get_status", "{}", /项目状态/],
    ["read_chapter", '{"chapter_no":3}', /第 3 章/],
    ["search_text", '{"query":"灯笼"}', /「灯笼」/],
    ["read_continuity", '{"entity":"刘康"}', /设定记忆.*刘康/],
    ["read_outline", "{}", /大纲/],
    ["read_blueprint", "{}", /读取蓝图/],
    ["read_blueprint", '{"section":"setting"}', /读取蓝图.*设定/],
    ["update_blueprint", "{}", /更新蓝图/],
    ["update_blueprint", '{"mode":"check_segment","chapterNo":3}', /骨架打勾.*3/],
    ["get_cost", "{}", /成本/],
    ["edit_chapter", '{"chapter_no":2}', /修改第 2 章/],
    ["rewrite_chapter", '{"chapter_no":4}', /重写第 4 章/],
    ["update_continuity", '{"entity":"刘康"}', /设定记忆.*刘康/],
    ["update_outline", "{}", /写作计划/],
    ["queue_chapters", "{}", /写作指令|写作任务/],
    ["update_settings", "{}", /项目设置/],
    ["export_book", '{"format":"txt"}', /导出成书.*txt/],
    ["archive_project", '{"archived":true}', /归档项目/],
    ["archive_project", '{"archived":"false"}', /解除归档/],
    ["start_run", "{}", /启动写作/],
    ["pause_run", "{}", /暂停写作/],
    ["resolve_failure", '{"command":"pause-here"}', /处理故障/]
  ];
  for (const [tool, args, re] of cases) {
    assert.match(toolLabel(tool, args), re, tool);
  }
});

test("未知工具回退「工具 name」", () => {
  assert.equal(toolLabel("mystery_tool", "{}"), "工具 mystery_tool");
});

test("args 缺失时降级仍可读", () => {
  assert.equal(toolLabel("read_chapter", null), "读取了章节");
  assert.equal(toolLabel("edit_chapter", null), "修改章节");
});

test("toolSourceChip：read 工具映射溯源 chip，read_chapter 带 chapterNo", () => {
  assert.deepEqual(toolSourceChip("read_chapter", '{"chapter_no":3}'), { label: "第 3 章", chapterNo: 3 });
  assert.deepEqual(toolSourceChip("read_chapter", null), { label: "章节", chapterNo: null });
  assert.deepEqual(toolSourceChip("read_continuity", "{}"), { label: "设定记忆", chapterNo: null });
  assert.deepEqual(toolSourceChip("read_outline", "{}"), { label: "大纲", chapterNo: null });
  assert.deepEqual(toolSourceChip("search_text", "{}"), { label: "全文搜索", chapterNo: null });
  assert.deepEqual(toolSourceChip("get_status", "{}"), { label: "项目状态", chapterNo: null });
  assert.deepEqual(toolSourceChip("get_cost", "{}"), { label: "成本台账", chapterNo: null });
  assert.equal(toolSourceChip("edit_chapter", "{}"), null, "write 工具不是溯源来源");
});

test("READ_TOOLS 集合与 6 个读工具一致", () => {
  assert.deepEqual([...READ_TOOLS].sort(), ["get_cost", "get_status", "read_chapter", "read_continuity", "read_outline", "search_text"]);
});