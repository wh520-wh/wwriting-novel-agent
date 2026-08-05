// tests/project-operations/blueprint.test.mjs —— 蓝图事务测试（统一 Agent 内核计划 Task 5）。
//
// 迁移来源（只读参考）：tests/blueprint-init.test.mjs / blueprint-status.test.mjs /
// blueprint-tools.test.mjs 的原子提交/回滚语义。全部通过 blueprint operations 公共
// 接口断言可观察行为：三文件一致提交、写入期失败回滚恢复先前字节（经注入写探针
// options.hooks.beforeWrite 真实触达事务 catch 分支）、yaml 手术式编辑保真、
// evidence 路径校验。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectRoot } from "../helpers/project-agent-harness.mjs";
import { parseSimpleYaml } from "../../src/core/simple-yaml.mjs";
import {
  BlueprintOperationError,
  commitBlueprint,
  inspectBlueprintContext
} from "../../src/core/project-operations/blueprint.mjs";

async function makeProject(options = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-ops-blueprint-"));
  const { projectRoot, project } = await createProjectRoot(workspace, options);
  return { workspace, projectRoot, project };
}

async function readProjectYaml(projectRoot) {
  return parseSimpleYaml(await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8"));
}

// 注入写探针：第 n 次事务写入失败（在写入前抛错，触发回滚 catch 分支）
function failOnWrite(n) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === n) {
      const error = new Error(`注入写入失败（第 ${n} 次）`);
      error.code = "EIO";
      throw error;
    }
  };
}

const OUTLINE = `# 总纲

## 一、核心矛盾
主角必须查明老宅钟声的真相。
`;
const SETTING = `# 设定

- 地点：临江市老宅
`;

