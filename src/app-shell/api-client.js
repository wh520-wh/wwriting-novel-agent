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

export async function getJson(url, { signal } = {}) {
  const response = await fetch(url, { cache: "no-store", signal });
  const data = await readResponseJson(response);
  if (!response.ok || data.ok === false) {
    const error = new Error(data.message ?? "请求失败");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function postJson(url, body, { signal } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
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
}

export async function deleteJson(url, body, { signal } = {}) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal
  });
  const data = await readResponseJson(response);
  if (!response.ok || data.ok === false) {
    const error = new Error(data.message ?? "请求失败");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
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
