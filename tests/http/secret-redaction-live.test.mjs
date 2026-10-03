// 运行中新增密钥的即时脱敏回归（2026-10-03 补强）：
// 服务器启动后保存的供应商密钥（不命中常见 token 模式）必须立即进入运行中
// Runtime 的脱敏名单——一次性与流式脱敏共享同一份名单（组合根 secretSink 容器
// push 即生效），持久 journal 事件不得出现明文。此前 createRedactor 在构造时
// 复制名单，运行中新增的值以明文进入 assistant_message_completed（已复现）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../../src/core/app-server.mjs";
import { createProjectRoot } from "../helpers/project-agent-harness.mjs";

test("服务器启动后保存的密钥即时进入脱敏名单（journal 无明文）", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ww-secret-live-"));
  const { projectRoot } = await createProjectRoot(workspace, { slug: "novel" });
  const fakeKey = "fixture_only_custom_key_987654321";
  const server = createAppShellServer({
    workspaceRoot: workspace,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(workspace, ".state"),
    secretsRoot: path.join(workspace, ".secrets"),
    staticRoot: path.resolve("src", "app-shell"),
    skills: { catalog: async () => ({ active: [] }) },
    testGatewayFactory: () => ({ complete: async () => ({ text: `工具原样回显 ${fakeKey}` }) })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, method, body) => {
    const response = await fetch(origin + route, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  try {
    const created = await call("/api/settings/providers", "POST", {
      id: "fixture_secret_provider",
      name: "测试连接",
      base_url: "https://example.invalid/v1",
      api_format: "openai-chat-completions"
    });
    await call(`/api/settings/providers/${created.provider.id}`, "PATCH", { api_key: fakeKey });
    await call("/api/agent/input", "POST", { projectRoot, text: "测试回显" });
    let snapshot;
    for (let i = 0; i < 300; i++) {
      snapshot = await call(`/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}&tail=1&limit=100`, "GET");
      if (snapshot.session?.active_run?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(snapshot.session?.active_run?.status, "completed");
    const reply = snapshot.events.find((e) => e.type === "assistant_message_completed");
    assert.ok(reply, "应产生 assistant_message_completed 事件");
    assert.ok(
      !JSON.stringify(snapshot.events).includes(fakeKey),
      "运行中新增的密钥不得以明文进入持久 journal"
    );
    assert.ok(
      String(reply?.payload?.text ?? "").includes("[REDACTED]"),
      "回显位置应被替换为 [REDACTED]"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.fixture_secret_provider;
  }
});
