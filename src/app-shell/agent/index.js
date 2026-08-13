// src/app-shell/agent/index.js —— AgentSurface 唯一前端外部 seam（计划 Rule 4）。
//
// 生产代码（app.js）只能从这里导入对话能力：
//   const surface = createAgentSurface({ root, api, onOpenSettings, onOpenChapter });
//   surface.openProject(projectRoot);
//   surface.applySnapshot(snapshot);   // { session, events }
//   surface.applyEvent(event);         // SSE 增量事件
//   surface.destroy();
//
// 内部拥有 composer、对话、Visible Plan、队列、「立即」、停止与错误状态。
// app.js 不再知道 Agent 状态字段与业务正则（Rule 5）。
//
// 提交规则：精确输入 /settings 与 /model 只调用注入的设置导航回调，不 POST
// Agent 输入；其余任何斜杠前缀字符串（含 /init、/review、/write）都是普通输入。
// 旧 decision id（已终结/已 supersede）不能应用到更新的待决动作：decide 动作
// 只放行 reducer 中仍为 pending 的 decision_id。
import { createState, reduceSnapshot, reduceEvent, resetState, getNeedsHistoryClear, TERMINAL_RUN_STATUSES } from "./state.js";
import { createAgentView } from "./view.js";
import { createAgentApi } from "./api.js";
import { localSlashSection } from "./slash-commands.mjs";
import { detectPermissionTier, getTierById } from "../permission-tiers.mjs";
import { buildModelPickerOptions } from "../settings-connection.mjs";

