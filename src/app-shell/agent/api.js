// src/app-shell/agent/api.js —— AgentSurface transport（Task 8 Step 1 的一部分）。
//
// /api/agent/* 传输层：
//   POST /api/agent/input                    submit(text)
//   POST /api/agent/input/:inputId/promote   promote(inputId)
//   POST /api/agent/run/:runId/stop          stop(runId)
//   POST /api/agent/run/:runId/retry         retry(runId)
//   POST /api/agent/decision/:decisionId     decide(decisionId, choice)
//   GET  /api/agent/snapshot?afterSeq&limit  fetchSnapshot()
//   GET  /api/project/events?afterSeq        connectEvents()（SSE 轮询流，断线指数退避重连）
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
  const pendingRequests = new Set(); // 在途请求的 AbortController（destroy 时全部中止）

  function root() {
    return currentRoot ?? getProjectRoot();
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

  async function submit(text) {
    return postJson("/api/agent/input", { projectRoot: root(), text });
  }

  async function promote(inputId) {
    return postJson(`/api/agent/input/${encodeURIComponent(inputId)}/promote`, {
      projectRoot: root()
    });
  }

  async function stop(runId) {
    return postJson(`/api/agent/run/${encodeURIComponent(runId)}/stop`, {
      projectRoot: root()
    });
  }

  async function retry(runId) {
    return postJson(`/api/agent/run/${encodeURIComponent(runId)}/retry`, {
      projectRoot: root()
    });
  }

  async function decide(decisionId, choice) {
    return postJson(`/api/agent/decision/${encodeURIComponent(decisionId)}`, {
      projectRoot: root(),
      choice
    });
  }

  async function fetchSnapshot({ afterSeq = 0, limit = SNAPSHOT_LIMIT } = {}) {
    const url =
      withProjectScope("/api/agent/snapshot", root()) +
      `&afterSeq=${Math.max(0, Number(afterSeq) || 0)}` +
      `&limit=${Math.max(1, Number(limit) || SNAPSHOT_LIMIT)}`;
    return request(url, { cache: "no-store" });
  }

  // 切换项目：关闭旧事件流，后续请求使用新作用域。
  async function openProject(projectRoot) {
    currentRoot = projectRoot;
    controller?.abort();
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
    const url = withProjectScope("/api/project/events", projectRoot) + `&afterSeq=${Math.max(0, Number(afterSeq) || 0)}`;
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
    for (const abortController of pendingRequests) abortController.abort();
    pendingRequests.clear();
  }

  return {
    openProject,
    submit,
    promote,
    stop,
    retry,
    decide,
    fetchSnapshot,
    connectEvents,
    destroy
  };
}
