export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined));
}

export function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value ?? 0));
}

// Task 21/25（spec 4.3 #4）：成本统一人民币「元」、两位小数的唯一出口（N.NN 元）。
// 总成本/章节成本/缓存节省全部经此格式化，任何路径不得再直接拼 $ / ¥ /
// 或缺两位小数。非有限值（NaN / ±Infinity，上游脏数据）按 0.00 元兜底，
// 不把 "NaN 元" 泄漏给用户；负数保留符号原样展示（成本语义上不应为负，
// 保留符号便于发现数据异常，不做静默取绝对值）。
export function formatYuan(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00 元";
  return `${n.toFixed(2)} 元`;
}

export function pathEquals(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

export function pathBaseName(value) {
  return String(value ?? "").replace(/[\\/]+$/u, "").split(/[\\/]/u).pop();
}

export function ensureTrailingSlash(value) {
  return String(value).endsWith("/") ? String(value) : `${value}/`;
}

export function isEnvironmentVariableName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

export function translateStage(stage) {
  return {
    "-": "-",
    idle: "空闲",
    queued: "排队",
    planned: "已规划",
    planning: "规划",
    drafting: "起草",
    reviewing: "审稿",
    revising: "修订",
    needs_revision: "需修订",
    finalizing: "定稿",
    summarizing: "摘要",
    completed: "已定稿",
    blocked: "阻塞",
    post_process: "后处理",
    user_input: "用户输入",
    run: "运行"
  }[stage] ?? stage;
}

export function translateSourceKind(kind) {
  return { search: "搜索", fetch: "抓取", page: "网页", source: "资料" }[kind] ?? "资料";
}
