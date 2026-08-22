import { icon } from "./icons.js";
import { compactObject } from "./utils.js";
import { deleteJson, getJson, postJson, withProjectScope } from "./api-client.js";
import { renderMarkdown } from "./markdown-lite.mjs";
import { motion } from "./motion-runtime.js";

// Re-export so consumers that already `import { ... } from "./settings-modal.js"`
// continue to work. The pure helper itself lives in ./settings-connection.mjs
// so it can be tested without DOM-bound modules. Task 17 cutover：模型区块已整体
// 删除，模型连接提交 helper 不再 re-export（新设置页自行调用 test-connection）。
export { formatConnectionStatus } from "./settings-connection.mjs";

const SETTINGS_SECTIONS = [
  { id: "model", label: "模型设置", icon: "settings", ready: true },
  { id: "writing", label: "写作参数", icon: "compose", ready: true },
  { id: "skills", label: "Agent 技能", icon: "skill", ready: true },
  { id: "danger", label: "项目管理", icon: "folder", ready: true }
];

// 写作参数分区字段注册表（Task 22 审查 Minor 2）：renderWritingSection 渲染、
// saveWritingSection 的 project_profile 提交、settingsDirty 的关闭保护三处共用
// ——新增字段只改这一处。
const WRITING_FIELDS = [
  { key: "targetChapters", projectKey: "target_chapters", label: "目标章节数（提高它可以继续已完成的小说）", type: "number" },
  { key: "minWords", projectKey: "min_words_per_chapter", label: "每章最低字数", type: "number" },
  { key: "targetWords", projectKey: "target_words_per_chapter", label: "每章目标字数", type: "number" },
  { key: "maxWords", projectKey: "max_words_per_chapter", label: "每章字数上限（留空 = 不限，按 target × 1.5 估算）", type: "number" }
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
    // 清除历史/删除/覆盖技能的确认函数（可注入以便测试；默认原生 confirm，桌面场景无需新 UI）。
    confirmImpl = (message) => {
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        return window.confirm(message);
      }
      return true;
    }
  } = options;

  let settingsSection = "model";
  // 保存序号：runSave 的「已保存」关闭定时器带序号，连续保存时旧定时器失效，
  // 不会关闭新弹窗或覆盖新按钮文案。
  let saveSequence = 0;
  // 分区渲染代次（Task 16 B12）：每次分区渲染开始都会推进；异步续作
  //（技能 catalog / 任务门禁 / 技能详情）在 await 后校验代次，慢分区（A）的续作
  // 不得覆写已切换到的新分区（B）内容。
  let sectionGeneration = 0;
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
  // 放弃未保存修改确认层（Task 22 关闭保护）的节点引用与文档级 Esc 监听。
  let dirtyConfirmRef = { layer: null };
  let removeDirtyConfirmDismissal = null;
  const settingsFields = {};

  // section 可选：Agent 斜杠命令可指定打开的分区；缺省打开「模型设置」（model 为首位）。
  async function openSettingsModal(section = "model") {
    settingsSection = SETTINGS_SECTIONS.some((s) => s.id === section) ? section : SETTINGS_SECTIONS[0].id;
    renderSectionNav();
    renderSectionBody();
    ctx.setLastFocused(document.activeElement);
    ctx.refs.settingsScrim.removeAttribute("inert");
    ctx.refs.settingsScrim.classList.add("show");
    motion.openModal(ctx.refs.settingsScrim, document.querySelector("#settings-modal"));
    // Task 22（§6.5 键盘焦点顺序）：打开后焦点移入弹窗内首个可聚焦元素——
    // 否则焦点停留在触发按钮（scrim 外），Tab 可逃出弹窗，focus trap 失效。
    focusFirstInModal();
  }

  // 弹窗内可聚焦元素选择器（Task 22 审查 Minor 4）：focusFirstInModal 与
  // bindModalTabTrap 共用同一选择器与过滤规则，避免两处口径分叉。
  const MODAL_FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])";

  // 弹窗内首个可聚焦元素（nav 分区按钮优先，任意顺序即第一个命中）。
  // 与 bindModalTabTrap 同款过滤：隐藏（offsetParent null）/禁用元素不得接收焦点
  // ——否则窄窗（@media ≤720px 隐藏 .sp-side）下首命中是隐藏 nav 按钮，
  // focus() 静默无效，焦点停留在触发按钮（trap 失效场景）。
  function focusFirstInModal() {
    const first = [...(ctx.refs.settingsScrim.querySelectorAll?.(MODAL_FOCUSABLE) ?? [])]
      .find((el) => !el.disabled && el.offsetParent !== null);
    first?.focus?.();
  }

  // Task 22 focus trap：Tab 在弹窗内循环（首末元素回绕）。挂在 scrim 的 bubble
  // 阶段——嵌套层（添加菜单/清空确认/放弃确认）的 document capture 监听先于
  // 本监听执行并 stopImmediatePropagation，故嵌套层打开时 Tab 不受弹窗级回绕
  // 干扰；弹窗关闭（非 show）时不拦截，不触碰 AgentSurface 的键盘路由。
  function bindModalTabTrap() {
    if (typeof ctx.refs.settingsScrim?.addEventListener !== "function") return null;
    const onKeydown = (event) => {
      if (event?.key !== "Tab") return;
      if (!ctx.refs.settingsScrim.classList.contains("show")) return;
      const focusables = [...(ctx.refs.settingsScrim.querySelectorAll?.(MODAL_FOCUSABLE) ?? [])]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (focusables.length === 0) { event.preventDefault?.(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault?.();
        event.stopPropagation?.();
        last.focus?.();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault?.();
        event.stopPropagation?.();
        first.focus?.();
      }
    };
    ctx.refs.settingsScrim.addEventListener("keydown", onKeydown);
    return () => ctx.refs.settingsScrim.removeEventListener?.("keydown", onKeydown);
  }
  bindModalTabTrap();

  // Task 22 弹窗级 Escape：挂在 scrim 的 bubble 阶段。嵌套层的 document capture
  // 监听先于本监听执行（capture 先于 bubble）且 stopImmediatePropagation，故 Esc
  // 仍只作用于最上层（先关添加菜单/确认层）；本监听处理「弹窗自身」的 Esc——
  // dirty 时先走确认层（closeSettingsModal 内守卫），clean 时直接关闭，并阻断
  // 全局路由（app.js）与 AgentSurface 的 Run 停止。
  function bindModalScrimDismissal() {
    if (typeof ctx.refs.settingsScrim?.addEventListener !== "function") return null;
    const onKeydown = (event) => {
      if (event?.key !== "Escape") return;
      if (!ctx.refs.settingsScrim.classList.contains("show")) return;
      closeSettingsModal();
      event.stopPropagation?.();
      event.preventDefault?.();
    };
    ctx.refs.settingsScrim.addEventListener("keydown", onKeydown);
    return () => ctx.refs.settingsScrim.removeEventListener?.("keydown", onKeydown);
  }
  bindModalScrimDismissal();

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

  // Round10：footer 状态槽——即时生效分区显示状态文字，不再把「无需保存」伪装成
  // 禁用主按钮；真实保存动作（runSave）仍只管理 settingsSave 按钮的 disabled/文案。
  // saveInFlight 标记：保存在途时切分区再回来，不得把「保存中...」按钮重新启用。
  let saveInFlight = false;

  function setFooterMode({ save = false, status = "" } = {}) {
    ctx.refs.settingsSave.hidden = !save;
    ctx.refs.settingsSave.disabled = !save || saveInFlight;
    ctx.refs.settingsSaveStatus.hidden = save || status === "";
    ctx.refs.settingsSaveStatus.textContent = save ? "" : status;
  }

  function renderSectionBody() {
    // Task 16 B12：分区切换/重渲推进代次——在途的旧分区异步续作一律丢弃。
    sectionGeneration += 1;
    if (settingsSection === "model") {
      // 模型分区：与 writing/skills/danger 同形态——renderSectionBody 构建本分区 DOM，
      // 把供应商列表/详情容器被注入的 modelSettings（model-settings-page）作为渲染目标。
      // 无整页宿主、无 restore 钩子：更换分区时 replaceChildren 直接覆盖模型 DOM，
      // 下次进入 model 分区重建（模型页不持有弹窗内外任何剩余引用）。
      const detail = ctx.refs.settingsDetail;
      detail.replaceChildren();
      const section = document.createElement("div");
      section.className = "model-section";
      const h2 = document.createElement("h2");
      h2.textContent = "模型设置";
      const lead = document.createElement("p");
      lead.className = "model-section-lead";
      lead.textContent = "管理自定义模型供应商，配置后可在聊天时选择使用。";
      const body = document.createElement("div");
      body.className = "model-settings-body";
      const list = document.createElement("aside");
      list.setAttribute("data-provider-list", "");
      const det = document.createElement("section");
      det.setAttribute("data-provider-detail", "");
      body.append(list, det);
      section.append(h2, lead, body);
      detail.append(section);
      if (typeof ctx.modelSettings?.attach === "function") {
        ctx.modelSettings.attach({ list, detail: det });
      }
      setFooterMode({ status: "更改即时生效" });
      if (typeof ctx.modelSettings?.open === "function") {
        void ctx.modelSettings.open();
      }
      return;
    }
    if (settingsSection === "writing") {
      if (ctx.getDashboard()?.hasProject === true) {
        void renderWritingSection();
        setFooterMode({ save: true });
      } else {
        // 普通文件夹没有 project.yaml，写作参数无可读写对象：只显示说明，
        // footer 显示「此分区无需保存」，避免出现无法生效的保存按钮。
        renderLegacyOnlySection("compose", "写作参数", "写作参数仅旧版小说项目可用。");
        setFooterMode({ status: "此分区无需保存" });
      }
      return;
    }
    if (settingsSection === "skills") {
      // 技能动作各自即时生效，不依赖底部保存按钮。
      void renderSkillsSection();
      setFooterMode({ status: "更改即时生效" });
      return;
    }
    if (settingsSection === "danger") {
      if (ctx.getDashboard()?.hasProject === true) {
        renderDangerSection();
        setFooterMode({ status: "更改即时生效" });
      } else {
        renderLegacyOnlySection("bolt", "项目管理", "项目管理仅旧版小说项目可用。");
        setFooterMode({ status: "此分区无需保存" });
      }
      return;
    }
  }

  // 旧版小说项目专属分区（写作参数/项目管理）在普通文件夹（hasProject:false）
  // 下无可操作内容：渲染头部 + 简短 muted 说明。与 renderSectionBody 的
  // setFooterMode({ status: "此分区无需保存" }) 配合，确保不会出现「点了保存却
  // 落空」的死角入口。
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
    intro.textContent = "控制每章的篇幅与目标章节数。";
    ctx.refs.settingsDetail.append(intro);

    for (const field of WRITING_FIELDS) {
      settingsFields[field.key] = settingField(field.label, field.type, {
        value: project[field.projectKey] ?? ""
      });
    }

    ctx.refs.settingsDetail.append(
      settingsFields.targetChapters.field,
      settingsFields.minWords.field,
      settingsFields.targetWords.field,
      settingsFields.maxWords.field
    );
  }

  function renderDangerSection() {
    // Task 16 B12：refreshArchivedSessions 会直接重渲本分区（不经 renderSectionBody），
    // 这里同样推进代次，在途的旧分区异步续作一律丢弃。
    sectionGeneration += 1;
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
    // Task 16 B12：await 后校验分区代次——慢快照返回时若已切到其他分区/重渲，
    // 不把旧结果写进新渲染的按钮（historyRefs 已指向新节点）。
    const generation = sectionGeneration;
    const busy = await taskInProgress();
    if (generation !== sectionGeneration) return;
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
    // Task 16：捕获分区代次——慢请求在途期间用户切走/重渲，迟到响应不得弹
    // 「技能清单加载失败」误导 toast，也不得覆写 skillsCatalog 快照。
    const generation = sectionGeneration;
    try {
      const data = await getJsonImpl(url);
      if (generation !== sectionGeneration) return skillsCatalog;
      if (data?.ok) {
        skillsCatalog = {
          active: Array.isArray(data.active) ? data.active : [],
          shadowed: Array.isArray(data.shadowed) ? data.shadowed : [],
          migration_errors: Array.isArray(data.migration_errors) ? data.migration_errors : []
        };
      }
    } catch (error) {
      if (generation !== sectionGeneration) return skillsCatalog;
      ctx.showToast(error?.message ?? "技能清单加载失败。", "error");
      skillsCatalog = { active: [], shadowed: [], migration_errors: [] };
    }
    return skillsCatalog;
  }

  async function renderSkillsSection() {
    // Task 16 B12：技能详情「返回列表」按钮直接重渲本分区（不经 renderSectionBody），
    // 这里同样推进代次，在途的旧分区异步续作一律丢弃。
    sectionGeneration += 1;
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
    // Task 22（#2）：popover 声明 menu 角色，选项声明 menuitem——触发按钮已有
    // aria-haspopup/aria-expanded，组合成完整的菜单语义。
    addMenu.setAttribute("role", "menu");
    const folderOpt = document.createElement("button");
    folderOpt.type = "button";
    folderOpt.id = "skills-add-folder";
    folderOpt.setAttribute("role", "menuitem");
    folderOpt.textContent = "从文件夹导入…";
    folderOpt.addEventListener("click", () => {
      addWrap.classList.remove("open");
      syncAddMenuAria();
      void addSkillFromFolder();
    });
    const zipOpt = document.createElement("button");
    zipOpt.type = "button";
    zipOpt.id = "skills-add-zip";
    zipOpt.setAttribute("role", "menuitem");
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
    // Task 16 B12：await 后校验分区代次——慢 catalog 响应不得把旧列表灌进
    // 已切换/重渲的分区。
    const generation = sectionGeneration;
    const catalog = await fetchSkillsCatalog();
    if (generation !== sectionGeneration) return;
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
    // Task 16 B12：await 后校验分区代次——慢详情响应不得把技能详情正文覆盖到
    // 已切换的其他分区。
    const generation = sectionGeneration;
    try {
      const url = withProjectScope(`/api/skills/${encodeURIComponent(name)}`, ctx.getCurrentProjectRoot());
      const data = await getJsonImpl(url);
      if (generation !== sectionGeneration) return;
      if (!data?.ok) throw new Error(data?.message ?? "技能详情加载失败。");
      renderReadonlySkillDetail(name, data.content);
    } catch (error) {
      if (generation !== sectionGeneration) return;
      ctx.showToast(error?.message ?? "技能详情加载失败。", "error");
    }
  }

  function renderReadonlySkillDetail(name, content) {
    // Task 16 B12：详情视图整体替换分区内容，同样推进代次——在途的技能列表
    // catalog 续作不再渲染进已替换的详情视图。
    sectionGeneration += 1;
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
    // Task 22（#9）：关闭保护——写作参数有未保存修改时先弹确认层，绝不静默丢失。
    // 关闭路径统一经此守卫（app.js 的 X/取消/遮罩/Esc 与保存成功后的自动关闭
    // 都调用本函数）；保存成功时 dashboard 已刷新，dirty 判定自然为 false。
    if (settingsDirty() && !dirtyConfirmRef.layer && ctx.refs.settingsScrim.classList.contains("show")) {
      openDirtyCloseConfirm();
      return;
    }
    performCloseSettingsModal();
  }

  // 真正关闭（确认放弃/无未保存修改时）：清空确认层 + 关闭动画 + 恢复原焦点。
  function performCloseSettingsModal() {
    // 清空确认层随设置弹窗一起关闭（X/关闭/遮罩/Esc 任一路径都先关嵌套层）。
    closeClearHistoryConfirm();
    closeDirtyCloseConfirm();
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

  // Task 22：分区是否有未保存修改。写作分区认表单值；模型分区（v4/A4）委派给
  // modelSettings.isDirty 判定「未失焦草稿 + 保存在途/失败」——两分区都只在各自
  // 仍为当前分区且弹窗开着时判定（分区切换 replaceChildren 会重建/丢弃草稿）。
  // 其余分区动作即时生效，无可挂起表单值，不判 dirty。
  function settingsDirty() {
    if (settingsSection === "model") {
      return typeof ctx.modelSettings?.isDirty === "function" && ctx.modelSettings.isDirty();
    }
    if (settingsSection !== "writing") return false;
    const dashboard = ctx.getDashboard();
    if (dashboard?.hasProject !== true) return false;
    const project = dashboard.project ?? {};
    for (const field of WRITING_FIELDS) {
      const input = settingsFields[field.key]?.input;
      if (!input) continue;
      if (String(input.value ?? "").trim() !== String(project[field.projectKey] ?? "").trim()) return true;
    }
    return false;
  }

  // 放弃未保存修改确认层（Task 22）：复用 spd-confirm-layer/spd-confirm-card
  // 确认控件结构（与清空历史确认层同款），不调用 browser confirm。
  function openDirtyCloseConfirm() {
    if (dirtyConfirmRef.layer) return;
    removeAddMenuDismissal?.();

    const layer = document.createElement("div");
    layer.className = "spd-confirm-layer";
    layer.id = "close-dirty-confirm";
    layer.hidden = false;
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      zIndex: "21",
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
    title.textContent = "放弃未保存的修改？";

    const copy = document.createElement("p");
    copy.className = "spd-confirm-copy spd-hint";
    copy.style.margin = "0";
    copy.textContent = "写作参数有未保存的修改，关闭后将丢失。";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "10px";
    const cancelBtn = actionButton("取消", () => closeDirtyCloseConfirm());
    cancelBtn.id = "close-dirty-cancel";
    const confirmBtn = actionButton("不保存并关闭", () => {
      closeDirtyCloseConfirm();
      performCloseSettingsModal();
    });
    confirmBtn.id = "close-dirty-confirm-btn";
    actions.append(cancelBtn, confirmBtn);

    card.append(title, copy, actions);
    layer.append(card);
    ctx.refs.settingsScrim.append(layer);

    dirtyConfirmRef.layer = layer;
    removeDirtyConfirmDismissal = bindNestedLayerDismissal({
      isOpen: () => dirtyConfirmRef.layer !== null && ctx.refs.settingsScrim.classList.contains("show"),
      close: closeDirtyCloseConfirm
    });
    // 点击确认层背景（卡片外部）关闭本层，不触碰弹窗级处理器。
    layer.addEventListener("click", (event) => {
      if (event?.target === layer) closeDirtyCloseConfirm();
    });
    cancelBtn.focus();
  }

  function closeDirtyCloseConfirm() {
    removeDirtyConfirmDismissal?.();
    removeDirtyConfirmDismissal = null;
    if (!dirtyConfirmRef.layer) return;
    dirtyConfirmRef.layer.replaceChildren();
    dirtyConfirmRef.layer.hidden = true;
    dirtyConfirmRef.layer = null;
  }


  function settingField(labelText, type, { value = "", placeholder = "", options = null, min = null, max = null, step = null } = {}) {
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
    field.append(input);
    return { field, input };
  }

  async function saveSettings() {
    if (settingsSection === "model") {
      // 模型动作各自即时生效，不依赖底部保存按钮（footer 显示「更改即时生效」状态槽）。
      return;
    }
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
  }

  // 任务进行中判定：agent snapshot 显示 active Run（非终态）或排队输入非空。
  // 快照拉取失败（如项目从未打开）按「不在进行中」处理——危险分区清空按钮据此
  // 门禁（Task 13），只读判定不写任何状态。
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
      const projectProfile = {};
      for (const field of WRITING_FIELDS) {
        projectProfile[field.projectKey] = settingsFields[field.key]?.input.value;
      }
      await postJsonImpl("/api/settings/update", {
        project_profile: compactObject(projectProfile)
      });
      await ctx.loadDashboard();
    });
  }

  async function runSave(fn) {
    const seq = ++saveSequence;
    saveInFlight = true;
    ctx.refs.settingsSave.disabled = true;
    const originalText = ctx.refs.settingsSave.textContent;
    ctx.refs.settingsSave.textContent = "保存中...";
    try {
      await fn();
      // 成功不弹 Toast：先显示「已保存」，短暂停留（700ms）后再关闭弹窗，
      // 保证用户能看到保存反馈。关闭定时器带保存序号，连续保存时旧定时器直接失效。
      if (seq !== saveSequence) return; // Task 16 B18：旧 save 不得接管按钮（新 save 在途）
      ctx.refs.settingsSave.textContent = "已保存";
      window.setTimeout(() => {
        if (seq !== saveSequence) return;
        closeSettingsModal();
        ctx.refs.settingsSave.textContent = originalText;
      }, 700);
    } catch (error) {
      // Task 16 B18：只有仍是最新 save 才收尾——旧 save 的迟到失败不弹 toast、
      // 不覆盖新 save 的「保存中.../已保存」文案。
      if (seq !== saveSequence) return;
      ctx.showToast(error.message, "error");
      // 恢复为规范标签而非 originalText：上一次保存的「已保存」可能尚未到恢复定时器，
      // 失败后不得沿用「已保存」误导用户。
      ctx.refs.settingsSave.textContent = "保存设置";
    } finally {
      // Task 16 B18：条件化收尾——只有仍是最新 save 才恢复按钮；旧 finally 不得
      // 在更新 save 仍在途时重新启用按钮（覆盖新 save 的禁用态）。
      if (seq === saveSequence) {
        ctx.refs.settingsSave.disabled = false;
        saveInFlight = false;
      }
    }
  }

  return {
    openSettingsModal, closeSettingsModal, saveSettings,
    // 仅供测试：读取当前分区。
    currentSettingsSection: () => settingsSection,
    // 仅供测试：直接触发保存（等价于点「保存设置」）。
    saveSettingsForTest() {
      return saveSettings();
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
