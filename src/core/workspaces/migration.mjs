// src/core/workspaces/migration.mjs —— 旧项目内 Agent 数据只读迁移（计划 Task 3）。
//
// 把旧 <projectRoot>/.wwriting/agent/ 的 journal 数据复制到应用私有 workspace
// 目录（targetAgentRoot），供新会话作为唯一真相源使用。契约（SPEC §9.2）：
//
//   - 只复制白名单：events.jsonl / session.json / transcript.jsonl / checkpoints/；
//     绝不复制旧 migration.json（应用私有迁移状态由 journal 自行维护）；
//   - 目标 events.jsonl 已有内容（非空）时拒绝复制（target_not_empty），
//     目标数据绝不覆盖；
//   - 复制前校验旧 events.jsonl 的 seq 连续性（从 1 起、无中间缺口）；尾部半行
//     截断（崩溃痕迹）容忍（与 journal.load() 的截断修复语义一致），中间的非法
//     行视为损坏（invalid_source），不产生任何半份复制产物；
//   - 原目录只读：不删除、不重命名、不覆盖，字节完全不变；
//   - 幂等：目标已有数据时第二次调用返回 target_not_empty，不重复、不覆盖。
//
// 本模块不写任何迁移标记（目标 events.jsonl 的存在性即幂等依据）；更老的
// legacy flat-file 导入标记由 journal.readMigration()/writeMigration() 维护。
// 迁移失败绝不抛给调用方（返回 { imported: false, reason }，技术详情经
// diagnostic 写入日志），保证 open() 在旧数据损坏时仍能开始新会话。
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../fs-utils.mjs";

const COPY_FILES = Object.freeze(["events.jsonl", "session.json", "transcript.jsonl"]);

async function hasNonEmptyFile(target) {
  try {
    return (await fs.stat(target)).size > 0;
  } catch {
    return false;
  }
}

async function copyIfPresent(source, target) {
  try {
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
  }
}

async function copyDirectoryIfPresent(source, target) {
  try {
    await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
  }
}

// 校验旧 events.jsonl：逐行 JSON.parse + seq 从 1 连续递增；最后一行不完整
// （崩溃痕迹）容忍，中间损坏行抛错拒绝导入。
async function validateLegacyEvents(target) {
  let raw;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const lines = raw.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  let expected = 1;
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const event = JSON.parse(lines[index]);
      if (event.seq !== expected) throw new Error(`事件 seq 应为 ${expected}`);
      expected += 1;
    } catch (error) {
      if (index === lines.length - 1) break;
      throw error;
    }
  }
}

export async function migrateProjectAgentStorage({ projectRoot, targetAgentRoot, diagnostic = console.warn }) {
  const source = path.join(path.resolve(projectRoot), ".wwriting", "agent");
  if (!(await pathExists(source))) return { imported: false, reason: "missing" };
  await fs.mkdir(targetAgentRoot, { recursive: true });
  if (await hasNonEmptyFile(path.join(targetAgentRoot, "events.jsonl"))) {
    return { imported: false, reason: "target_not_empty" };
  }
  try {
    await validateLegacyEvents(path.join(source, "events.jsonl"));
    for (const name of COPY_FILES) await copyIfPresent(path.join(source, name), path.join(targetAgentRoot, name));
    await copyDirectoryIfPresent(path.join(source, "checkpoints"), path.join(targetAgentRoot, "checkpoints"));
    return { imported: true };
  } catch (error) {
    diagnostic("[workspace-migration] legacy agent import failed", error);
    return { imported: false, reason: "invalid_source" };
  }
}
