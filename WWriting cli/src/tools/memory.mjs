// 设定档案服务：update_memory（更新设定）的落盘侧——事实/时间线/角色三组的唯一合法写通道。
//
// 存储照上游 round9 §2.2：<创作目录>/memory/continuity.json + continuity.md。
// I4 不变量：md 恒等于 json 的渲染打印件，只有本工具触发重印——两文件要么都新、要么都旧，
// 落盘失败时逐字回滚（双文件先备份后写）。内容属创作项目数据（不违反铁律 8），
// 但通用文件工具对 memory/ 只读（目录级保护），全应用只有这一条写通道。
//
// 参数归一化、合并语义、冲突标记、阈值全部照搬上游（memory-extractor / continuity-store）：
// quote ≤80、三组各 ≤50、事件串 ≤10、traits ≤10、单实体 facts ≤20；facts 按
// 实体+属性+值 去重，同属性不同值标 conflict_with（照实记、不调和）；timeline 按
// 路径+事件串去重；characters 按名合并 traits 与最新 status；整体幂等。
//
// 与上游的偏差（记录在 docs/design/2026-10-02 规格）：章节引用用相对路径替代 chapter_no；
// 无 chapter_index/checksum 体系，门禁只校验章节文件在磁盘上存在（轻量门禁 Q29）；
// checkTimeline 时间线冲突检测未搬——timeline_violations 恒空（空 ≠ 检测通过）。
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { isInside } from './permissions.mjs';

// 服务错误：message 是一条中文事实，code 供调用方判断（铁律 3）。
export class MemoryToolError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'MemoryToolError';
    this.code = code;
    this.details = details;
  }
}

const CONTINUITY_SCHEMA_VERSION = 3;
const MAX_FACTS_PER_ENTITY = 20;
const MAX_GROUP_ENTRIES = 50;
const MAX_EVENTS = 10;
const MAX_TRAITS = 10;
const MAX_QUOTE_CHARS = 80;
const MAX_TIME_RAW_CHARS = 120;

const TIME_KINDS = new Set(['scene', 'flashback', 'parallel', 'dream']);
const ANCHOR_TYPES = new Set(['date', 'age', 'named']);

const emptyContinuity = () => ({
  schema_version: CONTINUITY_SCHEMA_VERSION,
  facts: [],
  timeline: [],
  characters: [],
  // 上游格式的第四组；CLI 参数只有三组、不写伏笔，但存储与桌面版同路径——
  // 档案里可能带着桌面版记录的伏笔，读档原样保留、渲染照实打印（I4）。
  foreshadows: [],
});

// 时间字段归一（照上游 normalizeTimeField）：非法值落到确定形状，绝不原样入库。
function normalizeElapsed(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '+0' || text === '0') return '+0';
  return /^\+(\d+)(h|d|w|mo|y)$/u.test(text) ? text : null;
}

function normalizeAnchor(value) {
  if (!value || typeof value !== 'object') return null;
  const type = ANCHOR_TYPES.has(value.type) ? value.type : null;
  const raw = String(value.raw ?? '').trim();
  if (!type || !raw) return null;
  const subject = value.subject == null ? null : (String(value.subject).slice(0, 40) || null);
  return { type, raw: raw.slice(0, 60), subject };
}

function normalizeTimeField(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    kind: TIME_KINDS.has(v.kind) ? v.kind : 'scene',
    elapsed: normalizeElapsed(v.elapsed),
    anchor: normalizeAnchor(v.anchor),
    confidence: v.confidence === 'high' ? 'high' : 'low',
  };
}

// 章节引用渲染：CLI 用相对路径替代上游章号；兼容桌面版档案里的章号（`第N章`）；
// 没标就如实说未标，绝不输出 "null"。
function formatChapterRef(ref) {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref > 0) return `第${ref}章`;
  return typeof ref === 'string' && ref.trim() !== '' ? ref : '未标章节';
}

function requiredString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function pathOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeArray(value, mapFn, filterFn) {
  if (!Array.isArray(value)) return [];
  return value.map(mapFn).filter(filterFn).slice(0, MAX_GROUP_ENTRIES);
}

