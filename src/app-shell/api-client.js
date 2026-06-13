export async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await readResponseJson(response);
  if (!response.ok || data.ok === false) {
    throw new Error(data.message ?? "请求失败");
  }
  return data;
}

export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
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

export async function sendChatMessage(message) {
  return await postJson("/api/chat/send", { message });
}

export async function confirmChatAction(approve) {
  return await postJson("/api/chat/confirm", { approve });
}

export async function stopChat() {
  return await postJson("/api/chat/stop", {});
}

export async function fetchChatHistory({ after = null, limit = 100 } = {}) {
  const params = new URLSearchParams();
  if (after) params.set("after", after);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return await getJson(`/api/chat/history${qs ? `?${qs}` : ""}`);
}
