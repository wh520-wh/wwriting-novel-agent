// Task 7: AgentSurface transport（agent/api.js）多会话支持契约测试。
//
// 覆盖：
//   - openProject(projectRoot, sessionId?) 设置当前会话；无会话时所有请求不带
//     sessionId（缺省兼容，旧调用形状不变）；
//   - submit(text, sessionId?) body 携带 sessionId；显式参数优先于当前会话；
//   - fetchSnapshot({ sessionId?, ... }) URL query 携带 sessionId；
//   - stop/retry/decide/cancelCompaction/retryCompaction/exportHistory/
//     clearHistory body 携带 sessionId；
//   - connectEvents SSE URL 携带当前会话 sessionId；openProject 切换会 abort 旧流；
//   - sessions/createSession/renameSession/archiveSession/restoreSession/
//     deleteSession 的 URL / 方法 / body 形状。
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentApi } from "../../src/app-shell/agent/api.js";

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function sseResponse() {
  return {
    ok: true,
    status: 200,
    text: async () => {
      throw new Error("SSE path should not call response.text()");
    },
    body: {
      getReader() {
        let done = false;
        return {
          read() {
            if (done) return Promise.resolve({ done: true, value: undefined });
            done = true;
            return Promise.resolve({ done: false, value: new TextEncoder().encode("data: {}\n\n") });
          }
        };
      }
    }
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 最小注入：记录每次 fetch 的 url/method/body，返回通用成功响应。
// 命中 /api/project/events 时走 SSE 流（用于断言连接与 abort）。
function makeApi({ getProjectRoot = () => "P", captureSignal = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? "GET",
      body: options.body ? JSON.parse(options.body) : null,
      ...(captureSignal ? { signal: options.signal } : {})
    });
    if (String(url).includes("/api/project/events")) return sseResponse();
    return jsonResponse({ ok: true });
  };
  const api = createAgentApi({ getProjectRoot, fetchImpl });
  return { api, calls };
}

// 无论断言成败都销毁 api：SSE 重连退避计时器必须随 destroy 中止，否则
// 失败的测试会拖住 node --test 进程（指数退避永不退出）。
function withApi(t, opts) {
  const { api, calls } = makeApi(opts);
  t.after(() => api.destroy());
  return { api, calls };
}

// ---------------------------------------------------------------------------
// 当前会话注入：submit / fetchSnapshot
// ---------------------------------------------------------------------------

test("openProject(\"P\", \"sid-1\") 后 submit 的请求 body 含 sessionId", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "sid-1");
  await api.submit("你好");
  const call = calls.find((c) => c.url === "/api/agent/input");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { projectRoot: "P", text: "你好", sessionId: "sid-1" });
});

test("submit 显式 sessionId 参数优先于当前会话", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "sid-1");
  await api.submit("你好", "sid-2");
  const call = calls.find((c) => c.url === "/api/agent/input");
  assert.equal(call.body.sessionId, "sid-2", "显式参数应覆盖当前会话");
});

test("submit 显式 null：不携带 sessionId（按未设置会话处理）", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "sid-1");
  await api.submit("你好", null);
  const call = calls.find((c) => c.url === "/api/agent/input");
  assert.deepEqual(call.body, { projectRoot: "P", text: "你好" }, "显式 null 不得出现 sessionId 键");
});

test("未设置会话时 submit body 不带 sessionId（缺省兼容）", async (t) => {
  const { api, calls } = withApi(t);
  await api.submit("你好");
  const call = calls.find((c) => c.url === "/api/agent/input");
  assert.deepEqual(call.body, { projectRoot: "P", text: "你好" }, "不得出现 sessionId 键");
});

test("openProject 未带 sessionId 时重置当前会话，submit 不带 sessionId", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "sid-1");
  api.openProject("P");
  await api.submit("你好");
  const call = calls.find((c) => c.url === "/api/agent/input");
  assert.deepEqual(call.body, { projectRoot: "P", text: "你好" }, "切换项目未指定会话时应回到无会话语义");
});

test("fetchSnapshot 的 URL 含当前会话 sessionId（query 形态）", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "sid-1");
  await api.fetchSnapshot({});
  const call = calls.find((c) => c.url.includes("/api/agent/snapshot"));
  assert.match(call.url, /projectRoot=P/u);
  assert.match(call.url, /sessionId=sid-1/u);
});

test("fetchSnapshot 显式 sessionId 参数覆盖当前会话", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "sid-1");
  await api.fetchSnapshot({ sessionId: "sid-9" });
  const call = calls.find((c) => c.url.includes("/api/agent/snapshot"));
  assert.match(call.url, /sessionId=sid-9/u);
  assert.doesNotMatch(call.url, /sessionId=sid-1/u);
});

