// scripts/benchmark-agent-journal.mjs —— 百万事件 Journal 容量基准（计划 Task 14）。
//
// 用途：在专用临时项目根上生成大规模 Journal 数据集，并用真实 Journal/ProjectAgent
// API 测量计划 §2 的容量门槛：
//   - open_tail_ms         冷启动打开 + 尾部 200 事件返回耗时（门槛 <= 2000ms）
//   - rss_delta_mb         首屏常驻内存增量（门槛 < 200 MiB）
//   - read_previous_page_ms 向前 200 事件分页耗时（门槛 <= 500ms）
//   - segments             事件分段数量（默认段上限 25,000 条 / 16 MiB）
//   - index_rebuild_ms     删除全部稀疏索引后重建耗时（门槛：可后台、尾部健康仍可用）
//
// 用法：
//   node scripts/benchmark-agent-journal.mjs --events 1000000 --project-root <临时目录>
//   node scripts/benchmark-agent-journal.mjs --bytes 2147483648 --project-root <临时目录>
//
// 行为契约：
//   - 只写传入的 --project-root（默认 storage 在 <root>/.wwriting/agent/），执行前
//     校验它不是工作区根、磁盘根或用户目录；已存在 Journal 数据的目录拒绝覆盖。
//   - 生成数据使用流式 append（分批 appendBatch，单批最多 ~64 MiB），不在内存构造
//     百万元素数组；默认 1,000,000 个事件，事件为真实可回放的最小 Run 周期
//     （input_queued → run_started → input_started → tool_call_started →
//     tool_call_completed → input_completed → run_completed），--bytes 时把
//     tool_call_completed 的摘要载荷放大到目标总字节数。
//   - 测量在独立子进程进行（冷启动 = 真实应用重启场景；同一进程内 journal 已加载，
//     再测 open 无意义；同一 projectRoot 单实例契约也不允许）。
//   - 输出 JSON 字段固定：events / bytes / open_tail_ms / read_previous_page_ms /
//     rss_delta_mb / segments / index_rebuild_ms。
//   - 默认在生成并测量后删除专用临时目录（--keep 保留，供复现/人工核查）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const EVENTS_STREAM = path.join(".wwriting", "agent", "segments", "events");

// 事件周期：一个可回放的最小 Run（7 条事件，新输入生命周期）。tool_call_completed
// 的 output 是主要载荷（--bytes 放大它）。
function buildCycle(seqOffset, { outputSize = 32 } = {}) {
  const cycle = Math.floor(seqOffset / 7);
  const inputId = `bench-in-${cycle}`;
  const runId = `bench-run-${cycle}`;
  const toolCallId = `bench-tool-${cycle}`;
  const output = "汉".repeat(outputSize);
  return [
    { type: "input_queued", run_id: runId, payload: { input_id: inputId, text: `第 ${cycle} 轮基准输入` } },
    { type: "run_started", run_id: runId, payload: {} },
    { type: "input_started", run_id: runId, payload: { input_id: inputId } },
    { type: "tool_call_started", run_id: runId, payload: { tool_call_id: toolCallId, name: "read_file", arguments: { path: "OUTLINE.md" } } },
    { type: "tool_call_completed", run_id: runId, payload: { tool_call_id: toolCallId, name: "read_file", arguments: { path: "OUTLINE.md" }, output, result_summary: "基准工具摘要", duration_ms: 12 } },
    { type: "input_completed", run_id: runId, payload: { input_id: inputId } },
    { type: "run_completed", run_id: runId, payload: {} }
  ];
}

function parseArgs(argv) {
  const args = { events: 1_000_000, bytes: null, projectRoot: null, measure: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--events") args.events = Number(argv[++i]);
    else if (arg === "--bytes") args.bytes = Number(argv[++i]);
    else if (arg === "--project-root") args.projectRoot = argv[++i];
    else if (arg === "--measure") args.measure = true;
    else if (arg === "--keep") args.keep = true;
  }
  return args;
}

