// src/app-shell/session-sidebar.mjs —— 左侧栏两级树：项目折叠组 → 会话列表（Task 9）。
//
// 职责边界（app.js 只做薄接线）：
//   - 渲染项目行（经 renderProjectRow 回调，app.js 保留 renderProjectNav 与其
//     折叠箭头装饰）+ 展开态下的会话组：会话组直接以会话行开始（组头与「+」已
//     移除，加号移入项目行，R4）；
//   - 折叠状态 localStorage 持久化（key wwriting:projects:collapsed，默认展开）；
//   - 懒加载：当前项目会话来自 dashboard seed（不重复拉），展开其他未缓存项目时
//     懒调 fetchSessions(projectRoot) 并缓存（内存 Map，本次会话内不重复拉）；
//   - 会话操作委托 surface（switchSession / newSessionPlaceholder / renameSession /
//     archiveSession / setBusy），draft 占位特判（status === "draft"）；
//   - busy 复位（Task 8 契约）：列表刷新时检查当前项目其他会话 run_status，
//     有 running → setBusy(true)，全部非 running → setBusy(false)；
//   - 会话级代次守卫（防串场）：镜像 app.js 的 projectScope.capture 机制——
//     commitSessionSwitch 捕获 { projectRoot, generation }，慢切换/慢刷新到达时若
//     已切到别的项目/会话则丢弃后续动作。projectScope 守卫 dashboard 拉取（项目级），
//     本守卫覆盖会话级切换。
import { icon } from "./icons.js";
import { formatNumber, pathEquals } from "./utils.js";

const COLLAPSED_STORAGE_KEY = "wwriting:projects:collapsed";
// busy 周期刷新间隔：其他会话的运行终态不沿本会话 SSE 流到达（事件流按当前会话
// 订阅），busy=true 时由该定时器兜底重拉会话列表，保证其他会话结束后发送键能复位。
const BUSY_REFRESH_INTERVAL_MS = 5000;

const RUN_STATUS_LABELS = {
  running: "运行中",
  failed: "失败",
  idle: "待命"
};