test("sessionId 含特殊字符时 query/body 编码正确（URL 无裸 & / ?，服务端可还原）", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "a&b/c?d");
  // body：JSON 原样携带，可还原
  await api.submit("你好");
  const inputCall = calls.find((c) => c.url === "/api/agent/input");
  assert.equal(inputCall.body.sessionId, "a&b/c?d");
  // snapshot query：URLSearchParams 编码，值内不得出现裸 & / ?
  await api.fetchSnapshot({});
  const snapshotCall = calls.find((c) => c.url.includes("/api/agent/snapshot"));
  assert.match(snapshotCall.url, /sessionId=a%26b%2Fc%3Fd/u);
  assert.doesNotMatch(snapshotCall.url, /sessionId=a&b/u);
  // SSE query：encodeURIComponent 编码
  api.connectEvents();
  await tick();
  const sseCall = calls.find((c) => c.url.includes("/api/project/events"));
  assert.match(sseCall.url, /sessionId=a%26b%2Fc%3Fd/u);
});

test("未设置会话时 fetchSnapshot URL 不带 sessionId", async (t) => {
  const { api, calls } = withApi(t);
  await api.fetchSnapshot({});
  const call = calls.find((c) => c.url.includes("/api/agent/snapshot"));
  assert.match(call.url, /projectRoot=P/u);
  assert.doesNotMatch(call.url, /sessionId=/u);
});

// ---------------------------------------------------------------------------
// 其余请求携带 sessionId（按端点现有形态：URL query 或 body）
// ---------------------------------------------------------------------------

test("带会话时 stop/retry/decide/cancelCompaction/retryCompaction/clearHistory/exportHistory/requestPriority/withdrawInput body 携带 sessionId", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "sid-1");
  await api.stop("run-1");
  await api.retry("run-1");
  await api.decide("dec-1", "option-a");
  await api.cancelCompaction("cmp-1");
  await api.retryCompaction("cmp-1");
  await api.clearHistory({ confirm_irreversible: true });
  await api.exportHistory();
  await api.requestPriority("in-2");
  await api.withdrawInput("in-3");
  const withSession = calls.filter((c) => c.body && c.body.sessionId === "sid-1");
  assert.equal(withSession.length, 9, "全部 9 个 POST body 都应带 sessionId");
  for (const call of calls) {
    assert.equal(call.body.projectRoot, "P", `${call.url} 仍带 projectRoot`);
  }
  const exportCall = calls.find((c) => c.url === "/api/agent/history/export");
  assert.equal(exportCall.body.sessionId, "sid-1");
});

test("未设置会话时 stop/clearHistory body 不带 sessionId", async (t) => {
  const { api, calls } = withApi(t);
  await api.stop("run-1");
  await api.clearHistory();
  for (const call of calls) {
    assert.ok(!("sessionId" in call.body), `${call.url} 不得出现 sessionId 键`);
  }
});

// ---------------------------------------------------------------------------
// SSE：URL 会话 + openProject 切流 abort 旧连接
// ---------------------------------------------------------------------------

test("connectEvents 的 SSE URL 含当前会话 sessionId", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "sid-1");
  api.connectEvents();
  await tick();
  const sseCall = calls.find((c) => c.url.includes("/api/project/events"));
  assert.ok(sseCall, "应发起 SSE 连接");
  assert.match(sseCall.url, /sessionId=sid-1/u);
});

test("未设置会话时 SSE URL 不带 sessionId", async (t) => {
  const { api, calls } = withApi(t);
  api.connectEvents();
  await tick();
  const sseCall = calls.find((c) => c.url.includes("/api/project/events"));
  assert.ok(sseCall);
  assert.doesNotMatch(sseCall.url, /sessionId=/u);
});

test("openProject 切换会 abort 旧 SSE 连接", async (t) => {
  const { api, calls } = withApi(t, { captureSignal: true });
  api.openProject("P", "sid-1");
  api.connectEvents();
  await tick();
  const sseCall = calls.find((c) => c.url.includes("/api/project/events"));
  assert.ok(sseCall.signal, "SSE 连接应登记 signal");
  assert.equal(sseCall.signal.aborted, false);
  api.openProject("P", "sid-2");
  assert.equal(sseCall.signal.aborted, true, "切换会话应中止旧事件流");
});

test("openProject 切换会中止在途的普通请求（非 SSE）", async (t) => {
  let submitSignal = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/api/agent/input")) {
      submitSignal = options.signal;
      await gate; // 挂起 fetch，保持请求在途
    }
    return jsonResponse({ ok: true });
  };
  const api = createAgentApi({ getProjectRoot: () => "P", fetchImpl });
  t.after(() => {
    api.destroy();
    release();
  });
  const pending = api.submit("你好");
  await tick();
  assert.ok(submitSignal, "submit 请求应登记 signal");
  assert.equal(submitSignal.aborted, false);
  api.openProject("P", "sid-2");
  assert.equal(submitSignal.aborted, true, "切流应中止在途普通请求");
  release();
  await pending;
});

