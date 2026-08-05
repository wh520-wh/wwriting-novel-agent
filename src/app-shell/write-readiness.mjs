/**
 * @param {object} input - Dashboard data object
 * @param {boolean} input.hasProject
 * @param {object|null} input.project
 * @param {object|null} input.model_profile
 * @param {object} input.summary
 * @param {object} input.state
 * @param {object} input.chatHistory
 * @param {Array} input.failures
 * @returns {{ key, label, detail, primaryAction, primaryLabel, chapterNo, modelLabel, blocking, reasonCode }}
 */
export function deriveWriteReadiness(input) {
  if (!input) {
    return readiness("no_project", {
      primaryAction: "create_project",
      primaryLabel: "新建小说"
    });
  }

  // 1. No project
  if (input.hasProject === false) {
    return readiness("no_project", {
      primaryAction: "create_project",
      primaryLabel: "新建小说"
    });
  }

  const project = input.project || {};
  const summary = input.summary || {};
  const state = input.state || {};
  const chatHistory = input.chatHistory || {};
  const modelProfile = input.model_profile;
  const failures = input.failures || [];

  const chapterNo = summary.currentChapterNo || state.current_chapter_no || 1;
  const modelLabel = modelProfile ? modelProfile.display || "" : "";

  // 2. Project archived or read-only
  if (project.archived_at || project.tool_permissions?.read_only) {
    return readiness("project_read_only", {
      chapterNo,
      modelLabel,
      primaryAction: "view_project_status"
    });
  }

  // 3. Running or chat busy
  if (summary.projectStatus === "running" || chatHistory.busy) {
    return readiness("running", {
      chapterNo,
      modelLabel,
      primaryAction: "view_progress"
    });
  }

  // 4. Blocked or unresolved failure
  if (summary.projectStatus === "blocked" || (failures.length > 0)) {
    return readiness("blocked", {
      chapterNo,
      modelLabel,
      primaryAction: "view_issue",
      blocking: true
    });
  }

  // 5. Completed (completedChapters >= targetChapters)
  if (summary.completedChapters >= summary.targetChapters) {
    return readiness("completed", {
      chapterNo,
      modelLabel,
      primaryAction: "increase_target"
    });
  }

  // 5.5 Blueprint not initialized (spec §1.4 门禁):先 /init 再写作。
  // 新项目 blueprint_status 为 none/partial 时所有写作入口被门禁拒绝,
  // 主操作区直接给出显式触发入口,避免用户对着被拒的「开始写作」干等。
  if (state.blueprint_status === "none" || state.blueprint_status === "partial") {
    return readiness("blueprint_pending", {
      chapterNo,
      modelLabel,
      primaryAction: "init_blueprint",
      primaryLabel: "开始规划蓝图"
    });
  }

  // 6. Missing model
  const activeModel = project.active_model;
  if (!activeModel) {
    return readiness("missing_model", {
      chapterNo,
      modelLabel,
      primaryAction: "open_settings"
    });
  }

  // 7. Invalid model fields
  if (isInvalidModel(activeModel)) {
    return readiness("invalid_model", {
      chapterNo,
      modelLabel,
      primaryAction: "open_settings",
      blocking: true
    });
  }

  // 8. Mock/demo model
  if (modelProfile && modelProfile.is_mock) {
    return readiness("demo", {
      chapterNo,
      modelLabel,
      primaryAction: "start_chapter",
      primaryLabel: `用演示模型写第 ${chapterNo} 章`
    });
  }

  // 配置齐全即可开写。这里不做连接探测门禁：模型能不能连通，运行时会用真实
  // 报错告诉用户，界面不提前拦、也不显示「未验证」之类的状态标记。
  return readiness("ready", {
    chapterNo,
    modelLabel,
    primaryAction: "start_chapter",
    primaryLabel: `开始写第 ${chapterNo} 章`
  });
}

/**
 * Check if active model has invalid/incomplete fields.
 */
function isInvalidModel(model) {
  const required = ["provider", "model_name", "base_url", "api_key_env"];
  for (const field of required) {
    const val = model[field];
    if (val === undefined || val === null || val === "") {
      return true;
    }
  }
  return false;
}

/**
 * Build the readiness result object with defaults.
 */
function readiness(key, overrides = {}) {
  const labels = {
    no_project:         { label: "未创建项目",       detail: "请先创建小说项目。" },
    project_read_only:  { label: "项目只读",         detail: "项目已被归档或设置为只读。" },
    running:            { label: "写作进行中",       detail: "AI 正在写作中，请稍候。" },
    blocked:            { label: "遇到阻塞",         detail: "项目存在待解决的问题。" },
    completed:          { label: "已完成目标",       detail: "已达成目标章节数，可增加目标。" },
    blueprint_pending:  { label: "蓝图未初始化",     detail: "请先运行 /init 生成大纲与设定，再开始写作。" },
    missing_model:      { label: "未配置模型",       detail: "请先配置 AI 模型。" },
    invalid_model:      { label: "模型配置无效",     detail: "模型配置信息不完整或连接失败，请检查设置。" },
    demo:               { label: "演示模型模式",     detail: "演示模型用于体验写作流程，生成的章节会保存在项目里（无需真实 API Key）。" },
    ready:              { label: "模型已连接",       detail: "可以开始写第 1 章。" }
  };

  const entry = labels[key] || { label: key, detail: "" };

  // Build detail with chapter number for ready and demo
  let detail = entry.detail;
  if (key === "ready" && overrides.chapterNo) {
    detail = `可以开始写第 ${overrides.chapterNo} 章。`;
  }

  return {
    key,
    label: entry.label,
    detail,
    primaryAction: overrides.primaryAction || "",
    primaryLabel: overrides.primaryLabel || getDefaultPrimaryLabel(key, overrides.chapterNo),
    chapterNo: overrides.chapterNo || 1,
    modelLabel: overrides.modelLabel || "",
    blocking: overrides.blocking === true,
    reasonCode: overrides.reasonCode || null
  };
}

function getDefaultPrimaryLabel(key, chapterNo) {
  const labels = {
    no_project: "新建小说",
    project_read_only: "查看项目状态",
    running: "查看进度",
    blocked: "查看问题",
    completed: "增加目标",
    blueprint_pending: "开始规划蓝图",
    missing_model: "打开设置",
    invalid_model: "打开设置",
    demo: "用演示模型开始",
    ready: "开始写作"
  };
  return labels[key] || "";
}
