// src/core/shell/risk.mjs 的迁移测试（统一 Agent 内核计划 Task 4）。
// 前置计划 tests/command-risk.test.mjs 的语料用例全部迁入本文件，并新增：
// wrapper 剥壳、跨盘符 target class、projectRoot 缺省兜底、`..foo` 项目内目录等。
import assert from "node:assert/strict";
import test from "node:test";
import { classifyShellCommand, resolveProjectScope, unwrapShellWrapper } from "../../src/core/shell/risk.mjs";
import { EXTREME_COMMANDS, NORMAL_DESTRUCTIVE_COMMANDS } from "../fixtures/command-risk-corpus.mjs";

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

test("projectRoot 缺省时兜底到进程工作目录", () => {
  assert.equal(classifyShellCommand({ command: "git status" }).category, "read");
  assert.equal(classifyShellCommand({ command: "rm -rf /" }).risk, "extreme");
  assert.equal(classifyShellCommand({ command: "git status", cwd: PROJECT }).category, "read");
});

test("..foo 之类的项目内目录不被判为 outside", () => {
  assert.equal(classifyShellCommand({ command: "git status", cwd: "D:\\Novels\\demo\\..foo", projectRoot: PROJECT }).scope, "project");
  assert.equal(classifyShellCommand({ command: "git status", cwd: "D:\\Novels\\demo\\..\\sibling", projectRoot: PROJECT }).scope, "outside");
});

test("跨盘符目标 class 为盘符根（小写）", () => {
  const action = classifyShellCommand({ command: "Set-Content x.txt y", cwd: "D:\\Other", projectRoot: PROJECT });
  assert.equal(action.scope, "outside");
  assert.equal(action.grant_key, "write:outside:d:\\");
  assert.equal(resolveProjectScope(PROJECT, "D:\\Other\\file.txt").targetClass, "d:\\");
  assert.equal(resolveProjectScope(PROJECT, "D:\\Novels\\demo\\notes.md").targetClass, "project-root");
});

test("wrapper 剥壳后仍能识别真实命令", () => {
  // 剥壳：sudo / bash -c / zsh -c / env 前缀剥离后 rm -rf / 仍是 extreme
  for (const command of [
    "sudo rm -rf /",
    "bash -c 'rm -rf /'",
    "zsh -c 'rm -rf /'",
    "env X=1 rm -rf /",
    "sudo env X=1 rm -rf /",
    "nohup rm -rf /"
  ]) {
    assert.equal(classifyShellCommand({ command, cwd: PROJECT, projectRoot: PROJECT }).risk, "extreme", command);
  }
  // 剥壳后类别判定同样生效（bash -c 'git status' 是 read）
  assert.equal(
    classifyShellCommand({ command: "bash -c 'git status'", cwd: PROJECT, projectRoot: PROJECT }).category,
    "read"
  );
  // unwrapShellWrapper 直接可用
  assert.equal(unwrapShellWrapper("sudo env X=1 rm -rf /"), "rm -rf /");
});

test("普通破坏性命令不触发 extreme（正反例语料之外再抽查）", () => {
  for (const command of ["rm -rf ./dist", "git clean -fd build", "Remove-Item '.\\tmp.txt' -Force"]) {
    assert.equal(classifyShellCommand({ command, cwd: PROJECT, projectRoot: PROJECT }).risk, "normal", command);
  }
});

test("grant_key 由 category:scope:targetClass 组成", () => {
  assert.equal(
    classifyShellCommand({ command: "Set-Content a.txt x", cwd: PROJECT, projectRoot: PROJECT }).grant_key,
    "write:project:project-root"
  );
  assert.equal(
    classifyShellCommand({ command: "rm tmp.txt", cwd: "C:\\Temp", projectRoot: PROJECT }).grant_key,
    "delete:outside:c:\\"
  );
  assert.equal(
    classifyShellCommand({ command: "git status", cwd: "D:\\Novels\\demo\\..foo", projectRoot: PROJECT }).grant_key,
    "read:project:project-root"
  );
});
