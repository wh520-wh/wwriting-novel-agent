// 依赖规则契约（统一 Agent 内核计划 Task 1）。
//
// 本测试扫描 src/、tests/、scripts/ 下的真实文件（import 语句 + 写入调用），
// 断言只存在两个外部 seam：
//   - 后端：src/core/agent/index.mjs（ProjectAgent 公共接口）
//   - 前端：src/app-shell/agent/index.js（AgentSurface 公共接口）
//
// 规则清单（对应计划 "Dependency Direction" 与 Task 1 Step 3）：
//   A. 生产源码、scripts、acceptance/http/helpers 测试需要 Agent 行为时，
//      只能 import src/core/agent/index.mjs；tests/agent/ 例外（可测内部 seam）。
//   B. src/app-shell/agent/ 之外的文件只能 import src/app-shell/agent/index.js。
//   C. src/core/model/* 不得 import agent 或 project-operations 文件。
//   D. src/core/http/* 不得 import agent 内部文件（只能 index.mjs，规则 A 已覆盖）。
//   E. src/app-shell/app.js 不得 import agent state/view/api 内部文件（只能 index.js）。
//   F. 生产文件不得 import 旧控制面：agent-engine、task-queue、chat-agent、
//      blueprint-init、failure-actions、retry-candidates、event-bus、run-events-bus。
//   G. 生产文件不得写入旧状态文件（四个旧状态文件名清单见 LEGACY_WRITE_TARGETS，
//      按"写入调用 + 参数中出现文件名"判定）。
//   H. 旧数据文件名 0 提及（Task 7 的只读白名单文件已随聊天迁移整体删除——
//      Task 13 起不再有任何文件允许出现旧状态文件名，旧聊天导入路径已退役）。
//
// G 与 H 是两层防御，互相兜底：
//   - G 直接命中"写入调用参数内出现旧文件名"（如 writeFile(p, 旧状态文件名)）；
//   - 间接写入（文件名先存入常量/变量再传入写入调用，如
//     fs.appendFile(safeJoin(p, HISTORY_FILE), ...) 且 HISTORY_FILE 指向旧文件）
//     在 G 的参数扫描中漏报，但被 H 的"提及层"兜住：任何文件只要文本中出现
//     旧文件名即为违规（Task 7 曾存在两个只读白名单文件，Task 13 已删除，
//     白名单清空）。测试基建按片段拼接构造旧文件名（见 harness 的 LEGACY_*
//     常量），避免本测试与 Task 9 的全库 rg 证明被字面量误伤。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

const DOT = ".";
// 旧数据文件名（按片段构造，避免本文件出现字面量）。
const LEGACY_FILES = [
  ["agent_state", "json"],
  ["chat_history", "jsonl"],
  ["chat_transcript", "jsonl"],
  ["chat_pending_action", "json"],
  ["task_queue", "json"],
  ["failures", "jsonl"]
].map(([name, ext]) => name + DOT + ext);

const LEGACY_WRITE_TARGETS = LEGACY_FILES.filter((name) => {
  const [head] = name.split(DOT);
  return ["agent_state", "chat_history", "task_queue", "failures"].includes(head);
});

// 旧控制面模块（规则 F 的禁止 import 目标）。
const BANNED_MODULES = [
  "src/core/agent-engine.mjs",
  "src/core/task-queue.mjs",
  "src/core/chat/chat-agent.mjs",
  "src/core/blueprint-init.mjs",
  "src/core/failure-actions.mjs",
  "src/core/retry-candidates.mjs",
  "src/core/event-bus.mjs",
  "src/core/run-events-bus.mjs"
];

// 公共 seam 与目录。
const AGENT_DIR = "src/core/agent/";
const AGENT_INDEX = "src/core/agent/index.mjs";
const SURFACE_DIR = "src/app-shell/agent/";
const SURFACE_INDEX = "src/app-shell/agent/index.js";
const PROJECT_OPS_DIR = "src/core/project-operations/";
const SKILLS_DIR = "src/core/skills/";
const SKILLS_INDEX = "src/core/skills/index.mjs";

