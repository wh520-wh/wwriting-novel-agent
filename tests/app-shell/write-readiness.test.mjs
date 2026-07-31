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
  const merge = (field) => {
    if (Object.hasOwn(overrides, field)) {
      const v = overrides[field];
      if (v === null || v === undefined) return v;
      return { ...base[field], ...v };
    }
    return { ...base[field] };
  };
  return {
    ...base,
    ...overrides,
    project: merge("project"),
    model_profile: merge("model_profile"),
    summary: merge("summary"),
    state: merge("state")
  };
}

test("key readiness states", () => {
  assert.equal(deriveWriteReadiness({ hasProject: false }).key, "no_project");  assert.equal(
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
      events: [{ type: "model_connection_tested", data: { model_name: "deepseek-chat", ok: false } }]
    })).key,
    "invalid_model"
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

test("connection event matching rules", () => {
  const activeModel = { provider: "openai-compatible", model_name: "deepseek-chat", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" };

  // ok:true with matching model_name -> ready
  const matchedOk = deriveWriteReadiness(data({
    project: { active_model: activeModel },
    events: [{ type: "model_connection_tested", data: { model_name: "deepseek-chat", ok: true } }]
  }));
  assert.equal(matchedOk.key, "ready");
  assert.equal(matchedOk.reasonCode, null);

  // ok:true with non-matching model_name -> connection_unknown
  const nonMatchingOk = deriveWriteReadiness(data({
    project: { active_model: activeModel },
    events: [{ type: "model_connection_tested", data: { model_name: "old-model", ok: true } }]
  }));
  assert.equal(nonMatchingOk.key, "connection_unknown");
  assert.equal(nonMatchingOk.reasonCode, null);

  // ok:false with matching model_name -> invalid_model with reasonCode
  const failedConn = deriveWriteReadiness(data({
    project: { active_model: activeModel },
    events: [{ type: "model_connection_tested", data: { model_name: "deepseek-chat", ok: false } }]
  }));
  assert.equal(failedConn.key, "invalid_model");
  assert.equal(failedConn.reasonCode, "connection_failed");
  assert.equal(failedConn.blocking, true);

  // multiple events — latest matching event wins
  const latestWins = deriveWriteReadiness(data({
    project: { active_model: activeModel },
    events: [
      { type: "model_connection_tested", data: { model_name: "deepseek-chat", ok: false } },
      { type: "model_connection_tested", data: { model_name: "deepseek-chat", ok: true } }
    ]
  }));
  assert.equal(latestWins.key, "ready");
  assert.equal(latestWins.reasonCode, null);
});

test("全局已测模型：项目无连接事件时回退到 globallyTestedModels，判 ready 不强制重测", () => {
  // 项目无事件 + 全局记忆有该模型 -> ready
  const viaGlobal = deriveWriteReadiness(data({ events: [] }), {
    globallyTestedModels: ["deepseek-chat"]
  });
  assert.equal(viaGlobal.key, "ready");
  assert.equal(viaGlobal.primaryAction, "start_chapter");

  // 项目无事件 + 全局记忆无该模型 -> connection_unknown（原行为）
  const noGlobal = deriveWriteReadiness(data({ events: [] }), {
    globallyTestedModels: ["some-other-model"]
  });
  assert.equal(noGlobal.key, "connection_unknown");

  // 项目有失败事件 -> 仍 invalid_model（项目级失败优先于全局记忆）
  const projectFailed = deriveWriteReadiness(data({
    events: [{ type: "model_connection_tested", data: { model_name: "deepseek-chat", ok: false } }]
  }), { globallyTestedModels: ["deepseek-chat"] });
  assert.equal(projectFailed.key, "invalid_model");
});

test("full return shape for ready state", () => {
  const result = deriveWriteReadiness(data({
    events: [{ type: "model_connection_tested", data: { model_name: "deepseek-chat", ok: true } }]
  }));
  assert.equal(result.key, "ready");
  assert.equal(result.label, "模型已连接");
  assert.ok(result.detail.includes("第 1 章"));
  assert.equal(result.primaryAction, "start_chapter");
  assert.equal(result.primaryLabel, "开始写第 1 章");
  assert.equal(result.chapterNo, 1);
  assert.equal(result.modelLabel, "DeepSeek · deepseek-chat");
  assert.equal(result.blocking, false);
  assert.equal(result.reasonCode, null);
});

test("full return shape for no_project", () => {
  const result = deriveWriteReadiness({ hasProject: false });
  assert.equal(result.key, "no_project");
  assert.equal(result.primaryAction, "create_project");
  assert.equal(result.primaryLabel, "新建小说");
  assert.equal(result.blocking, false);
});

test("full return shape for missing_model", () => {
  const result = deriveWriteReadiness(data({ project: { active_model: null }, model_profile: null }));
  assert.equal(result.key, "missing_model");
  assert.equal(result.primaryAction, "open_settings");
  assert.equal(result.blocking, false);
});

test("full return shape for demo", () => {
  const result = deriveWriteReadiness(data({
    model_profile: { is_mock: true, display: "演示模型", model_name: "mock-writer" }
  }));
  assert.equal(result.key, "demo");
  assert.equal(result.primaryAction, "start_chapter");
  assert.equal(result.primaryLabel, "用演示模型写第 1 章");
  assert.equal(result.blocking, false);
});

test("blocked via failures when project status is idle", () => {
  const result = deriveWriteReadiness(data({
    summary: { projectStatus: "idle" },
    failures: [{ id: "f1", kind: "test" }]
  }));
  assert.equal(result.key, "blocked");
  assert.equal(result.blocking, true);
});

test("running via chatHistory.busy when project status is idle", () => {
  const result = deriveWriteReadiness(data({
    summary: { projectStatus: "idle" },
    chatHistory: { busy: true }
  }));
  assert.equal(result.key, "running");
});

test("null and undefined input are handled safely", () => {
  const nullResult = deriveWriteReadiness(null);
  assert.equal(nullResult.key, "no_project");
  const undefResult = deriveWriteReadiness(undefined);
  assert.equal(undefResult.key, "no_project");
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
