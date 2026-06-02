import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerCommand,
  unregisterCommand,
  getCommand,
  listCommands,
  onCommandsChanged,
  CommandValidationError,
  CommandNotAllowed,
  __resetRegistry
} from "../src/app-shell/command-registry.mjs";

function noop() {}

test.beforeEach(() => {
  __resetRegistry();
});

const sampleCmd = {
  name: "sample",
  category: "writing",
  description: "test",
  userInvocable: true,
  isConcurrencySafe: true,
  isReadOnly: false,
  run: async () => ({ ok: true }),
};

test("registerCommand stores and broadcasts on first add", () => {
  let count = 0;
  onCommandsChanged(() => count++);
  registerCommand({ ...sampleCmd });
  assert.equal(count, 1);
});

test("registerCommand overwriting same name does not re-broadcast", () => {
  let count = 0;
  onCommandsChanged(() => count++);
  registerCommand({ ...sampleCmd });
  registerCommand({ ...sampleCmd, description: "v2" });
  assert.equal(count, 1);
  assert.equal(getCommand("sample").description, "v2");
});

test("unregisterCommand removes and broadcasts", () => {
  let count = 0;
  onCommandsChanged(() => count++);
  registerCommand({ ...sampleCmd });
  unregisterCommand("sample");
  assert.equal(count, 2);
  assert.equal(getCommand("sample"), undefined);
});

test("unregisterCommand on missing name is a no-op (no broadcast)", () => {
  let count = 0;
  onCommandsChanged(() => count++);
  unregisterCommand("nope");
  assert.equal(count, 0);
});

test("getCommand returns undefined for unknown", () => {
  assert.equal(getCommand("nope"), undefined);
});

test("listCommands filters by category", () => {
  registerCommand({ ...sampleCmd, name: "a", category: "writing" });
  registerCommand({ ...sampleCmd, name: "b", category: "review" });
  const writing = listCommands({ category: "writing" });
  assert.equal(writing.length, 1);
  assert.equal(writing[0].name, "a");
});

test("listCommands filters by userInvocable", () => {
  registerCommand({ ...sampleCmd, name: "a", userInvocable: true });
  registerCommand({ ...sampleCmd, name: "b", userInvocable: false });
  const visible = listCommands({ userInvocable: true });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].name, "a");
});

test("listCommands skips commands whose isEnabled returns false", () => {
  registerCommand({ ...sampleCmd, isEnabled: () => false });
  assert.equal(listCommands().length, 0);
});

test("listCommands returns enabled by default", () => {
  registerCommand({ ...sampleCmd, isEnabled: () => true });
  assert.equal(listCommands().length, 1);
});

test("registerCommand throws CommandValidationError when name missing", () => {
  assert.throws(() => registerCommand({ run: noop }), CommandValidationError);
});

test("registerCommand throws CommandValidationError when run missing", () => {
  assert.throws(() => registerCommand({ name: "x" }), CommandValidationError);
});

test("registerCommand throws when cmd is null", () => {
  assert.throws(() => registerCommand(null), CommandValidationError);
});

test("canUse returning false throws CommandNotAllowed at run-time", async () => {
  registerCommand({
    ...sampleCmd,
    canUse: () => false,
  });
  const cmd = getCommand("sample");
  await assert.rejects(cmd.run({}, {}), CommandNotAllowed);
});
