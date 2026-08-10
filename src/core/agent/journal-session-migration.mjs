// src/core/agent/journal-session-migration.mjs —— 旧单流 journal → 会话注册表的一次性迁移
// （统一 Agent 内核计划 Task 3）。
//
// 背景：Task 2 引入会话注册表（sessions/index.json）后，多会话 journal 按会话实例化
//（storageRoot = <agentRoot>/sessions/<id>/）。升级前已存在的旧单流 journal 数据直接
// 躺在 <agentRoot> 根上，本模块把它搬入第一个会话目录并注册会话 1，使旧对话在新
// 架构下立即可见、可继续。
//
// 迁移判定（幂等，两条互补路径）：
//   A. migrateSingleSessionToRegistry：<agentRoot>/segments/events/ 存在（旧单流段
//      数据）且 sessions/index.json 不存在 且 migration.json 未标记
//      sessions_migrated: true → 迁移；
//   B. adoptLegacyFlatFilesToRegistry：无 segments、仅旧 flat 单体文件
//      （events.jsonl/transcript.jsonl/session.json/checkpoints，最老一代布局）且
//      sessions/index.json 不存在 → 迁入会话 1。
//   两条路径都返回 { migrated:false, sessionId:null } 表示无源（不抛错，无副作用）。
//   A 的 isSessionEntry 已含 flat 文件（有 segments 的旧布局两者兼有，一次搬走）；
//   B 只在纯 flat（无 segments）时兜底——两条路径互斥。
//
// 迁移动作（内容绝不重写，只搬目录/文件——journal 从新位置读取时布局必须完全一致）：
//   1. 把 <agentRoot> 顶层属于该 journal 会话的数据搬入 <agentRoot>/sessions/<id>/：
//      segments/ 整目录 + journal-manifest.json + session.json 是核心段数据；
//      checkpoints/（Task 8 正式 checkpoint）、active-context.json（Task 7 指针）、
//      compaction-commit-*.json（提交 marker）、cleared-history/（clearHistory 轮转
//      历史，manifest.generations 按相对路径引用它）与遗留单体 flat 文件同属该会话
//      的存储，一并搬走——否则新会话会在旧根读到旧会话的 checkpoint 残留，或
//      Task 8 对账因 checkpoint 文件缺失而误报 checkpoint_corrupt。migration.json
//      是 journal 级状态，留在旧根只追加 sessions_migrated 标记；sessions/ 与
//      .staging-*（workspace 迁移残留）不搬；
//   2. 注册会话 1（idFactory() 生成 id、title "对话 1"）；
//   3. 在 <agentRoot>/migration.json 合并写 sessions_migrated: true（不覆盖其他键）。
//
// adoptLegacyFlatFilesToRegistry 的迁移动作（与 A 同一"先搬后注册+标记"顺序）：
//   把根上存在的 flat 条目搬入 sessions/<id>/（目标已有则跳过，前次失败残留自愈），
//   注册会话 1（title "对话 1"），合并写 sessions_migrated 标记。此路径原先是
//   runtime.ensureSessionState 的副作用（首次物化会话时收养、依赖物化顺序，纯 flat
//   旧数据在用户发首条消息前不可见）——迁到这里后由 migrateProjectData 在
//   open/submit/sessions()/newSession 一次性确定性执行，首开即可见。
//
// 失败恢复顺序（先搬后注册+标记）的理由：
//   - segments/ 在所有条目中**最后搬**。若搬迁中途崩溃，segments/events/ 仍在旧根，
//     迁移判定继续成立，重试时已搬走的条目因目标已存在被跳过、继续搬余下条目——
//     自愈，不留半成品；
//   - 注册发生在搬迁完成之后。注册前崩溃只留下"完整且完好"的孤岛会话目录（不入
//     注册表、可手工找回），注册表自始至终只包含数据目录真实存在的会话——绝不出现
//     "已注册但目录为空"的幽灵会话（那会让新架构把空会话当正常对话列出）；
//   - 注册后再写标记。注册成功即 sessions/index.json 存在，重试判定已跳过，标记
//     缺失不破坏幂等。
//
// 并发迁移（两个进程同时跑）不做处理：本模块由 Task 4 在 runtime.open() 中接入，
// 打开项目时发现旧单流数据即执行迁移；在接入前模块尚未被任何 src/ 代码调用
// （仅测试直接使用），进程内幂等判定足够。
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists, readJson, renameWithRetry, writeJsonAtomic } from "../fs-utils.mjs";
import { createSessionRegistry } from "./session-registry.mjs";
import { SEGMENT_RE } from "./journal-segments.mjs";
import { COMMIT_MARKER_PREFIX } from "./context-checkpoints.mjs";

