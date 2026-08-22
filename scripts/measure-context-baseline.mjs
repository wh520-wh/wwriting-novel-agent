// 从 sim run 的 journal events 目录提取上下文成本基线与叙述行为证据。
// 口径与第十二轮 N1 收口记录一致：context_usage_updated 的 used_tokens 首末差 / 事件数。
// 供下一轮叙述收紧对照复用（mock 与真实模式均可测）。
// 用法: node scripts/measure-context-baseline.mjs <session-events-dir>

import fs from "node:fs/promises";
import path from "node:path";

const eventsDir = process.argv[2];
if (!eventsDir) {
  console.error("用法: node scripts/measure-context-baseline.mjs <session-events-dir>");
  process.exit(1);
}

const files = (await fs.readdir(eventsDir)).filter((f) => f.endsWith(".jsonl")).sort();
const events = [];
for (const f of files) {
  const text = await fs.readFile(path.join(eventsDir, f), "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
}
events.sort((a, b) => a.seq - b.seq);

// ---- 1. 上下文成本基线：context_usage_updated 首末差 / 事件数 ----
const usage = events.filter((e) => e.type === "context_usage_updated");
const first = usage[0]?.payload?.usage?.used_tokens;
const last = usage[usage.length - 1]?.payload?.usage?.used_tokens;
console.log(`context_usage_updated: ${usage.length} 个, used_tokens ${first} -> ${last}, 差 ${last - first}`);
if (usage.length > 0) {
  console.log(`基线（首末差/事件数）= ${((last - first) / usage.length).toFixed(1)} tokens/轮`);
}
// 各阶段切分：按 run_started 分组看每轮增长
let runStartSeq = 0;
const perRun = [];
for (const e of events) {
  if (e.type === "run_started") {
    runStartSeq = e.seq;
    perRun.push({ startSeq: e.seq, first: null, last: null, count: 0 });
  }
  if (e.type === "context_usage_updated" && perRun.length > 0) {
    const cur = perRun[perRun.length - 1];
    if (cur.first === null) cur.first = e?.payload?.usage?.used_tokens;
    cur.last = e?.payload?.usage?.used_tokens;
    cur.count += 1;
  }
}
for (const r of perRun) {
  if (r.count > 0) {
    console.log(`  run@seq${r.startSeq}: ${r.count} 个事件, ${r.first} -> ${r.last}, 差 ${r.last - r.first}, ${((r.last - r.first) / r.count).toFixed(1)} tokens/轮`);
  }
}
// usage 事件是否携带真实 API usage（approximate 标记）
const approxFlags = new Set(usage.map((e) => String(e.payload?.usage?.approximate ?? "absent")));
console.log(`approximate 标记取值: ${[...approxFlags].join(", ")}`);
const sample = usage[Math.floor(usage.length / 2)]?.payload?.usage;
if (sample) console.log(`中位 usage 样例: ${JSON.stringify(sample)}`);

// ---- 2. 叙述行为（N1）：写正文工具完成前的叙述正文 ----
const toolDone = events.filter((e) => e.type === "tool_call_completed");
const writeDone = toolDone.find((e) => e.payload?.name === "write_file" && String(e.payload?.path ?? "").endsWith(".md") && !String(e.payload?.path ?? "").includes("WWRITING"));
console.log(`\nwrite_file(md, 非WWRITING) 完工事件: ${writeDone ? `seq=${writeDone.seq} path=${writeDone.payload?.path}` : "无"}`);
if (writeDone) {
  const before = events.filter((e) =>
    (e.type === "assistant_message_delta" || e.type === "assistant_message_completed")
    && e.seq < writeDone.seq
    && typeof e.payload?.text === "string" && e.payload.text.trim().length > 0
  );
  const recent = before.slice(-8);
  console.log(`完工前的叙述正文（最近 ${recent.length} 条）:`);
  for (const e of recent) {
    console.log(`  [seq${e.seq} ${e.type}] ${e.payload.text.slice(0, 80).replace(/\n/g, " ")}`);
  }
}

// ---- 3. 工具序列总览（看模型干了什么）----
const names = toolDone.map((e) => e.payload?.name);
console.log(`\n工具调用序列 (${names.length}): ${names.join(" -> ")}`);
const writes = toolDone.filter((e) => e.payload?.name === "write_file").map((e) => e.payload?.path);
console.log(`write_file 目标: ${writes.join(", ")}`);
const counts = toolDone.filter((e) => e.payload?.name === "count_text").map((e) => e.payload?.path);
console.log(`count_text 目标: ${counts.join(", ")}`);