// ---------------------------------------------------------------------------
// streamEvents：流结束冲刷 TextDecoder 并分发残留尾块（R5-3）
// ---------------------------------------------------------------------------

test("streamEvents 流结束：无参 decode() 冲刷并把残留尾块分发（含 truncated:true 事件透出）", async (t) => {
  const events = [];
  // 第二个块没有尾部空行分隔——旧实现把它留在 buffer 里静默丢弃；流结束冲刷
  //（decoder.decode()）后应作为最后一帧照常分发。事件负载原样透出，截断正文
  // 事件的 truncated:true 不得丢失。
  const payloads = [
    'data: {"type":"assistant_message_completed","payload":{"text":"半截正文","truncated":true}}\n\n',
    'data: {"type":"tail","payload":2}'
  ];
  const fetchImpl = async (url, options = {}) => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new Error("SSE path should not call response.text()");
    },
    body: {
      getReader() {
        let index = 0;
        return {
          read() {
            if (index >= payloads.length) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: new TextEncoder().encode(payloads[index++]) });
          }
        };
      }
    }
  });
  const api = createAgentApi({ getProjectRoot: () => "P", fetchImpl, onEvent: (event) => events.push(event) });
  t.after(() => api.destroy());
  api.connectEvents();
  const deadline = Date.now() + 2000;
  while (events.length < 2 && Date.now() < deadline) await tick();
  assert.deepEqual(events, [
    { type: "assistant_message_completed", payload: { text: "半截正文", truncated: true } },
    { type: "tail", payload: 2 }
  ], "首块与无分隔尾块都应分发，truncated:true 原样透出");
});

// ---------------------------------------------------------------------------
// 会话管理端点：sessions / createSession / renameSession / archiveSession /
// restoreSession / deleteSession
// ---------------------------------------------------------------------------

test("sessions()：GET /api/agent/sessions?projectRoot=，返回 { sessions, active_session_id }", async (t) => {
  const payload = {
    sessions: [{ session_id: "s1", title: "会话一" }],
    active_session_id: "s1"
  };
  const recorded = [];
  const fetchImpl = async (url, options = {}) => {
    recorded.push({ url: String(url), method: options.method ?? "GET" });
    return jsonResponse(payload);
  };
  const api = createAgentApi({ getProjectRoot: () => "P", fetchImpl });
  t.after(() => api.destroy());
  const data = await api.sessions();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].method, "GET");
  assert.equal(recorded[0].url, "/api/agent/sessions?projectRoot=P");
  assert.deepEqual(data, payload);
});

test("createSession()：POST /api/agent/sessions，body 仅 projectRoot（无 title 不传键）", async (t) => {
  const { api, calls } = withApi(t);
  await api.createSession();
  const call = calls.find((c) => c.url === "/api/agent/sessions");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { projectRoot: "P" });
});

test("createSession(title)：body 携带 title", async (t) => {
  const { api, calls } = withApi(t);
  await api.createSession("新会话");
  const call = calls.find((c) => c.url === "/api/agent/sessions");
  assert.deepEqual(call.body, { projectRoot: "P", title: "新会话" });
});

test("renameSession：PATCH /api/agent/sessions/:id，body { projectRoot, title }", async (t) => {
  const { api, calls } = withApi(t);
  await api.renameSession("s1", "新名字");
  const call = calls.find((c) => c.url === "/api/agent/sessions/s1");
  assert.equal(call.method, "PATCH");
  assert.deepEqual(call.body, { projectRoot: "P", title: "新名字" });
});

test("archiveSession：PATCH body { projectRoot, archived: true }", async (t) => {
  const { api, calls } = withApi(t);
  await api.archiveSession("s1");
  const call = calls.find((c) => c.url === "/api/agent/sessions/s1");
  assert.equal(call.method, "PATCH");
  assert.deepEqual(call.body, { projectRoot: "P", archived: true });
});

test("restoreSession：PATCH body { projectRoot, archived: false }", async (t) => {
  const { api, calls } = withApi(t);
  await api.restoreSession("s1");
  const call = calls.find((c) => c.url === "/api/agent/sessions/s1");
  assert.equal(call.method, "PATCH");
  assert.deepEqual(call.body, { projectRoot: "P", archived: false });
});

test("deleteSession：DELETE /api/agent/sessions/:id?projectRoot=", async (t) => {
  const { api, calls } = withApi(t);
  await api.deleteSession("s1");
  const call = calls.find((c) => c.url.startsWith("/api/agent/sessions/s1"));
  assert.equal(call.method, "DELETE");
  assert.equal(call.url, "/api/agent/sessions/s1?projectRoot=P");
});

