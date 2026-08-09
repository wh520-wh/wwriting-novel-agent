import { icon } from "./icons.js";
import { compactObject, resolveModelEndpoint } from "./utils.js";
import { deleteJson, getJson, postJson, withProjectScope } from "./api-client.js";
import { renderMarkdown } from "./markdown-lite.mjs";
import { motion } from "./motion-runtime.js";
import { formatConnectionStatus, submitModelConnectionTest } from "./settings-connection.mjs";

// Re-export so consumers that already `import { ... } from "./settings-modal.js"`
// continue to work. The pure helpers themselves live in ./settings-connection.mjs
// so they can be tested without DOM-bound modules.
export { formatConnectionStatus, submitModelConnectionTest } from "./settings-connection.mjs";

const PROVIDER_PRESETS = {
  deepseek: { title: "DeepSeek 官方", provider: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"] },
  mimo: { title: "小米 MiMo 官方", provider: "openai-compatible", baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_MIMO_API_KEY", models: ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro"] },
  custom: { title: "自定义", provider: "openai-compatible", baseUrl: "", apiKeyEnv: "WWRITING_PROVIDER_API_KEY", models: ["custom-model"] }
};

const SETTINGS_PROVIDERS = [
  { id: "deepseek", name: "DeepSeek · 深度求索", short: "DS", color: "#4d6bfe", preset: "deepseek" },
  { id: "mimo", name: "小米 MiMo 官方", short: "Mi", color: "#ff6a00", preset: "mimo" },
  { id: "custom", name: "OpenAI 兼容 · 自定义", short: "AI", color: "#10a37f", preset: "custom" }
];

const SETTINGS_SECTIONS = [
  { id: "model", label: "模型与密钥", icon: "settings", ready: true },
  { id: "writing", label: "写作参数", icon: "compose", ready: true },
  { id: "skills", label: "Agent 技能", icon: "skill", ready: true },
  { id: "danger", label: "项目管理", icon: "folder", ready: true }
];

// 「已归档对话」归档时间展示格式（Task 10）：模块级单例避免每次渲染新建
// Intl.DateTimeFormat；hour12:false 显式锁定 24 小时制，避免个别环境 zh-CN 默认
// 12 小时制。
const ARCHIVED_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
});

// 通用嵌套层 Esc 关闭（Task 13）：Esc 用 capture 监听先于 app.js 的弹窗级 Esc，
// stopImmediatePropagation 阻断后者（避免一次 Esc 同时关掉嵌套层与弹窗，也阻断
// AgentSurface 的 Run 停止路由）。返回解除监听的函数。
function bindNestedLayerDismissal({ isOpen, close, doc = document } = {}) {
  if (typeof doc === "undefined" || typeof doc.addEventListener !== "function") return null;
  const onDocKeydown = (event) => {
    if (event?.key !== "Escape" || !isOpen()) return;
    close();
    event.stopImmediatePropagation?.();
    event.preventDefault?.();
  };
  doc.addEventListener("keydown", onDocKeydown, true);
  return () => doc.removeEventListener("keydown", onDocKeydown, true);
}

// 添加技能菜单（.spd-addmenu）的关闭行为：点击菜单外部或按 Esc 只关菜单，不关整个
// 设置弹窗。Esc 走 bindNestedLayerDismissal 的 capture 监听（先于 app.js 的弹窗级
// Esc，stopImmediatePropagation 阻断后者）。返回解除监听的函数。
function bindAddMenuDismissal(addWrap, syncAddMenuAria) {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return null;
  const close = () => {
    if (!addWrap.classList.contains("open")) return;
    addWrap.classList.remove("open");
    syncAddMenuAria();
  };
  const onDocClick = (event) => {
    if (!addWrap.classList.contains("open")) return;
    const target = event?.target ?? null;
    if (target && typeof addWrap.contains === "function" && addWrap.contains(target)) return;
    close();
  };
  document.addEventListener("click", onDocClick);
  const unbindEsc = bindNestedLayerDismissal({
    isOpen: () => addWrap.classList.contains("open"),
    close
  });
  return () => {
    document.removeEventListener("click", onDocClick);
    unbindEsc?.();
  };
}