// 参数归一化（照上游 normalizeMemoryUpdateArgs 的阈值与缺省规则）：
// 条目级 path 缺省继承顶层 path；无效条目过滤、超限截断——先归一再谈落盘。
function normalizeUpdateArgs(args) {
  const topPath = pathOrNull(args?.path);
  const facts = normalizeArray(
    args?.facts,
    (item) => ({
      entity: requiredString(item?.entity),
      attribute: requiredString(item?.attribute),
      value: requiredString(item?.value),
      path: pathOrNull(item?.path) ?? topPath,
      quote: String(item?.quote ?? '').slice(0, MAX_QUOTE_CHARS),
    }),
    (fact) => fact.entity !== null && fact.attribute !== null && fact.value !== null,
  );
  const timeline = normalizeArray(
    args?.timeline,
    (item) => ({
      path: pathOrNull(item?.path) ?? topPath,
      story_time_raw: String(item?.story_time_raw ?? item?.story_time ?? '').slice(0, MAX_TIME_RAW_CHARS),
      events: Array.isArray(item?.events) ? item.events.map((event) => String(event)).slice(0, MAX_EVENTS) : [],
      time: normalizeTimeField(item?.time),
    }),
    (node) => node.path !== null,
  );
  const characters = normalizeArray(
    args?.characters,
    (item) => ({
      name: requiredString(item?.name),
      traits: Array.isArray(item?.traits) ? item.traits.map((trait) => String(trait)).slice(0, MAX_TRAITS) : [],
      status: String(item?.status ?? ''),
      path: pathOrNull(item?.path) ?? topPath,
    }),
    (character) => character.name !== null,
  );
  return { path: topPath, facts, timeline, characters };
}

// 时间线节点迁移：旧版本磁盘数据可能缺字段，读入时归一到当前形状（照上游）。
function migrateTimelineNode(node) {
  const n = node && typeof node === 'object' ? node : {};
  return {
    path: pathOrNull(n.path),
    events: Array.isArray(n.events) ? n.events : [],
    story_time_raw: String(n.story_time_raw ?? n.story_time ?? ''),
    time: normalizeTimeField(n.time),
  };
}

// 合并（照上游 mergeExtraction）：幂等是硬要求——重复调用安全，冲突照实记不调和。
// 返回合并结果与各组的**净新增**计数（照上游的差值口径）。
function mergeExtraction(base, extraction) {
  const next = { ...emptyContinuity(), ...structuredClone(base) };
  next.schema_version = CONTINUITY_SCHEMA_VERSION;
  for (const fact of extraction.facts ?? []) {
    const same = next.facts.find((f) => f.entity === fact.entity && f.attribute === fact.attribute && f.value === fact.value);
    if (same) continue;
    const prior = [...next.facts].reverse().find((f) => f.entity === fact.entity && f.attribute === fact.attribute);
    next.facts.push({
      entity: fact.entity,
      attribute: fact.attribute,
      value: fact.value,
      path: fact.path,
      quote: fact.quote ?? '',
      conflict_with: prior ? `${formatChapterRef(prior.path)}: ${prior.value}` : null,
    });
    enforceEntityCap(next.facts, fact.entity);
  }
  for (const node of extraction.timeline ?? []) {
    const incoming = migrateTimelineNode(node);
    const fingerprint = incoming.events.join('¦');
    const dup = next.timeline.find((t) => t.path === incoming.path && (t.events ?? []).join('¦') === fingerprint);
    if (!dup) next.timeline.push(incoming);
  }
  for (const character of extraction.characters ?? []) {
    const existing = next.characters.find((c) => c.name === character.name);
    if (existing) {
      existing.traits = [...new Set([...(existing.traits ?? []), ...(character.traits ?? [])])].slice(0, MAX_TRAITS);
      if (character.status) existing.status = character.status;
      existing.path = character.path ?? existing.path;
    } else {
      next.characters.push({
        name: character.name,
        traits: character.traits ?? [],
        status: character.status ?? '',
        path: character.path,
      });
    }
  }
  return {
    next,
    counts: {
      facts: next.facts.length - base.facts.length,
      timeline: next.timeline.length - base.timeline.length,
      characters: next.characters.filter((c) => !base.characters.some((b) => b.name === c.name)).length,
    },
  };
}

// 单实体 facts 上限：超出时淘汰**最早**的一条（照上游 enforceEntityCap）。
function enforceEntityCap(facts, entity) {
  const indices = facts.map((fact, index) => (fact.entity === entity ? index : -1)).filter((index) => index >= 0);
  while (indices.length > MAX_FACTS_PER_ENTITY) {
    facts.splice(indices.shift(), 1);
    for (let k = 0; k < indices.length; k += 1) indices[k] -= 1;
  }
}

