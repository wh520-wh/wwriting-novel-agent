// src/app-shell/tool-labels.mjs
// 19 个 chat 工具 + 2 个章节写作工具 → 写作者语言。技术名/原始 JSON 由 thread-renderer 收进展开区。
// args 摘要可能是被截断 200 字符的 JSON 字符串：parseArgsSummary 先整体 parse，
// 失败再做关键字段抢救（chapter_no/chapterNo/query/entity），都失败返回 null（调用方降级）。

export const READ_TOOLS = new Set(["get_status", "read_chapter", "search_text", "read_continuity", "read_outline", "read_blueprint", "get_cost"]);

export function parseArgsSummary(argsSummary) {
  if (argsSummary == null) return null;
  if (typeof argsSummary === "object") return argsSummary;
  const text = String(argsSummary);
  try { return JSON.parse(text); } catch { /* 截断 JSON，下面抢救 */ }
  const out = {};
  const chapter = /"chapter_no"\s*:\s*(\d+)/.exec(text);
  if (chapter) out.chapter_no = Number(chapter[1]);
  const chapterCamel = /"chapterNo"\s*:\s*(\d+)/.exec(text);
  if (chapterCamel) out.chapterNo = Number(chapterCamel[1]);
  const query = /"query"\s*:\s*"([^"]*)"/.exec(text);
  if (query) out.query = query[1];
  const entity = /"entity"\s*:\s*"([^"]*)"/.exec(text);
  if (entity) out.entity = entity[1];
  return Object.keys(out).length > 0 ? out : null;
}

const LABELS = {
  get_status: () => "查询了项目状态",
  read_chapter: (a) => (a?.chapter_no ? `读取了第 ${a.chapter_no} 章` : "读取了章节"),
  search_text: (a) => (a?.query ? `搜索「${a.query}」` : "搜索了全文"),
  read_continuity: (a) => (a?.entity ? `查阅了设定记忆 · ${a.entity}` : "查阅了设定记忆"),
  read_outline: () => "查阅了大纲与计划",
  // Task 5 新增蓝图工具（spec §1.6）：section 区分读哪份蓝图
  read_blueprint: (a) => {
    const section = a?.section;
    if (section === "outline") return "读取蓝图 · 总纲";
    if (section === "setting") return "读取蓝图 · 设定";
    return "读取蓝图";
  },
  update_blueprint: (a) => {
    if (a?.mode === "check_segment") {
      const no = a?.chapterNo ?? a?.chapter_no;
      return `蓝图骨架打勾（第 ${no ?? "?"} 章）`;
    }
    return "更新蓝图";
  },
  list_chapters: () => "列出章节",
  get_cost: () => "查询了成本台账",
  edit_chapter: (a) => (a?.chapter_no ? `修改第 ${a.chapter_no} 章` : "修改章节"),
  rewrite_chapter: (a) => (a?.chapter_no ? `重写第 ${a.chapter_no} 章` : "重写章节"),
  append_chapter_segment: () => "写入章节内容",
  update_continuity: (a) => (a?.entity ? `更新设定记忆 · ${a.entity}` : "更新设定记忆"),
  update_outline: () => "更新写作计划",
  queue_chapters: () => "排队写作指令",
  update_settings: () => "更新项目设置",
  export_book: (a) => `导出成书（${a?.format ?? "md"}）`,
  archive_project: (a) => (a?.archived === false || a?.archived === "false" ? "解除归档" : "归档项目"),
  start_run: () => "启动写作任务",
  pause_run: () => "暂停写作任务",
  resolve_failure: (a) => (a?.command ? `处理故障（${a.command}）` : "处理故障"),
  // Task 9: shell 工具（确认卡标题 / 活动流兜底）。命令文本由确认卡元信息区展示，标题保持简洁。
  shell: () => "运行命令"
};

export function toolLabel(tool, argsSummary) {
  const fn = LABELS[tool];
  if (!fn) return `工具 ${tool}`;
  return fn(parseArgsSummary(argsSummary));
}

const SOURCE_LABELS = {
  read_chapter: (a) => ({ label: a?.chapter_no ? `第 ${a.chapter_no} 章` : "章节", chapterNo: a?.chapter_no ?? null }),
  read_continuity: () => ({ label: "设定记忆", chapterNo: null }),
  read_outline: () => ({ label: "大纲", chapterNo: null }),
  search_text: () => ({ label: "全文搜索", chapterNo: null }),
  get_status: () => ({ label: "项目状态", chapterNo: null }),
  get_cost: () => ({ label: "成本台账", chapterNo: null }),
  // 蓝图读取也进依据 chips（spec §1.6 新增读工具，kind: read）
  read_blueprint: (a) => {
    const section = a?.section;
    if (section === "outline") return { label: "蓝图 · 总纲", chapterNo: null };
    if (section === "setting") return { label: "蓝图 · 设定", chapterNo: null };
    return { label: "蓝图", chapterNo: null };
  }
};

export function toolSourceChip(tool, argsSummary) {
  const fn = SOURCE_LABELS[tool];
  if (!fn) return null;
  return fn(parseArgsSummary(argsSummary));
}