function fail(message) {
  console.error(`benchmark-agent-journal: ${message}`);
  process.exit(1);
}

// 目标字节时每个 tool 摘要的尺寸：总字节 ≈ 每事件 ~180B 固定开销 + 摘要载荷。
function outputSizeFor(events, targetBytes) {
  const fixedPerEvent = 180;
  const cycles = Math.max(1, Math.floor(events / 7));
  const overhead = events * fixedPerEvent;
  const perCycle = (targetBytes - overhead) / cycles;
  if (perCycle <= 0) fail(`--bytes ${targetBytes} 小于固定开销 ${overhead}，无法达成`);
  // CJK 字符 ≈ 3 字节 UTF-8；摘要按目标字节数精确近似即可
  return Math.max(32, Math.floor(perCycle / 3));
}

function batchSizeFor(events, avgBytesPerEvent) {
  const byBytes = Math.max(1000, Math.floor((64 * 1024 * 1024) / avgBytesPerEvent));
  return Math.min(30_000, byBytes);
}

// 校验 project root：必须是绝对路径、非工作区根/主仓库根/磁盘根/用户目录，且尚未
// 含 Journal。主仓库根经 worktree 的 .git 文件（gitdir: ...）反推，防止把
// D:\WWriting 主仓库根误当作可写目录。
async function validateProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") fail("必须指定 --project-root <临时目录>");
  if (!path.isAbsolute(projectRoot.trim())) fail(`--project-root 必须是绝对路径（如 D:\\tmp\\...），收到: ${projectRoot}`);
  const resolved = path.resolve(projectRoot.trim());
  const parsed = path.parse(resolved);
  if (parsed.root === resolved || resolved === parsed.root) fail(`拒绝磁盘根作为 project-root: ${resolved}`);
  if (resolved === os.homedir()) fail(`拒绝用户主目录作为 project-root: ${resolved}`);
  const repoRoots = [REPO_ROOT];
  const mainRepoRoot = await mainRepoRootOf(SCRIPT_DIR);
  if (mainRepoRoot && mainRepoRoot !== REPO_ROOT) repoRoots.push(mainRepoRoot);
  for (const repo of repoRoots) {
    if (resolved === path.resolve(repo)) fail(`拒绝工作区根作为 project-root: ${resolved}`);
  }
  if (resolved === SCRIPT_DIR || resolved === path.join(REPO_ROOT, "scripts")) fail("拒绝把脚本目录作为 project-root");
  const eventsDir = path.join(resolved, EVENTS_STREAM);
  try {
    const names = await fs.readdir(eventsDir);
    if (names.some((name) => name.endsWith(".jsonl"))) {
      fail(`project-root 已存在 Journal 数据，拒绝覆盖: ${eventsDir}`);
    }
  } catch {
    // 目录不存在 = 全新，继续
  }
  return resolved;
}

