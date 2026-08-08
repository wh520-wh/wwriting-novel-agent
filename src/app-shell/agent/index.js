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
import { createState, reduceSnapshot, reduceEvent, resetState } from "./state.js";
import { createAgentView } from "./view.js";
import { createAgentApi } from "./api.js";
import { localSlashSection } from "./slash-commands.mjs";
import { detectPermissionTier, getTierById } from "../permission-tiers.mjs";

export function createAgentSurface({
  root,
  api,
  onOpenSettings = () => {},
  onOpenChapter = () => {},
  onCreateProject = () => {},
  onOpenProjectFolder = () => {},
  document: doc = globalThis.document,
  requestFrame = null
}) {
  const state = createState();
  const view = createAgentView({ root, document: doc, requestFrame });
  let transport = api ?? null;
  let destroyed = false;
  let projectGeneration = 0;
  let loadingEarlier = false; // 前置分页防重复（view 侧也有同名单标记，双保险）
  let composerOptions = null; // 三控件当前选项（view 侧由 view.reset 清空）

  function normalizeComposerOptions(data) {
    const importedModels = Array.isArray(data?.models) ? data.models : [];
    const models = [...importedModels];
    const activeModel = data?.activeModel ?? null;
    let activeEntry =
      models.find((model) => model?.active === true) ??
      models.find((model) =>
        activeModel &&
        model?.model_name === activeModel.model_name &&
        String(model?.base_url ?? "") === String(activeModel.base_url ?? "")
      ) ??
      null;
    // 旧项目或外部配置可能已有生效模型，但尚未进入全局模型清单。界面必须
    // 显示运行时事实，不能误报「未导入模型」；只有这一项时保持只读展示。
    if (!activeEntry && activeModel?.model_name) {
      activeEntry = {
        ...activeModel,
        id: String(activeModel.id ?? activeModel.model_name),
        display: String(activeModel.display ?? activeModel.model_name),
        active: true,
        imported: false
      };
      models.unshift(activeEntry);
    }
    return {
      models,
      modelSelectionEnabled: importedModels.length > 0,
      activeModelId: activeEntry ? String(activeEntry.id ?? activeEntry.model_name ?? "") : null,
      permissionTier: detectPermissionTier(data?.toolPermissions),
      reasoningEffort: typeof data?.reasoningEffort === "string" ? data.reasoningEffort : "auto",
      reasoningEffortLevels: Array.isArray(activeEntry?.capabilities?.reasoningEffortLevels)
        ? activeEntry.capabilities.reasoningEffortLevels
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

  function currentProjectScope() {
    return { projectRoot: state.projectRoot, generation: projectGeneration };
  }

  function isCurrentProjectScope(scope) {
    return !destroyed &&
      scope.generation === projectGeneration &&
      scope.projectRoot === state.projectRoot;
  }

  function ensureApi() {
    if (!transport) {
      transport = createAgentApi({
        getProjectRoot: () => state.projectRoot,
        getAfterSeq: () => state.lastSeq,
        onEvent: (event) => {
          if (!destroyed) applyEvent(event);
        },
        onReconnect: async () => {
          // SSE 断线补齐：按最新 seq 增量拉快照（与 onEvent 一致受 destroyed 守卫）。
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
  }

  function applyEvent(event) {
    if (!event || typeof event !== "object") return;
    reduceEvent(state, event);
    view.render(state, actions);
    maybeRefreshAfterTerminal(event);
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

  async function openProject(projectRoot) {
    const scope = { projectRoot, generation: projectGeneration + 1 };
    projectGeneration = scope.generation;
    resetState(state, { projectRoot });
    composerOptions = null;
    view.reset();
    const t = ensureApi();
    if (typeof t.openProject === "function") await t.openProject(projectRoot);
    if (!isCurrentProjectScope(scope)) return;
    let snapshot = null;
    try {
      // Task 10：首屏只取最新尾部页（tail），更早历史由滚动到顶触发 beforeSeq
      // 前置分页加载（loadEarlier）。不再按 afterSeq 循环补齐全量 Journal。
      snapshot = await t.fetchSnapshot({ tail: true, limit: 200 });
    } catch {
      // 首次加载失败：保留空会话，SSE 重连补齐
    }
    if (!isCurrentProjectScope(scope)) return;
    applySnapshot(snapshot);
    if (typeof t.connectEvents === "function") t.connectEvents();
    await refreshComposerOptions();
    view.render(state, actions);
  }

  function submit(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return;
    const localSection = localSlashSection(trimmed);
    if (localSection) {
      // 精确导航快捷方式：只打开设置对应分区，不创建 Run、不 POST Agent 输入。
      onOpenSettings(localSection);
      return { localOnly: true };
    }
    const t = ensureApi();
    const scope = currentProjectScope();
    return Promise.resolve(t.submit(trimmed)).then(async (result) => {
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
    });
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
        view.showHistoryLoadError(seq);
      } finally {
        view.restoreScrollAnchor();
        view.setLoadingEarlier(false);
        loadingEarlier = false;
      }
    },
    promote: (inputId) => ensureApi().promote(inputId),
    stop: (runId) => ensureApi().stop(runId),
    retry: (runId) => ensureApi().retry(runId),
    decide: (decisionId, choice) => {
      // 终态/未知/已 supersede 的 decision 保持锁定：不发出请求。
      if (!isPendingDecision(decisionId)) return;
      return ensureApi().decide(decisionId, choice);
    },
    openChapter: (chapterNo) => onOpenChapter(chapterNo),
    createProject: () => onCreateProject(),
    openProjectFolder: () => onOpenProjectFolder(),
    // 三控件动作：选择即落盘；当前 Run 不受影响，从下一条输入生效。
    switchModel: async (modelId) => {
      const t = ensureApi();
      if (typeof t.switchModel !== "function") return;
      const scope = currentProjectScope();
      try {
        const data = await t.switchModel(modelId);
        if (!isCurrentProjectScope(scope)) return;
        // 服务端响应即最新事实：capabilities 只由服务端能力矩阵判定。
        composerOptions = {
          ...(composerOptions ?? {}),
          models: Array.isArray(data?.available_models) ? data.available_models : (composerOptions?.models ?? []),
          modelSelectionEnabled: Array.isArray(data?.available_models)
            ? data.available_models.length > 0
            : composerOptions?.modelSelectionEnabled,
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
    exportHistory,
    clearHistory,
    // Task 12 将在本 return 对象增加 handleEscape()（唯一 ESC 出口）；这里不预留
    // 同名方法，避免与 Task 12 的实现语义冲突。
    destroy
  };
}