test("inspectBlueprintContext 反映 project.yaml 状态与真实文件证据", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const before = await inspectBlueprintContext({ projectRoot });
    assert.equal(before.blueprint_status, "none");
    assert.equal(before.outline.exists, true);
    assert.equal(before.outline.placeholder, true, "新建项目 OUTLINE 是占位蓝图");
    assert.equal(before.setting.placeholder, true);
    assert.equal(before.has_blueprint, false);
    assert.deepEqual(before.chapter_evidence.chapter_files, []);

    await commitBlueprint({
      projectRoot,
      projectId: project.project_id,
      outline: OUTLINE,
      setting: SETTING,
      evidencePaths: ["sources.md"]
    });

    const after = await inspectBlueprintContext({ projectRoot });
    assert.equal(after.blueprint_status, "complete");
    assert.equal(after.outline.placeholder, false);
    assert.equal(after.setting.placeholder, false);
    assert.equal(after.has_blueprint, true);
    assert.match(after.outline.file, /OUTLINE\.md$/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint 三文件一致提交且保留 project.yaml 其它字段", async () => {
  const { workspace, projectRoot, project } = await makeProject({ title: "蓝图书", target_chapters: 5 });
  try {
    const yamlBefore = await readProjectYaml(projectRoot);
    assert.equal(yamlBefore.title, "蓝图书");
    assert.equal(yamlBefore.target_chapters, 5);

    const result = await commitBlueprint({
      projectRoot,
      projectId: project.project_id,
      outline: OUTLINE,
      setting: SETTING,
      evidencePaths: ["sources.md", "memory/continuity.json"]
    });
    assert.equal(result.ok, true);
    assert.equal(result.blueprint_status, "complete");

    assert.equal(await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8"), `${OUTLINE.trim()}\n`);
    assert.equal(await fs.readFile(path.join(projectRoot, "SETTING.md"), "utf8"), `${SETTING.trim()}\n`);
    const yamlAfter = await readProjectYaml(projectRoot);
    assert.equal(yamlAfter.blueprint_status, "complete");
    assert.equal(yamlAfter.title, "蓝图书", "其余字段必须原样保留");
    assert.equal(yamlAfter.target_chapters, 5);

    // run_log 记录蓝图提交领域事实
    const runLog = await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8");
    assert.match(runLog, /blueprint_committed/u);
    assert.match(runLog, /sources\.md/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint 只替换 blueprint_status 行，其余 yaml 字节（含注释）原样保留", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const yamlPath = path.join(projectRoot, "project.yaml");
    // 手写带注释、缩进与空行的 project.yaml（模拟人工编辑过的旧项目）
    const handWritten = [
      "# 项目配置（人工维护，请勿删除注释）",
      "schema_version: 1",
      "project_id: " + JSON.stringify(project.project_id),
      "title: \"手写项目\"",
      "blueprint_status: \"none\"",
      "target_chapters: 3",
      "",
      "tool_permissions: {\"safe_edit\":true}",
      ""
    ].join("\n");
    await fs.writeFile(yamlPath, handWritten, "utf8");

    await commitBlueprint({ projectRoot, projectId: project.project_id, outline: OUTLINE, setting: SETTING });

    const after = await fs.readFile(yamlPath, "utf8");
    assert.ok(after.includes("# 项目配置（人工维护，请勿删除注释）"), "注释必须保留");
    assert.match(after, /^blueprint_status: "complete"$/mu, "blueprint_status 行被替换为 complete");
    assert.ok(!/blueprint_status: "none"/u.test(after), "旧值不得残留");
    assert.ok(after.includes("tool_permissions: {\"safe_edit\":true}"), "非 JSON 内联值原样保留");
    assert.ok(after.includes("schema_version: 1"));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint 写入期失败回滚：第 2 次写（SETTING）失败恢复三文件先前字节", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    // 预置有效蓝图：先成功提交一次，得到可恢复的先前状态
    await commitBlueprint({ projectRoot, projectId: project.project_id, outline: OUTLINE, setting: SETTING });
    const outlineBefore = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");
    const settingBefore = await fs.readFile(path.join(projectRoot, "SETTING.md"), "utf8");
    const yamlBefore = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");
    const runLogBefore = await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8");

    await assert.rejects(
      () =>
        commitBlueprint(
          { projectRoot, projectId: project.project_id, outline: "新的总纲内容", setting: "新的设定内容" },
          { hooks: { beforeWrite: failOnWrite(2) } }
        ),
      /注入写入失败/u
    );

    // OUTLINE 已写（第 1 次成功）→ 必须恢复；SETTING/yaml/run_log 未动
    assert.equal(await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8"), outlineBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "SETTING.md"), "utf8"), settingBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8"), yamlBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8"), runLogBefore);
    assert.equal((await readProjectYaml(projectRoot)).blueprint_status, "complete");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint 第 1 次写失败：零写入", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const outlineBefore = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");
    const settingBefore = await fs.readFile(path.join(projectRoot, "SETTING.md"), "utf8");
    const yamlBefore = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");

    await assert.rejects(
      () =>
        commitBlueprint(
          { projectRoot, projectId: project.project_id, outline: OUTLINE, setting: SETTING },
          { hooks: { beforeWrite: failOnWrite(1) } }
        ),
      /注入写入失败/u
    );

    assert.equal(await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8"), outlineBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "SETTING.md"), "utf8"), settingBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8"), yamlBefore);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint 第 3 次写（project.yaml）失败：OUTLINE 与 SETTING 恢复", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const outlineBefore = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");
    const settingBefore = await fs.readFile(path.join(projectRoot, "SETTING.md"), "utf8");
    const yamlBefore = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");

    await assert.rejects(
      () =>
        commitBlueprint(
          { projectRoot, projectId: project.project_id, outline: OUTLINE, setting: SETTING },
          { hooks: { beforeWrite: failOnWrite(3) } }
        ),
      /注入写入失败/u
    );

    assert.equal(await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8"), outlineBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "SETTING.md"), "utf8"), settingBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8"), yamlBefore);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint run_log 追加失败：三文件与 run_log 一并回滚", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const outlineBefore = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");
    const settingBefore = await fs.readFile(path.join(projectRoot, "SETTING.md"), "utf8");
    const yamlBefore = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");
    const runLogBefore = await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8");

    await assert.rejects(
      () =>
        commitBlueprint(
          { projectRoot, projectId: project.project_id, outline: OUTLINE, setting: SETTING },
          { hooks: { beforeWrite: failOnWrite(4) } }
        ),
      /注入写入失败/u
    );

    assert.equal(await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8"), outlineBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "SETTING.md"), "utf8"), settingBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8"), yamlBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8"), runLogBefore, "run_log 不得残留幻影事件");
    assert.equal((await readProjectYaml(projectRoot)).blueprint_status, "none");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint 连续两次提交后 project.yaml 字节稳定（尾部不累积空行）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const yamlPath = path.join(projectRoot, "project.yaml");
    await commitBlueprint({ projectRoot, projectId: project.project_id, outline: OUTLINE, setting: SETTING });
    const afterFirst = await fs.readFile(yamlPath, "utf8");
    assert.match(afterFirst, /blueprint_status: "complete"\n$/u, "提交后文件应以单个换行结尾");
    assert.ok(!afterFirst.endsWith("\n\n"), "不得出现尾部空行累积");

    await commitBlueprint({ projectRoot, projectId: project.project_id, outline: OUTLINE, setting: SETTING });
    const afterSecond = await fs.readFile(yamlPath, "utf8");
    assert.equal(afterSecond, afterFirst, "第二次提交后字节必须与第一次完全一致（不累积尾部空行）");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint blueprint_status 行含尾随注释：值替换时注释随行丢弃，其余行保留", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const yamlPath = path.join(projectRoot, "project.yaml");
    // 人工维护的 yaml：blueprint_status 行带尾随注释（描述旧值）
    const handWritten = [
      "# 项目配置",
      "schema_version: 1",
      "project_id: " + JSON.stringify(project.project_id),
      "title: \"注释项目\"",
      "blueprint_status: \"none\" # 待生成",
      "target_chapters: 3",
      ""
    ].join("\n");
    await fs.writeFile(yamlPath, handWritten, "utf8");

    await commitBlueprint({ projectRoot, projectId: project.project_id, outline: OUTLINE, setting: SETTING });

    const after = await fs.readFile(yamlPath, "utf8");
    // blueprint_status 行是本模块拥有的行：尾随注释随值替换被丢弃（语义已注释固化）
    assert.match(after, /^blueprint_status: "complete"$/mu, "尾随注释随值替换一起丢弃");
    assert.ok(!after.includes("# 待生成"), "旧值注释不得残留");
    assert.ok(after.includes("# 项目配置"), "其它行注释必须保留");
    assert.ok(after.includes('title: "注释项目"'));
    assert.ok(after.includes("target_chapters: 3"));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint 拒绝越出项目根的 evidence 路径且零写入", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const outlineBefore = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");
    await assert.rejects(
      () =>
        commitBlueprint({
          projectRoot,
          projectId: project.project_id,
          outline: OUTLINE,
          setting: SETTING,
          evidencePaths: ["../outside.md"]
        }),
      (error) => error instanceof BlueprintOperationError && error.code === "evidence_path_escapes_project"
    );
    assert.equal(await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8"), outlineBefore);
    assert.equal((await readProjectYaml(projectRoot)).blueprint_status, "none");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitBlueprint 校验 project_id 与空内容", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await assert.rejects(
      () => commitBlueprint({ projectRoot, projectId: "wrong", outline: OUTLINE, setting: SETTING }),
      (error) => error instanceof BlueprintOperationError && error.code === "invalid_project_id"
    );
    await assert.rejects(
      () => commitBlueprint({ projectRoot, projectId: project.project_id, outline: "", setting: SETTING }),
      (error) => error instanceof BlueprintOperationError && error.code === "empty_outline"
    );
    await assert.rejects(
      () => commitBlueprint({ projectRoot, projectId: project.project_id, outline: OUTLINE, setting: "  " }),
      (error) => error instanceof BlueprintOperationError && error.code === "empty_setting"
    );
    assert.equal((await readProjectYaml(projectRoot)).blueprint_status, "none");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("inspectBlueprintContext 汇总章节证据", async () => {
  const { workspace, projectRoot } = await makeProject();
  try {
    await fs.writeFile(path.join(projectRoot, "chapters", "001.md"), "正文", "utf8");
    await fs.writeFile(path.join(projectRoot, "chapters", "002.txt"), "正文", "utf8");
    await fs.writeFile(path.join(projectRoot, "chapters", "Thumbs.db"), "系统杂项", "utf8");
    const ctx = await inspectBlueprintContext({ projectRoot });
    assert.deepEqual(ctx.chapter_evidence.chapter_files, ["001.md", "002.txt"]);
    assert.equal(ctx.chapter_evidence.indexed_chapters, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