export function createSessionSidebar({
  listEl,
  countEl = null,
  filterEl = null,
  scrollEl = null,
  getProjectListData,
  getCurrentProjectRoot,
  fetchSessions,
  renderProjectRow,
  surface,
  showToast = () => {},
  promptDialog = globalThis.prompt,
  storage = globalThis.localStorage,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
  openProjectAndSession = async () => {},
  doc = globalThis.document
}) {
  const collapsedByRoot = loadCollapsed();
  const sessionCache = new Map(); // projectRoot -> { sessions, activeSessionId }
  const pendingFetches = new Map(); // projectRoot -> Promise（并发展开去重）
  const failedRoots = new Set(); // 懒拉取/dashboard seed 失败的项目（显示失败行，可重试）
  const groupEls = new Map(); // projectRoot -> .session-group 元素（定向重渲）
  let archivedExpanded = false;
  let sessionSwitchGeneration = 0;
  let busyRefreshTimer = null; // busy=true 时的周期刷新定时器（见 startBusyRefresh）
  let busyRefreshInFlight = false; // 在途刷新标记：跳过重叠 tick

  // ---- 折叠状态（localStorage 持久化；损坏/不可用回退默认展开） ----
  function loadCollapsed() {
    try {
      const raw = storage?.getItem?.(COLLAPSED_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // localStorage 不可用/JSON 损坏：默认全部展开
    }
    return {};
  }
  function persistCollapsed() {
    try {
      storage?.setItem?.(COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedByRoot));
    } catch {
      // 持久化失败忽略（会话内仍生效）
    }
  }
  function isCollapsed(projectRoot) {
    return collapsedByRoot[projectRoot] === true;
  }
  function setCollapsed(projectRoot, value) {
    if (value) collapsedByRoot[projectRoot] = true;
    else {
      delete collapsedByRoot[projectRoot];
      failedRoots.delete(projectRoot); // 重新展开 = 重试（懒拉失败恢复路径）
    }
    persistCollapsed();
    render();
  }
  function toggleCollapsed(projectRoot) {
    setCollapsed(projectRoot, !isCollapsed(projectRoot));
  }

  // ---- busy 周期刷新（规格审查修复） ----
  // 背景：SSE 事件流按当前会话订阅，其他会话的运行终态事件不会到达本会话流，
  // onRunTerminal 只在当前会话的 run 结束时触发。busy=true（其他会话运行中）时若
  // 只依赖终态通知复位，发送键可能永久禁用——这是多会话常态路径（切到 B 后 A 结束）。
  // 因此 busy 置 true 时启动周期刷新兜底：每 5s 重拉会话列表，经 onSessionsChanged
  // → handleSessionsChanged → syncBusy 重新推导，其他会话终态后自然复位。在途刷新
  // 跳过 tick 避免重叠；surface.refreshSessions 内部已有项目/会话代次守卫，迟到响应
  // 不会污染当前视图。
  function startBusyRefresh() {
    if (busyRefreshTimer != null) return;
    busyRefreshTimer = setIntervalFn(() => {
      if (busyRefreshInFlight) return;
      busyRefreshInFlight = true;
      Promise.resolve(surface.refreshSessions?.()).catch(() => {}).finally(() => {
        busyRefreshInFlight = false;
      });
    }, BUSY_REFRESH_INTERVAL_MS);
  }
  function stopBusyRefresh() {
    if (busyRefreshTimer != null) {
      clearIntervalFn(busyRefreshTimer);
      busyRefreshTimer = null;
    }
  }

  // ---- 会话级代次守卫（防串场；镜像 projectScope.capture 的 token 形状） ----
  function captureSessionToken() {
    return { projectRoot: getCurrentProjectRoot(), generation: sessionSwitchGeneration };
  }
  function isSessionCurrent(token) {
    return token.projectRoot === getCurrentProjectRoot() && token.generation === sessionSwitchGeneration;
  }
  // app.js 在项目切换（commitProjectSwitch）时调用：在途会话切换的续作一律丢弃。
  function invalidateProject() {
    sessionSwitchGeneration += 1;
    stopBusyRefresh(); // 项目切换：busy 由 surface.openProject 重置，下次刷新重新推导
  }

  function findProject(projectRoot) {
    const data = getProjectListData();
    return data?.projects?.find((p) => p.projectRoot === projectRoot) ?? null;
  }

  // ---- 整表渲染 ----
  function render() {
    const data = getProjectListData();
    if (!data) {
      listEl.replaceChildren();
      return;
    }
    const query = String(filterEl?.value ?? "").trim().toLowerCase();
    const filtered = query
      ? data.projects.filter((project) =>
          [project.title, project.story_seed, project.model_label].some((text) =>
            String(text ?? "").toLowerCase().includes(query)
          )
        )
      : data.projects;
    const active = filtered.filter((p) => !p.archived_at);
    const archived = filtered.filter((p) => p.archived_at);
    if (countEl) countEl.textContent = formatNumber(filtered.length);
    const parts = [];
    for (const project of active) {
      const row = renderProjectRow(project);
      row.classList.add("proj-sessioned");
      decorateRow(row, project);
      parts.push(row);
      if (!isCollapsed(project.projectRoot)) parts.push(renderSessionGroup(project));
    }
    if (archived.length > 0) {
      parts.push(renderArchivedToggle(archived.length));
      if (archivedExpanded) {
        for (const project of archived) {
          const row = renderProjectRow(project);
          row.classList.add("proj-archived");
          parts.push(row);
        }
      }
    }
    if (parts.length === 0) parts.push(projEmptyRow(query ? "没有匹配的小说。" : "还没有小说"));
    listEl.replaceChildren(...parts);
  }

  // 项目行装饰：折叠箭头（role=button + aria-expanded）+ .proj 主体点击折叠/展开。
  // 项目不可选中（R3/B1）：点击行主体只折叠/展开会话列表，不再触发项目切换；
  // 切换项目唯一入口 = 点击其他项目的会话行（app.js 委托 openProjectAndSession）。
  function decorateRow(row, project) {
    const collapsed = isCollapsed(project.projectRoot);
    const chevron = doc.createElement("span");
    chevron.className = "proj-chevron";
    chevron.setAttribute("role", "button");
    chevron.setAttribute("tabindex", "0");
    chevron.setAttribute("aria-expanded", collapsed ? "false" : "true");
    chevron.title = collapsed ? "展开对话列表" : "收起对话列表";
    // 可访问名以 aria-label 为准（title 仅作 tooltip）。
    chevron.setAttribute("aria-label", collapsed ? "展开对话列表" : "收起对话列表");
    chevron.append(icon("chevR", 14, null, doc));
    chevron.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCollapsed(project.projectRoot);
    });
    chevron.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleCollapsed(project.projectRoot);
      }
    });
    row.appendChild(chevron);
    const body = row.querySelector(".proj") ?? row;
    body.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCollapsed(project.projectRoot);
    });
  }

  // 已归档项目折叠组（沿用 Task 12 之前的行为：折叠/展开切换 + 列表）。
  function renderArchivedToggle(count) {
    const toggle = doc.createElement("div");
    toggle.className = "rail-group-label rail-archived-toggle";
    toggle.setAttribute("role", "button");
    toggle.setAttribute("tabindex", "0");
    const labelSpan = doc.createElement("span");
    labelSpan.textContent = "已归档";
    const countSpan = doc.createElement("span");
    countSpan.className = "count";
    countSpan.textContent = String(count);
    toggle.append(labelSpan, countSpan);
    const toggleArchived = () => {
      archivedExpanded = !archivedExpanded;
      render();
    };
    toggle.addEventListener("click", toggleArchived);
    toggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleArchived();
      }
    });
    return toggle;
  }

  // ---- 会话组 ----
  function renderSessionGroup(project) {
    const root = project.projectRoot;
    const group = groupEls.get(root) ?? doc.createElement("div");
    if (!groupEls.has(root)) {
      group.className = "session-group";
      group.dataset.projectRoot = root;
      groupEls.set(root, group);
    }
    group.replaceChildren(...buildSessionGroupChildren(root));
    return group;
  }

  function buildSessionGroupChildren(root) {
    const parts = [];
    const entry = sessionCache.get(root);
    if (entry) {
      const visible = entry.sessions.filter((session) => session.status === "draft" || !session.archived_at);
      for (const session of visible) parts.push(renderSessionRow(session, entry.activeSessionId, root));
      if (visible.length === 0) parts.push(emptyRow("还没有对话"));
    } else if (failedRoots.has(root)) {
      // dashboard seed 失败与懒拉失败共用降级行（可点击重试）。
      parts.push(renderFailedRow(root));
    } else if (root === getCurrentProjectRoot()) {
      // 当前项目：数据源是 dashboard（loadDashboard 完成后 seedSessions 定向补渲）。
      // 这里不懒拉——避免与 dashboard 数据竞态重复请求；dashboard 失败时经
      // markSessionsFailed 降级为失败行，点击重试走 ensureSessions 直拉。
      parts.push(loadingRow());
    } else if (pendingFetches.has(root)) {
      parts.push(loadingRow());
    } else {
      parts.push(loadingRow());
      loadSessions(root);
    }
    return parts;
  }

  // 懒拉取 + 完成后定向重渲（成功清除失败标记 / 失败打标）。fetch 在途时
  // ensureSessions 返回同一 promise，重入安全（pendingFetches 去重）。
  function loadSessions(root) {
    void ensureSessions(root).then(() => {
      failedRoots.delete(root);
      rerenderGroup(root);
    }).catch(() => {
      failedRoots.add(root);
      rerenderGroup(root);
    });
  }

  // 会话加载失败降级行（可点击重试；dashboard seed 失败与懒拉失败共用）。
  function renderFailedRow(root) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "session-retry";
    btn.title = "重新加载对话列表";
    // 可访问名以 aria-label 为准（textContent 同名，双保险）。
    btn.setAttribute("aria-label", "会话加载失败，点击重试");
    btn.textContent = "会话加载失败，点击重试";
    btn.addEventListener("click", () => retrySessions(root));
    return btn;
  }

  function retrySessions(root) {
    failedRoots.delete(root);
    rerenderGroup(root); // 立即回到加载中
    loadSessions(root);
  }

  // 定向重渲某项目的会话组（onSessionsChanged / 懒加载完成时；沿用 refreshDrawerIfOpen
  // 的保滚动思路——重渲前后保持滚动容器 scrollTop）。组已不在 DOM（折叠/被过滤）则跳过。
  function rerenderGroup(root) {
    const group = groupEls.get(root);
    if (!group || !group.parentNode) return;
    const project = findProject(root);
    if (!project) return;
    const scrollTop = scrollEl?.scrollTop ?? null;
    renderSessionGroup(project);
    if (scrollTop != null && scrollEl) scrollEl.scrollTop = scrollTop;
  }

  // ---- 会话行 ----
  function renderSessionRow(session, activeSessionId, ownerRoot) {
    const isDraft = session.status === "draft";
    const isActive = !isDraft && session.session_id === activeSessionId;
    const row = doc.createElement("div");
    row.className = `session-row${isActive ? " active" : ""}${isDraft ? " session-draft" : ""}`;
    row.dataset.sessionId = session.session_id;
    // 可访问铁律：会话行与项目行（真实 <button class="proj">）同构——role=button +
    // tabindex=0 + Enter/Space 触发同一 commitSessionSwitch（行内含改名/归档按钮，
    // 不能嵌套真实 button，用 role=button；与 rail-archived-toggle 同款先例）。
    // draft 占位是不可交互项：aria-disabled + 移出 Tab 序（点击/Enter 均留在占位）。
    row.setAttribute("role", "button");
    if (isDraft) {
      row.setAttribute("aria-disabled", "true");
      row.setAttribute("tabindex", "-1");
    } else {
      row.setAttribute("tabindex", "0");
    }

    const runStatus = isDraft ? "idle" : (session.run_status ?? "idle");
    const dot = doc.createElement("span");
    dot.className = "session-status";
    dot.dataset.status = runStatus;
    dot.title = RUN_STATUS_LABELS[runStatus] ?? "待命";
    dot.setAttribute("aria-hidden", "true");

    const title = doc.createElement("span");
    title.className = "session-title";
    title.textContent = isDraft ? "新对话" : (session.title ?? "新对话");

    const menu = doc.createElement("div");
    menu.className = "session-menu";
    menu.append(sessionOp("compose", "重命名", () => renameSession(session), isDraft));
    menu.append(sessionOp("trash", "归档", () => archiveSession(session), isDraft));

    row.append(dot, title, menu);
    row.addEventListener("click", () => {
      if (isDraft) return; // 点击占位项 = 留在占位视图
      commitSessionSwitch(session.session_id, ownerRoot);
    });
    row.addEventListener("keydown", (event) => {
      // 仅行自身聚焦时响应（改名/归档按钮的 keydown 冒泡到这里必须忽略，
      // 否则在操作按钮上按 Enter 会误触发会话切换）。
      if (event.target !== row) return;
      if (isDraft) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); // 防 Space 滚动
        commitSessionSwitch(session.session_id, ownerRoot);
      }
    });
    return row;
  }

  function sessionOp(iconName, label, action, disabled) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = `session-op session-op-${iconName}`;
    btn.append(icon(iconName, 14, null, doc));
    btn.disabled = disabled;
    if (label) {
      btn.title = label;
      btn.setAttribute("aria-label", label);
    }
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (btn.disabled) return;
      action();
    });
    return btn;
  }

  // ---- 会话操作 ----
  function commitSessionSwitch(sessionId, ownerRoot = null) {
    sessionSwitchGeneration += 1; // 每次切换都推进代次：旧切换的续作一律丢弃
    const token = captureSessionToken();
    if (ownerRoot && !pathEquals(ownerRoot, token.projectRoot)) {
      // 跨项目：全流程打开目标项目并激活目标会话（内部完成 commitProjectSwitch →
      // invalidateProject 推进代次，token 已失效，无需续作刷新）
      return Promise.resolve(openProjectAndSession(ownerRoot, sessionId)).catch(() => {});
    }
    // 切走 draft 占位：surface 在 switchSession 内部已刷新一次列表（agent/index.js
    // 的切走收尾 prevDraft 分支），这里跳过续作刷新避免双刷；其余切换仍需 app 侧
    // 刷新（Task 8 契约：surface 不自动拉）。活跃指针取自会话缓存（与渲染同源）。
    const leavingEntry = sessionCache.get(token.projectRoot);
    const leavingDraft = leavingEntry?.activeSessionId != null &&
      leavingEntry.sessions.some(
        (s) => s.session_id === leavingEntry.activeSessionId && s.status === "draft"
      );
    return Promise.resolve(surface.switchSession(sessionId)).then(() => {
      // 防串场：慢切换/慢刷新在途期间用户已切到别的项目/会话 → 丢弃后续动作
      //（列表活跃高亮 + busy 复位由下一次刷新承担）。
      if (!isSessionCurrent(token)) return;
      if (!leavingDraft) surface.refreshSessions();
    }).catch(() => {
      // 切换失败不阻塞：surface 内部已有错误处理（保留当前会话视图）
    });
  }

  async function renameSession(session) {
    if (typeof promptDialog !== "function") return;
    const title = promptDialog("重命名对话", session.title ?? "");
    if (title == null) return; // 用户取消
    const trimmed = String(title).trim();
    if (!trimmed) return; // 空标题忽略（registry 拒绝空标题）
    try {
      await surface.renameSession(session.session_id, trimmed);
      showToast(`已重命名为「${trimmed}」`, "success");
    } catch (error) {
      showToast(error?.message ?? "重命名失败", "error");
    }
  }

  async function archiveSession(session) {
    try {
      await surface.archiveSession(session.session_id);
      showToast(`已归档对话 ${session.title ?? "新对话"}`, "success");
    } catch (error) {
      showToast(error?.message ?? "归档失败", "error");
    }
  }

  // ---- 懒加载（内存缓存，本次会话内不重复拉） ----
  function ensureSessions(projectRoot) {
    const cached = sessionCache.get(projectRoot);
    if (cached) return Promise.resolve(cached);
    const pending = pendingFetches.get(projectRoot);
    if (pending) return pending;
    const promise = Promise.resolve(fetchSessions(projectRoot)).then((data) => {
      const entry = {
        sessions: Array.isArray(data?.sessions) ? data.sessions : [],
        activeSessionId: data?.active_session_id ?? null
      };
      sessionCache.set(projectRoot, entry);
      return entry;
    }).finally(() => {
      pendingFetches.delete(projectRoot);
    });
    pendingFetches.set(projectRoot, promise);
    return promise;
  }

  // ---- 数据入口 ----
  // dashboard 数据（当前项目会话 + 最近活跃）：seed 后定向补渲当前组 + busy 复位。
  // 空值语义与 handleSessionsChanged 一致：activeSessionId 为空 → 缓存清空活跃指针
  //（无会话时绝不残留上一项目的旧会话 id——syncBusy 的"其他会话"判定依赖它）。
  function seedSessions(projectRoot, sessions, activeSessionId) {
    if (!projectRoot) return;
    sessionCache.set(projectRoot, {
      sessions: Array.isArray(sessions) ? sessions : [],
      activeSessionId: activeSessionId ?? null
    });
    failedRoots.delete(projectRoot); // dashboard seed 成功：清理失败标记（与缓存覆盖一致）
    rerenderGroup(projectRoot);
    syncBusy();
  }

  // surface.onSessionsChanged → app.js 转发：只重渲当前项目组（保滚动）+ busy 复位。
  function handleSessionsChanged(projectRoot, sessions, activeSessionId) {
    if (!projectRoot) return;
    sessionCache.set(projectRoot, {
      sessions: Array.isArray(sessions) ? sessions : [],
      activeSessionId: activeSessionId ?? null
    });
    rerenderGroup(projectRoot);
    syncBusy();
  }

  // Task 8 契约：busy 复位——检查当前项目「其他」会话的 run_status（当前会话运行
  // 不阻塞发送键，同会话 submit 走 FIFO 队列）。刷新时机由 app.js 控制
  //（openProject/switchSession 后 refreshSessions、SSE 终态事件）＋ busy=true 时的
  // 周期刷新兜底（其他会话终态不达本会话流，见 startBusyRefresh）。
  function syncBusy() {
    const root = getCurrentProjectRoot();
    if (!root) {
      surface.setBusy?.(false);
      stopBusyRefresh();
      return;
    }
    const entry = sessionCache.get(root);
    const busy = entry
      ? entry.sessions.some((s) => s.session_id !== entry.activeSessionId && s.run_status === "running")
      : false;
    surface.setBusy?.(busy);
    if (busy) startBusyRefresh();
    else stopBusyRefresh();
  }

  // dashboard 加载失败（app.js renderError 路径）时把目标项目标记为加载失败：
  // 当前项目组的「加载中…」降级为可重试的失败行（否则永不消失）。
  function markSessionsFailed(projectRoot) {
    if (!projectRoot) return;
    failedRoots.add(projectRoot);
    rerenderGroup(projectRoot);
  }

  function getSessions(projectRoot) {
    return sessionCache.get(projectRoot) ?? null;
  }

  function emptyRow(text) {
    const row = doc.createElement("div");
    row.className = "session-empty";
    row.textContent = text;
    return row;
  }

  // 列表级空态（沿用既有 .proj-empty 样式；与组内 .session-empty 区分）。
  function projEmptyRow(text) {
    const row = doc.createElement("div");
    row.className = "proj-empty";
    row.textContent = text;
    return row;
  }

  function loadingRow() {
    const row = doc.createElement("div");
    row.className = "session-loading";
    row.textContent = "加载中…";
    return row;
  }

  return {
    render,
    seedSessions,
    handleSessionsChanged,
    syncBusy,
    invalidateProject,
    markSessionsFailed,
    switchSession: commitSessionSwitch,
    getSessions
  };
}
