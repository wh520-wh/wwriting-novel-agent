export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined));
}

export function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value ?? 0));
}

export function formatCompact(value) {
  const number = Number(value ?? 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 10_000) return `${(number / 10_000).toFixed(1)}万`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return formatNumber(number);
}

export function formatMoney(value) {
  return `$${Number(value ?? 0).toFixed(6)}`;
}

export function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export function statusClass(value) {
  return String(value ?? "idle").replace(/[^a-z0-9_-]/giu, "-");
}

export function pathEquals(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

export function pathBaseName(value) {
  return String(value ?? "").replace(/[\\/]+$/u, "").split(/[\\/]/u).pop();
}

export function resolveModelEndpoint(baseUrl) {
  try {
    return new URL("chat/completions", ensureTrailingSlash(baseUrl)).toString();
  } catch {
    return `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  }
}

export function ensureTrailingSlash(value) {
  return String(value).endsWith("/") ? String(value) : `${value}/`;
}

export function isEnvironmentVariableName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

export function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/gu, (char) => `\\${char.codePointAt(0).toString(16)} `);
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

export function translateReviewStatus(status) {
  return { passed: "通过", failed: "失败" }[status] ?? status ?? "未运行";
}

export function translateSkillType(type) {
  return { style: "风格", "flow-control": "流程", "quality-gate": "质检", "post-process": "后处理" }[type] ?? type;
}

export function translateSourceKind(kind) {
  return { search: "搜索", fetch: "抓取", page: "网页", source: "资料" }[kind] ?? "资料";
}

export function translateEventType(type) {
  return {
    project_created: "项目创建",
    project_run_started: "运行开始",
    project_run_finished: "运行结束",
    project_run_failed: "运行失败",
    project_run_skipped: "运行跳过",
    project_started: "开始运行",
    project_completed: "项目完成",
    project_blocked: "项目阻塞",
    checkpoint_written: "检查点",
    model_call_started: "模型调用开始",
    model_call_completed: "模型调用完成",
    model_usage_recorded: "用量记录",
    cache_report_updated: "缓存更新",
    chapter_queued: "章节排队",
    stage_started: "阶段开始",
    chapter_finalized: "章节定稿",
    chapter_completed: "章节完成",
    quality_gate_failed: "质检失败",
    tool_call_rejected: "工具调用拒绝",
    skill_configuration_changed: "技能配置",
    project_settings_updated: "设置更新",
    web_search_completed: "搜索完成",
    web_fetch_completed: "抓取完成",
    user_instruction_received: "用户指令"
  }[type] ?? type;
}
