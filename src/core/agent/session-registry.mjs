// 会话注册表（session-registry.mjs）——多对话改造的会话元数据存储层（Task 2）。
//
// 职责：
//   - 维护 `<root>/sessions/index.json`：会话元数据列表 + 最近活跃会话指针
//   - 提供会话 CRUD（create/rename/archive/restore/removePermanently）
//   - list 返回全部会话，archived_at 为 null（未归档）的在前，按 updated_at 倒序
//     （归档会话也返回，Task 10 设置页需列出"已归档对话"，由调用方按需过滤）
//   - 所有写 index.json 的操作经进程内互斥锁串行化（先读后写，避免并发丢数据），
//     写盘用 writeJsonAtomic（临时文件 + rename），读用 readJson
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../fs-utils.mjs";
import { createMutex } from "../async-utils.mjs";
// 领域错误统一带 code（不 import runtime 的 fail；HTTP 层按 code 映射状态码，
// message 仅作人类可读原因——code 是契约，message 不是，调用方不得按文案匹配）。
import { codedError } from "./agent-utils.mjs";

// ISO-8601 字符串字典序即时间序；返回 updated_at 倒序的比较器（缺失值垫底）。
function compareByUpdatedAtDesc(a, b) {
  const aTime = a.updated_at ?? "";
  const bTime = b.updated_at ?? "";
  if (aTime < bTime) return 1;
  if (aTime > bTime) return -1;
  return 0;
}

export function createSessionRegistry({ root }) {
  const indexPath = path.join(root, "sessions", "index.json");
  const mutex = createMutex();

  const emptyStore = () => ({ schema_version: 1, sessions: [], last_active_session_id: null });

  // 文件不存在由 readJson 的 fallback 参数返回 null；这里仅把 JSON 解析失败
  // （SyntaxError，文件损坏）兜底为空 store。EACCES/EMFILE 等 I/O 错误必须上抛：
  // 若吞掉，下一次写会以空 store 覆盖 index.json，其余会话注册元数据被静默丢弃。
  async function load() {
    const raw = await readJson(indexPath, null).catch((error) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
    if (raw && Array.isArray(raw.sessions)) {
      return {
        schema_version: 1,
        sessions: raw.sessions,
        last_active_session_id: raw.last_active_session_id ?? null
      };
    }
    return emptyStore();
  }

  async function save(store) {
    // writeJsonAtomic 内部（writeFileAtomic）已 ensureDir，无需重复
    await writeJsonAtomic(indexPath, store);
  }

  // 全部会话：未归档（archived_at 为 null）在前，组内按 updated_at 倒序。
  async function list() {
    const store = await load();
    return store.sessions
      .slice()
      .sort((a, b) => {
        const aActive = a.archived_at == null ? 0 : 1;
        const bActive = b.archived_at == null ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return compareByUpdatedAtDesc(a, b);
      });
  }

  async function get(sessionId) {
    const store = await load();
    return store.sessions.find((s) => s.session_id === sessionId) ?? null;
  }

  async function create({ sessionId = randomUUID(), title = "新对话" } = {}) {
    return mutex.run(async () => {
      const store = await load();
      // 同 id 幂等：既有 meta 原样保留（created_at/title/updated_at 都不动），
      // 仅把最近活跃指针指过来并返回既有 meta。覆盖 HTTP 重试 / 惰性创建重复调用。
      const existing = store.sessions.find((s) => s.session_id === sessionId);
      if (existing) {
        store.last_active_session_id = sessionId;
        await save(store);
        return existing;
      }
      const now = new Date().toISOString();
      const meta = {
        schema_version: 1,
        session_id: sessionId,
        title: typeof title === "string" && title.trim() ? title.trim() : "新对话",
        created_at: now,
        updated_at: now,
        archived_at: null
      };
      store.sessions = [meta, ...store.sessions];
      store.last_active_session_id = sessionId;
      await save(store);
      return meta;
    });
  }

  async function rename(sessionId, title) {
    return mutex.run(async () => {
      const store = await load();
      const meta = store.sessions.find((s) => s.session_id === sessionId);
      if (!meta) throw codedError("session_not_found", `会话不存在: ${sessionId}`);
      const trimmed = String(title ?? "").trim();
      if (!trimmed) throw codedError("invalid_session_title", "标题不能为空");
      meta.title = trimmed;
      meta.updated_at = new Date().toISOString();
      await save(store);
      return meta;
    });
  }

  async function archive(sessionId) {
    return mutex.run(async () => {
      const store = await load();
      const meta = store.sessions.find((s) => s.session_id === sessionId);
      if (!meta) throw codedError("session_not_found", `会话不存在: ${sessionId}`);
      meta.archived_at = new Date().toISOString();
      meta.updated_at = meta.archived_at;
      await save(store);
      return meta;
    });
  }

  async function restore(sessionId) {
    return mutex.run(async () => {
      const store = await load();
      const meta = store.sessions.find((s) => s.session_id === sessionId);
      if (!meta) throw codedError("session_not_found", `会话不存在: ${sessionId}`);
      meta.archived_at = null;
      meta.updated_at = new Date().toISOString();
      await save(store);
      return meta;
    });
  }

  async function setLastActive(sessionId) {
    return mutex.run(async () => {
      const store = await load();
      store.last_active_session_id = sessionId;
      await save(store);
      return sessionId;
    });
  }

  // 返回最近活跃的未归档会话 id：
  //   - 显式 last_active_session_id 存在且指向未归档会话 → 直接用；
  //   - 指针为空 / 指向不存在或已归档会话 → 回退未归档会话中 updated_at 最新的一条
  //     （打开项目恢复上次活跃，被归档则回退最近）；
  //   - 没有任何未归档会话 → null。
  async function getLastActive() {
    const store = await load();
    const active = store.sessions.filter((s) => s.archived_at == null);
    const pointer = store.last_active_session_id;
    if (pointer != null && active.some((s) => s.session_id === pointer)) return pointer;
    return active.sort(compareByUpdatedAtDesc)[0]?.session_id ?? null;
  }

  // runtime 每次 append 事件后调用，刷新 updated_at（sessions() 排序依据）。
  async function touch(sessionId) {
    return mutex.run(async () => {
      const store = await load();
      const meta = store.sessions.find((s) => s.session_id === sessionId);
      if (!meta) return null;
      meta.updated_at = new Date().toISOString();
      await save(store);
      return meta;
    });
  }

  // 二次永久删除：从注册表移除元数据，并清空 last_active 指向（Task 10 设置页）。
  async function removePermanently(sessionId) {
    return mutex.run(async () => {
      const store = await load();
      store.sessions = store.sessions.filter((s) => s.session_id !== sessionId);
      if (store.last_active_session_id === sessionId) store.last_active_session_id = null;
      await save(store);
      return true;
    });
  }

  return { list, get, create, rename, archive, restore, setLastActive, getLastActive, touch, removePermanently };
}
