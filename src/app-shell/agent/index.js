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
      snapshot = await t.fetchSnapshot({ afterSeq: 0 });
      if (!isCurrentProjectScope(scope)) return;
      if (snapshot?.session && Array.isArray(snapshot.events)) {
        const events = [...snapshot.events];
        let cursor = events.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0);
        const targetSeq = Number(snapshot.session.last_seq) || cursor;
        // 首次打开必须补齐所有事件后再渲染。否则固定 200 条的第一页只能还原
        // 历史中间态，并会丢失后续消息、活动终态和模型轮次闭合事件。
        while (cursor < targetSeq) {
          const page = await t.fetchSnapshot({ afterSeq: cursor });
          if (!isCurrentProjectScope(scope)) return;
          const pageEvents = Array.isArray(page?.events) ? page.events : [];
          const nextCursor = pageEvents.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), cursor);
          if (nextCursor <= cursor) break;
          events.push(...pageEvents);
          cursor = nextCursor;
          if (page?.session) snapshot.session = page.session;
        }
        snapshot = { ...snapshot, events };
      }
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
    destroy
  };
}
