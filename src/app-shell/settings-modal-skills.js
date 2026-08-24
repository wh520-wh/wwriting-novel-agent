// src/app-shell/settings-modal-skills.js -- 「Agent 技能」分区（第十六轮 T8
// 从 settings-modal.js 拆出，行为不变）。deps 契约（红队审查后补全）：
//   ctx / getJsonImpl / withProjectScope / confirmImpl / deleteJsonImpl /
//   postJsonImpl / skillsRefs -- 原样透传（confirmImpl 等三个是 createSettingsModal
//   的工厂参数，块内有引用）；
//   sectionState  = { get(): 分区代次, bump(): 代次+1 }（计数器归 modal 所有）；
//   skillsScopeState = { get(): 当前 skillsScope, set(v): 设置 }（let 原始值的
//   双向可变共享必须经包装器，传值无效--红队缺陷 2）；
//   bindAddMenuDismissal / removeAddMenuDismissalState -- 添加菜单文档级关闭监听
//   的绑定函数与解除句柄（句柄 let 归 modal 所有：清空历史/脏关闭确认层也要解除，
//   同样必须经包装器共享）。
import { icon } from "./icons.js";

export function createSkillsSection({
  ctx, getJsonImpl, withProjectScope,
  confirmImpl, deleteJsonImpl, postJsonImpl,
  skillsRefs, sectionState, skillsScopeState,
  bindAddMenuDismissal, removeAddMenuDismissalState
}) {
  // 技能 catalog 快照（settings 的 GET /api/skills/catalog）。
  let skillsCatalog = { active: [], shadowed: [], migration_errors: [] };

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
    const generation = sectionState.get();
    try {
      const data = await getJsonImpl(url);
      if (generation !== sectionState.get()) return skillsCatalog;
      if (data?.ok) {
        skillsCatalog = {
          active: Array.isArray(data.active) ? data.active : [],
          shadowed: Array.isArray(data.shadowed) ? data.shadowed : [],
          migration_errors: Array.isArray(data.migration_errors) ? data.migration_errors : []
        };
      }
    } catch (error) {
      if (generation !== sectionState.get()) return skillsCatalog;
      ctx.showToast(error?.message ?? "技能清单加载失败。", "error");
      skillsCatalog = { active: [], shadowed: [], migration_errors: [] };
    }
    return skillsCatalog;
  }

  async function renderSkillsSection() {
    // Task 16 B12：技能详情「返回列表」按钮直接重渲本分区（不经 renderSectionBody），
    // 这里同样推进代次，在途的旧分区异步续作一律丢弃。
    sectionState.bump();
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
    if (skillsScopeState.get() === "project" && !projectRoot) skillsScopeState.set("global");
    const seg = document.createElement("div");
    seg.className = "spd-segmented";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "技能目录范围");
    const globalBtn = document.createElement("button");
    globalBtn.type = "button";
    globalBtn.className = `spd-seg${skillsScopeState.get() === "global" ? " on" : ""}`;
    globalBtn.dataset.scope = "global";
    globalBtn.id = "skills-scope-global";
    globalBtn.textContent = "全局";
    const projectBtn = document.createElement("button");
    projectBtn.type = "button";
    projectBtn.className = `spd-seg${skillsScopeState.get() === "project" ? " on" : ""}`;
    projectBtn.dataset.scope = "project";
    projectBtn.id = "skills-scope-project";
    projectBtn.textContent = "项目";
    projectBtn.disabled = !projectRoot;
    if (!projectRoot) projectBtn.title = "打开项目后才能管理项目技能";
    const setSkillsScope = (scope) => {
      if (skillsScopeState.get() === scope || (scope === "project" && !ctx.getCurrentProjectRoot())) return;
      skillsScopeState.set(scope);
      skillsRefs.globalBtn?.classList.toggle("on", skillsScopeState.get() === "global");
      skillsRefs.projectBtn?.classList.toggle("on", skillsScopeState.get() === "project");
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
    removeAddMenuDismissalState.get()?.();
    removeAddMenuDismissalState.set(bindAddMenuDismissal(addWrap, syncAddMenuAria));
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
    const generation = sectionState.get();
    const catalog = await fetchSkillsCatalog();
    if (generation !== sectionState.get()) return;
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
    const scopeLabel = skillsScopeState.get() === "global" ? "全局" : "项目";
    // F2：无内置只读分区——内置技能与全局/项目技能一样走普通行，按来源标签
    // 归入「其他来源」列表（四层优先级同名覆盖，无保留名）。
    const scoped = catalog.active.filter((skill) => skill.source === skillsScopeState.get());
    const others = catalog.active.filter((skill) => skill.source !== skillsScopeState.get());

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
        desc.textContent = "被更高优先级同名技能覆盖，不生效。";
        main.append(nameLine, desc);
        row.append(main);
        frag.append(row);
      }
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
    const scopeLabel = skillsScopeState.get() === "global" ? "全局" : "项目";
    try {
      await postJsonImpl("/api/skills/import", {
        source_path: sourcePath,
        scope: skillsScopeState.get(),
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
    void reveal(skillsScopeState.get(), ctx.getCurrentProjectRoot() ?? null)
      .then(() => ctx.showToast("已打开技能目录。", "info"))
      .catch(() => ctx.showToast("打开技能目录失败。", "error"));
  }

  async function deleteSkill(name) {
    if (!confirmImpl(`删除技能「${name}」？将删除其目录。`)) return;
    try {
      await deleteJsonImpl(`/api/skills/${encodeURIComponent(name)}`, { scope: skillsScopeState.get() });
      ctx.showToast(`已删除技能：${name}`, "success");
      await renderSkillsCatalogBody();
    } catch (error) {
      ctx.showToast(error?.message ?? "技能删除失败。", "error");
    }
  }

  return { renderSkillsSection, fetchSkillsCatalog, renderSkillsCatalogBody, renderSkillsList };
}
