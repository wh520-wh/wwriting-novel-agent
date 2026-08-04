// Task 10：题材字段分化模板（spec §1.3/§1.4 + P2「题材字段分化完善」）。
// /init 时按用户说的题材命中模板，把题材专属字段清单作为必填字段注入 prompt：
// - outlineFields → OUTLINE.md 总纲区第 5 节起的「### N. 字段名」小节标题（N 从 5 起连续编号）；
// - settingFields → SETTING.md「三、题材专属设定」区的字段。
// 匹配不到题材时 pickTemplate 返回 undefined，走基础模板（不强制字段，
// 靠 prompt 里已有的"按题材自然分化"指令兜底）。
export const GENRE_TEMPLATES = {
  玄幻: {
    outlineFields: ["主角金手指", "能力体系", "修为阶层"],
    settingFields: ["力量体系", "境界划分"]
  },
  爱情: {
    outlineFields: ["情感基调", "CP设计"],
    settingFields: ["情感设定", "人物关系网"]
  },
  都市: {
    outlineFields: ["社会背景", "行业设定"],
    settingFields: ["现实参照"]
  },
  悬疑: {
    outlineFields: ["核心谜题", "悬念钩子"],
    settingFields: ["线索与伏笔", "疑点清单"]
  },
  科幻: {
    outlineFields: ["科技设定", "未来背景"],
    settingFields: ["技术体系", "社会形态"]
  }
};

// 关键词匹配：在用户题材描述里找题材关键词（includes 精确匹配，不猜测近义词）。
// - 迭代顺序即优先级：组合题材（如"都市异能玄幻"）取先命中的模板；
// - 「科幻」与「玄幻」互不为子串（"玄幻小说".includes("科幻") === false），不会互误；
// - 无匹配返回 undefined（走基础模板）。
export function pickTemplate(genreHint) {
  const hint = String(genreHint ?? "").trim();
  if (!hint) return undefined;
  for (const genre of Object.keys(GENRE_TEMPLATES)) {
    if (hint.includes(genre)) return { genre, ...GENRE_TEMPLATES[genre] };
  }
  return undefined;
}
