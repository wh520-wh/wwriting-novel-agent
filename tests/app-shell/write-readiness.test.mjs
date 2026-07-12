import assert from "node:assert/strict";
import test from "node:test";
import { deriveWriteReadiness } from "../../src/app-shell/write-readiness.mjs";

const base = {
  hasProject: true,
  project: {
    title: "夜航钟表铺",
    target_chapters: 10,
    active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY"
    },
    tool_permissions: {}
  },
  model_profile: {
    display: "DeepSeek · deepseek-chat",
    model_name: "deepseek-chat",
    is_mock: false
  },
  summary: {
    completedChapters: 0,
    targetChapters: 10,
    currentChapterNo: 1,
    projectStatus: "idle"
  },
  state: { project_status: "idle", current_chapter_no: 1 },
  chatHistory: { busy: false },
  events: [],
  failures: []
};

function data(overrides = {}) {
  return {
    ...base,
    ...overrides,
    project: { ...base.project, ...(overrides.project || {}) },
    model_profile: { ...base.model_profile, ...(overrides.model_profile || {}) },
    summary: { ...base.summary, ...(overrides.summary || {}) },
    state: { ...base.state, ...(overrides.state || {}) }
  };
}

test("key readiness states", () => {
  assert.equal(deriveWriteReadiness({ hasProject: false }).key, "no_project");
  assert.equal(
    deriveWriteReadiness(data({ project: { active_model: null }, model_profile: null })).key,
    "missing_model"
  );
  assert.equal(
    deriveWriteReadiness(data({
      model_profile: { is_mock: true, display: "演示模型", model_name: "mock-writer" }
    })).key,
    "demo"
  );
  assert.equal(
    deriveWriteReadiness(data({
      events: [{ type: "model_connection_tested", data: { model_name: "deepseek-chat", ok: true } }]
    })).key,
    "ready"
  );
  assert.equal(
    deriveWriteReadiness(data({
      events: [{ type: "model_connection_tested", data: { model_name: "old-model", ok: true } }]
    })).key,
    "connection_unknown"
  );
});

test("project states take precedence", () => {
  assert.equal(deriveWriteReadiness(data({ summary: { projectStatus: "running" } })).key, "running");
  assert.equal(deriveWriteReadiness(data({ summary: { projectStatus: "blocked" } })).key, "blocked");
  assert.equal(deriveWriteReadiness(data({ summary: { completedChapters: 10 } })).key, "completed");
  assert.equal(
    deriveWriteReadiness(data({ project: { archived_at: "2026-07-12T00:00:00Z" } })).key,
    "project_read_only"
  );
  assert.equal(
    deriveWriteReadiness(data({ project: { tool_permissions: { read_only: true } } })).key,
    "project_read_only"
  );
});