// ---------------------------------------------------------------------------
// requestPriority / withdrawInput（Task 11）：会话作用域——target 由 body.sessionId
// 决定，缺 sessionId 会命中其他会话的 last-active 队列，跨会话误打断/误撤回。
// 旧 promote/cancel 概念已从前端移除，不再有 /promote 调用。
// ---------------------------------------------------------------------------

test("requestPriority：POST /api/agent/input/:id/priority，body 带当前会话 sessionId", async (t) => {
  const { api, calls } = withApi(t);
  api.openProject("P", "sid-1");
  await api.requestPriority("in-2");
  const call = calls.find((c) => c.url === "/api/agent/input/in-2/priority");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { projectRoot: "P", sessionId: "sid-1" });
  assert.ok(!calls.some((c) => c.url.includes("/promote")), "旧 promote 端点不得再被调用");
});

test("withdrawInput：POST /api/agent/input/:id/withdraw，body 带当前会话 sessionId，透传 draft_text", async (t) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null });
    return jsonResponse({ ok: true, withdrawn: true, draft_text: "被撤回的文本" });
  };
  const api = createAgentApi({ getProjectRoot: () => "P", fetchImpl });
  t.after(() => api.destroy());
  api.openProject("P", "sid-1");
  const result = await api.withdrawInput("in-3");
  const call = calls.find((c) => c.url === "/api/agent/input/in-3/withdraw");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { projectRoot: "P", sessionId: "sid-1" });
  assert.equal(result.draft_text, "被撤回的文本", "撤回接口返回权威 draft_text 供 composer 回填");
});

test("未设置会话时 requestPriority/withdrawInput body 不带 sessionId（缺省兼容）", async (t) => {
  const { api, calls } = withApi(t);
  await api.requestPriority("in-2");
  await api.withdrawInput("in-3");
  const priorityCall = calls.find((c) => c.url === "/api/agent/input/in-2/priority");
  const withdrawCall = calls.find((c) => c.url === "/api/agent/input/in-3/withdraw");
  assert.deepEqual(priorityCall.body, { projectRoot: "P" }, "不得出现 sessionId 键");
  assert.deepEqual(withdrawCall.body, { projectRoot: "P" }, "不得出现 sessionId 键");
});

// ---------------------------------------------------------------------------
// composer 三控件保存（Task 21）：模型切换 / 权限 / 思考强度端点契约 + 非 2xx
// 一律 reject（前端据此显示 error toast，绝不静默接受失败响应）。
// ---------------------------------------------------------------------------

test("switchModel：POST /api/settings/model-switch，引用形态拆分为 provider_id/model_id", async (t) => {
  const { api, calls } = withApi(t);
  await api.switchModel("p-deepseek/m-reasoner");
  const call = calls.find((c) => c.url === "/api/settings/model-switch");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { projectRoot: "P", provider_id: "p-deepseek", model_id: "m-reasoner" });
});

test("updatePermissions：POST /api/settings/update，body 携带 tool_permissions", async (t) => {
  const { api, calls } = withApi(t);
  await api.updatePermissions({ read_only: false, safe_edit: true, auto_edit: true, yolo: true });
  const call = calls.find((c) => c.url === "/api/settings/update");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { projectRoot: "P", tool_permissions: { read_only: false, safe_edit: true, auto_edit: true, yolo: true } });
});

test("updateReasoningEffort：POST /api/settings/update，body 携带 reasoning_effort", async (t) => {
  const { api, calls } = withApi(t);
  await api.updateReasoningEffort("high");
  const call = calls.find((c) => c.url === "/api/settings/update");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { projectRoot: "P", reasoning_effort: "high" });
});

test("三控件保存返回非 2xx：reject 并携带 status/code，不把失败当成功返回", async (t) => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/api/project/events")) return sseResponse();
    if (String(url) === "/api/settings/model-switch" || String(url) === "/api/settings/update") {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ ok: false, message: "保存失败", code: "save_failed" })
      };
    }
    return jsonResponse({ ok: true });
  };
  const api = createAgentApi({ getProjectRoot: () => "P", fetchImpl });
  t.after(() => api.destroy());
  await assert.rejects(
    api.switchModel("p-ds/m-r"),
    (error) => error.status === 500 && error.code === "save_failed" && /保存失败/u.test(error.message)
  );
  await assert.rejects(
    api.updatePermissions({ read_only: true }),
    (error) => error.status === 500 && error.code === "save_failed"
  );
  await assert.rejects(
    api.updateReasoningEffort("low"),
    (error) => error.status === 500 && error.code === "save_failed"
  );
});