// 主仓库根：worktree 的 <root>/.git 是文件，内容形如 "gitdir: <main>/.git/worktrees/<name>"。
async function mainRepoRootOf(scriptDir) {
  const candidate = path.resolve(scriptDir, "..");
  const gitEntry = path.join(candidate, ".git");
  try {
    const stat = await fs.stat(gitEntry);
    if (stat.isDirectory()) {
      return (await pathExists(path.join(candidate, "package.json"))) ? candidate : null;
    }
    if (stat.isFile()) {
      const content = await fs.readFile(gitEntry, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(content);
      if (match) {
        const gitDir = path.resolve(String(match[1]).trim());
        const parts = gitDir.split(/[\\/]+/);
        const dotGitIndex = parts.lastIndexOf(".git");
        if (dotGitIndex > 0) {
          const root = parts.slice(0, dotGitIndex).join(path.sep);
          if (await pathExists(path.join(root, "package.json"))) return root;
        }
      }
    }
  } catch {
    // 无 .git 信息时只检查 REPO_ROOT
  }
  return null;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 生成阶段（主进程）：流式分批 append 到真实 journal
// ---------------------------------------------------------------------------
async function generate({ projectRoot, events, bytes }) {
  const { createAgentJournal } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "core", "agent", "journal.mjs")).href);
  await fs.mkdir(projectRoot, { recursive: true });
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const outputSize = bytes ? outputSizeFor(events, bytes) : 32;
  // 近似平均事件字节：固定 180B/事件 + 摘要贡献（每周期 1 条摘要载荷）
  const avgBytesPerEvent = 180 + (outputSize * 3) / 7;
  const batchSize = batchSizeFor(events, avgBytesPerEvent);
  const started = Date.now();
  let appended = 0;
  let batch = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await journal.appendBatch(batch);
    appended += batch.length;
    batch = [];
    const percent = Math.floor((appended / events) * 100);
    process.stderr.write(`\r生成事件 ${appended}/${events}（${percent}%）`);
  };
  const cycles = Math.floor(events / 7);
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const eventsInCycle = buildCycle(cycle * 7, { outputSize });
    for (const event of eventsInCycle) {
      batch.push(event);
      if (batch.length >= batchSize) await flush();
    }
  }
  // 余数（events 非 7 的倍数）：用不依赖 Run 的 history_compacted 补足，总数精确
  const remainder = events % 7;
  for (let i = 0; i < remainder; i += 1) {
    batch.push({ type: "history_compacted", payload: { summary: "基准补足事件" } });
  }
  await flush();
  process.stderr.write("\n");
  const generateMs = Date.now() - started;
  const actualBytes = await dirBytes(projectRoot);
  const lastSeq = journal.lastSeq;
  if (lastSeq !== events + 1) {
    throw new Error(`事件数不符：journal last_seq=${lastSeq}（含 session_created），期望 ${events + 1}`);
  }
  return { appended, actualBytes, generateMs };
}

async function dirBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        total += stat.size;
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// 测量阶段（子进程）：冷启动打开、尾部分页、RSS 增量、分段计数、索引重建
// ---------------------------------------------------------------------------
async function measure({ projectRoot }) {
  const results = {};
  // RSS 基线：进程刚启动、任何 journal 加载之前
  const rssBefore = process.memoryUsage().rss;

  const t0 = Date.now();
  const { createProjectAgent } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "core", "agent", "index.mjs")).href);
  // 只做快照读，绝不调用模型；gateway 抛错兜底（被调用即基准错误）
  const agent = createProjectAgent({
    modelGateway: {
      async complete() {
        throw new Error("benchmark: 快照阶段不应调用模型");
      }
    }
  });
  const tail = await agent.snapshot({ projectRoot, tail: true, limit: 200 });
  const openTailMs = Date.now() - t0;
  if (tail.events.length !== 200) fail(`尾部页应为 200 条事件，实际 ${tail.events.length}`);
  results.open_tail_ms = openTailMs;

  const rssAfterFirstScreen = process.memoryUsage().rss;
  results.rss_delta_mb = Math.round(((rssAfterFirstScreen - rssBefore) / (1024 * 1024)) * 10) / 10;

  const lastSeq = tail.events.at(-1).seq;
  const t1 = Date.now();
  const previous = await agent.snapshot({ projectRoot, beforeSeq: lastSeq, limit: 200 });
  results.read_previous_page_ms = Date.now() - t1;
  if (previous.events.length !== 200) fail(`向前页应为 200 条事件，实际 ${previous.events.length}`);
  if (previous.events.at(-1).seq >= lastSeq) fail("向前分页应返回 strictly older 事件");

  // 分段计数：事件流目录下的 *.jsonl（不含 .corrupt / .index.json）
  const eventsDir = path.join(projectRoot, EVENTS_STREAM);
  const segmentNames = (await fs.readdir(eventsDir)).filter((name) => /^\d{8}\.jsonl$/u.test(name)).sort();
  results.segments = segmentNames.length;

  // 索引重建：删除全部 .index.json（派生数据）→ 新 store 实例 inline 重建
  const indexFiles = (await fs.readdir(eventsDir)).filter((name) => name.endsWith(".index.json"));
  for (const name of indexFiles) await fs.rm(path.join(eventsDir, name), { force: true });
  const t2 = Date.now();
  const { createJournalSegmentStore } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "core", "agent", "journal-segments.mjs")).href);
  const freshStore = createJournalSegmentStore({
    root: eventsDir,
    streamName: "events",
    manifestPath: path.join(projectRoot, ".wwriting", "agent", "journal-manifest.json")
  });
  const loaded = await freshStore.load({ rebuildMode: "inline" });
  results.index_rebuild_ms = Date.now() - t2;
  if (loaded.last_seq !== lastSeq) fail(`重建后 last_seq 不符：${loaded.last_seq} != ${lastSeq}`);
  if (loaded.gaps.length !== 0) fail(`重建后不应出现缺口: ${JSON.stringify(loaded.gaps)}`);

  // 结果行（父进程解析）
  console.log(`RESULT ${JSON.stringify(results)}`);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));