export function createAgentSurface({
  root,
  api,
  onOpenSettings = () => {},
  onOpenChapter = () => {},
  onCreateProject = () => {},
  onOpenProjectFolder = () => {},
  onSessionsChanged = () => {},
  // Task 9：Run 终态事件（run_completed/failed/cancelled/interrupted）通知回调。
  // SSE 是 surface 的唯一消费者，app.js 需经此钩子在终态后重拉会话列表并复位 busy。
  onRunTerminal = () => {},
  document: doc = globalThis.document,
  requestFrame = null
}) {
  let state = createState();
  const view = createAgentView({ root, document: doc, requestFrame });
  let transport = api ?? null;
  let destroyed = false;
  let projectGeneration = 0;
  // Task 8：会话代次守卫（防竞态）。switchSession/占位/切项目都会递增
  // sessionGeneration；所有异步回调（fetchSnapshot resolve、submit 后补快照、
  // onReconnect 补齐、loadEarlier 等）都以发起时的代次做校验，resolve 时若与
  // 当前代次不一致则丢弃——迟到的快照/事件绝不污染已切换会话的视图。
  let sessionGeneration = 0;
  let streamGeneration = -1;   // 当前 SSE 事件流的代次：connectEvents 时 = sessionGeneration
  // Task 8：会话列表刷新的请求序号（新鲜度守卫，镜像 app.js dashboardRequestId）。
  // 代次守卫（isCurrentProjectScope）管切项目/会话；本序号管同代次内的并发刷新——
  // 慢响应在返回后若发现已有更新发起的刷新，则丢弃，绝不覆盖新状态。
  let sessionsRequestId = 0;
  let sessionStates = new Map(); // sessionId -> state 实例（已载入会话缓存：切回不重拉全量）
  let activeSessionId = null;  // 当前会话 id（null = 未指定，由后端 last-active 决定）
  let draftSessionId = null;   // 本地未落盘的新对话占位 id（提交后由后端 session_id 替换）
  let loadingEarlier = false; // 前置分页防重复（view 侧也有同名单标记，双保险）
  let composerOptions = null; // 三控件当前选项（view 侧由 view.reset 清空）
  let escapeLatch = null;     // ESC 去重锁：HTTP 成功只表示请求已接收，终态事件/失败才释放

  // Task 16：选择器数据源改由全局供应商清单（GET /api/settings/providers 扁平
  // store）经 buildModelPickerOptions 派生——只列启用供应商的启用模型，value 为
  // `${provider.id}/${model.id}` 引用形态。activeModel 来自 dashboard 有效配置：
  // 引用形态（迁移后）直接命中；字面配置（未迁移旧项目）按 base_url+model_name
  // 匹配清单；清单外模型保留为只读展示项（不伪装成可切换选项）。无任何可用模型时
  // 唯一选项是「未配置」占位（可点，开设置页）。modelSelectionEnabled 跟随「存在
  // 可切换选项」；capabilities（思考强度档位）由 dashboard 模型档案提供（服务端
  // 能力矩阵判定，前端不猜测）。
  function normalizeComposerOptions(data) {
    const store = data?.store ?? {};
    const options = buildModelPickerOptions(store);
    const activeModel = data?.activeModel ?? null;
    const usable = options.some((option) => option.value !== "");
    let activeModelId = "";
    if (typeof activeModel?.provider_id === "string" && typeof activeModel?.model_id === "string") {
      const candidate = `${activeModel.provider_id}/${activeModel.model_id}`;
      if (options.some((option) => option.value === candidate)) activeModelId = candidate;
    }
    if (!activeModelId && activeModel?.model_name) {
      const baseUrl = String(activeModel.base_url ?? "").replace(/\/+$/u, "").toLowerCase();
      const modelName = String(activeModel.model_name).trim();
      for (const provider of Array.isArray(store.providers) ? store.providers : []) {
        if (provider?.status === "disabled") continue;
        if (String(provider.base_url ?? "").replace(/\/+$/u, "").toLowerCase() !== baseUrl) continue;
        const model = (Array.isArray(provider.models) ? provider.models : [])
          .find((m) => m?.enabled !== false && String(m.model_name) === modelName);
        if (model) { activeModelId = `${provider.id}/${model.id}`; break; }
      }
    }
    const legacyEntry = !activeModelId && activeModel?.model_name
      ? { value: `legacy:${activeModel.model_name}`, label: String(activeModel.model_name), isDefault: false }
      : null;
    let models;
    let modelSelectionEnabled;
    if (usable) {
      models = legacyEntry ? [legacyEntry, ...options] : options;
      modelSelectionEnabled = true;
    } else if (legacyEntry) {
      models = [legacyEntry];
      modelSelectionEnabled = false;
    } else {
      models = options; // 唯一一项：「未配置」占位 → 点击开设置页
      modelSelectionEnabled = true;
    }
    if (legacyEntry) activeModelId = legacyEntry.value;
    return {
      models,
      modelSelectionEnabled,
      activeModelId,
      permissionTier: detectPermissionTier(data?.toolPermissions),
      reasoningEffort: typeof data?.reasoningEffort === "string" ? data.reasoningEffort : "auto",
      reasoningEffortLevels: Array.isArray(data?.activeModelCapabilities?.reasoningEffortLevels)
        ? data.activeModelCapabilities.reasoningEffortLevels
        : null
    };
  }

  function pushComposerOptions() {
    view.setComposerOptions(composerOptions);
  }

  async function refreshComposerOptions() {
    const t = ensureApi();
    if (typeof t.fetchComposerOptions !== "function") return;
    const scope = currentProjectScope();
    try {
      const data = await t.fetchComposerOptions();
      if (!isCurrentProjectScope(scope)) return;
      composerOptions = normalizeComposerOptions(data);
      pushComposerOptions();
    } catch {
      // 选项加载失败不阻断对话：控件保持禁用态。
    }
  }

  // Task 8：scope 同时捕获项目代次与会话代次。请求发起时捕获，异步 resolve 后
  // 经 isCurrentProjectScope 校验——切项目/切会话后旧代次的响应一律丢弃。
  function currentProjectScope() {
    return { projectRoot: state.projectRoot, generation: projectGeneration, sessionGeneration };
  }

  function isCurrentProjectScope(scope) {
    return !destroyed &&
      scope.generation === projectGeneration &&
      scope.sessionGeneration === sessionGeneration &&
      scope.projectRoot === state.projectRoot;
  }

  function ensureApi() {
    if (!transport) {
      transport = createAgentApi({
        getProjectRoot: () => state.projectRoot,
        getAfterSeq: () => state.lastSeq,
        onEvent: (event) => {
          if (destroyed) return;
          // Task 8 会话代次守卫：switchSession 已 abort 旧事件流，但 abort 完成前
          // dispatch 的残留事件仍可能到达——按事件流代次丢弃，不污染新会话视图。
          if (streamGeneration !== sessionGeneration) return;
          applyEvent(event);
        },
        onReconnect: async () => {
          // SSE 断线补齐：按最新 seq 增量拉快照（与 onEvent 一致受 destroyed 守卫）。
          // 旧事件流（代次不符）的重连回调直接丢弃，避免用旧会话游标拉错快照。
          if (destroyed || streamGeneration !== sessionGeneration) return;
          const scope = currentProjectScope();
          if (!isCurrentProjectScope(scope)) return;
          try {
            const snapshot = await transport.fetchSnapshot({ afterSeq: state.lastSeq });
            if (snapshot && isCurrentProjectScope(scope)) applySnapshot(snapshot);
          } catch {
            // 下次重连再试
          }
        },
        document: doc
      });
    }
    return transport;
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    const rebuild = reduceSnapshot(state, snapshot);
    if (rebuild) view.reset();
    view.render(state, actions);
    // I4：ESC 去重锁的释放必须覆盖快照路径。SSE 断线后重连补齐按合并后的 max seq
    // 增量拉快照，若取消请求与 context_compaction_cancelled/run_cancelled 之间的
    // 连接恰好断开，终态事件永远不会经 applyEvent 送达（被快照吞掉）——这里对
    // 快照事件列表做同 id 终态检查，否则 latch 永驻、ESC 停止/取消永久失效。
    for (const event of snapshot.events ?? []) clearEscapeLatch(event);
  }

  function applyEvent(event) {
    if (!event || typeof event !== "object") return;
    reduceEvent(state, event);
    view.render(state, actions);
    maybeRefreshAfterTerminal(event);
    clearEscapeLatch(event);
  }

  // ESC 去重锁释放（Task 12）：HTTP 成功只表示「取消/停止请求已接收」，不能释放
  // latch；只有同一 id 的终态事件到达才清除。请求失败由 handleEscape 的 catch
  // 立即释放（允许用户重试）。终态映射：
  //   compaction: context_compaction_cancelled/completed/failed
  //   run:        run_cancelled/completed/failed/interrupted
  const ESCAPE_LATCH_TERMINALS = new Map([
    ["context_compaction_cancelled", "compaction"],
    ["context_compaction_completed", "compaction"],
    ["context_compaction_failed", "compaction"],
    ["run_cancelled", "run"],
    ["run_completed", "run"],
    ["run_failed", "run"],
    ["run_interrupted", "run"]
  ]);
  function clearEscapeLatch(event) {
    if (!escapeLatch) return;
    const kind = ESCAPE_LATCH_TERMINALS.get(event?.type);
    if (!kind || kind !== escapeLatch.kind) return;
    const id = kind === "compaction" ? event?.payload?.compaction_id : event?.run_id;
    if (id != null && String(id) === String(escapeLatch.id)) escapeLatch = null;
  }

  // Task 12 Step 2（brief 提供代码 verbatim）：AgentSurface 唯一 ESC 出口。
  // 一次键只执行第一项：dismissTopLayer（slash menu → composer menu → context
  // popover）→ 压缩取消 → Run 停止。latch/cancelling/stopping 期间后续 ESC
  // 一律吞掉，不得转而停止普通 Run。
  function handleEscape() {
    if (view.dismissTopLayer()) return true;
    const compaction = state.compaction;
    if (escapeLatch || compaction?.state === "cancelling") return true;
    if (["started", "running"].includes(compaction?.state)) {
      escapeLatch = { kind: "compaction", id: compaction.id };
      Promise.resolve(ensureApi().cancelCompaction(compaction.id))
        .catch(() => { escapeLatch = null; });
      return true;
    }
    const run = state.session?.active_run;
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
      escapeLatch = { kind: "run", id: run.id };
      Promise.resolve(ensureApi().stop(run.id))
        .catch(() => { escapeLatch = null; });
      return true;
    }
    return false;
  }

  // Run 终态后补一次权威快照：增量事件只带 status，不带 journal 冻结的
  // active_elapsed_ms 等 session 字段；不刷新的话工作组终态耗时文案会停留在
  // 提交瞬间的旧快照值（如“工作了 0 秒”）。终态每个 seq 只刷一次。
  const TERMINAL_RUN_EVENTS = new Set(["run_completed", "run_failed", "run_cancelled", "run_interrupted"]);
  let terminalRefreshSeq = -1;
  function maybeRefreshAfterTerminal(event) {
    if (!TERMINAL_RUN_EVENTS.has(event?.type)) return;
    const seq = Number(event.seq);
    if (Number.isFinite(seq) && seq === terminalRefreshSeq) return;
    if (Number.isFinite(seq)) terminalRefreshSeq = seq;
    // Task 9：通知 app.js（左侧栏重拉会话列表 + busy 复位）。终态事件沿当前会话
    // 事件流到达；跨会话运行结束的复位由 app.js 的 openProject/switchSession 刷新兜底。
    onRunTerminal(event);
    const t = ensureApi();
    if (typeof t.fetchSnapshot !== "function") return;
    const scope = currentProjectScope();
    Promise.resolve(t.fetchSnapshot({ afterSeq: state.lastSeq }))
      .then((snapshot) => {
        if (snapshot && isCurrentProjectScope(scope)) applySnapshot(snapshot);
      })
      .catch(() => {
        // 刷新失败不阻断：SSE 断线补齐路径会在下次重连重试
      });
  }

  async function openProject(projectRoot, activeSessionIdParam = null) {
    // 项目切换是硬边界：清空全部会话缓存与占位，按指定活跃会话（缺省 null =
    // 后端 last-active）重建视图并重连 SSE。旧调用形状 openProject(root) 不变。
    const scope = {
      projectRoot,
      generation: projectGeneration + 1,
      sessionGeneration: sessionGeneration + 1
    };
    projectGeneration = scope.generation;
    sessionGeneration = scope.sessionGeneration;
    sessionStates = new Map();
    composerOptions = null;
    escapeLatch = null; // 项目切换是硬边界：旧项目的终态事件不会到达，必须释放 latch
    draftSessionId = null;
    view.setBusy(false); // 项目切换重置 busy（唯一自动复位路径；见 setBusy 契约）
    await switchSession(activeSessionIdParam ?? null, scope);
    if (!isCurrentProjectScope(scope)) return;
    await refreshComposerOptions();
    view.render(state, actions);
  }

  // Task 8：会话切换（同一项目内）。真实会话经 transport.openProject 切流
  // （abort 旧 SSE + 清游标）→ 载入该会话的 state 实例 → 拉快照 → 重连事件流；
  // 新对话占位（draft）是本地未落盘状态，不切 transport、不拉快照。
  async function switchSession(sessionId, presetScope = null) {
    const scope = presetScope ?? {
      projectRoot: state.projectRoot,
      generation: projectGeneration,
      sessionGeneration: sessionGeneration + 1
    };
    sessionGeneration = scope.sessionGeneration;
    streamGeneration = -1; // 旧事件流立即作废（新流 connectEvents 后恢复为当前代次）

    // 切走未提交的新对话占位：占位消失并同步刷新列表（占位项移除）。占位只在
    // 停留其视图时存在，切走是它唯一的收尾路径，这里统一处理。
    const prevDraft = draftSessionId;
    const isDraft = prevDraft != null && sessionId === prevDraft;
    activeSessionId = sessionId ?? null;
    if (prevDraft != null && !isDraft) {
      draftSessionId = null;
      refreshSessions();
    }

    // 先载入该会话的 state 实例（projectRoot 同步为 scope 目标，后续 scope 校验
    // 与 transport 的 getProjectRoot 都基于它）：已载入会话复用缓存（切回不重拉
    // 全量，按已见游标增量补齐），首见新建空实例——每会话独立实例，派生投影
    // 天然隔离。再切 transport（abort 旧 SSE + 清游标、重置请求作用域）；占位是
    // 本地未落盘状态，后端不认识 draft id，不切 transport。
    state = (!isDraft ? sessionStates.get(sessionId) : null)
      ?? resetState(createState(), { projectRoot: scope.projectRoot });
    if (!isDraft && !sessionStates.has(sessionId)) sessionStates.set(sessionId, state);

    // 会话切换是视图硬边界：重建 DOM（revisions/节点映射按会话隔离）
    view.reset();
    // 跨会话状态清零：旧会话的终态事件不会到达新事件流，escapeLatch 永驻会吞掉
    // 新会话的 ESC 停止/取消；terminalRefreshSeq 是全局单值，而各会话 seq 独立
    // 编号，不清会漏刷新会话的终态权威快照。
    escapeLatch = null;
    terminalRefreshSeq = -1;
    loadingEarlier = false;

    const t = ensureApi();
    if (!isDraft && typeof t.openProject === "function") {
      await t.openProject(scope.projectRoot, sessionId);
    }
    if (!isCurrentProjectScope(scope)) return;

    let snapshot = null;
    if (!isDraft) {
      try {
        // 首见/空游标 → 最新尾部页（tail，Task 10 语义）；已有缓存 → 按已见
        // 游标增量补齐（afterSeq）。sessionId 经显式参数传给 transport（fake
        // transport 同样可见），真实 transport 以 URL query 携带。
        const fetchOpts = { limit: 200 };
        if (sessionId != null) fetchOpts.sessionId = sessionId;
        if (state.lastSeq > 0) fetchOpts.afterSeq = state.lastSeq;
        else fetchOpts.tail = true;
        snapshot = await t.fetchSnapshot(fetchOpts);
      } catch {
        // 载入失败：保留空会话，SSE 重连补齐
      }
    }
    if (!isCurrentProjectScope(scope)) return;
    if (!isDraft && snapshot && typeof snapshot === "object") {
      applySnapshot(snapshot);
    }
    if (!isDraft && typeof t.connectEvents === "function") t.connectEvents();
    streamGeneration = sessionGeneration; // 新事件流从当前代次生效
    if (composerOptions) pushComposerOptions(); // view.reset 清了三控件选项，恢复已加载项
    view.render(state, actions);
  }

  // Task 8：新对话占位（未落盘）。占位期间右侧空白对话、composer 可输入，列表
  // 不出现新项（Task 3：占位不进会话列表）；提交时先 createSession 落盘（后端
  // 返回 session_id）替换占位再投递输入，刷新后列表才出现真实会话。
  function newSessionPlaceholder() {
    if (draftSessionId != null) return draftSessionId; // 已有未提交占位：不重复创建
    draftSessionId = `draft-${Date.now().toString(36)}`;
    const scope = {
      projectRoot: state.projectRoot,
      generation: projectGeneration,
      sessionGeneration: sessionGeneration + 1
    };
    sessionGeneration = scope.sessionGeneration;
    streamGeneration = -1; // 占位期间无事件流：旧流残留事件一律丢弃
    activeSessionId = draftSessionId;
    state = resetState(createState(), { projectRoot: scope.projectRoot });
    view.reset();
    escapeLatch = null;
    terminalRefreshSeq = -1;
    // 中止旧 SSE 僵尸连接（占位没有事件流）：transport.openProject 同步 abort 旧
    // 流并清请求作用域，避免旧会话连接持续重连拉事件（虽被 streamGeneration 丢弃
    // 但浪费）。占位不重建连接——提交（createSession 后 openProject）或切走
    // （switchSession）时现有逻辑会重新连接。abort 不触发意外重连：旧流循环在
    // signal.aborted 时退出，新流只由 connectEvents 显式建立。
    const t = ensureApi();
    if (typeof t.openProject === "function") {
      Promise.resolve(t.openProject(scope.projectRoot, null)).catch(() => {});
    }
    if (composerOptions) pushComposerOptions();
    view.render(state, actions);
    refreshSessions();
    return draftSessionId;
  }

  // 拉取会话列表 → onSessionsChanged（Task 3：draft 占位不再插入列表头部——占位是
  // 本地未落盘状态，发送首条消息（createSession 落盘）前左侧栏不显示任何新项）。
  // 任务 9 左侧栏以此为数据源；列表刷新失败不阻断对话。活跃通知缺口：
  // openProject/switchSession 不触发 refreshSessions，Task 9 侧边栏须在这些操作后
  // 自行调 refreshSessions() 更新活跃高亮。draft 占位只经 activeSessionId 透出
  //（draft id 不在列表中、无行匹配，侧边栏据此清除旧高亮），永不进入 sessions 列表。
  // Task 5：活跃指针 = surface 当前 activeSessionId（非 null 时优先），null 时用
  // 后端 active_session_id 兜底（启动/归档切走等未指定会话的场景，侧边栏据此保持
  // 正确高亮，避免把当前会话误判为「其他会话」导致 busy 误禁发送键）。
  function emitSessions(list, fallbackActiveId = null) {
    const sessions = Array.isArray(list) ? list : [];
    onSessionsChanged(sessions, activeSessionId ?? fallbackActiveId);
  }

  async function refreshSessions() {
    const t = ensureApi();
    if (typeof t.sessions !== "function") return;
    const scope = currentProjectScope();
    const requestId = ++sessionsRequestId; // 新鲜度守卫：慢响应返回后若已有更新发起则丢弃
    try {
      const data = await t.sessions();
      if (requestId !== sessionsRequestId) return; // 慢响应不覆盖更新发起的刷新
      if (!isCurrentProjectScope(scope)) return;
      // 后端契约：GET /api/agent/sessions 返回 { sessions, active_session_id }
      //（agent-routes.mjs）。active_session_id 是「未指定会话」时的权威活跃指针。
      emitSessions(
        Array.isArray(data?.sessions) ? data.sessions : [],
        data?.active_session_id ?? null
      );
    } catch {
      // 列表刷新失败不阻断对话
    }
  }

  // Task 8：项目其他会话运行中 → 禁发送键、保留输入（app.js/Task 9 显式调用，
  // 或 submit 收到后端 409 project_busy 时自动置位）。busy 状态由 view 自持
  // （composerBusy）；此处只转发。复位契约：busy 不会自动复位——Task 9 必须在
  // 其他会话运行结束时显式 setBusy(false)，唯一例外是 openProject 会重置。
  function setBusy(isBusy) {
    view.setBusy(isBusy === true);
  }

  // 会话 CRUD（委托 transport + 刷新列表）。删除当前会话时由调用方（Task 9）
  // 负责 switchSession 切走，这里只保证列表与后端一致。四个动作共享同一骨架：
  // ensureApi → 代次守卫 → await → 刷新列表（transport 方法缺失时静默返回 undefined）。
  function sessionAction(methodName, args) {
    const t = ensureApi();
    if (typeof t[methodName] !== "function") return undefined;
    const scope = currentProjectScope();
    return Promise.resolve(t[methodName](...args)).then((result) => {
      if (!isCurrentProjectScope(scope)) return result;
      refreshSessions();
      return result;
    });
  }

  const archiveSession = (sessionId) => sessionAction("archiveSession", [sessionId]);
  const restoreSession = (sessionId) => sessionAction("restoreSession", [sessionId]);
  const renameSession = (sessionId, title) => sessionAction("renameSession", [sessionId, title]);
  const deleteSession = (sessionId) => sessionAction("deleteSession", [sessionId]);

  function submit(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return;
    // Task 16（R5-7）：对话历史损坏（needs_history_clear）时 surface 层同样拒绝
    // 提交——view 的 canSubmit 门禁是第一道，这里是第二道（防御绕过视图的
    // 直接调用路径；后端 submit 另有拒绝契约）。
    if (getNeedsHistoryClear(state)) {
      const error = new Error("此对话已损坏，无法发送。");
      error.code = "history_clear_required";
      return Promise.reject(error);
    }
    const localSection = localSlashSection(trimmed);
    if (localSection) {
      // 精确导航快捷方式：只打开设置对应分区，不创建 Run、不 POST Agent 输入。
      onOpenSettings(localSection);
      return { localOnly: true };
    }
    const t = ensureApi();
    const scope = currentProjectScope();
    return Promise.resolve(submitWithDraft(t, trimmed, scope)).then(async (result) => {
      if (!isCurrentProjectScope(scope)) return result;
      // POST 成功后主动补一次快照。SSE 仍负责实时流，但消息是否出现不再依赖
      // 单条长连接是否恰好健康。
      try {
        const snapshot = await t.fetchSnapshot({ afterSeq: state.lastSeq });
        if (snapshot && isCurrentProjectScope(scope)) applySnapshot(snapshot);
      } catch {
        // POST 已持久化成功；快照失败时交给 SSE 重连补齐，不能把提交误报为失败。
      }
      return result;
    }).catch((error) => {
      // 项目级串行门：其他会话运行中后端返回 409 project_busy。自动置 busy
      // （发送键禁用、保留输入）；错误透出由 view 的失败路径处理（草稿恢复）。
      if (error?.code === "project_busy") setBusy(true);
      throw error;
    });
  }

  // 新对话占位提交：先落盘创建真实会话（后端返回 session_id），替换占位并刷新
  // 列表，再投递输入——占位是本地未落盘状态，后端不认识 draft id，直接 submit
  // 会落到 last-active 旧会话。createSession 失败时抛错（草稿保留，可重试）。
  async function submitWithDraft(t, text, scope) {
    if (activeSessionId != null && activeSessionId === draftSessionId) {
      // 竞态窗口：createSession 落盘在途期间用户可能切走会话（Task 9 侧边栏）。
      // 守卫语义：占位替换、sessionStates 缓存迁移、transport 切流、输入投递都
      // 是会话作用域操作，一旦当前代次不再是发起时的代次（用户已切走），任何
      // 一步都不许执行——否则会用新会话 state 污染缓存、打断新会话 SSE、把草稿
      // 投到错误会话。中止时草稿回填 composer（view 失败路径已被 viewGeneration
      // 守卫跳过，这里主动恢复，仅当输入框为空时回填）。
      let created;
      try {
        created = await t.createSession();
      } catch (error) {
        // 失败路径（含 AbortError：createSession 在途时用户切走，switchSession 的
        // transport.openProject 会 abortPendingRequests 把 createSession 一并中止）
        // 不经代次守卫——无论是否切走，草稿都回填 composer，错误继续透出（view
        // 按现有失败路径处理：发送失败提示 + 输入恢复）。
        view.restoreComposerText(text);
        throw error;
      }
      if (!isCurrentProjectScope(scope)) {
        view.restoreComposerText(text);
        throw createSessionSwitchAbort();
      }
      const realSessionId = created?.session?.session_id ?? created?.session_id ?? null;
      if (!realSessionId) {
        const error = new Error("创建新会话失败");
        error.code = "session_create_failed";
        throw error;
      }
      sessionStates.delete(draftSessionId);
      sessionStates.set(realSessionId, state);
      draftSessionId = null;
      activeSessionId = realSessionId;
      if (typeof t.openProject === "function") await t.openProject(state.projectRoot, realSessionId);
      // 切流在途又切走：同样中止投递（后端会话已落盘，前端下次 switchSession/
      // refreshSessions 会校正列表；sessionStates 迁移已随占位替换完成，无污染）。
      if (!isCurrentProjectScope(scope)) {
        view.restoreComposerText(text);
        throw createSessionSwitchAbort();
      }
      if (typeof t.connectEvents === "function") t.connectEvents();
      streamGeneration = sessionGeneration;
      refreshSessions();
    }
    return t.submit(text);
  }

  function createSessionSwitchAbort() {
    const error = new Error("会话已切换，未发送。");
    error.code = "session_switch_aborted";
    return error;
  }

  function isPendingDecision(decisionId) {
    const decision = state.decisions.get(decisionId);
    return Boolean(decision) && decision.status === "pending";
  }

  const actions = {
    submit,
    // 前置分页（Task 10 Step 4）：view 滚动到顶（≤240px）且有更早历史时调用。
    // 插入前记录 oldHeight/oldTop，插入后按差恢复 scrollTop 保持锚点；失败只
    // 显示一次可重试提示且不清空当前消息。
    loadEarlier: async (beforeSeq) => {
      if (loadingEarlier) return;
      const seq = Number(beforeSeq);
      if (!Number.isFinite(seq) || seq <= 0) return;
      loadingEarlier = true;
      const t = ensureApi();
      const scope = currentProjectScope();
      view.prepareEarlierInsert();
      try {
        const page = await t.fetchSnapshot({ beforeSeq: seq, limit: 200 });
        if (!isCurrentProjectScope(scope)) return;
        if (page && (Array.isArray(page.events) || Array.isArray(page.gaps))) {
          applySnapshot(page);
          view.clearHistoryLoadError();
        }
      } catch {
        // 加载失败提示也是视图操作：切走会话后不得打到新会话视图。
        if (isCurrentProjectScope(scope)) view.showHistoryLoadError(seq);
      } finally {
        view.restoreScrollAnchor();
        view.setLoadingEarlier(false);
        loadingEarlier = false;
      }
    },
    // Task 11：旧 promote 概念已删除——「立即」= requestPriority（安全点优先调度，
    // 不再是 abort 式提升）；「取消」= withdrawInput（撤回排队输入）。
    requestPriority: (inputId) => ensureApi().requestPriority(inputId),
    withdrawInput: (inputId) => ensureApi().withdrawInput(inputId),
    stop: (runId) => ensureApi().stop(runId),
    retry: (runId) => ensureApi().retry(runId),
    // Task 11：压缩状态行动作按钮——重试同一 compaction_id 的新 attempt /
    // 取消（ESC、按钮与 HTTP 都调用同一后端方法）。
    retryCompaction: (compactionId) => ensureApi().retryCompaction(compactionId),
    cancelCompaction: (compactionId) => ensureApi().cancelCompaction(compactionId),
    decide: (decisionId, choice) => {
      // 终态/未知/已 supersede 的 decision 保持锁定：不发出请求。
      if (!isPendingDecision(decisionId)) return;
      return ensureApi().decide(decisionId, choice);
    },
    openChapter: (chapterNo) => onOpenChapter(chapterNo),
    createProject: () => onCreateProject(),
    openProjectFolder: () => onOpenProjectFolder(),
    // Task 16：「未配置」占位点击 → 打开新设置页（模型分区入口与 /model 命令一致）。
    openModelSettings: () => onOpenSettings("model"),
    // 三控件动作：选择即落盘；当前 Run 不受影响，从下一条输入生效。
    // Task 16：响应不再带 available_models——全局供应商清单不随项目切换改变，
    // 选项保持；activeModelId 由选中值（引用形态）直接更新，capabilities 以服务端
    // 能力矩阵判定为准。
    switchModel: async (modelId) => {
      const t = ensureApi();
      if (typeof t.switchModel !== "function") return;
      const scope = currentProjectScope();
      try {
        const data = await t.switchModel(modelId);
        if (!isCurrentProjectScope(scope)) return;
        composerOptions = {
          ...(composerOptions ?? {}),
          activeModelId: String(modelId),
          permissionTier: detectPermissionTier(data?.project?.tool_permissions),
          reasoningEffortLevels: Array.isArray(data?.capabilities?.reasoningEffortLevels)
            ? data.capabilities.reasoningEffortLevels
            : null
        };
      } catch {
        // 切换失败：重推旧选项，还原下拉显示。
      }
      pushComposerOptions();
    },
    setPermissionTier: async (tierId) => {
      const t = ensureApi();
      if (typeof t.updatePermissions !== "function") return;
      const tier = getTierById(tierId);
      const scope = currentProjectScope();
      try {
        await t.updatePermissions(tier.combo);
        if (!isCurrentProjectScope(scope)) return;
        composerOptions = { ...(composerOptions ?? {}), permissionTier: tier.id };
      } catch {
        // 保存失败：重推旧选项。
      }
      pushComposerOptions();
    },
    setReasoningEffort: async (effort) => {
      const t = ensureApi();
      if (typeof t.updateReasoningEffort !== "function") return;
      const scope = currentProjectScope();
      try {
        await t.updateReasoningEffort(effort);
        if (!isCurrentProjectScope(scope)) return;
        composerOptions = { ...(composerOptions ?? {}), reasoningEffort: String(effort) };
      } catch {
        // 保存失败：重推旧选项。
      }
      pushComposerOptions();
    }
  };

  // 初始空状态渲染：未打开项目时 composer 立即处于禁用态。
  view.render(state, actions);

  // 历史导出（Task 9）：纯委托 transport，返回 NDJSON 原文（{ text }），不解析、
  // 不碰 DOM 或 Journal 文件。
  function exportHistory() {
    const t = ensureApi();
    if (typeof t.exportHistory !== "function") return Promise.resolve(null);
    return t.exportHistory();
  }

  // 不可逆清空（Task 9）：transport 成功后才动本地状态——清空投影、重建视图并
  // 重新打开当前项目。openProject 内部经 transport.openProject 终止旧 SSE、按新
  // session（tail 尾页）重拉快照并连接新事件流（clear-reconnect 语义）。失败
  // （409 history_busy / 400 confirmation_required）时状态保持不动，错误抛给调用方。
  async function clearHistory(options = {}) {
    const t = ensureApi();
    if (typeof t.clearHistory !== "function") return undefined;
    const projectRoot = state.projectRoot;
    if (!projectRoot) return undefined;
    const scope = currentProjectScope();
    const result = await t.clearHistory(options);
    if (!isCurrentProjectScope(scope)) return undefined;
    resetState(state, { projectRoot });
    view.reset();
    await openProject(projectRoot);
    return result;
  }

  function destroy() {
    destroyed = true;
    projectGeneration += 1;
    try {
      transport?.destroy?.();
    } catch {
      // 已销毁忽略
    }
    view.destroy();
  }

  return {
    openProject,
    applySnapshot,
    applyEvent,
    handleEscape,
    exportHistory,
    clearHistory,
    switchSession,
    newSessionPlaceholder,
    refreshSessions,
    // Task 16：设置页（模型设置）变更后刷新三控件选项——模型选择器选项来自全局
    // 供应商清单，新增/停用/删除模型后需重拉（app.js 的 modelSettings.onChanged 接线）。
    refreshComposerOptions,
    setBusy,
    archiveSession,
    restoreSession,
    renameSession,
    deleteSession,
    destroy
  };
}
