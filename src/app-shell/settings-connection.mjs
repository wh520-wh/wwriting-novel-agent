// Pure helpers for the model connection test feature.
// Extracted into a separate module so they can be exercised in node:test
// without pulling in DOM-bound code (gsap, settings-modal.js, etc.).

// MiMo preset exact fields (per Task 5 plan). Do NOT rename the env var.
export const MIMO_PRESET = Object.freeze({
  provider: "openai-compatible",
  model_name: "mimo-v2.5-pro",
  base_url: "https://api.xiaomimimo.com/v1",
  api_key_env: "XIAOMI_MIMO_API_KEY",
});

// Translate a server `/api/settings/test-connection` payload into a single
// user-facing status string. Pure: no DOM, no I/O.
export function formatConnectionStatus(result) {
  if (!result) return "";
  if (result.ok) {
    const latency = Number.isFinite(result.latency_ms) ? result.latency_ms : null;
    return latency === null ? "连接成功" : `连接成功 · ${latency} ms`;
  }
  if (typeof result.message === "string" && result.message.length > 0) {
    return result.message;
  }
  return "";
}

// POST a candidate `active_model` to `/api/settings/test-connection`. Pure: the
// transport is injected so callers can stub it from tests. Propagates
// AbortError when the caller cancels via `signal`.
export async function submitModelConnectionTest({
  postJsonImpl,
  projectRoot,
  active_model,
  apiKey,
  signal,
} = {}) {
  if (typeof postJsonImpl !== "function") {
    throw new TypeError("submitModelConnectionTest requires postJsonImpl");
  }
  const body = {
    projectRoot,
    active_model: {
      ...active_model,
      api_key: apiKey ?? "",
    },
  };
  return await postJsonImpl("/api/settings/test-connection", body, { signal });
}