// 规则 A 的扫描集合：生产源码（agent 目录内部除外）+ scripts + 契约测试目录。
const A_SCAN_SET = (rel) =>
  (rel.startsWith("src/") && !rel.startsWith(AGENT_DIR)) ||
  rel.startsWith("scripts/") ||
  rel.startsWith("tests/acceptance/") ||
  rel.startsWith("tests/http/") ||
  rel.startsWith("tests/helpers/");

// 规则 H 的白名单：Task 7 曾授权两个只读文件（src/core/agent/legacy-import.mjs 与
// tests/agent/legacy-import.test.mjs）提及旧数据文件名；Task 13 已整体删除聊天迁移
// 路径，白名单清空——旧数据文件名现在 0 提及（含注释）。
const LEGACY_ALLOWLIST = new Set([]);

// 扫描根守卫（防目录改名/缺失导致规则静默空过）：
//   REQUIRED_SCAN_ROOTS —— 必须存在，缺失即失败；
//   REQUIRED_CONTRACT_DIRS —— 本任务已创建的契约测试目录，同样必须存在；
//   EXPECTED_MISSING_DIRS —— 计划中由后续任务（Task 2–8）创建的目录，当前允许
//   缺失；一旦出现即照常纳入扫描（无需额外处理）。
const REQUIRED_SCAN_ROOTS = ["src", "tests", "scripts"];
const REQUIRED_CONTRACT_DIRS = ["tests/acceptance", "tests/architecture", "tests/helpers", "tests/skills"];
const EXPECTED_MISSING_DIRS = [
  "src/core/agent",
  "src/core/model",
  "src/core/shell",
  "src/core/http",
  "src/core/project-operations",
  "src/app-shell/agent",
  "tests/agent",
  "tests/model",
  "tests/shell",
  "tests/project-operations",
  "tests/http"
];

// ---------------------------------------------------------------------------
// 扫描基建：收集源码文件、解析 import、检测写入调用
// ---------------------------------------------------------------------------

async function collectSourceFiles() {
  const rels = [];
  for (const dir of ["src", "tests", "scripts"]) {
    await walkDir(path.join(ROOT, dir), dir, rels);
  }
  return rels.sort();
}

// 显式递归遍历：node:fs readdir(recursive:true) 的 Dirent.name 只含 basename，
// 无法还原目录前缀，这里自行维护相对路径。walkDir 对单目录 readdir 失败静默跳过，
// 但扫描根的存在性由下方"扫描根守卫"测试强制保证——根缺失时整体失败，不会静默空过。
async function walkDir(absDir, relPrefix, rels) {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkDir(path.join(absDir, entry.name), rel, rels);
    } else if (entry.isFile() && /\.(mjs|js|cjs)$/u.test(entry.name)) {
      rels.push(rel);
    }
  }
}

// 提取 import/require specifier。
// 有意不剔除注释与字符串内的 import 文本（保守扫描）：注释掉的旧模块 import 同样
// 是待清理残留（与 Task 9 的 rg 全库证明口径一致）；当前仓库零误报——规则 A/B 的
// 违规列表均来自真实 import 行。若未来出现注释/文档字符串误报，再引入注释剥离。
function extractSpecifiers(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+[^;"']*?\s+from\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source)) !== null) specs.push(match[1]);
  }
  return specs;
}

// 把相对 import specifier 解析为仓库相对路径（posix）；非相对 specifier 返回 null。
function resolveSpecifier(fileRel, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const dir = path.posix.dirname(fileRel);
  return path.posix.normalize(path.posix.join(dir, specifier));
}

