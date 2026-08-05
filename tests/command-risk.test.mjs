import assert from "node:assert/strict";
import test from "node:test";
import { classifyShellCommand } from "../src/core/chat/command-risk.mjs";
import { redactChatData } from "../src/core/chat/chat-redaction.mjs";
import { EXTREME_COMMANDS, NORMAL_DESTRUCTIVE_COMMANDS } from "./fixtures/command-risk-corpus.mjs";

const PROJECT = "D:\\Novels\\demo";

test("高危命令全部为 extreme", () => {
  for (const command of EXTREME_COMMANDS) {
    const { risk } = classifyShellCommand({ command, cwd: PROJECT, projectRoot: PROJECT });
    assert.equal(risk, "extreme", `命令应判为 extreme: ${command}`);
  }
});

test("日常破坏性命令不触发 extreme", () => {
  for (const command of NORMAL_DESTRUCTIVE_COMMANDS) {
    const { risk } = classifyShellCommand({ command, cwd: PROJECT, projectRoot: PROJECT });
    assert.equal(risk, "normal", `命令不应判为 extreme: ${command}`);
  }
});

test("只读命令自动分类", () => {
  for (const command of ["rg -n chapter .", "git status --short", "Get-Content .\\OUTLINE.md", "Get-ChildItem -Force"]) {
    assert.equal(classifyShellCommand({ command, cwd: PROJECT, projectRoot: PROJECT }).category, "read", command);
  }
});

test("修改、联网、安装、启动程序和项目外目录需要普通确认", () => {
  assert.equal(classifyShellCommand({ command: "Set-Content a.txt x", cwd: PROJECT, projectRoot: PROJECT }).category, "write");
  assert.equal(classifyShellCommand({ command: "curl https://example.com", cwd: PROJECT, projectRoot: PROJECT }).category, "network");
  assert.equal(classifyShellCommand({ command: "npm install lodash", cwd: PROJECT, projectRoot: PROJECT }).category, "install");
  assert.equal(classifyShellCommand({ command: "npm run dev", cwd: PROJECT, projectRoot: PROJECT }).category, "process");
  assert.equal(classifyShellCommand({ command: "git status", cwd: "D:\\Other", projectRoot: PROJECT }).scope, "outside");
});

test("未知或混合命令落 control,不猜成只读", () => {
  assert.equal(classifyShellCommand({ command: "npm install lodash && npm run dev", cwd: PROJECT, projectRoot: PROJECT }).category, "control");
  assert.equal(classifyShellCommand({ command: "foobar --help", cwd: PROJECT, projectRoot: PROJECT }).category, "control");
});

test("命令中的密钥片段被脱敏", () => {
  const inputs = [
    "api_key=abc123secret",
    "Authorization: Bearer abc123secret",
    "tvly-abcdefghijklmnop",
    "sk-abcdefghijklmnop123456",
    'secret="abc123secret"',
    "token = 'abc123secret'",
    'Authorization: Bearer "abc123secret"',
    '--password="abc123secret"'
  ];
  for (const input of inputs) {
    const redacted = redactChatData(input);
    assert.ok(!redacted.includes("abc123secret"), `应脱敏原密钥: ${input}`);
    assert.ok(!/tvly-[A-Za-z0-9_-]{12,}/u.test(redacted), `应脱敏 tvly 令牌: ${input}`);
    assert.ok(!/sk-[A-Za-z0-9_-]{12,}/u.test(redacted), `应脱敏 sk 令牌: ${input}`);
    assert.match(redacted, /\[REDACTED\]/u);
  }
});

test("引号包裹的密钥脱敏后保留引号", () => {
  assert.equal(redactChatData('secret="abc123secret"'), 'secret="[REDACTED]"');
  assert.equal(redactChatData("token = 'abc123secret'"), "token = '[REDACTED]'");
  assert.equal(redactChatData('Authorization: Bearer "abc123secret"'), 'Authorization: Bearer "[REDACTED]"');
  assert.equal(redactChatData('--password="abc123secret"'), '--password="[REDACTED]"');
});

test("projectRoot 缺省时兜底到进程工作目录", () => {
  assert.equal(classifyShellCommand({ command: "git status" }).category, "read");
  assert.equal(classifyShellCommand({ command: "rm -rf /" }).risk, "extreme");
  assert.equal(classifyShellCommand({ command: "git status", cwd: PROJECT }).category, "read");
});

test("..foo 之类的项目内目录不被判为 outside", () => {
  assert.equal(classifyShellCommand({ command: "git status", cwd: "D:\\Novels\\demo\\..foo", projectRoot: PROJECT }).scope, "project");
  assert.equal(classifyShellCommand({ command: "git status", cwd: "D:\\Novels\\demo\\..\\sibling", projectRoot: PROJECT }).scope, "outside");
});

test("不含密钥的文本原样保留", () => {
  const plain = "今天修改了大纲，git status 显示无变更。";
  assert.equal(redactChatData(plain), plain);
});
