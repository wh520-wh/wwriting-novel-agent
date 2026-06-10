import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerCommand,
  unregisterCommand,
  getCommand,
  listCommands,
  __resetRegistry
} from "../src/app-shell/command-registry.mjs";
import {
  askCommand,
  chaptersCommand,
  reviewCommand,
  settingsCommand,
  writeCommand
} from "../src/app-shell/commands/index.mjs";

function noop() {}

test.beforeEach(() => {
  __resetRegistry();
});

const sampleCmd = {
  name: "sample",
  description: "test",
  run: async () => ({ ok: true }),
};

test("registerCommand stores command", () => {
  registerCommand({ ...sampleCmd });
  const cmd = getCommand("sample");
  assert.ok(cmd);
  assert.equal(cmd.name, "sample");
});

test("registerCommand overwriting same name replaces it", () => {
  registerCommand({ ...sampleCmd });
  registerCommand({ ...sampleCmd, description: "v2" });
  assert.equal(getCommand("sample").description, "v2");
});

test("unregisterCommand removes the command", () => {
  registerCommand({ ...sampleCmd });
  assert.ok(unregisterCommand("sample"));
  assert.equal(getCommand("sample"), undefined);
});

test("unregisterCommand on missing name returns false", () => {
  assert.equal(unregisterCommand("nope"), false);
});

test("getCommand returns undefined for unknown", () => {
  assert.equal(getCommand("nope"), undefined);
});

test("listCommands returns all registered commands", () => {
  registerCommand({ ...sampleCmd, name: "a" });
  registerCommand({ ...sampleCmd, name: "b" });
  const all = listCommands();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((c) => c.name).sort(), ["a", "b"]);
});

test("listCommands filters by userInvocable, category, and isEnabled", () => {
  registerCommand({ ...sampleCmd, name: "public", userInvocable: true, category: "main" });
  registerCommand({ ...sampleCmd, name: "internal", userInvocable: false, category: "main" });
  registerCommand({ ...sampleCmd, name: "hidden", userInvocable: true, category: "main", isEnabled: () => false });
  registerCommand({ ...sampleCmd, name: "settings", userInvocable: true, category: "settings" });

  assert.deepEqual(
    listCommands({ userInvocable: true, category: "main" }).map((c) => c.name),
    ["public"]
  );
});

test("built-in slash commands are user invocable", () => {
  for (const command of [askCommand, chaptersCommand, reviewCommand, settingsCommand, writeCommand]) {
    registerCommand(command);
  }

  assert.deepEqual(
    listCommands({ userInvocable: true }).map((c) => c.name).sort(),
    ["ask", "chapters", "review", "settings", "write"]
  );
});

test("registerCommand throws when name missing", () => {
  assert.throws(() => registerCommand({ run: noop }), /name must be a non-empty string/);
});

test("registerCommand throws when run missing", () => {
  assert.throws(() => registerCommand({ name: "x" }), /run must be a function/);
});

test("registerCommand throws when cmd is null", () => {
  assert.throws(() => registerCommand(null), /command must be an object/);
});