const WRITE_API_NAMES = [
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "createWriteStream",
  "writeJsonAtomic",
  "writeFileAtomic"
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// 从 openIndex 的 "(" 开始找配对的 ")"（跳过字符串字面量），找不到返回 -1。
function findCallEnd(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 返回该文件中"写入调用参数范围内包含 targetLiteral"的调用摘要。
function findWriteCallsTo(source, targetLiteral) {
  const hits = [];
  for (const name of WRITE_API_NAMES) {
    const re = new RegExp(`${escapeRegExp(name)}\\s*\\(`, "g");
    let match;
    while ((match = re.exec(source)) !== null) {
      const openIndex = match.index + match[0].length - 1;
      const endIndex = findCallEnd(source, openIndex);
      if (endIndex === -1) continue;
      if (source.slice(match.index, endIndex + 1).includes(targetLiteral)) {
        hits.push(source.slice(match.index, endIndex + 1).replace(/\s+/gu, " ").slice(0, 140));
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 装载全量源码并做一次解析
// ---------------------------------------------------------------------------

const fileRels = await collectSourceFiles();
const analyzed = new Map(); // rel -> { text, imports: [{spec,target}], writeHits: Map<literal, []> }

for (const rel of fileRels) {
  const abs = path.join(ROOT, rel);
  let text;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    continue;
  }
  const imports = extractSpecifiers(text)
    .map((spec) => ({ spec, target: resolveSpecifier(rel, spec) }))
    .filter((entry) => entry.target !== null);
  const writeHits = new Map();
  for (const literal of [...LEGACY_WRITE_TARGETS, ...LEGACY_FILES]) {
    const hits = findWriteCallsTo(text, literal);
    if (hits.length > 0) writeHits.set(literal, hits);
  }
  analyzed.set(rel, { text, imports, writeHits });
}

function mentionsLegacy(rel) {
  const file = analyzed.get(rel);
  if (!file) return [];
  return LEGACY_FILES.filter((literal) => file.text.includes(literal));
}

function formatList(items) {
  return items.join("\n");
}

// ---------------------------------------------------------------------------
// 扫描根守卫：防止目录缺失/改名导致全部规则静默空过
// ---------------------------------------------------------------------------

test("扫描根与契约目录必须存在，扫描必须命中真实文件", async () => {
  const missing = [];
  for (const rel of [...REQUIRED_SCAN_ROOTS, ...REQUIRED_CONTRACT_DIRS]) {
    try {
      await fs.access(path.join(ROOT, rel));
    } catch {
      missing.push(rel);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `必须存在的扫描根/契约目录缺失（规则将静默空过）：${missing.join(", ")}`
  );
  // 计划中由后续任务创建的目录允许当前缺失；一旦出现，必须被 walker 实际扫描到
  //（否则说明遍历路径退化，相关规则会静默空过）。
  for (const rel of EXPECTED_MISSING_DIRS) {
    const exists = await fs
      .access(path.join(ROOT, rel))
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const prefix = `${rel}/`;
      assert.ok(
        [...analyzed.keys()].some((fileRel) => fileRel.startsWith(prefix)),
        `已出现的计划目录未被扫描到：${rel}`
      );
    }
  }
  // 扫描必须命中真实文件：低于下限说明 walker 退化（例如根目录被改名后空扫）。
  assert.ok(analyzed.size >= 50, `扫描命中文件过少（${analyzed.size}），检查扫描根是否有效`);
});

// ---------------------------------------------------------------------------
// 规则 A：Agent 行为只能经 src/core/agent/index.mjs 进入
// ---------------------------------------------------------------------------

test("Agent 行为只能通过 src/core/agent/index.mjs 对外暴露", () => {
  const violations = [];
  for (const [rel, file] of analyzed) {
    if (!A_SCAN_SET(rel)) continue;
    for (const { spec, target } of file.imports) {
      if (!target.startsWith(AGENT_DIR)) continue;
      if (target !== AGENT_INDEX) {
        violations.push(`${rel} -> "${spec}" 解析为 ${target}；只允许 ${AGENT_INDEX}`);
      }
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

// 规则 A2 的意图（比计划字面更严，是有意为之）：
//   计划明文只授予 "production source、HTTP、scripts、acceptance tests" 经
//   src/core/agent/index.mjs 取用 Agent 行为，并允许 tests/agent/ 测试内部 seam；
//   并未授予其他测试目录任何 Agent import 权利。本规则据此收紧为：tests/agent/
//   （内部 seam）与 tests/acceptance|http|helpers（公共 seam，规则 A）之外的所有
//   测试目录一律不得 import Agent 文件——哪怕是 index.mjs。理由：任何需要 Agent
//   行为的测试要么是分层单测（应落在对应层目录，如 tests/model|shell|http），要么
//   是公共行为测试（应落在 tests/acceptance|tests/http）；不允许第三类"绕过层测试"
//   出现，保证测试目录结构镜像目标架构。此收紧不与计划冲突（计划未授予这些目录
//   导入权），且 Task 9 的全部新测试（agent/model/shell/project-operations/http/
//   app-shell/architecture 目录）都不会触犯该规则。
test("其他测试目录不得 import Agent 文件（tests/agent/ 例外，可测内部 seam）", () => {
  const violations = [];
  for (const [rel, file] of analyzed) {
    if (!rel.startsWith("tests/")) continue;
    if (rel.startsWith("tests/agent/")) continue;
    if (A_SCAN_SET(rel)) continue; // acceptance/http/helpers 由规则 A 覆盖（可 import index.mjs）
    for (const { spec, target } of file.imports) {
      if (target.startsWith(AGENT_DIR)) {
        violations.push(`${rel} -> "${spec}" 解析为 ${target}；契约测试目录外不得 import Agent 文件`);
      }
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

// ---------------------------------------------------------------------------
// 规则 B：AgentSurface 只能经 src/app-shell/agent/index.js 对外暴露
// ---------------------------------------------------------------------------

// 规则 B 的唯一例外：tests/app-shell/work-items.test.mjs 与
// tests/app-shell/reasoning-ticker.test.mjs 是内部 seam 单测（计划 Task 5 明确
// 要求直接测 reduceWorkEvent；Task 6 的 reasoning-ticker 同样直接测
// createReasoningTicker），与规则 A2 授予 tests/agent/ 内部 seam 权利的意图一致。
// Task 11 追加：agent-context-ring.test.mjs 直接测纯 DOM 圆环模块
// createContextRing（brief Step 1/2 的模块级契约测试，同一 seam 意图）。
// Task 7 追加：agent-api.test.mjs 直接测传输层 createAgentApi（api.js 是
// AgentSurface 的正式依赖——index.js 经 createAgentApi() 构造 transport）；它以
// 注入 fetchImpl 方式做请求形状单元测试，与 agent-surface.test.mjs 经 fake api
// 验证 surface 行为互补：后者只能断言 surface 的调用形状，覆盖不到 transport 的
// URL/body 构造细节。agent-surface.test.mjs 不在名单内：它只 import index.js
//（规则 B 允许的公共 seam），不触碰内部 seam。
const SURFACE_SEAM_TESTS = new Set([
  "tests/app-shell/work-items.test.mjs",
  "tests/app-shell/reasoning-ticker.test.mjs",
  "tests/app-shell/agent-context-ring.test.mjs",
  "tests/app-shell/agent-api.test.mjs",
  // state-notices.test.mjs 直接测 agent/state.js 的 systemNotices 投影（纯 state
  // reducer，与 work-items 等投影测试同属 seam 意图——绕 index.js 触达内部投影
  // 逻辑，测试 agent-surface.test.mjs 经 fake api 覆盖不到的 reducer 细节）。
  "tests/app-shell/state-notices.test.mjs",
  // agent-stream-finalize.test.mjs 直接测 agent/state.js 的流式正文终态定稿 reducer
  //（Task 1 遗留登记，同一 seam 意图：绕 index.js 触达内部投影逻辑）。
  "tests/app-shell/agent-stream-finalize.test.mjs"
]);

test("AgentSurface 只能通过 src/app-shell/agent/index.js 对外暴露", () => {
  const violations = [];
  for (const [rel, file] of analyzed) {
    if (rel.startsWith(SURFACE_DIR)) continue;
    if (SURFACE_SEAM_TESTS.has(rel)) continue;
    for (const { spec, target } of file.imports) {
      if (!target.startsWith(SURFACE_DIR)) continue;
      if (target !== SURFACE_INDEX) {
        violations.push(`${rel} -> "${spec}" 解析为 ${target}；只允许 ${SURFACE_INDEX}`);
      }
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

// ---------------------------------------------------------------------------
// 规则 C / D / E：分层隔离
// ---------------------------------------------------------------------------

test("src/core/model/* 不得 import agent 或 project-operations 文件", () => {
  const violations = [];
  for (const [rel, file] of analyzed) {
    if (!rel.startsWith("src/core/model/")) continue;
    for (const { spec, target } of file.imports) {
      if (target.startsWith(AGENT_DIR) || target.startsWith(PROJECT_OPS_DIR)) {
        violations.push(`${rel} -> "${spec}" 解析为 ${target}；model 层不得依赖 agent/project-operations`);
      }
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

test("src/core/http/* 不得 import agent 内部文件", () => {
  const violations = [];
  for (const [rel, file] of analyzed) {
    if (!rel.startsWith("src/core/http/")) continue;
    for (const { spec, target } of file.imports) {
      if (target.startsWith(AGENT_DIR) && target !== AGENT_INDEX) {
        violations.push(`${rel} -> "${spec}" 解析为 ${target}；http 层只能依赖 ${AGENT_INDEX}`);
      }
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

test("src/app-shell/app.js 不得 import agent state/view/api 内部文件", () => {
  const violations = [];
  const file = analyzed.get("src/app-shell/app.js");
  if (!file) return;
  for (const { spec, target } of file.imports) {
    if (target.startsWith(SURFACE_DIR) && target !== SURFACE_INDEX) {
      violations.push(`src/app-shell/app.js -> "${spec}" 解析为 ${target}；只允许 ${SURFACE_INDEX}`);
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

// ---------------------------------------------------------------------------
// 规则 F：生产文件不得 import 旧控制面
// ---------------------------------------------------------------------------

test("生产文件不得 import 旧控制面模块", () => {
  const violations = [];
  for (const [rel, file] of analyzed) {
    if (!rel.startsWith("src/")) continue;
    for (const { spec, target } of file.imports) {
      if (BANNED_MODULES.includes(target)) {
        violations.push(`${rel} -> "${spec}" 解析为 ${target}；旧控制面模块禁止 import`);
      }
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

// ---------------------------------------------------------------------------
// 规则 I（Task 12）：Skills 只能经 src/core/skills/index.mjs 使用
// ---------------------------------------------------------------------------

test("生产文件只能从 src/core/skills/index.mjs 导入；tests/skills/ 才可测内部 seam", () => {
  const violations = [];
  for (const [rel, file] of analyzed) {
    // src/core/skills/ 内部文件（index.mjs / skill-file / catalog / hooks /
    // legacy-migration）正常互相引用，不参与本规则。
    if (rel.startsWith(SKILLS_DIR)) continue;
    const inProduction = rel.startsWith("src/");
    const inSkillsTests = rel.startsWith("tests/skills/");
    if (!inProduction && !inSkillsTests) continue;
    for (const { spec, target } of file.imports) {
      if (!target.startsWith(SKILLS_DIR)) continue;
      if (inProduction && target !== SKILLS_INDEX) {
        violations.push(`${rel} -> "${spec}" 解析为 ${target}；生产文件只允许 ${SKILLS_INDEX}`);
      }
      if (!inSkillsTests && target !== SKILLS_INDEX) {
        violations.push(`${rel} -> "${spec}" 解析为 ${target}；非 tests/skills/ 测试目录只能导入 ${SKILLS_INDEX}`);
      }
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

// ---------------------------------------------------------------------------
// 规则 G：生产文件不得写入旧状态文件
// ---------------------------------------------------------------------------

test("生产文件不得写入旧状态文件", () => {
  const violations = [];
  for (const [rel, file] of analyzed) {
    if (!rel.startsWith("src/")) continue;
    for (const [literal, hits] of file.writeHits) {
      if (!LEGACY_WRITE_TARGETS.includes(literal)) continue;
      for (const hit of hits) {
        violations.push(`${rel} 写入 ${literal}：${hit}`);
      }
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

// ---------------------------------------------------------------------------
// 规则 H：旧数据文件名只允许出现在两个只读白名单文件里
// ---------------------------------------------------------------------------

test("旧数据文件名 0 提及（聊天迁移已删除，白名单清空）", () => {
  const violations = [];
  const matchingFiles = [];
  for (const rel of analyzed.keys()) {
    const mentions = mentionsLegacy(rel);
    if (mentions.length === 0) continue;
    matchingFiles.push(rel);
    if (!LEGACY_ALLOWLIST.has(rel)) {
      violations.push(`${rel} 引用旧数据文件名：${mentions.join(", ")}`);
    }
  }
  // 白名单已清空：任何匹配都是违规（测试基建用片段拼接，见 harness LEGACY_*）。
  assert.equal(
    violations.length,
    0,
    formatList([
      ...violations,
      `当前匹配文件：${formatList(matchingFiles) || "（无）"}`
    ])
  );
});

// ---------------------------------------------------------------------------
// 规则 J（Task 12）：统一 Agent 架构负向门禁——旧概念符号在生产源码与生产
// 验证脚本中 0 命中；旧持久字段在生产源码中 0 命中（读取/写入/默认值全退役）
// ---------------------------------------------------------------------------

// 旧架构符号（Task 12 Step 1 清单 + Task 13 聊天迁移退役清单 + 代码审查补强）：
// 一旦出现在 src/ 或 scripts/，说明旧概念（工作流切换、workflow 政策、旧
// blueprint 事务工具、run_started 的 workflow 载荷、WORKFLOWS 常量、旧聊天迁移
// 入口）仍残留在生产代码或生产验证脚本中。tests/ 目录不受此约束：允许负向
// 字面量断言（如"不得出现 workflow_changed 事件"）与旧用户 YAML fixture，也
// 允许为兼容性重放旧形状事件（旧 run_started.payload.workflow 等）。
const RETIRED_SYMBOLS = [
  "enter_workflow",
  "workflow_changed",
  "WORKFLOW_POLICIES",
  "WORKFLOW_POLICY_RECORDS",
  "allowedDeepTools",
  "commit_blueprint",
  // spec §3.1 目标 4 / §6.1：run_started 不再携带 workflow，Run projection
  // 不再存储 workflow，WORKFLOWS 常量退役（代码审查 I1 补强）
  "WORKFLOWS",
  "payload.workflow",
  "workflow: \"general\"",
  // Task 13（spec §3.7 / §6.1）：旧聊天迁移入口整体退役——生产代码与验证脚本
  // 不得再引用 runLegacyImport / migrateProjectAgentStorage / 两个旧模块路径
  //（模块文件已删除，任何残留引用都说明接线或死代码仍在）。
  "runLegacyImport",
  "migrateProjectAgentStorage",
  "legacy-import",
  "journal-session-migration"
];

test("旧架构符号在生产源码与验证脚本中 0 命中（Task 12/13 负向门禁）", () => {
  const violations = [];
  for (const [rel, file] of analyzed) {
    if (!rel.startsWith("src/") && !rel.startsWith("scripts/")) continue;
    for (const symbol of RETIRED_SYMBOLS) {
      if (file.text.includes(symbol)) {
        violations.push(`${rel} 命中已退役符号：${symbol}`);
      }
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});

test("旧持久字段在生产源码中 0 命中（无读取/写入/默认值）", () => {
  // src/ 下任何文件（含注释与迁移代码）都不得提及该字段：概念已整体删除，
  // 生产代码不得读取、迁移或写入它。scripts/ 允许负向断言字面量（如验证脚本
  // 断言新项目不含该字段），tests/ 允许负向字面量与旧用户 YAML fixture。
  const violations = [];
  for (const [rel, file] of analyzed) {
    if (!rel.startsWith("src/")) continue;
    if (file.text.includes("blueprint_status")) {
      violations.push(`${rel} 命中已退役持久字段：blueprint_status`);
    }
  }
  assert.equal(violations.length, 0, formatList(violations));
});