// md 打印件（照上游 renderContinuityMarkdown 逐字，章节引用换路径）。
// 它是 json 的渲染打印件（I4），没有任何独立事实。
export function renderContinuityMarkdown(data) {
  const lines = ['# 设定档案（continuity）', ''];
  const byEntity = new Map();
  for (const fact of data.facts) {
    if (!byEntity.has(fact.entity)) byEntity.set(fact.entity, []);
    byEntity.get(fact.entity).push(fact);
  }
  lines.push('## 事实');
  for (const [entity, facts] of byEntity) {
    lines.push(`### ${entity}`);
    for (const fact of facts) {
      const conflict = fact.conflict_with ? ` ⚠ 与既有记录冲突（${fact.conflict_with}），以人工或门禁裁决为准` : '';
      lines.push(`- ${fact.attribute}: ${fact.value} (${formatChapterRef(fact.path)})${conflict}`);
    }
  }
  lines.push('', '## 时间线');
  for (const node of [...data.timeline].sort((a, b) => String(a.path ?? '').localeCompare(String(b.path ?? '')))) {
    const migrated = migrateTimelineNode(node);
    const tags = [migrated.time.elapsed, migrated.time.kind !== 'scene' ? migrated.time.kind : null].filter(Boolean).join('·');
    const meta = tags ? ` [${tags}]` : '';
    const when = migrated.story_time_raw || (migrated.time.anchor?.raw ?? '');
    lines.push(`- ${formatChapterRef(migrated.path)}${when ? ` [${when}]` : ''}${meta}: ${migrated.events.join('；')}`);
  }
  lines.push('', '## 角色');
  for (const character of data.characters) {
    lines.push(`- ${character.name}（${character.status || '状态未知'}）：${(character.traits ?? []).join('、') || '无记录特征'}`);
  }
  lines.push('', '## 伏笔台账');
  // CLI 参数只有三组、不写伏笔，但存储与桌面版同路径：档案里可能带着桌面版记录的伏笔。
  // md 是 json 的渲染打印件（I4）——非空就照实渲染，绝不能既不说「无记录」又把内容吞掉。
  const foreshadows = Array.isArray(data.foreshadows) ? data.foreshadows : [];
  const openOnes = foreshadows.filter((f) => f.status === 'open');
  const paidOnes = foreshadows.filter((f) => f.status !== 'open');
  if (openOnes.length === 0 && paidOnes.length === 0) {
    lines.push('- 无记录');
  }
  for (const f of openOnes) {
    const hint = f.expected_payoff_hint ? `（回收提示：${f.expected_payoff_hint}）` : '';
    lines.push(`- 【未收】${formatChapterRef(f.planted_chapter ?? f.path)}埋设：${f.content}${hint}`);
  }
  for (const f of paidOnes) {
    lines.push(`- 【已收】${formatChapterRef(f.planted_chapter ?? f.path)}埋设 → ${formatChapterRef(f.paid_chapter)}回收：${f.content}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function createMemoryService({ fs = fsp } = {}) {
  if (typeof fs?.writeFile !== 'function') {
    throw new MemoryToolError('设定档案服务需要可用的文件系统。', 'MEMORY_FS_INVALID');
  }

  const continuityPath = (projectRoot) => path.join(projectRoot, 'memory', 'continuity.json');

  async function loadContinuity(projectRoot) {
    let raw;
    try {
      raw = await fs.readFile(continuityPath(projectRoot), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyContinuity();
      throw new MemoryToolError('设定档案读不出来，未做任何修改。', 'MEMORY_CONTINUITY_UNREADABLE', {
        errorCode: error?.code,
      });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new MemoryToolError('设定档案读不出来，未做任何修改。', 'MEMORY_CONTINUITY_UNREADABLE', {
        errorCode: 'JSON_INVALID',
      });
    }
    // 形状不对（数组 / 标量 / null）与解析失败同罪：绝不静默当空档案——
    // 那样下一次写入就把损坏的档案整体覆盖掉，等于无声丢数据（与「不静默清空」同一条纪律）。
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new MemoryToolError('设定档案读不出来，未做任何修改。', 'MEMORY_CONTINUITY_UNREADABLE', {
        errorCode: 'JSON_SHAPE_INVALID',
      });
    }
    return {
      ...emptyContinuity(),
      facts: Array.isArray(data.facts) ? data.facts : [],
      timeline: (Array.isArray(data.timeline) ? data.timeline : []).map(migrateTimelineNode),
      characters: Array.isArray(data.characters) ? data.characters : [],
      foreshadows: Array.isArray(data.foreshadows) ? data.foreshadows : [],
    };
  }

  // 原子写入：同目录临时文件 + rename，与文件工具同一条纪律。
  async function writeAtomic(abs, text) {
    const tmpPath = path.join(path.dirname(abs), `${path.basename(abs)}.wwriting-${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(tmpPath, text, 'utf8');
      await fs.rename(tmpPath, abs);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  // 双文件落盘：先备份两份旧档案，任一写入失败就逐字回滚（I4：两份要么都新、要么都旧）。
  async function saveContinuity(projectRoot, data) {
    const memoryDir = path.join(projectRoot, 'memory');
    const jsonPath = path.join(memoryDir, 'continuity.json');
    const mdPath = path.join(memoryDir, 'continuity.md');
    const backups = [];
    for (const filePath of [jsonPath, mdPath]) {
      try {
        backups.push({ path: filePath, bytes: await fs.readFile(filePath, 'utf8') });
      } catch (error) {
        if (error && error.code === 'ENOENT') backups.push({ path: filePath, bytes: null });
        else throw new MemoryToolError('设定档案读不出来，未做任何修改。', 'MEMORY_CONTINUITY_UNREADABLE', { errorCode: error?.code });
      }
    }
    try {
      await writeAtomic(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
      await writeAtomic(mdPath, renderContinuityMarkdown(data));
    } catch (error) {
      const rollbackWarnings = [];
      for (const backup of backups) {
        try {
          if (backup.bytes === null) await fs.unlink(backup.path);
          else await writeAtomic(backup.path, backup.bytes);
        } catch (rollbackError) {
          if (!(rollbackError?.code === 'ENOENT' && backup.bytes === null)) {
            rollbackWarnings.push(backup.path);
          }
        }
      }
      throw new MemoryToolError(
        rollbackWarnings.length === 0 ? '设定档案写入失败，内容保持原样。' : '设定档案写入失败，且回滚未完成，请检查 memory/ 目录。',
        'MEMORY_WRITE_FAILED',
        { errorCode: error?.code, rollback_warnings: rollbackWarnings },
      );
    }
  }

  // 轻量门禁（Q29）：只校验引用的章节文件在磁盘上存在，不比指纹、不强制先入账。
  // 符号链接按真实路径再验一次（与文件工具同一纪律）；不存在时文案点名该文件。
  async function assertChapterExists(projectRoot, chapterPath) {
    const abs = path.resolve(projectRoot, chapterPath);
    if (!isInside(projectRoot, abs)) {
      throw new MemoryToolError(`章节文件 ${chapterPath} 在创作目录之外，未更新设定。`, 'CHAPTER_PATH_OUTSIDE', {
        path: chapterPath,
      });
    }
    let real;
    try {
      real = await fs.realpath(abs);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        throw new MemoryToolError(`章节文件 ${chapterPath} 不存在，无法更新设定。`, 'CHAPTER_NOT_FOUND', {
          path: chapterPath,
        });
      }
      throw new MemoryToolError(`章节文件 ${chapterPath} 存在与否无法确认，未更新设定。`, 'MEMORY_CHAPTER_UNVERIFIABLE', {
        path: chapterPath,
        errorCode: error?.code,
      });
    }
    if (!isInside(projectRoot, real)) {
      throw new MemoryToolError(`章节文件 ${chapterPath} 指向创作目录之外，未更新设定。`, 'CHAPTER_PATH_OUTSIDE', {
        path: chapterPath,
      });
    }
  }

  // 更新设定：归一 → 门禁 → 读档 → 合并 → 双文件原子落盘 → 报告净新增。
  async function update({ projectRoot, path: chapterPath, facts, timeline, characters } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new MemoryToolError('设定档案服务需要创作目录。', 'MEMORY_PROJECT_ROOT_INVALID', { projectRoot });
    }
    const normalized = normalizeUpdateArgs({ path: chapterPath, facts, timeline, characters });
    // 顶层章节路径是引用键（照上游 assertChapterNo）：缺了就没有「本次更新针对哪一章」，
    // 不能靠条目级 path 兜底——那会让门禁与报告都含糊。
    if (normalized.path === null) {
      throw new MemoryToolError('要更新的章节路径不能为空。', 'MEMORY_PATH_INVALID', { path: chapterPath ?? null });
    }
    if (normalized.facts.length === 0 && normalized.timeline.length === 0 && normalized.characters.length === 0) {
      throw new MemoryToolError('没有可更新的设定：三组参数都没有有效条目。', 'MEMORY_UPDATE_EMPTY', {
        path: normalized.path,
      });
    }
    const referenced = new Set(
      [normalized.path, ...normalized.facts.map((f) => f.path), ...normalized.timeline.map((t) => t.path), ...normalized.characters.map((c) => c.path)]
        .filter((p) => p !== null),
    );
    for (const reference of referenced) {
      await assertChapterExists(projectRoot, reference);
    }
    const base = await loadContinuity(projectRoot);
    const { next, counts } = mergeExtraction(base, normalized);
    await saveContinuity(projectRoot, next);
    return {
      ok: true,
      path: normalized.path,
      facts_added: counts.facts,
      timeline_added: counts.timeline,
      characters_added: counts.characters,
      // 上游 checkTimeline 时间线冲突检测未搬：如实给空数组。空 ≠ 检测通过——
      // 与「检测失败≠检测通过」的既有纪律同源，不得对模型暗示时间线已核验。
      timeline_violations: [],
    };
  }

  return { update, continuityPath };
}
