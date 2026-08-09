// src/core/agent/journal-session-migration.mjs —— 旧单流 journal → 会话注册表的一次性迁移
// （统一 Agent 内核计划 Task 3）。
//
// 背景：Task 2 引入会话注册表（sessions/index.json）后，多会话 journal 按会话实例化
//（storageRoot = <agentRoot>/sessions/<id>/）。升级前已存在的旧单流 journal 数据直接
// 躺在 <agentRoot> 根上，本模块把它搬入第一个会话目录并注册会话 1，使旧对话在新
// 架构下立即可见、可继续。
//
// 迁移判定（幂等）：
//   - <agentRoot>/segments/events/ 存在（旧单流段数据）且
//   - <agentRoot>/sessions/index.json 不存在 且
//   - migration.json 未标记 sessions_migrated: true
//   → 迁移；否则 { migrated:false, sessionId:null }（不抛错，不产生副作用）。
//
// 迁移动作（内容绝不重写，只搬目录/文件——journal 从新位置读取时布局必须完全一致）：
//   1. 先读取事件段的最大 seq（用于注册表 meta.last_seq，供 Task 4 SSE 恢复游标；
//      扫描实际 JSONL 而非依赖 manifest/session.json 派生值，取健康行的真实最大值）；
//   2. 把 <agentRoot> 顶层属于该 journal 会话的数据搬入 <agentRoot>/sessions/<id>/：
//      segments/ 整目录 + journal-manifest.json + session.json 是核心段数据；
//      checkpoints/（Task 8 正式 checkpoint）、active-context.json（Task 7 指针）、
//      compaction-commit-*.json（提交 marker）、cleared-history/（clearHistory 轮转
//      历史，manifest.generations 按相对路径引用它）与遗留单体 flat 文件同属该会话
//      的存储，一并搬走——否则新会话会在旧根读到旧会话的 checkpoint 残留，或
//      Task 8 对账因 checkpoint 文件缺失而误报 checkpoint_corrupt。migration.json
//      是 journal 级状态，留在旧根只追加 sessions_migrated 标记；sessions/ 与
//      .staging-*（workspace 迁移残留）不搬；
//   3. 注册会话 1（idFactory() 生成 id、title "对话 1"），并把 last_seq 写入 meta；
//   4. 在 <agentRoot>/migration.json 合并写 sessions_migrated: true（不覆盖其他键）。
//
// 失败恢复顺序（先搬后注册+标记）的理由：
//   - segments/ 在所有条目中**最后搬**。若搬迁中途崩溃，segments/events/ 仍在旧根，
//     迁移判定继续成立，重试时已搬走的条目因目标已存在被跳过、继续搬余下条目——
//     自愈，不留半成品；
//   - 注册发生在搬迁完成之后。注册前崩溃只留下"完整且完好"的孤岛会话目录（不入
//     注册表、可手工找回），注册表自始至终只包含数据目录真实存在的会话——绝不出现
//     "已注册但目录为空"的幽灵会话（那会让新架构把空会话当正常对话列出）；
//   - 注册后再写标记。注册成功即 sessions/index.json 存在，重试判定已跳过，标记
//     缺失不破坏幂等；
//   - create 与 setLastSeq 之间崩溃：注册表已有会话但 last_seq 仍是 create 的初始值
//     0，重试被 sessions/index.json 短路、不会再校准——SSE 游标会停在 0。消解：
//     Task 4 在 runtime.open() 打开该会话时以 journal 实际 lastSeq 校准注册表
//     （校准幂等），此窗口只影响游标起点、不影响会话可用性。
//
// 并发迁移（两个进程同时跑）不做处理：本模块由 Task 4 在 runtime.open() 中接入，
// 打开项目时发现旧单流数据即执行迁移；在接入前模块尚未被任何 src/ 代码调用
// （仅测试直接使用），进程内幂等判定足够。
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists, readJson, writeJsonAtomic } from "../fs-utils.mjs";
import { createSessionRegistry } from "./session-registry.mjs";

// 段文件名（与 journal-segments.mjs 的 SEGMENT_RE 一致；.corrupt 天然被排除）。
const SEGMENT_FILE_RE = /^\d{8}\.jsonl$/u;
// compaction 提交 marker（context-checkpoints.mjs 的 COMMIT_MARKER_PREFIX）。
const COMMIT_MARKER_RE = /^compaction-commit-[\w.-]+\.json$/u;
// 旧单体文件导入后改名的产物（journal-segments.mjs renameLegacy）。
const LEGACY_RENAMED_RE = /\.legacy\.jsonl$/u;

// <agentRoot> 顶层不属于会话数据的条目：migration.json（journal 级标记，留在旧根）、
// sessions/（迁移目标容器）与 workspace 迁移 staging 残留。
const SKIP_ENTRIES = new Set(["migration.json", "sessions"]);

// 迁移返回形状。
const NO_MIGRATION = Object.freeze({ migrated: false, sessionId: null });

// 判定旧单流数据存在：segments/events/ 必须是目录（缺目录/被文件占据都视为无源）。
async function hasLegacySingleStream(agentRoot) {
  try {
    return (await fs.stat(path.join(agentRoot, "segments", "events"))).isDirectory();
  } catch {
    return false;
  }
}

