// src/app-shell/agent/api.js —— AgentSurface transport（Task 8 Step 1 的一部分）。
//
// /api/agent/* 传输层：
//   POST /api/agent/input                    submit(text, sessionId?)
//   POST /api/agent/input/:inputId/promote   promote(inputId)
//   POST /api/agent/run/:runId/stop          stop(runId)
//   POST /api/agent/run/:runId/retry         retry(runId)
//   POST /api/agent/compaction/:id/cancel    cancelCompaction(id)
//   POST /api/agent/compaction/:id/retry     retryCompaction(id)
//   POST /api/agent/decision/:decisionId     decide(decisionId, choice)
//   GET  /api/agent/snapshot?afterSeq|beforeSeq|tail&limit  fetchSnapshot()
//   POST /api/agent/history/export          exportHistory()（NDJSON 文本，不按 JSON 解析）
//   POST /api/agent/history/clear           clearHistory({ confirm_irreversible })
//   GET  /api/agent/sessions?projectRoot     sessions()
//   POST /api/agent/sessions                 createSession(title?)
//   PATCH /api/agent/sessions/:sessionId     renameSession/archiveSession/restoreSession
//   DELETE /api/agent/sessions/:sessionId?projectRoot  deleteSession(sessionId)
//   GET  /api/project/events?afterSeq        connectEvents()（SSE 轮询流，断线指数退避重连）
//   GET  /api/settings/models + /api/dashboard  fetchComposerOptions()（composer 三控件选项）
//   POST /api/settings/model-switch            switchModel(modelId)（落盘项目默认模型）
//   POST /api/settings/update                  updatePermissions(combo) / updateReasoningEffort(effort)
//
// 复用 api-client.js 的通用 helper：withProjectScope（URL 作用域）与
// readResponseJson（响应解析）。fetch 实现可注入（测试用），默认全局 fetch。
import { withProjectScope, readResponseJson } from "../api-client.js";

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15000;
const SNAPSHOT_LIMIT = 200;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function createAgentApi({
  getProjectRoot = () => null,
  getAfterSeq = () => 0,
  onEvent = () => {},
  onReconnect = async () => {},
  fetchImpl = (url, options) => fetch(url, options),
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS
} = {}) {
  let controller = null;  // 当前 SSE 连接的 AbortController
  let destroyed = false;
  let currentRoot = null;
  let currentSessionId = null; // 当前会话（openProject/setSession 设置；null → 请求不带 sessionId）
  const pendingRequests = new Set(); // 在途请求的 AbortController（destroy 时全部中止）

  function root() {
    return currentRoot ?? getProjectRoot();
  }

  // 会话作用域请求体：projectRoot 打底，设置当前会话时附加 sessionId。
  function scopedBody(extra = {}) {
    const body = { projectRoot: root(), ...extra };
    if (currentSessionId) body.sessionId = currentSessionId;
    return body;
  }

  function abortPendingRequests() {
    for (const abortController of pendingRequests) abortController.abort();
    pendingRequests.clear();
  }

  async function request(url, options = {}) {
    const abortController = new AbortController();
    pendingRequests.add(abortController);
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: options.signal ?? abortController.signal
      });
      const data = await readResponseJson(response);
      if (!response.ok || data.ok === false) {
        const error = new Error(data.message ?? "请求失败");
        error.code = data.code;
        error.status = response.status;
        error.fields = data.fields;
        error.action = data.action;
        throw error;
      }
      return data;
    } finally {
      pendingRequests.delete(abortController);
    }
  }

  function postJson(url, body) {
    return request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async function submit(text, sessionId = currentSessionId) {
    // sessionId 缺省不传 → 后端惰性创建/取活跃会话；显式参数优先于当前会话。
    const body = { projectRoot: root(), text };
    if (sessionId) body.sessionId = sessionId;
    return postJson("/api/agent/input", body);
  }

  async function promote(inputId) {
    return postJson(`/api/agent/input/${encodeURIComponent(inputId)}/promote`, {
      projectRoot: root()
    });
  }

  async function stop(runId) {
    return postJson(`/api/agent/run/${encodeURIComponent(runId)}/stop`, scopedBody());
  }

  async function retry(runId) {
    return postJson(`/api/agent/run/${encodeURIComponent(runId)}/retry`, scopedBody());
  }

  async function decide(decisionId, choice) {
    return postJson(`/api/agent/decision/${encodeURIComponent(decisionId)}`, scopedBody({ choice }));
  }

  async function fetchSnapshot({ afterSeq = 0, beforeSeq = null, tail = false, limit = SNAPSHOT_LIMIT, sessionId = currentSessionId } = {}) {
    // 双向分页（Task 9）：tail=true → 最新尾部页；beforeSeq → 该 seq 之前的旧页；
    // 缺省 → afterSeq 增量拉取（afterSeq=0 只表示从头读取，旧调用方不变）。
    // 优先级与后端一致：tail > beforeSeq > afterSeq。会话走 URL query。
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    if (tail === true) {
      params.set("tail", "1");
    } else if (Number.isFinite(Number(beforeSeq)) && Number(beforeSeq) > 0) {
      params.set("beforeSeq", String(Math.floor(Number(beforeSeq))));
    } else {
      params.set("afterSeq", String(Math.max(0, Number(afterSeq) || 0)));
    }
    params.set("limit", String(Math.max(1, Number(limit) || SNAPSHOT_LIMIT)));
    const url = withProjectScope("/api/agent/snapshot", root()) + "&" + params.toString();
    return request(url, { cache: "no-store" });
  }

  // 压缩取消/重试（Task 9）：ESC、按钮与 HTTP 都调用同一后端方法。
  async function cancelCompaction(compactionId) {
    return postJson(`/api/agent/compaction/${encodeURIComponent(compactionId)}/cancel`, scopedBody());
  }

  async function retryCompaction(compactionId) {
    return postJson(`/api/agent/compaction/${encodeURIComponent(compactionId)}/retry`, scopedBody());
  }

  // 历史导出（Task 9）：响应是 NDJSON 文本流，不是 JSON —— 不能用 readResponseJson
  // 解析，原文交给调用方（Task 13 触发下载）。仍登记 pending request AbortController，
  // 切项目/destroy 时一并中止。
  async function exportHistory() {
    const abortController = new AbortController();
    pendingRequests.add(abortController);
    try {
      const response = await fetchImpl("/api/agent/history/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scopedBody()),
        signal: abortController.signal
      });
      if (!response.ok) {
        const data = await readResponseJson(response).catch(() => null);
        const error = new Error(data?.message ?? "导出失败，请重试。");
        error.code = data?.code;
        error.status = response.status;
        throw error;
      }
      const text = await response.text();
      return { text, status: response.status };
    } finally {
      pendingRequests.delete(abortController);
    }
  }

  // 不可逆清空（Task 9）：需显式 confirm_irreversible:true（服务端守卫）。
  // 活动 Run → 409 history_busy；缺确认 → 400 confirmation_required（前端按码分支）。
  async function clearHistory({ confirm_irreversible = false } = {}) {
    return postJson("/api/agent/history/clear", scopedBody({
      confirm_irreversible: confirm_irreversible === true
    }));
  }

  // 会话管理（Task 7 多会话）：列表 / 新建 / 重命名 / 归档 / 恢复 / 删除。
  // PATCH body 互斥：{ projectRoot, title } 或 { projectRoot, archived: true|false }；
  // DELETE 用 query projectRoot。
  function sessions() {
    return request(withProjectScope("/api/agent/sessions", root()), { cache: "no-store" });
  }

  async function createSession(title) {
    const body = { projectRoot: root() };
    if (title) body.title = title;
    return postJson("/api/agent/sessions", body);
  }

  function patchSession(sessionId, fields) {
    return request(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: root(), ...fields })
    });
  }

  function renameSession(sessionId, title) {
    return patchSession(sessionId, { title });
  }

  function archiveSession(sessionId) {
    return patchSession(sessionId, { archived: true });
  }

  function restoreSession(sessionId) {
    return patchSession(sessionId, { archived: false });
  }

  function deleteSession(sessionId) {
    return request(withProjectScope(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, root()), {
      method: "DELETE"
    });
  }

  // 当前会话：setSession 显式切换；sessionRoot 供调用方读取会话作用域。
  // 契约：setSession 仅改变后续请求的作用域（body/query 的 sessionId，以及下次
  // connectEvents 发起的 SSE URL）；活跃 SSE 连接不会被中止，已建立的连接仍按
  // 连接建立时捕获的 currentSessionId 继续推送旧会话事件。切换会话必须经
  // openProject/connectEvents 重建连接（streamEvents 在发起请求时捕获
  // currentSessionId）——直接 setSession 不切流，调用方不得依赖旧连接自动跟随。
  function setSession(sessionId) {
    currentSessionId = sessionId ?? null;
  }

  function sessionRoot() {
    return { projectRoot: root(), sessionId: currentSessionId ?? null };
  }

  // composer 三控件选项：模型清单（全局）+ 当前项目生效配置（dashboard）。
  // 契约：GET /api/settings/models → { models }（每项带 active 与 capabilities）；
  //       GET /api/dashboard?projectRoot → config.effective.{active_model, tool_permissions, reasoning_effort}。
  async function fetchComposerOptions() {
    const [modelsData, dashboard] = await Promise.all([
      request("/api/settings/models", { cache: "no-store" }),
      request(withProjectScope("/api/dashboard", root()), { cache: "no-store" })
    ]);
    const effective = dashboard?.config?.effective ?? {};
    return {
      models: Array.isArray(modelsData?.models) ? modelsData.models : [],
      activeModel: effective.active_model ?? dashboard?.project?.active_model ?? null,
      toolPermissions: effective.tool_permissions ?? dashboard?.project?.tool_permissions ?? {},
      reasoningEffort: typeof effective.reasoning_effort === "string" ? effective.reasoning_effort : "auto"
    };
  }

  // 模型切换即落盘为当前项目默认模型；响应带 capabilities / available_models / project。
  async function switchModel(modelId) {
    return postJson("/api/settings/model-switch", { projectRoot: root(), model_id: modelId });
  }

  // 权限模式：combo 四布尔整体落盘（与设置页同一契约）。
  async function updatePermissions(toolPermissions) {
    return postJson("/api/settings/update", { projectRoot: root(), tool_permissions: toolPermissions });
  }

  // 思考强度：auto/low/medium/high 落盘（仅 thinking 模型生效，由后端能力矩阵决定发送）。
  async function updateReasoningEffort(effort) {
    return postJson("/api/settings/update", { projectRoot: root(), reasoning_effort: effort });
  }

  // 切换项目/会话：关闭旧事件流和旧项目请求，后续请求使用新作用域。
  async function openProject(projectRoot, sessionId) {
    controller?.abort();
    controller = null;
    abortPendingRequests();
    currentRoot = projectRoot;
    currentSessionId = sessionId ?? null;
  }

  // SSE /api/project/events：断线后按指数退避重连（上限 maxDelayMs）。
  // 每次重连前调用 onReconnect 钩子（AgentSurface 用它按最新 seq 补齐快照）。
  // 退避等待与在途请求均可被 destroy() 中止（signal/abortController）。
  function connectEvents() {
    if (destroyed) return;
    controller?.abort();
    const myController = new AbortController();
    controller = myController;
    let attempt = 0;
    const backoff = () => Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
    const run = async () => {
      while (!destroyed && !myController.signal.aborted) {
        const projectRoot = root();
        if (!projectRoot) return;
        try {
          await streamEvents({
            projectRoot,
            afterSeq: getAfterSeq(),
            signal: myController.signal
          });
          // 流被服务端关闭（重启/网络中断）→ 视作断线，退避重连
          attempt += 1;
          await sleep(backoff(), myController.signal);
        } catch (error) {
          if (destroyed || myController.signal.aborted) return;
          attempt += 1;
          await sleep(backoff(), myController.signal);
        }
        if (destroyed || myController.signal.aborted) return;
        // 重连前补齐缺口，保证事件连续
        try {
          await onReconnect();
        } catch {
          // 补齐失败不阻断重连
        }
      }
    };
    void run();
  }

  // 已知限制（自定义 server 契约）：事件流按 \n\n 分块，data: 单行 JSON，
  // 不做多行 data 拼接（/api/project/events 永不发送多行 data）。
  async function streamEvents({ projectRoot, afterSeq, signal }) {
    let url = withProjectScope("/api/project/events", projectRoot) + `&afterSeq=${Math.max(0, Number(afterSeq) || 0)}`;
    if (currentSessionId) url += `&sessionId=${encodeURIComponent(currentSessionId)}`;
    const response = await fetchImpl(url, { cache: "no-store", signal });
    if (!response.ok) {
      const data = await readResponseJson(response).catch(() => null);
      throw new Error(data?.message ?? `事件流失败 (HTTP ${response.status})`);
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error("事件流响应缺少可读 body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        dispatchBlock(block);
      }
    }
  }

  function dispatchBlock(block) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue; // 忽略注释行与 event: 类型行
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        const event = JSON.parse(raw);
        if (event && typeof event === "object") onEvent(event);
      } catch {
        // 坏行忽略
      }
    }
  }

  function destroy() {
    destroyed = true;
    controller?.abort();
    controller = null;
    abortPendingRequests();
  }

  return {
    openProject,
    submit,
    promote,
    stop,
    retry,
    decide,
    cancelCompaction,
    retryCompaction,
    fetchSnapshot,
    exportHistory,
    clearHistory,
    fetchComposerOptions,
    switchModel,
    updatePermissions,
    updateReasoningEffort,
    connectEvents,
    setSession,
    sessionRoot,
    sessions,
    createSession,
    renameSession,
    archiveSession,
    restoreSession,
    deleteSession,
    destroy
  };
}