// 段文件名与 compaction 提交 marker：直接复用 journal-segments / context-checkpoints
// 的既有常量/判定（.corrupt 天然被 SEGMENT_RE 排除）。
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

// 顶层条目是否属于会话数据（排除 SKIP_ENTRIES、.staging-*，只收明确文件或目录）。
async function isSessionEntry(agentRoot, name) {
  if (SKIP_ENTRIES.has(name) || name.startsWith(".staging-")) return false;
  // compaction 提交 marker 与 *.legacy.jsonl 按前缀/后缀识别，其余按名直接匹配
  return (
    (name.startsWith(COMMIT_MARKER_PREFIX) && name.endsWith(".json")) ||
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
    ...existing,
    sessions_migrated: true
  });
}

// sessionId 会拼进文件系统路径（sessions/<id>/）：拒绝空串、路径分隔符与 . / ..
// 等穿越片段，防止异常 idFactory 把搬迁写到 agentRoot 之外。
function resolveMigrationSessionId(idFactory = randomUUID) {
  const sessionId = typeof idFactory === "function" ? idFactory() : randomUUID();
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
  return sessionId;
}

// 注册会话 1 + 迁移标记（两条迁移路径共用的收尾；先搬后注册，理由见文件头）。
async function registerSessionOne(agentRoot, sessionId) {
  const registry = createSessionRegistry({ root: agentRoot });
  await registry.create({ sessionId, title: "对话 1" });
  await writeMigrationMarker(agentRoot);
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

  const sessionId = resolveMigrationSessionId(idFactory);
  const targetDir = path.join(root, "sessions", sessionId);
  await ensureDir(targetDir);

  // 1. 搬迁（segments/ 最后搬：中途崩溃时旧判定仍成立，重试可继续）
  await moveSessionEntries(root, targetDir);
  // 2+3. 注册会话 1 + 迁移标记（先搬后注册，理由见文件头）
  await registerSessionOne(root, sessionId);

  return { migrated: true, sessionId };
}

// 旧 flat-only 遗留（无 segments/ 的最老一代布局：events.jsonl / transcript.jsonl /
// session.json / checkpoints 直接躺在根）→ 会话 1。判定：未注册 且 根存在任一 flat
// 条目。搬移/注册/标记与 migrateSingleSessionToRegistry 同一"先搬后注册"顺序；
// 由 runtime.migrateProjectData 在 workspace 复制之后调用，纯 flat 数据首开即可见。
export async function adoptLegacyFlatFilesToRegistry({ agentRoot, idFactory = randomUUID }) {
  if (typeof agentRoot !== "string" || agentRoot.length === 0) {
    throw new TypeError("agentRoot 必须是字符串路径");
  }
  const root = path.resolve(agentRoot);
  if (await pathExists(path.join(root, "sessions", "index.json"))) return NO_MIGRATION;

  const FLAT_ENTRIES = ["events.jsonl", "transcript.jsonl", "session.json", "checkpoints"];
  const present = [];
  for (const name of FLAT_ENTRIES) {
    if (await pathExists(path.join(root, name))) present.push(name);
  }
  if (present.length === 0) return NO_MIGRATION;

  const sessionId = resolveMigrationSessionId(idFactory);
  const targetDir = path.join(root, "sessions", sessionId);
  await ensureDir(targetDir);
  for (const name of present) {
    const target = path.join(targetDir, name);
    if (await pathExists(target)) continue; // 前次失败残留 → 跳过
    await renameWithRetry(path.join(root, name), target);
  }
  await registerSessionOne(root, sessionId);

  return { migrated: true, sessionId };
}