// 扫描事件段取健康行的最大 seq（迁移流的事实最大值；manifest/session.json 的
// 派生 last_seq 在崩溃窗口可能落后，不采用）。损坏行（非末尾半行）跳过：迁移流
// 的游标只覆盖可读事件，Task 4 打开该会话时 journal 会另行做缺口恢复。
async function readMaxEventSeq(eventsDir) {
  let names;
  try {
    names = await fs.readdir(eventsDir);
  } catch {
    return 0;
  }
  let maxSeq = 0;
  for (const name of names.filter((n) => SEGMENT_FILE_RE.test(n)).sort()) {
    const raw = await fs.readFile(path.join(eventsDir, name), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const seq = JSON.parse(line)?.seq;
        if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
      } catch {
        // 坏行：跳过，最大 seq 以健康行为准
      }
    }
  }
  return maxSeq;
}

// Windows 下杀软/句柄占用可能让 rename 瞬时失败（与 fs-utils.renameWithRetry 同款
// 重试策略；该函数未导出，这里按同模式内联一份轻量版）。
async function renameWithRetry(sourcePath, targetPath) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 35));
    }
  }
  throw lastError;
}

// 顶层条目是否属于会话数据（排除 SKIP_ENTRIES、.staging-*，只收明确文件或目录）。
async function isSessionEntry(agentRoot, name) {
  if (SKIP_ENTRIES.has(name) || name.startsWith(".staging-")) return false;
  // compaction 提交 marker 与 *.legacy.jsonl 按前缀/后缀识别，其余按名直接匹配
  return (
    COMMIT_MARKER_RE.test(name) ||
    LEGACY_RENAMED_RE.test(name) ||
    ["segments", "journal-manifest.json", "session.json", "checkpoints", "active-context.json", "cleared-history", "events.jsonl", "transcript.jsonl"].includes(name)
  );
}

// 把 <agentRoot> 顶层会话数据搬入 targetDir（同盘 rename，原子）。segments/ 最后搬：
// 中途崩溃时旧判定仍成立，重试可继续；目标已存在（前次失败残留）则跳过不覆盖。
async function moveSessionEntries(agentRoot, targetDir) {
  const names = await fs.readdir(agentRoot);
  // segments/ 排最后：order 小的先搬（V8 sort 稳定）
  names.sort((a, b) => (a === "segments" ? 1 : 0) - (b === "segments" ? 1 : 0));
  for (const name of names) {
    if (!(await isSessionEntry(agentRoot, name))) continue;
    const source = path.join(agentRoot, name);
    const target = path.join(targetDir, name);
    if (await pathExists(target)) continue; // 前次失败残留 → 跳过
    await renameWithRetry(source, target);
  }
}

// 迁移标记：合并写 sessions_migrated: true，保留 journal 标准键与既有自定义键。
// migration.json 损坏（非法 JSON）按缺失处理并重写为合法标记（旧字节已不可读，
// 重写是修复而非覆盖有效数据）。
async function writeMigrationMarker(agentRoot) {
  let existing = {};
  try {
    existing = (await readJson(path.join(agentRoot, "migration.json"), {})) ?? {};
  } catch {
    existing = {};
  }
  if (typeof existing !== "object" || Array.isArray(existing)) existing = {};
  await writeJsonAtomic(path.join(agentRoot, "migration.json"), {
    schema_version: 1,
    legacy_imported: false,
    project_agent_imported: false,
    ...existing,
    sessions_migrated: true
  });
}

export async function migrateSingleSessionToRegistry({ agentRoot, idFactory = randomUUID }) {
  if (typeof agentRoot !== "string" || agentRoot.length === 0) {
    throw new TypeError("agentRoot 必须是字符串路径");
  }
  const root = path.resolve(agentRoot);

  // 判定：旧单流数据存在 且 未注册 且 未标记
  if (!(await hasLegacySingleStream(root))) return NO_MIGRATION;
  if (await pathExists(path.join(root, "sessions", "index.json"))) return NO_MIGRATION;
  try {
    const migration = await readJson(path.join(root, "migration.json"), {});
    if (migration?.sessions_migrated === true) return NO_MIGRATION;
  } catch {
    // migration.json 损坏：视为未标记，继续（标记写入路径会修复该文件）
  }

  const sessionId = typeof idFactory === "function" ? idFactory() : randomUUID();
  // sessionId 会拼进文件系统路径（sessions/<id>/）：拒绝空串、路径分隔符与 . / ..
  // 等穿越片段，防止异常 idFactory 把搬迁写到 agentRoot 之外。
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\")
  ) {
    throw new TypeError(`idFactory 返回了非法 sessionId: ${String(sessionId)}`);
  }
  const targetDir = path.join(root, "sessions", sessionId);
  await ensureDir(targetDir);

  // 1. 最大事件 seq（搬迁前读取，只读）
  const maxSeq = await readMaxEventSeq(path.join(root, "segments", "events"));
  // 2. 搬迁（segments/ 最后）
  await moveSessionEntries(root, targetDir);
  // 3. 注册会话 1 + last_seq（先搬后注册，理由见文件头）。create 与 setLastSeq
  //    之间崩溃会留下 last_seq=0 的会话且重试被 index.json 短路，由 Task 4
  //    open() 时以 journal 实际 lastSeq 校准（见文件头）。
  const registry = createSessionRegistry({ root });
  await registry.create({ sessionId, title: "对话 1" });
  await registry.setLastSeq(sessionId, maxSeq);
  // 4. 迁移标记（合并，不覆盖其他键）
  await writeMigrationMarker(root);

  return { migrated: true, sessionId };
}