export function createSettingsModal(ctx, options = {}) {
  // ctx provides: refs, getDashboard, getCurrentProjectRoot, showToast, loadDashboard,
  //   getLastFocused, setLastFocused
  const {
    getJsonImpl = getJson,
    postJsonImpl = postJson,
    deleteJsonImpl = deleteJson,
    // 模型切换确认的确认函数（可注入以便测试；默认原生 confirm，桌面场景无需新 UI）。
    confirmImpl = (message) => {
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        return window.confirm(message);
      }
      return true;
    }
  } = options;

  let settingsProviderId = "deepseek";
  let settingsSection = "model";
  // 技能管理 scope（Task 13）：segmented control 的当前目录范围。
  let skillsScope = "global";
  // 技能 catalog 快照（settings 的 GET /api/skills/catalog）。
  let skillsCatalog = { active: [], shadowed: [], migration_errors: [] };
  // 技能分区内的节点引用（scope 切换 / 导入删除后局部重渲染，不重建整个分区）。
  const skillsRefs = { list: null, errors: null, globalBtn: null, projectBtn: null, addWrap: null };
  // 添加技能菜单的文档级关闭监听；重渲/换分区前先解除旧监听避免泄漏。
  let removeAddMenuDismissal = null;
  // 对话历史分区（Task 13）：导出/清空按钮与活动 Run 门禁提示（重渲时更新引用）。
  let historyRefs = { exportBtn: null, clearBtn: null, hint: null };
  // 清空确认层（settings 内最上层）的节点引用与文档级 Esc 监听。
  let clearConfirmRef = { layer: null, ack: null, confirmBtn: null, error: null };
  let removeClearConfirmDismissal = null;
  // 模型清单来自全局（~/.wwriting/model-profiles.json），与项目无关。
  // 打开设置时拉一次，保存/删除/选用后刷新。
  let globalModels = { default_model: null, models: [] };
  const settingsFields = {};
  // connection-test state machine: "idle" | "testing" | "success" | "failure" | "aborted" | "saving"
  let connectionState = "idle";
  // 保存序号：runSave 的「已保存」关闭定时器带序号，连续保存时旧定时器失效，
  // 不会关闭新弹窗或覆盖新按钮文案。
  let saveSequence = 0;
  // Single in-flight AbortController per modal so closing/switching cancels cleanly.
  let connectionAbortController = null;
  // 密钥槽是供应商实现细节，不暴露给普通用户；预设与已保存模型在此保留其槽名。
  let currentApiKeyEnv = PROVIDER_PRESETS.deepseek.apiKeyEnv;
  // 「当前已生效模型」快照（模型切换确认的基线）：打开设置时从项目/全局默认捕获。
  // 模型变更比较只含 model_name 与 base_url——API Key/环境变量变更是凭据修复，
  // 不改变文风语义，不需要确认。
  const MODEL_SWITCH_CONFIRM_COPY = "切换后将由新模型继续，本章文风可能变化。继续？";
  const savedModelRef = { current: null };

  async function fetchModelSecret(envName) {
    try {
      const data = await getJsonImpl(`/api/settings/model-secret?env=${encodeURIComponent(envName ?? "")}`);
      return data.value ?? "";
    } catch {
      return "";
    }
  }

  // 拉取全局模型清单（Task 4 的 GET /api/settings/models）。失败时回到空清单，
  // 表单仍能用预设默认值渲染，不阻塞设置面板打开。
  async function fetchGlobalModels() {
    try {
      const result = await getJsonImpl("/api/settings/models");
      if (result?.ok) {
        globalModels = { default_model: result.default_model ?? null, models: result.models ?? [] };
      }
    } catch {
      globalModels = { default_model: null, models: [] };
    }
    return globalModels;
  }

  async function fetchOutputStyles() {
    try {
      const data = await getJsonImpl("/api/output-styles");
      return Array.isArray(data.styles) ? data.styles : [];
    } catch (error) {
      console.warn("fetchOutputStyles failed:", error);
      return [
        { name: "creative", description: "创作模式", source: "bundled" },
        { name: "review", description: "审稿模式", source: "bundled" }
      ];
    }
  }

  // section 可选：快捷 rail / Agent 斜杠命令（/settings、/model）可指定打开的分区；
  // 非法值回落 model。
  async function openSettingsModal(section = "model") {
    settingsSection = SETTINGS_SECTIONS.some((s) => s.id === section) ? section : "model";
    // 模型清单来自全局配置，与项目无关：先拉一次，没打开项目时表单也能显示已配好的模型。
    await fetchGlobalModels();
    const dashboard = ctx.getDashboard();
    // 有项目时以项目当前模型为准；没项目时退回全局默认模型。
    const activeModel = dashboard?.project?.active_model ?? globalModels.default_model;
    if (activeModel) {
      settingsProviderId = detectProviderPreset(activeModel);
    }
    // 模型切换确认的基线：保存时若 model_name/base_url 与之不同且任务进行中则弹确认。
    savedModelRef.current = activeModel
      ? { model_name: activeModel.model_name ?? null, base_url: activeModel.base_url ?? null }
      : null;
    // Cancel any in-flight test from a previous session and clear temporary state.
    resetConnectionState();
    ctx.refs.settingsSearch.value = "";
    renderSectionNav();
    renderSectionBody();
    ctx.setLastFocused(document.activeElement);
    ctx.refs.settingsScrim.removeAttribute("inert");
    ctx.refs.settingsScrim.classList.add("show");
    motion.openModal(ctx.refs.settingsScrim, document.querySelector("#settings-modal"));
    if (settingsSection === "model") ctx.refs.settingsSearch.focus();
  }

  function setSettingsSection(next) {
    if (!SETTINGS_SECTIONS.some((s) => s.id === next)) return;
    if (next === settingsSection) return;
    settingsSection = next;
    renderSectionNav();
    renderSectionBody();
  }

  function renderSectionNav() {
    const nav = document.getElementById("settings-section-nav");
    if (!nav) return;
    nav.replaceChildren(...SETTINGS_SECTIONS.map((section) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sp-section-item${section.id === settingsSection ? " on" : ""}`;
      button.dataset.section = section.id;
      button.setAttribute("aria-current", section.id === settingsSection ? "true" : "false");
      button.setAttribute("aria-label", section.label);
      const ic = document.createElement("span");
      ic.className = "sp-section-ic";
      ic.append(icon(section.icon, 14));
      const label = document.createElement("span");
      label.textContent = section.label;
      button.append(ic, label);
      if (!section.ready) {
        const badge = document.createElement("span");
        badge.className = "sp-section-soon";
        badge.textContent = section.milestone ?? "稍后";
        button.append(badge);
      }
      button.addEventListener("click", () => setSettingsSection(section.id));
      return button;
    }));
    // Sync the data-section on the side container so CSS can hide provider list
    // for non-model sections.
    const side = nav.closest(".sp-side");
    if (side) side.dataset.section = settingsSection;
  }

  function renderSectionBody() {
    if (settingsSection === "model") {
      renderModelSection();
      ctx.refs.settingsSave.disabled = false;
      ctx.refs.settingsSave.textContent = "保存设置";
      return;
    }
    if (settingsSection === "writing") {
      if (ctx.getDashboard()?.hasProject === true) {
        void renderWritingSection();
        ctx.refs.settingsSave.disabled = false;
        ctx.refs.settingsSave.textContent = "保存设置";
      } else {
        // 普通文件夹没有 project.yaml，写作参数无可读写对象：只显示说明，
        // 禁用底部保存，避免出现无法生效的保存按钮（旧版小说项目专属分区）。
        renderLegacyOnlySection("compose", "写作参数", "写作参数仅旧版小说项目可用。");
        ctx.refs.settingsSave.disabled = true;
        ctx.refs.settingsSave.textContent = "无需保存";
      }
      return;
    }
    if (settingsSection === "skills") {
      // 技能动作各自即时生效，不依赖底部保存按钮。
      void renderSkillsSection();
      ctx.refs.settingsSave.disabled = true;
      ctx.refs.settingsSave.textContent = "无需保存";
      return;
    }
    if (settingsSection === "danger") {
      if (ctx.getDashboard()?.hasProject === true) {
        renderDangerSection();
      } else {
        renderLegacyOnlySection("bolt", "项目管理", "项目管理仅旧版小说项目可用。");
      }
      ctx.refs.settingsSave.disabled = true;
      ctx.refs.settingsSave.textContent = "无需保存";
      return;
    }
  }

  function renderModelSection() {
    renderSettingsProviders();
    renderSettingsDetail();
  }

  // 旧版小说项目专属分区（写作参数/项目管理）在普通文件夹（hasProject:false）
  // 下无可操作内容：渲染头部 + 简短 muted 说明。与 renderSectionBody 的保存按钮
  // 禁用逻辑配合，确保不会出现「点了保存却落空」的死角入口。
  function renderLegacyOnlySection(iconName, title, note) {
    ctx.refs.settingsDetail.replaceChildren();
    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon(iconName, 16));
    const h3 = document.createElement("h3");
    h3.textContent = title;
    head.append(ic, h3);
    ctx.refs.settingsDetail.append(head);
    const noteEl = document.createElement("p");
    noteEl.className = "spd-hint";
    noteEl.textContent = note;
    ctx.refs.settingsDetail.append(noteEl);
  }

  async function renderWritingSection() {
    const dashboard = ctx.getDashboard();
    const project = dashboard?.project ?? {};
    ctx.refs.settingsDetail.replaceChildren();

    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon("compose", 16));
    const h3 = document.createElement("h3");
    h3.textContent = "写作参数";
    head.append(ic, h3);
    ctx.refs.settingsDetail.append(head);

    const intro = document.createElement("p");
    intro.className = "spd-hint";
    intro.textContent = "控制每章的篇幅、目标章节数和输出风格。";
    ctx.refs.settingsDetail.append(intro);

    settingsFields.targetChapters = settingField("目标章节数（提高它可以继续已完成的小说）", "number", {
      value: project.target_chapters ?? ""
    });
    settingsFields.minWords = settingField("每章最低字数", "number", { value: project.min_words_per_chapter ?? "" });
    settingsFields.targetWords = settingField("每章目标字数", "number", { value: project.target_words_per_chapter ?? "" });
    settingsFields.maxWords = settingField("每章字数上限（留空 = 不限，按 target × 1.5 估算）", "number", {
      value: project.max_words_per_chapter ?? ""
    });

    // 输出风格下拉（从模型区平移）
    const currentOutputStyle = project.output_style ?? "creative";
    const outputStyles = await fetchOutputStyles();
    const outputStyleField = document.createElement("div");
    outputStyleField.className = "spd-field";
    const outputStyleLabel = document.createElement("div");
    outputStyleLabel.className = "spd-label";
    const outputStyleSpan = document.createElement("span");
    outputStyleSpan.textContent = "输出风格";
    outputStyleLabel.append(outputStyleSpan);
    const outputStyleSelect = document.createElement("select");
    outputStyleSelect.className = "spd-input";
    outputStyleSelect.id = "settings-output-style";
    outputStyleSelect.setAttribute("aria-label", "输出风格");
    for (const style of outputStyles) {
      const opt = document.createElement("option");
      opt.value = style.name;
      opt.textContent = `${style.name} — ${style.description}`;
      outputStyleSelect.append(opt);
    }
    outputStyleSelect.value = currentOutputStyle;
    outputStyleField.append(outputStyleLabel, outputStyleSelect);
    settingsFields.outputStyle = { field: outputStyleField, input: outputStyleSelect };

    ctx.refs.settingsDetail.append(
      settingsFields.targetChapters.field,
      settingsFields.minWords.field,
      settingsFields.targetWords.field,
      settingsFields.maxWords.field,
      settingsFields.outputStyle.field
    );
  }

  function renderDangerSection() {
    const dashboard = ctx.getDashboard();
    const project = dashboard?.project ?? {};
    const projectRoot = ctx.getCurrentProjectRoot();
    const isArchived = Boolean(project.archived_at);
    ctx.refs.settingsDetail.replaceChildren();

    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon("bolt", 16));
    const h3 = document.createElement("h3");
    h3.textContent = "项目管理";
    head.append(ic, h3);
    ctx.refs.settingsDetail.append(head);

    const intro = document.createElement("p");
    intro.className = "spd-hint";
    intro.textContent = "管理当前项目的归档状态和本地文件夹。";
    ctx.refs.settingsDetail.append(intro);

    // 归档/解除归档
    const archiveHeading = document.createElement("h4");
    archiveHeading.className = "spd-section";
    archiveHeading.textContent = "项目归档";
    ctx.refs.settingsDetail.append(archiveHeading);

    const archiveField = document.createElement("div");
    archiveField.className = "spd-field spd-toggle";
    const archiveLabel = document.createElement("div");
    archiveLabel.className = "spd-label";
    const archiveSpan = document.createElement("span");
    archiveSpan.textContent = isArchived ? "项目已归档" : "项目状态：活跃";
    archiveLabel.append(archiveSpan);
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "sp-btn";
    archiveBtn.id = isArchived ? "settings-unarchive-trigger" : "settings-archive-trigger";
    archiveBtn.textContent = isArchived ? "解除归档" : "归档此项目";
    archiveBtn.addEventListener("click", () => {
      // 归档是确定性设置变更（Rule 6：不为确定性功能创建 Agent 工具/对话路径）
      archiveBtn.disabled = true;
      void postJson("/api/settings/update", {
        projectRoot: ctx.getCurrentProjectRoot?.(),
        archived_at: isArchived ? null : new Date().toISOString()
      })
        .then(async () => {
          closeSettingsModal();
          ctx.showToast(isArchived ? "已解除归档。" : "项目已归档，只读。", "success");
          await ctx.loadDashboard?.();
        })
        .catch((error) => {
          ctx.showToast(error?.message ?? "归档操作失败。", "error");
          archiveBtn.disabled = false;
        });
    });
    archiveField.append(archiveLabel, archiveBtn);
    settingsFields.archiveButton = { field: archiveField, input: archiveBtn };
    ctx.refs.settingsDetail.append(archiveField);

    const archiveHint = document.createElement("div");
    archiveHint.className = "spd-hint";
    archiveHint.textContent = "归档后项目只读。";
    ctx.refs.settingsDetail.append(archiveHint);

    // 打开项目文件夹
    const folderHeading = document.createElement("h4");
    folderHeading.className = "spd-section";
    folderHeading.textContent = "项目文件夹";
    ctx.refs.settingsDetail.append(folderHeading);

    const folderField = document.createElement("div");
    folderField.className = "spd-field spd-toggle";
    const folderLabel = document.createElement("div");
    folderLabel.className = "spd-label";
    const folderSpan = document.createElement("span");
    folderSpan.textContent = projectRoot ?? "未选择项目";
    folderLabel.append(folderSpan);
    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "sp-btn";
    folderBtn.id = "settings-open-folder";
    folderBtn.textContent = "打开项目文件夹";
    folderBtn.addEventListener("click", () => {
      if (!projectRoot) {
        ctx.showToast("请先新建或打开一部小说。", "info");
        return;
      }
      const reveal = window.wwritingDesktop?.revealPath;
      if (typeof reveal === "function") {
        void reveal(projectRoot).catch(() => ctx.showToast("打开项目文件夹失败。", "error"));
        return;
      }
      ctx.showToast("当前环境不支持打开文件夹。", "info");
    });
    folderField.append(folderLabel, folderBtn);
    settingsFields.folderButton = { field: folderField, input: folderBtn };
    ctx.refs.settingsDetail.append(folderField);

    // 对话历史（Task 13）：导出可选、清空二次确认、活动 Run 门禁。对话历史保存在
    // 项目状态目录，与创作文件分离——清空不触碰章节、总纲、设定与 WWRITING.md。
    const historyHeading = document.createElement("h4");
    historyHeading.className = "spd-section";
    historyHeading.textContent = "对话历史";
    ctx.refs.settingsDetail.append(historyHeading);

    const historyIntro = document.createElement("p");
    historyIntro.className = "spd-hint";
    historyIntro.textContent = "导出或清空本项目与 Agent 的对话记录；不影响任何创作文件。";
    ctx.refs.settingsDetail.append(historyIntro);

    const historyField = document.createElement("div");
    historyField.className = "spd-field spd-toggle";
    const historyLabel = document.createElement("div");
    historyLabel.className = "spd-label";
    const historySpan = document.createElement("span");
    historySpan.textContent = "对话历史保存在项目状态目录。";
    historyLabel.append(historySpan);
    const historyBtns = document.createElement("div");
    historyBtns.style.display = "flex";
    historyBtns.style.gap = "8px";
    const exportButton = actionButton("导出对话历史", () => void exportHistoryFlow(exportButton));
    exportButton.id = "export-history-trigger";
    const clearButton = actionButton("清空对话历史", () => openClearHistoryConfirm());
    clearButton.id = "clear-history-trigger";
    historyBtns.append(exportButton, clearButton);
    historyField.append(historyLabel, historyBtns);
    ctx.refs.settingsDetail.append(historyField);

    // 活动 Run 门禁提示：任务进行中清空按钮禁用，先停止任务。
    const runHint = document.createElement("div");
    runHint.className = "spd-hint";
    runHint.id = "clear-history-run-hint";
    runHint.textContent = "任务进行中，请先停止任务后再清空对话历史。";
    runHint.hidden = true;
    ctx.refs.settingsDetail.append(runHint);

    historyRefs = { exportBtn: exportButton, clearBtn: clearButton, hint: runHint };
    // 活动 Run 判定是异步快照检查：渲染后更新按钮禁用态与提示可见性。
    void refreshHistoryRunGate();

    // 「已归档对话」分类（Task 10）：仅在存在归档会话时渲染（与技能分区
    // 「被覆盖」等条件渲染先例同款）；分类内按归档时间倒序。
    renderArchivedSessionsBlock(ctx.refs.settingsDetail);
  }

  // 「已归档对话」分类（Task 10）：列出 archived_at != null 的会话（标题 + 归档
  // 时间 + 恢复/永久删除）。数据源 = dashboard.sessions（含归档会话，与设置页
  // 其他分区同一数据 seam）；无归档会话时整个分类不渲染。
  function renderArchivedSessionsBlock(detail) {
    const archived = archivedSessions();
    if (archived.length === 0) return;

    const heading = document.createElement("h4");
    heading.className = "spd-section";
    heading.textContent = "已归档对话";
    detail.append(heading);

    const intro = document.createElement("p");
    intro.className = "spd-hint";
    intro.textContent = "归档的对话不参与新对话，可在此恢复或永久删除。";
    detail.append(intro);

    const list = document.createElement("div");
    list.className = "spd-archived-list";
    list.id = "archived-sessions-list";
    for (const session of archived) list.append(buildArchivedSessionRow(session));
    detail.append(list);
  }

  // 归档会话快照：dashboard.sessions 中 archived_at 非空者，按归档时间倒序。
  function archivedSessions() {
    return (ctx.getDashboard()?.sessions ?? [])
      .filter((session) => session.archived_at != null)
      .sort((a, b) => String(b.archived_at).localeCompare(String(a.archived_at)));
  }

  function buildArchivedSessionRow(session) {
    const row = document.createElement("div");
    row.className = "spd-archived-row";
    row.dataset.sessionId = session.session_id;

    const main = document.createElement("div");
    main.className = "spd-archived-main";
    const title = document.createElement("div");
    title.className = "spd-archived-title";
    title.textContent = session.title ?? "新对话";
    const when = document.createElement("div");
    when.className = "spd-archived-when";
    when.textContent = `归档于 ${formatArchivedTime(session.archived_at)}`;
    main.append(title, when);

    const actions = document.createElement("div");
    actions.className = "spd-archived-actions";

    const restore = actionButton("恢复", () => { void restoreArchivedSession(session, restore); });
    restore.id = `archived-restore-${session.session_id}`;
    restore.setAttribute("aria-label", `恢复对话 ${session.title ?? "新对话"}`);
    actions.append(restore);

    // 危险操作按钮：复用 .sp-btn 组件语言 + .sp-btn-danger 红系样式。
    const del = document.createElement("button");
    del.type = "button";
    del.className = "sp-btn sp-btn-danger";
    del.id = `archived-delete-${session.session_id}`;
    del.setAttribute("aria-label", `永久删除对话 ${session.title ?? "新对话"}`);
    del.title = "永久删除对话";
    del.append(icon("trash", 14), "永久删除");
    del.addEventListener("click", () => { void deleteArchivedSession(session, del); });
    actions.append(del);

    row.append(main, actions);
    return row;
  }

  // in-flight 按钮禁用对齐 exportHistoryFlow 先例：请求期间 disabled=true 防双击
  // 双调，finally 复位（成功后重渲的按钮是全新节点，对旧节点复位无副作用）。
  async function restoreArchivedSession(session, btn) {
    if (btn) btn.disabled = true;
    try {
      if (typeof ctx.restoreSession !== "function") {
        ctx.showToast("当前环境不支持恢复对话。", "info");
        return;
      }
      const label = session.title ?? "新对话";
      await ctx.restoreSession(session.session_id);
      ctx.showToast(`已恢复对话 ${label}`, "success");
      await refreshArchivedSessions();
    } catch (error) {
      ctx.showToast(error?.message ?? "恢复对话失败。", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function deleteArchivedSession(session, btn) {
    if (btn) btn.disabled = true;
    try {
      const label = session.title ?? "新对话";
      // 永久删除是危险操作：先二次确认，取消则不发起任何请求。
      if (!confirmImpl("永久删除后不可恢复，该对话的全部历史将被移除。确认？")) return;
      if (typeof ctx.deleteSession !== "function") {
        ctx.showToast("当前环境不支持删除对话。", "info");
        return;
      }
      // ctx.deleteSession 由 app.js 注入 deleteSessionAndResolveActive：删的是当前
      // 活跃会话时切到最近活跃会话（归档会话正常不会是活跃会话，但 active_session_id
      // 可能残留指向它，走它最安全）。surface 内部已刷新侧边栏，这里重拉 dashboard
      // 供本分区重渲。
      await ctx.deleteSession(session.session_id);
      ctx.showToast(`已永久删除对话 ${label}`, "success");
      await refreshArchivedSessions();
    } catch (error) {
      ctx.showToast(error?.message ?? "删除对话失败。", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 恢复/永久删除成功后刷新分区：重拉 dashboard（更新 sessions 快照）再整区重渲，
  // 归档会话消失/解除归档后列表与条件渲染自然回到最新状态。
  // 竞态守卫：请求 in-flight 期间用户可能切到其他分区（甚至正在填 API Key）或关闭
  // 弹窗——数据已由 loadDashboard 缓存，跳过重渲即可，用户切回 danger 分区时
  // renderSectionBody 会用最新 dashboard 渲染，不丢任何表单输入。
  async function refreshArchivedSessions() {
    await ctx.loadDashboard?.();
    if (settingsSection !== "danger" || !ctx.refs.settingsScrim.classList.contains("show")) return;
    renderDangerSection();
  }

  function formatArchivedTime(value) {
    if (!value) return "";
    const date = new Date(value);
    // 非 ISO 字符串会得到 Invalid Date，format 抛 RangeError：兜底为空串。
    if (Number.isNaN(date.getTime())) return "";
    return ARCHIVED_TIME_FORMAT.format(date);
  }

  // 设置详情内的二级动作按钮（与 .sp-btn 同一组件语言）。
  function actionButton(text, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sp-btn";
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }

  // 活动 Run / 排队输入进行中：清空按钮禁用并显示「先停止任务」提示。
  async function refreshHistoryRunGate() {
    const busy = await taskInProgress();
    if (!historyRefs.clearBtn) return;
    historyRefs.clearBtn.disabled = busy;
    if (historyRefs.hint) historyRefs.hint.hidden = !busy;
  }

  // 导出对话历史（可选动作，不是清空的前置条件）：surface 返回 NDJSON 原文，
  // 这里触发下载并提示；失败只提示，不影响后续清空。
  async function exportHistoryFlow(btn) {
    if (typeof ctx.exportAgentHistory !== "function") {
      ctx.showToast("当前环境不支持导出对话历史。", "info");
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const result = await ctx.exportAgentHistory();
      const text = result?.text;
      if (typeof text !== "string" || text.length === 0) throw new Error("导出结果为空。");
      downloadHistoryText(text, historyExportFilename());
      ctx.showToast("对话历史已导出。", "success");
    } catch (error) {
      ctx.showToast(error?.message ?? "导出对话历史失败。", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function historyExportFilename() {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return `对话历史-${ts}.ndjson`;
  }

  function downloadHistoryText(text, filename) {
    const blob = new Blob([text], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // 清空确认层（Task 13）：settings 内最上层，覆盖整个弹窗。未勾选确认时确认
  // 按钮禁用，绝不发请求；ESC 只关本层（capture 监听阻断弹窗级 Esc 与 Run 停止）。
  function openClearHistoryConfirm() {
    if (clearConfirmRef.layer) return;
    // 确认层是当前最上层：先解除更低的添加菜单文档监听，ESC 只作用于确认层。
    removeAddMenuDismissal?.();

    const layer = document.createElement("div");
    layer.className = "spd-confirm-layer";
    layer.id = "clear-history-confirm";
    layer.hidden = false;
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      zIndex: "20",
      background: "rgba(20, 18, 14, 0.45)",
      display: "grid",
      placeItems: "center",
      padding: "28px"
    });

    const card = document.createElement("div");
    card.className = "spd-confirm-card";
    Object.assign(card.style, {
      width: "min(430px, 100%)",
      background: "var(--surface)",
      border: "1px solid var(--line)",
      borderRadius: "var(--r-xl)",
      boxShadow: "var(--shadow-pop)",
      padding: "22px 24px",
      display: "grid",
      gap: "14px"
    });

    const title = document.createElement("h4");
    title.className = "spd-section";
    title.style.margin = "0";
    title.textContent = "清空对话历史";

    const copy = document.createElement("p");
    copy.className = "spd-confirm-copy spd-hint";
    copy.style.margin = "0";
    copy.textContent = "此操作不可恢复，将删除本项目全部对话历史；不影响章节、总纲、设定与 WWRITING.md 等创作文件。如需保留可先导出对话历史。";

    const ackLabel = document.createElement("label");
    ackLabel.style.display = "flex";
    ackLabel.style.alignItems = "center";
    ackLabel.style.gap = "8px";
    ackLabel.style.fontSize = "13px";
    const ack = document.createElement("input");
    ack.type = "checkbox";
    ack.id = "clear-history-ack";
    ack.style.width = "16px";
    ack.style.height = "16px";
    const ackSpan = document.createElement("span");
    ackSpan.textContent = "我确认要清空对话历史";
    ackLabel.append(ack, ackSpan);

    const error = document.createElement("div");
    error.className = "spd-field-error";
    error.id = "clear-history-error";
    error.hidden = true;

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "10px";
    const cancelBtn = actionButton("取消", () => closeClearHistoryConfirm());
    cancelBtn.id = "clear-history-cancel";
    const confirmBtn = actionButton("清空对话历史", () => void runClearHistory(confirmBtn));
    confirmBtn.id = "clear-history-confirm-btn";
    confirmBtn.disabled = true;
    actions.append(cancelBtn, confirmBtn);

    ack.addEventListener("change", () => {
      confirmBtn.disabled = !ack.checked;
    });

    card.append(title, copy, ackLabel, error, actions);
    layer.append(card);
    ctx.refs.settingsScrim.append(layer);

    clearConfirmRef = { layer, ack, confirmBtn, error };
    removeClearConfirmDismissal = bindNestedLayerDismissal({
      // 只有设置弹窗开着且确认层存在时才消费 Esc，避免影响其他层。
      isOpen: () => clearConfirmRef.layer !== null && ctx.refs.settingsScrim.classList.contains("show"),
      close: closeClearHistoryConfirm
    });
    // 点击确认层背景（卡片外部）关闭本层，不触碰弹窗级处理器。
    layer.addEventListener("click", (event) => {
      if (event?.target === layer) closeClearHistoryConfirm();
    });
    cancelBtn.focus();
  }

  function closeClearHistoryConfirm() {
    removeClearConfirmDismissal?.();
    removeClearConfirmDismissal = null;
    if (!clearConfirmRef.layer) return;
    clearConfirmRef.layer.replaceChildren();
    clearConfirmRef.layer.hidden = true;
    clearConfirmRef.layer = null;
  }

  function showClearHistoryError(message) {
    if (!clearConfirmRef.error) return;
    clearConfirmRef.error.textContent = message;
    clearConfirmRef.error.hidden = false;
  }

  async function runClearHistory(confirmBtn) {
    if (confirmBtn.disabled) return;
    if (typeof ctx.clearAgentHistory !== "function") {
      showClearHistoryError("当前环境不支持清空对话历史。");
      return;
    }
    confirmBtn.disabled = true;
    try {
      // surface.clearHistory 内部负责重置投影并重开当前项目（clear-reconnect）。
      await ctx.clearAgentHistory({ confirm_irreversible: true });
      closeClearHistoryConfirm();
      ctx.showToast("对话历史已清空，创作文件未改动。", "success");
    } catch (error) {
      // 请求期间确认层被关闭（ESC/取消）：丢弃迟到的失败反馈。
      if (!clearConfirmRef.layer) return;
      showClearHistoryError(error?.message ?? "清空对话历史失败。");
      confirmBtn.disabled = !clearConfirmRef.ack?.checked;
    }
  }

  // -------------------------------------------------------------------------
  // 「Agent 技能」分区（Task 13）：全局/项目 segmented control、技能列表（来源
  // 标签）、覆盖说明、打开目录 icon button、添加菜单（文件夹/ZIP）、删除按钮。
  // 不存在任何开关、批量启用按钮或项目启用集合——发现即生效。
  // -------------------------------------------------------------------------

  const SKILL_SOURCE_LABELS = { project: "项目", global: "全局", bundled: "随应用分发", builtin: "内置" };

  function skillSourceLabel(source) {
    return SKILL_SOURCE_LABELS[source] ?? String(source ?? "");
  }

  async function fetchSkillsCatalog() {
    const url = withProjectScope("/api/skills/catalog", ctx.getCurrentProjectRoot());
    try {
      const data = await getJsonImpl(url);
      if (data?.ok) {
        skillsCatalog = {
          active: Array.isArray(data.active) ? data.active : [],
          shadowed: Array.isArray(data.shadowed) ? data.shadowed : [],
          migration_errors: Array.isArray(data.migration_errors) ? data.migration_errors : []
        };
      }
    } catch (error) {
      ctx.showToast(error?.message ?? "技能清单加载失败。", "error");
      skillsCatalog = { active: [], shadowed: [], migration_errors: [] };
    }
    return skillsCatalog;
  }

  async function renderSkillsSection() {
    const detail = ctx.refs.settingsDetail;
    detail.replaceChildren();

    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon("skill", 16));
    const h3 = document.createElement("h3");
    h3.textContent = "Agent 技能";
    head.append(ic, h3);
    detail.append(head);

    const intro = document.createElement("p");
    intro.className = "spd-hint";
    intro.textContent = "技能是写作规则包：起草时自动注入规则，审稿时按清单检查。导入到目录即生效，无需手动启用。";
    detail.append(intro);

    // 全局/项目 segmented control（决定导入/删除/打开目录的目标目录）。
    const projectRoot = ctx.getCurrentProjectRoot();
    if (skillsScope === "project" && !projectRoot) skillsScope = "global";
    const seg = document.createElement("div");
    seg.className = "spd-segmented";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "技能目录范围");
    const globalBtn = document.createElement("button");
    globalBtn.type = "button";
    globalBtn.className = `spd-seg${skillsScope === "global" ? " on" : ""}`;
    globalBtn.dataset.scope = "global";
    globalBtn.id = "skills-scope-global";
    globalBtn.textContent = "全局";
    const projectBtn = document.createElement("button");
    projectBtn.type = "button";
    projectBtn.className = `spd-seg${skillsScope === "project" ? " on" : ""}`;
    projectBtn.dataset.scope = "project";
    projectBtn.id = "skills-scope-project";
    projectBtn.textContent = "项目";
    projectBtn.disabled = !projectRoot;
    if (!projectRoot) projectBtn.title = "打开项目后才能管理项目技能";
    const setSkillsScope = (scope) => {
      if (skillsScope === scope || (scope === "project" && !ctx.getCurrentProjectRoot())) return;
      skillsScope = scope;
      skillsRefs.globalBtn?.classList.toggle("on", skillsScope === "global");
      skillsRefs.projectBtn?.classList.toggle("on", skillsScope === "project");
      renderSkillsList();
    };
    globalBtn.addEventListener("click", () => setSkillsScope("global"));
    projectBtn.addEventListener("click", () => setSkillsScope("project"));
    skillsRefs.globalBtn = globalBtn;
    skillsRefs.projectBtn = projectBtn;
    seg.append(globalBtn, projectBtn);
    detail.append(seg);

    // 覆盖说明（同名技能按优先级生效）。
    const override = document.createElement("p");
    override.className = "spd-hint";
    override.textContent = "同名技能按 项目 > 全局 > 随应用分发 > 内置 的优先级生效，高优先级覆盖低优先级。";
    detail.append(override);

    // 工具条：打开目录 icon button + 添加技能菜单（文件夹/ZIP）。
    const toolbar = document.createElement("div");
    toolbar.className = "spd-skill-toolbar";
    const openDir = document.createElement("button");
    openDir.type = "button";
    openDir.className = "icon-btn";
    openDir.id = "skills-open-dir";
    openDir.title = "打开当前范围的技能目录";
    openDir.setAttribute("aria-label", "打开技能目录");
    openDir.append(icon("folder", 15));
    openDir.addEventListener("click", () => openSkillDirectory());
    toolbar.append(openDir);

    const addWrap = document.createElement("div");
    addWrap.className = "spd-addmenu";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "small-button";
    addBtn.id = "skills-add";
    addBtn.textContent = "添加技能";
    addBtn.setAttribute("aria-haspopup", "menu");
    addBtn.setAttribute("aria-expanded", "false");
    const syncAddMenuAria = () => addBtn.setAttribute("aria-expanded", addWrap.classList.contains("open") ? "true" : "false");
    addBtn.addEventListener("click", () => {
      const open = !addWrap.classList.contains("open");
      addWrap.classList.toggle("open", open);
      syncAddMenuAria();
    });
    const addMenu = document.createElement("div");
    addMenu.className = "spd-addmenu-pop";
    const folderOpt = document.createElement("button");
    folderOpt.type = "button";
    folderOpt.id = "skills-add-folder";
    folderOpt.textContent = "从文件夹导入…";
    folderOpt.addEventListener("click", () => {
      addWrap.classList.remove("open");
      syncAddMenuAria();
      void addSkillFromFolder();
    });
    const zipOpt = document.createElement("button");
    zipOpt.type = "button";
    zipOpt.id = "skills-add-zip";
    zipOpt.textContent = "从 ZIP 包导入…";
    zipOpt.addEventListener("click", () => {
      addWrap.classList.remove("open");
      syncAddMenuAria();
      void addSkillFromZip();
    });
    addMenu.append(folderOpt, zipOpt);
    addWrap.append(addBtn, addMenu);
    skillsRefs.addWrap = addWrap;
    // 点击菜单外部 / Esc 关闭菜单（Esc 只关菜单不关弹窗；重渲先解除旧监听）。
    removeAddMenuDismissal?.();
    removeAddMenuDismissal = bindAddMenuDismissal(addWrap, syncAddMenuAria);
    toolbar.append(addWrap);
    detail.append(toolbar);

    // 列表 + 迁移失败容器（refresh 只重渲这两个节点）。
    const list = document.createElement("div");
    list.className = "spd-skill-list";
    list.id = "skills-list";
    skillsRefs.list = list;
    detail.append(list);
    const errors = document.createElement("div");
    errors.id = "skills-migration-errors";
    skillsRefs.errors = errors;
    detail.append(errors);

    await renderSkillsCatalogBody();
  }

  // 拉取最新 catalog 并重渲列表区（scope 切换 / 导入删除后刷新）。
  async function renderSkillsCatalogBody() {
    const catalog = await fetchSkillsCatalog();
    renderSkillsList(catalog);
  }

  function renderSkillsList(catalog = skillsCatalog) {
    if (!skillsRefs.list) return;
    skillsRefs.list.replaceChildren(buildSkillList(catalog));
    if (skillsRefs.errors) {
      skillsRefs.errors.replaceChildren(buildMigrationErrors(catalog));
    }
  }

  function buildSkillList(catalog) {
    const frag = document.createDocumentFragment();
    const scopeLabel = skillsScope === "global" ? "全局" : "项目";
    // Task 8：内置写作风格（readonly 的内置技能）在独立无框分区展示，不混入
    // 「全局/项目」管理与「其他来源」列表。
    const styleSkills = (catalog.active ?? []).filter(
      (skill) => skill.source === "builtin" && skill.readonly === true
    );
    const styleNames = new Set(styleSkills.map((skill) => skill.name));
    const scoped = catalog.active.filter((skill) => skill.source === skillsScope);
    const others = catalog.active.filter((skill) => skill.source !== skillsScope && !styleNames.has(skill.name));

    if (catalog.active.length === 0) {
      const empty = document.createElement("p");
      empty.className = "dpanel-empty";
      empty.textContent = "未发现技能。";
      frag.append(empty);
      return frag;
    }

    const scopedHeading = document.createElement("div");
    scopedHeading.className = "spd-skill-heading";
    scopedHeading.textContent = `${scopeLabel}目录`;
    frag.append(scopedHeading);
    if (scoped.length === 0) {
      const empty = document.createElement("p");
      empty.className = "dpanel-empty";
      empty.textContent = `「${scopeLabel}」目录下还没有技能，可用上方「添加技能」导入。`;
      frag.append(empty);
    } else {
      for (const skill of scoped) frag.append(buildSkillRow(skill, { deletable: true }));
    }

    if (others.length > 0) {
      const otherHeading = document.createElement("div");
      otherHeading.className = "spd-skill-heading";
      otherHeading.textContent = "其他来源";
      frag.append(otherHeading);
      for (const skill of others) frag.append(buildSkillRow(skill, { deletable: false }));
    }

    if (catalog.shadowed.length > 0) {
      const shadowHeading = document.createElement("div");
      shadowHeading.className = "spd-skill-heading";
      shadowHeading.textContent = "被覆盖";
      frag.append(shadowHeading);
      for (const skill of catalog.shadowed) {
        const row = document.createElement("div");
        row.className = "spd-skill-row shadowed";
        row.dataset.skillName = skill.name;
        row.dataset.shadowReason = skill.shadow_reason ?? "";
        const main = document.createElement("div");
        main.className = "spd-skill-main";
        const nameLine = document.createElement("div");
        nameLine.className = "spd-skill-name";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = skill.name;
        const src = document.createElement("span");
        src.className = "spd-skill-source";
        src.textContent = skillSourceLabel(skill.source);
        nameLine.append(nameSpan, src);
        const desc = document.createElement("div");
        desc.className = "spd-skill-desc";
        desc.textContent = skill.shadow_reason === "reserved_builtin"
          ? "保留名称，内置写作风格不可覆盖或删除。"
          : "被更高优先级同名技能覆盖，不生效。";
        main.append(nameLine, desc);
        row.append(main);
        frag.append(row);
      }
    }

    // Task 8：内置写作风格无框只读分区（三个分隔行，点击在详情区展开完整正文）。
    if (styleSkills.length > 0) {
      const styleHeading = document.createElement("div");
      styleHeading.className = "spd-skill-heading";
      styleHeading.textContent = "内置写作风格";
      frag.append(styleHeading);
      for (const skill of styleSkills) frag.append(buildBuiltinStyleRow(skill));
    }
    return frag;
  }

  function buildSkillRow(skill, { deletable }) {
    const row = document.createElement("div");
    row.className = "spd-skill-row";
    row.dataset.skillName = skill.name;
    row.dataset.skillSource = skill.source;
    const main = document.createElement("div");
    main.className = "spd-skill-main";
    const nameLine = document.createElement("div");
    nameLine.className = "spd-skill-name";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = skill.name;
    const src = document.createElement("span");
    src.className = "spd-skill-source";
    src.textContent = skillSourceLabel(skill.source);
    nameLine.append(nameSpan, src);
    const desc = document.createElement("div");
    desc.className = "spd-skill-desc";
    desc.textContent = skill.description || "";
    main.append(nameLine, desc);
    row.append(main);
    if (deletable) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "spd-skill-del";
      del.setAttribute("aria-label", `删除技能 ${skill.name}`);
      del.title = "删除技能";
      del.append(icon("trash", 14));
      del.addEventListener("click", () => { void deleteSkill(skill.name); });
      row.append(del);
    }
    return row;
  }

  // Task 8：技能行的「名称 + 一行说明」文本块（名称优先显示 display_name）。
  function buildSkillText(skill) {
    const main = document.createElement("div");
    main.className = "spd-skill-main";
    const nameLine = document.createElement("div");
    nameLine.className = "spd-skill-name";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = skill.display_name || skill.name;
    nameLine.append(nameSpan);
    const desc = document.createElement("div");
    desc.className = "spd-skill-desc";
    desc.textContent = skill.description || "";
    main.append(nameLine, desc);
    return main;
  }

  // Task 8 brief Step 6 verbatim：内置写作风格无框分隔行（button），点击展开只读详情。
  // 注：代码库图标注册表无 "chevron-right"，改用实际存在的 chevR（adaptation）。
  function buildBuiltinStyleRow(skill) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "spd-skill-row spd-skill-row--readonly";
    row.dataset.skillName = skill.name;
    row.append(buildSkillText(skill), icon("chevR", 14));
    row.addEventListener("click", () => openReadonlySkillDetail(skill.name));
    return row;
  }

  // Task 8 Step 5/6：只读详情——GET /api/skills/:name（带项目作用域），在同一
  // settings detail 区渲染完整正文。无删除/编辑/覆盖控件。
  async function openReadonlySkillDetail(name) {
    try {
      const url = withProjectScope(`/api/skills/${encodeURIComponent(name)}`, ctx.getCurrentProjectRoot());
      const data = await getJsonImpl(url);
      if (!data?.ok) throw new Error(data?.message ?? "技能详情加载失败。");
      renderReadonlySkillDetail(name, data.content);
    } catch (error) {
      ctx.showToast(error?.message ?? "技能详情加载失败。", "error");
    }
  }

  function renderReadonlySkillDetail(name, content) {
    const detail = ctx.refs.settingsDetail;
    detail.replaceChildren();

    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon("skill", 16));
    const h3 = document.createElement("h3");
    // Task 14：详情头部优先显示 catalog DTO 的 display_name（如「均衡」），
    // 缺省回落技能 ID（detail API 只返回 name + content）。
    const entry = (skillsCatalog.active ?? []).find((skill) => skill.name === name);
    h3.textContent = entry?.display_name || name;
    head.append(ic, h3);
    detail.append(head);

    const back = document.createElement("button");
    back.type = "button";
    back.className = "sp-btn";
    back.id = "skills-detail-back";
    back.textContent = "返回技能列表";
    back.addEventListener("click", () => { void renderSkillsSection(); });
    detail.append(back);

    // 正文用现有 Markdown 字级（agent-markdown），容器局部滚动（max-height 由
    // styles.css 提供）。frontmatter 不展示，只展开技能正文。
    const body = document.createElement("div");
    body.className = "spd-skill-detail-body agent-markdown";
    body.innerHTML = renderMarkdown(stripSkillFrontmatter(content));
    detail.append(body);
  }

  // 去掉 SKILL.md 开头的 frontmatter（`---\n…\n---`），只保留正文。
  function stripSkillFrontmatter(content) {
    const text = String(content ?? "");
    const lines = text.split(/\r?\n/u);
    if (lines[0]?.trim() === "---") {
      const closeIndex = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
      if (closeIndex > 0) return lines.slice(closeIndex + 1).join("\n").trimStart();
    }
    return text;
  }

  function buildMigrationErrors(catalog) {
    const frag = document.createDocumentFragment();
    if (!Array.isArray(catalog.migration_errors) || catalog.migration_errors.length === 0) return frag;
    const box = document.createElement("div");
    box.className = "spd-skill-errors";
    const heading = document.createElement("div");
    heading.className = "spd-skill-heading";
    heading.textContent = "迁移失败";
    const hint = document.createElement("p");
    hint.className = "spd-hint";
    hint.textContent = "以下旧格式技能未能自动迁移，仍保留在源目录（可修复后重开应用重试）：";
    box.append(heading, hint);
    for (const errorItem of catalog.migration_errors) {
      const row = document.createElement("div");
      row.className = "spd-skill-error-row";
      row.textContent = `${errorItem.name ?? "?"}（${errorItem.scope === "project" ? "项目" : "全局"}）：${errorItem.error}`;
      box.append(row);
    }
    frag.append(box);
    return frag;
  }

  // 导入：重名默认 409，仅 UI 二次确认后带 replace:true 重试（冻结契约）。
  async function importSkillSource(sourcePath, replace = false) {
    const scopeLabel = skillsScope === "global" ? "全局" : "项目";
    try {
      await postJsonImpl("/api/skills/import", {
        source_path: sourcePath,
        scope: skillsScope,
        ...(replace ? { replace: true } : {})
      });
      ctx.showToast(`已导入技能到${scopeLabel}目录。`, "success");
      await renderSkillsCatalogBody();
    } catch (error) {
      if (error?.status === 409 && error?.code === "skill_exists" && !replace) {
        if (confirmImpl("同名技能已存在，是否覆盖？覆盖会替换现有内容。")) {
          return importSkillSource(sourcePath, true);
        }
        return;
      }
      ctx.showToast(error?.message ?? "技能导入失败。", "error");
    }
  }

  async function addSkillFromFolder() {
    const picker = window.wwritingDesktop?.selectSkillFolder;
    if (typeof picker !== "function") {
      ctx.showToast("当前环境不支持选择文件夹，请使用桌面版。", "info");
      return;
    }
    const sourcePath = await picker();
    if (sourcePath) await importSkillSource(sourcePath);
  }

  async function addSkillFromZip() {
    const picker = window.wwritingDesktop?.selectSkillZip;
    if (typeof picker !== "function") {
      ctx.showToast("当前环境不支持选择 ZIP，请使用桌面版。", "info");
      return;
    }
    const sourcePath = await picker();
    if (sourcePath) await importSkillSource(sourcePath);
  }

  function openSkillDirectory() {
    const reveal = window.wwritingDesktop?.revealSkillDirectory;
    if (typeof reveal !== "function") {
      ctx.showToast("当前环境不支持打开文件夹。", "info");
      return;
    }
    void reveal(skillsScope, ctx.getCurrentProjectRoot() ?? null)
      .then(() => ctx.showToast("已打开技能目录。", "info"))
      .catch(() => ctx.showToast("打开技能目录失败。", "error"));
  }

  async function deleteSkill(name) {
    if (!confirmImpl(`删除技能「${name}」？将删除其目录。`)) return;
    try {
      await deleteJsonImpl(`/api/skills/${encodeURIComponent(name)}`, { scope: skillsScope });
      ctx.showToast(`已删除技能：${name}`, "success");
      await renderSkillsCatalogBody();
    } catch (error) {
      ctx.showToast(error?.message ?? "技能删除失败。", "error");
    }
  }

  function closeSettingsModal() {
    // 清空确认层随设置弹窗一起关闭（X/关闭/遮罩/Esc 任一路径都先关嵌套层）。
    closeClearHistoryConfirm();
    // Closing the modal aborts any in-flight connection test and clears the
    // temporary key the user typed. Reopening will not prefill the secret.
    resetConnectionState();
    ctx.refs.settingsScrim.dataset.closing = "true";
    ctx.refs.settingsScrim.classList.remove("show");
    ctx.refs.settingsScrim.setAttribute("inert", "");
    motion.closeModal(ctx.refs.settingsScrim, document.querySelector("#settings-modal"), {
      onComplete: () => {
        delete ctx.refs.settingsScrim.dataset.closing;
        const lastFocused = ctx.getLastFocused();
        if (lastFocused && lastFocused.isConnected) lastFocused.focus();
        ctx.setLastFocused(null);
      }
    });
  }

  function renderSettingsProviders() {
    // 已存模型清单——比供应商预设优先展示。
    const savedSection = buildSavedModelSection(globalModels.models);
    ctx.refs.settingsProviderList.replaceChildren(savedSection);
  }

  // 私有：左栏清单 = 「已配置」已存模型（可选用/删除）+「新增供应商」模板入口。
  function buildSavedModelSection(models) {
    const frag = document.createDocumentFragment();
    if (models?.length > 0) {
      const heading = document.createElement("div");
      heading.className = "sp-list-heading";
      heading.textContent = "已配置";
      frag.append(heading);
      for (const model of models) {
        const row = document.createElement("div");
        row.className = "sp-saved-item";
        row.dataset.modelId = model.id;
        row.dataset.modelName = model.model_name;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sp-saved-btn";
        btn.textContent = model.display ?? model.model_name;
        btn.addEventListener("click", () => { void selectSavedModel(model).catch((error) => ctx.showToast(error.message, "error")); });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "sp-saved-del";
        del.setAttribute("aria-label", `删除 ${model.display ?? model.model_name}`);
        del.textContent = "×";
        del.addEventListener("click", (e) => { e.stopPropagation(); void deleteSavedModel(model.id).catch((error) => ctx.showToast(error.message, "error")); });
        row.append(btn, del);
        frag.append(row);
      }
      const divider = document.createElement("div");
      divider.className = "sp-list-heading";
      divider.textContent = "新增供应商";
      frag.append(divider);
    }
    // 原有静态供应商列表（DeepSeek / MiMo / 自定义），现在作为「新增」模板入口
    const q = ctx.refs.settingsSearch.value.trim().toLowerCase();
    const list = SETTINGS_PROVIDERS.filter((p) => p.name.toLowerCase().includes(q));
    for (const provider of list) {
      const button = document.createElement("button");
      button.className = `sp-item${provider.id === settingsProviderId ? " on" : ""}`;
      button.type = "button";
      const av = document.createElement("span");
      av.className = "sp-av";
      av.style.background = provider.color;
      av.textContent = provider.short;
      const name = document.createElement("span");
      name.className = "sp-name";
      name.textContent = provider.name;
      button.append(av, name);
      button.addEventListener("click", async () => {
        const previousEnv = currentApiKeyEnv;
        const previousKey = settingsFields.apiKey?.input?.value ?? "";
        settingsProviderId = provider.id;
        renderSettingsProviders();
        await renderSettingsDetail();
        // Restore the key the user was typing if the env name did not change.
        // Different env names mean different providers/keys, so we intentionally
        // leave the field empty there.
        if (previousEnv && previousKey && currentApiKeyEnv === previousEnv) {
          if (settingsFields.apiKey?.input && !settingsFields.apiKey.input.value) {
            settingsFields.apiKey.input.value = previousKey;
          }
        }
      });
      frag.append(button);
    }
    return frag;
  }

  // 选用已存模型：设为全局默认，并把它的字段回填到右侧表单。
  // 「选用」是显式单点动作，语义即「立即切换」，不重复弹确认（模型切换确认只
  // 挂在保存路径；若未来要求一致，在此处加同一守卫即可）。
  async function selectSavedModel(model) {
    await postJsonImpl("/api/settings/model-select", { model_id: model.id });
    await fetchGlobalModels();
    settingsProviderId = detectProviderPreset(model);
    // 表单回填为刚选用的模型：保存时以此为基线，避免「选用后立即保存」重复确认。
    savedModelRef.current = {
      model_name: model.model_name ?? null,
      base_url: model.base_url ?? null
    };
    renderSettingsProviders();
    await renderSettingsDetail();
  }

  // 删除已存模型：从全局清单移除，并同步刷新左栏列表与右侧表单，
  // 避免删除当前展示/默认模型后表单残留已删模型的字段（保存时把模型「复活」回清单）。
  async function deleteSavedModel(modelId) {
    await postJsonImpl("/api/settings/model-remove", { model_id: modelId });
    await fetchGlobalModels();
    renderSettingsProviders();
    await renderSettingsDetail();
  }

  async function renderSettingsDetail() {
    const provider = SETTINGS_PROVIDERS.find((p) => p.id === settingsProviderId) ?? SETTINGS_PROVIDERS[0];
    const preset = PROVIDER_PRESETS[provider.preset];
    const dashboard = ctx.getDashboard();
    // 模型字段优先用全局清单里的默认模型：没有项目时也要能显示已配好的模型。
    const globalDefault = globalModels.default_model;
    // globalDefault 是 buildModelProfile 的输出（app-server），已含本表单要用的
    // provider/model_name/base_url/api_key_env，无需再投影一份。
    const active = dashboard?.project?.active_model ?? globalDefault ?? {};
    const profile = dashboard?.model_profile ?? globalDefault ?? {};
    const usingThisPreset = detectProviderPreset(active) === provider.id;

    ctx.refs.settingsDetail.replaceChildren();
    const head = document.createElement("header");
    head.className = "spd-head";
    const av = document.createElement("span");
    av.className = "sp-av lg";
    av.style.background = provider.color;
    av.textContent = provider.short;
    const h3 = document.createElement("h3");
    h3.textContent = provider.name;
    head.append(av, h3);
    ctx.refs.settingsDetail.append(head);

    settingsFields.model = settingField("模型", "model-id", {
      options: preset.models.includes(active.model_name) ? preset.models : (usingThisPreset && active.model_name ? [active.model_name, ...preset.models] : preset.models),
      value: usingThisPreset ? active.model_name : preset.models[0],
      placeholder: "输入模型 ID，例如 deepseek-chat"
    });
    settingsFields.modelError = document.createElement("div");
    settingsFields.modelError.className = "spd-field-error";
    settingsFields.modelError.hidden = true;

    settingsFields.baseUrl = settingField("API 地址 · 基础 URL", "text", {
      value: usingThisPreset && active.base_url ? active.base_url : preset.baseUrl
    });
    settingsFields.baseUrlError = document.createElement("div");
    settingsFields.baseUrlError.className = "spd-field-error";
    settingsFields.baseUrlError.hidden = true;
    const endpointHint = document.createElement("div");
    endpointHint.className = "spd-hint";
    settingsFields.endpointHint = endpointHint;

    // 已保存的 key 按「正在编辑的供应商」的 env 回填进输入框：
    // 打开设置即可看到完整 key，可用眼睛按钮查看、复制按钮复制。
    // （本地个人使用，不做遮罩隐藏。）
    const apiKeyEnvValue = usingThisPreset && active.api_key_env ? active.api_key_env : preset.apiKeyEnv;
    currentApiKeyEnv = apiKeyEnvValue;
    const savedForEnv = (globalModels.models ?? []).find((model) => model.api_key_env && model.api_key_env === apiKeyEnvValue);
    const hasSavedKey = savedForEnv?.api_key_saved ?? (usingThisPreset && profile.api_key_saved);
    settingsFields.apiKey = settingField("API Key", "password", {
      placeholder: "粘贴官方 API Key",
      secret: true
    });
    if (hasSavedKey && apiKeyEnvValue) {
      fetchModelSecret(apiKeyEnvValue).then((savedKey) => {
        // 仅当用户还没有手动输入时回填，避免覆盖正在输入的内容。
        if (savedKey && settingsFields.apiKey?.input && !settingsFields.apiKey.input.value) {
          settingsFields.apiKey.input.value = savedKey;
        }
      });
    }
    settingsFields.apiKeyError = document.createElement("div");
    settingsFields.apiKeyError.className = "spd-field-error";
    settingsFields.apiKeyError.hidden = true;

    const keyHint = document.createElement("div");
    keyHint.className = "spd-hint";
    keyHint.textContent = "API Key 仅保存在本机。";

    // 测试连接 状态行：放在密钥字段之后、密码提示之后。
    const connectionStatus = document.createElement("div");
    connectionStatus.id = "settings-connection-status";
    connectionStatus.className = "spd-connection-status";
    connectionStatus.setAttribute("role", "status");
    connectionStatus.setAttribute("aria-live", "polite");
    connectionStatus.dataset.state = connectionState;
    connectionStatus.textContent = "";
    settingsFields.connectionStatus = connectionStatus;

    // 测试连接 button lives next to the API Key field. We attach the click
    // handler below after the field is fully wired.
    const testRow = document.createElement("div");
    testRow.className = "spd-test-row";
    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.id = "settings-test-connection";
    testBtn.className = "spd-test-connection";
    testBtn.textContent = "测试连接";
    testBtn.addEventListener("click", () => { void runConnectionTest(); });
    testRow.append(testBtn);
    settingsFields.testConnectionBtn = testBtn;

    ctx.refs.settingsDetail.append(
      settingsFields.model.field, settingsFields.modelError,
      settingsFields.baseUrl.field, settingsFields.baseUrlError, endpointHint,
      settingsFields.apiKey.field, settingsFields.apiKeyError, keyHint,
      testRow, connectionStatus
    );
    bindEndpointPreview();
    updateEndpointPreview();
    applyConnectionButtonState();
  }

  function applyConnectionButtonState() {
    const testBtn = settingsFields.testConnectionBtn;
    const status = settingsFields.connectionStatus;
    const saveBtn = ctx.refs.settingsSave;
    if (!testBtn || !status) return;
    const busy = connectionState === "testing" || connectionState === "saving";
    testBtn.disabled = busy;
    saveBtn.disabled = busy;
    status.dataset.state = connectionState;
    if (connectionState === "testing") {
      testBtn.textContent = "正在连接…";
      status.textContent = "";
    } else if (connectionState === "saving") {
      testBtn.textContent = "测试连接";
      status.textContent = "";
    } else {
      testBtn.textContent = "测试连接";
    }
  }

  function setConnectionStatusFromResult(result) {
    const status = settingsFields.connectionStatus;
    if (!status) return;
    status.textContent = formatConnectionStatus(result);
    status.dataset.state = result?.ok ? "success" : "failure";
  }

  function clearConnectionStatus() {
    const status = settingsFields.connectionStatus;
    if (status) {
      status.textContent = "";
      status.dataset.state = "idle";
    }
  }

  function applyServerFields(errors) {
    const map = {
      model_name: settingsFields.modelError,
      base_url: settingsFields.baseUrlError,
      api_key: settingsFields.apiKeyError,
    };
    for (const key of Object.keys(map)) {
      const node = map[key];
      if (!node) continue;
      if (errors && typeof errors[key] === "string" && errors[key]) {
        node.textContent = errors[key];
        node.hidden = false;
      } else {
        node.textContent = "";
        node.hidden = true;
      }
    }
  }

  function resetConnectionState() {
    if (connectionAbortController) {
      try { connectionAbortController.abort(); } catch { /* ignore */ }
      connectionAbortController = null;
    }
    connectionState = "idle";
    applyConnectionButtonState();
    clearConnectionStatus();
  }

  async function runConnectionTest() {
    if (settingsSection !== "model") return;
    if (connectionState === "testing" || connectionState === "saving") return;
    applyServerFields(null);
    connectionState = "testing";
    applyConnectionButtonState();
    const controller = new AbortController();
    connectionAbortController = controller;
    const candidate = {
      provider: PROVIDER_PRESETS[SETTINGS_PROVIDERS.find((p) => p.id === settingsProviderId)?.preset ?? "custom"]?.provider ?? "openai-compatible",
      model_name: settingsFields.model.input.value.trim(),
      base_url: settingsFields.baseUrl.input.value.trim(),
      api_key_env: currentApiKeyEnv,
    };
    // Empty key field is intentional: when the user leaves it blank we trust
    // the server-side stored secret for the same env. The server re-checks
    // secrets and returns configuration_missing if neither is available.
    const temporaryKey = settingsFields.apiKey.input.value.trim();
    try {
      const result = await submitModelConnectionTest({
        postJsonImpl,
        // 没有项目也能测连接（Task 5 起服务端不再要求项目）；有项目时带上用于审计事件。
        projectRoot: ctx.getCurrentProjectRoot(),
        active_model: candidate,
        apiKey: temporaryKey,
        signal: controller.signal,
      });
      // Late-arriving guard: another call may have aborted us. Drop the
      // success/failure paint so we don't fight the latest user action.
      if (connectionAbortController !== controller) return;
      connectionState = "success";
      setConnectionStatusFromResult(result);
      applyServerFields(null);
      applyConnectionButtonState();
    } catch (error) {
      if (connectionAbortController !== controller) return;
      if (error?.name === "AbortError") {
        connectionState = "aborted";
        clearConnectionStatus();
      } else {
        connectionState = "failure";
        setConnectionStatusFromResult({ ok: false, message: error?.message ?? "连接失败" });
        if (error?.fields && typeof error.fields === "object") {
          applyServerFields(error.fields);
        }
      }
      applyConnectionButtonState();
    } finally {
      if (connectionAbortController === controller) connectionAbortController = null;
    }
  }

  function settingField(labelText, type, { value = "", placeholder = "", options = null, secret = false, min = null, max = null, step = null } = {}) {
    const field = document.createElement("div");
    field.className = "spd-field";
    const label = document.createElement("div");
    label.className = "spd-label";
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(span);
    field.append(label);
    let input;
    if (type === "select") {
      input = document.createElement("select");
      input.className = "spd-input";
      input.replaceChildren(...(options ?? []).map((opt) => {
        const option = document.createElement("option");
        option.value = opt;
        option.textContent = opt;
        return option;
      }));
      input.value = value ?? "";
    } else if (type === "model-id") {
      input = document.createElement("input");
      input.className = "spd-input";
      input.type = "text";
      input.value = value ?? "";
      input.setAttribute("list", "settings-model-suggestions");
      if (placeholder) input.placeholder = placeholder;
      const suggestions = document.createElement("datalist");
      suggestions.id = "settings-model-suggestions";
      suggestions.replaceChildren(...(options ?? []).map((opt) => {
        const option = document.createElement("option");
        option.value = opt;
        return option;
      }));
      field.append(suggestions);
    } else {
      input = document.createElement("input");
      input.className = "spd-input";
      input.type = type;
      input.value = value ?? "";
      if (placeholder) input.placeholder = placeholder;
      if (min !== null) input.min = min;
      if (max !== null) input.max = max;
      if (step !== null) input.step = step;
    }
    input.setAttribute("aria-label", labelText);
    if (secret) {
      input.setAttribute("autocomplete", "off");
      input.setAttribute("spellcheck", "false");
      const wrap = document.createElement("div");
      wrap.className = "spd-input-wrap";
      wrap.append(input, buildSecretReveal(input), buildSecretCopy(input));
      field.append(wrap);
    } else {
      field.append(input);
    }
    return { field, input };
  }

  function buildSecretReveal(input) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "spd-affix spd-affix-eye";
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", "显示 API Key");
    btn.title = "显示 / 隐藏";
    btn.append(icon("eye", 15));
    btn.addEventListener("click", () => {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      btn.setAttribute("aria-pressed", reveal ? "true" : "false");
      btn.setAttribute("aria-label", reveal ? "隐藏 API Key" : "显示 API Key");
      btn.replaceChildren(icon(reveal ? "eyeOff" : "eye", 15));
    });
    return btn;
  }

  function buildSecretCopy(input) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "spd-affix spd-affix-copy";
    btn.setAttribute("aria-label", "复制 API Key");
    btn.title = "复制到剪贴板";
    btn.append(icon("copy", 15));
    btn.addEventListener("click", async () => {
      const value = input.value;
      if (!value) {
        ctx.showToast("API Key 为空，没有可复制的内容。", "error");
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
        btn.classList.add("copied");
        btn.replaceChildren(icon("check", 15));
        window.setTimeout(() => {
          btn.classList.remove("copied");
          btn.replaceChildren(icon("copy", 15));
        }, 1300);
        ctx.showToast("已复制 API Key 到剪贴板。", "success");
      } catch {
        ctx.showToast("复制失败：未授权访问剪贴板。", "error");
      }
    });
    return btn;
  }

  function bindEndpointPreview() {
    if (settingsFields.baseUrl.input.dataset.boundPreview === "true") return;
    settingsFields.baseUrl.input.addEventListener("input", updateEndpointPreview);
    settingsFields.baseUrl.input.dataset.boundPreview = "true";
  }

  function updateEndpointPreview() {
    const baseUrl = settingsFields.baseUrl.input.value.trim();
    settingsFields.endpointHint.hidden = !baseUrl;
    settingsFields.endpointHint.textContent = baseUrl ? `完整请求地址：${resolveModelEndpoint(baseUrl)}` : "";
  }

  function detectProviderPreset(activeModel = {}) {
    const baseUrl = activeModel.base_url ?? "";
    const envName = activeModel.api_key_env ?? "";
    const modelName = activeModel.model_name ?? "";
    if (baseUrl === PROVIDER_PRESETS.deepseek.baseUrl || envName === PROVIDER_PRESETS.deepseek.apiKeyEnv || modelName.startsWith("deepseek-")) {
      return "deepseek";
    }
    if (baseUrl === PROVIDER_PRESETS.mimo.baseUrl || envName === PROVIDER_PRESETS.mimo.apiKeyEnv || modelName.startsWith("mimo-")) {
      return "mimo";
    }
    return "custom";
  }

  async function saveSettings() {
    if (settingsSection === "writing") {
      await saveWritingSection();
      return;
    }
    if (settingsSection === "danger") {
      // 项目管理动作各自即时生效，不依赖底部保存按钮。
      return;
    }
    if (settingsSection === "skills") {
      // 技能导入/删除/打开目录各自即时生效，不依赖底部保存按钮。
      return;
    }
    await saveModelSection();
  }

  async function saveModelSection() {
    const provider = SETTINGS_PROVIDERS.find((p) => p.id === settingsProviderId) ?? SETTINGS_PROVIDERS[0];
    // 模型切换确认（计划 UI Copy Audit 保留项）：app-server 每次调用重读
    // project.yaml——任务进行中保存设置会静默切换写作模型。仅当「模型确有变更」
    // 且「任务进行中（active Run 或排队输入）」时弹确认；取消则不保存。API Key/
    // 环境变量变更不算模型变更（凭据修复，不改变文风语义）。选用已存模型路径
    // 是显式单点动作，不重复确认（见 selectSavedModel）。
    if (modelSelectionChanged() && await taskInProgress()) {
      if (!confirmImpl(MODEL_SWITCH_CONFIRM_COPY)) {
        ctx.showToast("已取消保存：模型保持不变。", "info");
        return;
      }
    }
    await runSave(async () => {
      // 第一步：模型配置存全局（~/.wwriting/model-profiles.json），不需要项目。
      // 服务端对 ModelConfigValidationError 一律回 400 + fields，postJson 会抛错携带 error.fields，
      // 因此校验失败在这里捕获：逐项标红后继续抛出，由 runSave 兜底 toast 展示服务端原文错误。
      try {
        const activeModelPayload = compactObject({
          provider: PROVIDER_PRESETS[provider.preset].provider,
          model_name: settingsFields.model.input.value.trim(),
          base_url: settingsFields.baseUrl.input.value.trim(),
          api_key: settingsFields.apiKey.input.value.trim(),
          api_key_env: currentApiKeyEnv
        });
        await postJsonImpl("/api/settings/model-profile", {
          active_model: activeModelPayload
        });
      } catch (error) {
        if (error?.fields && typeof error.fields === "object") {
          applyServerFields(error.fields);
        }
        throw error;
      }
      await fetchGlobalModels();
      await ctx.loadDashboard();
    });
  }

  // 模型变更判定：表单新值（model_name/base_url）与打开设置时的已生效模型基线
  // 比较。无基线（无项目且无全局默认）视为变更（防御性）；URL 做尾斜杠归一化，
  // "https://api.deepseek.com" 与 "https://api.deepseek.com/" 不算变更。
  function modelSelectionChanged() {
    const newModelName = settingsFields.model?.input?.value?.trim() ?? "";
    const newBaseUrl = normalizeModelUrl(settingsFields.baseUrl?.input?.value?.trim() ?? "");
    const saved = savedModelRef.current;
    if (!saved) return true;
    return newModelName !== String(saved.model_name ?? "") || newBaseUrl !== normalizeModelUrl(String(saved.base_url ?? ""));
  }

  function normalizeModelUrl(url) {
    return url.replace(/\/+$/u, "").toLowerCase();
  }

  // 任务进行中判定：agent snapshot 显示 active Run（非终态）或排队输入非空。
  // 快照拉取失败（如项目从未打开）按「不在进行中」处理——确认只在能确定有任务时
  // 才弹，避免网络抖动阻塞保存。
  async function taskInProgress() {
    const currentProjectRoot = ctx.getCurrentProjectRoot?.();
    if (!currentProjectRoot) return false;
    try {
      const data = await getJsonImpl(`/api/agent/snapshot?projectRoot=${encodeURIComponent(currentProjectRoot)}&afterSeq=0&limit=1`);
      const session = data?.session ?? null;
      if (!session) return false;
      if (Array.isArray(session.queued_inputs) && session.queued_inputs.length > 0) return true;
      const run = session.active_run;
      if (!run) return false;
      return ["running", "waiting_user", "interrupting", "stopping"].includes(run.status);
    } catch {
      return false;
    }
  }

  async function saveWritingSection() {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot || ctx.getDashboard()?.hasProject !== true) {
      ctx.showToast("请先新建或打开一部小说，再保存写作参数。", "info");
      return;
    }
    await runSave(async () => {
      await postJsonImpl("/api/settings/update", {
        project_profile: compactObject({
          target_chapters: settingsFields.targetChapters.input.value,
          min_words_per_chapter: settingsFields.minWords.input.value,
          target_words_per_chapter: settingsFields.targetWords.input.value,
          max_words_per_chapter: settingsFields.maxWords.input.value
        }),
        output_style: settingsFields.outputStyle?.input?.value ?? "creative"
      });
      await ctx.loadDashboard();
    });
  }

  async function runSave(fn) {
    const seq = ++saveSequence;
    ctx.refs.settingsSave.disabled = true;
    const originalText = ctx.refs.settingsSave.textContent;
    ctx.refs.settingsSave.textContent = "保存中...";
    const previousState = connectionState;
    connectionState = "saving";
    applyConnectionButtonState();
    try {
      await fn();
      // 成功不弹 Toast：先显示「已保存」，短暂停留（700ms）后再关闭弹窗，
      // 保证用户能看到保存反馈。关闭定时器带保存序号，连续保存时旧定时器直接失效。
      ctx.refs.settingsSave.textContent = "已保存";
      window.setTimeout(() => {
        if (seq !== saveSequence) return;
        closeSettingsModal();
        ctx.refs.settingsSave.textContent = originalText;
      }, 700);
    } catch (error) {
      ctx.showToast(error.message, "error");
      // 恢复为规范标签而非 originalText：上一次保存的「已保存」可能尚未到恢复定时器，
      // 失败后不得沿用「已保存」误导用户。
      ctx.refs.settingsSave.textContent = "保存设置";
    } finally {
      ctx.refs.settingsSave.disabled = false;
      connectionState = previousState === "testing" ? "testing" : "idle";
      applyConnectionButtonState();
    }
  }

  function resetToCustom() {
    settingsProviderId = "custom";
    ctx.refs.settingsSearch.value = "";
    renderSettingsProviders();
    renderSettingsDetail();
  }

  return {
    openSettingsModal, closeSettingsModal, renderSettingsProviders, renderSettingsDetail, saveSettings, resetToCustom,
    // 仅供测试：直接回填模型表单字段（避免测试里模拟 DOM 输入）。
    setModelFieldsForTest(values = {}) {
      if (settingsFields.model) settingsFields.model.input.value = values.model_name ?? "";
      if (settingsFields.baseUrl) settingsFields.baseUrl.input.value = values.base_url ?? "";
      if (settingsFields.apiKey) settingsFields.apiKey.input.value = values.api_key ?? "";
      if (values.api_key_env) currentApiKeyEnv = values.api_key_env;
    },
    // 仅供测试：直接触发保存（等价于点「保存设置」）。
    saveSettingsForTest() {
      return saveSettings();
    },
    // 仅供测试：读取左栏已配置模型清单（每项带 modelName / modelId 与按钮节点）。
    getSavedModelItems() {
      return [...ctx.refs.settingsProviderList.children]
        .filter((el) => el.className === "sp-saved-item")
        .map((row) => ({
          modelName: row.dataset.modelName ?? row.dataset.modelId ?? "",
          modelId: row.dataset.modelId ?? "",
          btn: [...row.children].find((c) => c.className === "sp-saved-btn") ?? null,
          del: [...row.children].find((c) => c.className === "sp-saved-del") ?? null
        }));
    },
    // 仅供测试：点击某个已保存模型（等异步选用链完成后返回）。
    async clickSavedModel(modelName) {
      const item = this.getSavedModelItems().find((it) => it.modelName === modelName);
      if (!item?.btn) throw new Error(`未找到已保存模型：${modelName}`);
      item.btn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    // 仅供测试：点击某个已保存模型的删除按钮（等异步删除链完成后返回）。
    async deleteSavedModel(modelName) {
      const item = this.getSavedModelItems().find((it) => it.modelName === modelName);
      if (!item?.del) throw new Error(`未找到已保存模型的删除按钮：${modelName}`);
      item.del.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    // 仅供测试：读取模型表单字段值（api_key_env 是内部密钥槽，不对应可见输入框）。
    getModelFieldValue(fieldName) {
      const byName = {
        model_name: settingsFields.model,
        base_url: settingsFields.baseUrl,
        api_key: settingsFields.apiKey
      };
      return fieldName === "api_key_env" ? currentApiKeyEnv : (byName[fieldName]?.input?.value ?? "");
    },
    // 仅供测试：当前技能管理 scope（"global" | "project"）。
    getSkillsScope() {
      return skillsScope;
    },
    // 仅供测试：切换技能管理 scope 并重渲列表。
    setSkillsScopeForTest(scope) {
      skillsScope = scope === "project" ? "project" : "global";
      skillsRefs.globalBtn?.classList.toggle("on", skillsScope === "global");
      skillsRefs.projectBtn?.classList.toggle("on", skillsScope === "project");
      renderSkillsList();
    },
    // 仅供测试：读取技能列表（name/source/deletable/删除按钮）。
    getSkillsRowsForTest() {
      if (!skillsRefs.list) return [];
      return [...skillsRefs.list.children]
        .filter((el) => el.className === "spd-skill-row")
        .map((row) => ({
          name: row.dataset.skillName ?? "",
          source: row.dataset.skillSource ?? "",
          deletable: [...row.children].some((c) => c.className === "spd-skill-del"),
          del: [...row.children].find((c) => c.className === "spd-skill-del") ?? null
        }));
    },
    // 仅供测试：读取「内置写作风格」只读行（name/readonly/是否有删除按钮/click）。
    getBuiltinStyleRowsForTest() {
      if (!skillsRefs.list) return [];
      return [...skillsRefs.list.children]
        .filter((el) => el.className.includes("spd-skill-row--readonly"))
        .map((row) => ({
          name: row.dataset.skillName ?? "",
          readonly: row.className.includes("--readonly"),
          hasDelete: [...row.children].some((c) => c.className === "spd-skill-del"),
          click: () => row.click()
        }));
    },
    // 仅供测试：等待技能 catalog 拉取完成（fetchSkillsCatalog 是异步的）。
    async waitForSkillsCatalog() {
      await renderSkillsCatalogBody();
    },
    // 仅供测试：读取当前 settings detail 区挂载的子元素（判断分区切换竞态下
    // 内容是否被意外重渲；domRegistry 会累积历史元素，不能用它断言当前挂载）。
    getSettingsDetailForTest() {
      return ctx.refs.settingsDetail;
    }
  };
}
