import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { analyzeCost } from "../src/core/cost-audit.mjs";

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error("用法: node scripts/audit-cost.mjs <项目目录>");
  process.exit(1);
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

const logText = await readFile(path.join(projectRoot, "run_log.jsonl"), "utf8").catch(() => "");
const events = logText
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const costSummary = await readJsonOrNull(path.join(projectRoot, "cost.json"));

const report = analyzeCost({ events, costSummary });
console.log(JSON.stringify(report, null, 2));
