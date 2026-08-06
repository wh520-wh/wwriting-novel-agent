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

const SETTINGS_SLASH_COMMANDS = new Map([
  ["/settings", "settings"],
  ["/model", "model"]
]);

export function createAgentSurface({
  root,
  api,
  onOpenSettings = () => {},
  onOpenChapter = () => {},
  document: doc = globalThis.document
}) {
  const state = createState();
  const view = createAgentView({ root, document: doc });
  let transport = api ?? null;
  let destroyed = false;

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
          if (destroyed) return;
          try {
            const snapshot = await transport.fetchSnapshot({ afterSeq: state.lastSeq });
            if (snapshot) applySnapshot(snapshot);
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
  }

  async function openProject(projectRoot) {
    resetState(state, { projectRoot });
    view.reset();
    const t = ensureApi();
    if (typeof t.openProject === "function") await t.openProject(projectRoot);
    let snapshot = null;
    try {
      snapshot = await t.fetchSnapshot({ afterSeq: 0 });
      if (snapshot?.session && Array.isArray(snapshot.events)) {
        const events = [...snapshot.events];
        let cursor = events.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0);
        const targetSeq = Number(snapshot.session.last_seq) || cursor;
        // 首次打开必须补齐所有事件后再渲染。否则固定 200 条的第一页只能还原
        // 历史中间态，并会丢失后续消息、活动终态和模型轮次闭合事件。
        while (cursor < targetSeq) {
          const page = await t.fetchSnapshot({ afterSeq: cursor });
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
    applySnapshot(snapshot);
    if (typeof t.connectEvents === "function") t.connectEvents();
    view.render(state, actions);
  }

  function submit(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return;
    if (SETTINGS_SLASH_COMMANDS.has(trimmed)) {
      // 精确导航快捷方式：只打开设置对应分区，不创建 Run、不 POST Agent 输入。
      onOpenSettings(SETTINGS_SLASH_COMMANDS.get(trimmed));
      return;
    }
    return ensureApi().submit(trimmed);
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
    openChapter: (chapterNo) => onOpenChapter(chapterNo)
  };

  // 初始空状态渲染：未打开项目时 composer 立即处于禁用态。
  view.render(state, actions);

  function destroy() {
    destroyed = true;
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
