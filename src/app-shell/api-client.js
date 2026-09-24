// 通用 HTTP helper（统一 Agent 内核计划 Task 9：保留通用 GET/POST/JSON/project-scope
// helper；旧聊天助手已删除——AgentSurface transport 收敛到 agent/api.js）。
// 附加 ?projectRoot=... 到 URL。给需要显式作用域的端点用。
// 任何模块（包括 app.js）都应该走这个 helper，避免散落手写 URLSearchParams。
export function withProjectScope(pathname, projectRoot) {
  const origin = (typeof window !== "undefined" && window.location?.origin) || "http://localhost";
  const url = new URL(pathname, origin);
  if (projectRoot) url.searchParams.set("projectRoot", projectRoot);
  // 维持原 pathname 的相对形式：返回 pathname + search。
  return `${url.pathname}${url.search}`;
}

// 三函数共核。options 原样透传给 fetch（method/headers/body/signal/cache 的差异由调用方
// 声明，故 getJson 的 cache: "no-store" 只出现在 getJson——post/delete 原本不设，不得外溢）。
// attachActionFields 仅供 postJson：错误恒挂 fields/action（值可为 undefined），与原实现
// 的无条件赋值逐字等价；不改成条件赋值，避免改变键存在性。
async function request(url, options, attachActionFields) {
  const response = await fetch(url, options);
  const data = await readResponseJson(response);
  if (!response.ok || data.ok === false) {
    const error = new Error(data.message ?? "请求失败");
    error.code = data.code;
    error.status = response.status;
    if (attachActionFields) {
      error.fields = data.fields;
      error.action = data.action;
    }
    throw error;
  }
  return data;
}

export async function getJson(url, { signal } = {}) {
  return request(url, { cache: "no-store", signal });
}

export async function postJson(url, body, { signal } = {}) {
  return request(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    },
    true
  );
}

export async function deleteJson(url, body, { signal } = {}) {
  return request(url, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal
  });
}

export async function readResponseJson(response) {
  const text = await response.text();
  if (!text) return { ok: response.ok };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, message: text.slice(0, 240) || `HTTP ${response.status}` };
  }
}