if (args.measure) {
  await measure({ projectRoot: path.resolve(args.projectRoot) });
  process.exit(0);
}

const projectRoot = await validateProjectRoot(args.projectRoot);
const events = Number.isInteger(args.events) && args.events > 0 ? args.events : 1_000_000;
const bytes = Number.isInteger(args.bytes) && args.bytes > 0 ? args.bytes : null;

console.log(`[benchmark] events=${events} bytes=${bytes ?? "（小事件）"} project-root=${projectRoot}`);

let kept = false;
try {
  const { appended, actualBytes, generateMs } = await generate({ projectRoot, events, bytes });
  console.log(`[benchmark] 生成完成：${appended} 条事件，${actualBytes} 字节，耗时 ${generateMs}ms`);

  // 冷启动测量（独立子进程）
  const child = spawnSync(process.execPath, [process.argv[1], "--measure", "--project-root", projectRoot], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    timeout: 600000
  });
  if (child.error || child.status !== 0) {
    fail(`测量子进程失败：${child.error?.message ?? `exit ${child.status}`}\n${child.stderr ?? ""}`);
  }
  const resultLine = child.stdout.split("\n").filter((line) => line.startsWith("RESULT ")).at(-1);
  if (!resultLine) fail(`测量子进程未输出结果行：\n${child.stdout}`);
  const measured = JSON.parse(resultLine.slice("RESULT ".length));

  const output = {
    events: appended,
    bytes: actualBytes,
    open_tail_ms: measured.open_tail_ms,
    read_previous_page_ms: measured.read_previous_page_ms,
    rss_delta_mb: measured.rss_delta_mb,
    segments: measured.segments,
    index_rebuild_ms: measured.index_rebuild_ms
  };
  console.log(JSON.stringify(output, null, 2));

  // 门槛自检（只输出到 stderr，不混入 JSON）
  const gateWarnings = [];
  if (output.open_tail_ms > 2000) gateWarnings.push(`open_tail_ms ${output.open_tail_ms}ms > 2000ms`);
  if (output.rss_delta_mb >= 200) gateWarnings.push(`rss_delta_mb ${output.rss_delta_mb}MiB >= 200MiB`);
  if (output.read_previous_page_ms > 500) gateWarnings.push(`read_previous_page_ms ${output.read_previous_page_ms}ms > 500ms`);
  if (gateWarnings.length > 0) {
    process.stderr.write(`[benchmark] 门槛未达标：${gateWarnings.join("；")}\n`);
  } else {
    process.stderr.write("[benchmark] 门槛自检：open_tail<=2000ms、rss<200MiB、page<=500ms 全部通过\n");
  }

  if (!args.keep) {
    await fs.rm(projectRoot, { recursive: true, force: true });
    console.log(`[benchmark] 已清理临时目录：${projectRoot}`);
  } else {
    kept = true;
    console.log(`[benchmark] --keep：保留临时目录 ${projectRoot}`);
  }
} catch (error) {
  // 失败也尽力清理（保留现场供排查时使用 --keep）
  if (!kept) {
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
  throw error;
}
