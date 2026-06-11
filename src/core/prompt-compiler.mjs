import { sha256 } from "./fs-utils.mjs";

export const STABLE_BLOCK_ORDER = [
  "system_rules",
  "goal",
  "audience",
  "style",
  "skill_instructions",
  "source_summaries",
  "outline"
];

export const DYNAMIC_BLOCK_ORDER = [
  "project_memory",
  "chapter_plan",
  "current_task",
  "selected_draft_fragment",
  "latest_user_feedback",
  "recent_trace_summary"
];

export class PromptCompiler {
  constructor({ templateVersion = "prompt.v1" } = {}) {
    this.templateVersion = templateVersion;
  }

  compile({ stableBlocks = {}, dynamicBlocks = {} } = {}) {
    const stable = orderBlocks(normalizeBlocks(stableBlocks, "stable"), STABLE_BLOCK_ORDER);
    const dynamic = orderBlocks(normalizeBlocks(dynamicBlocks, "dynamic"), DYNAMIC_BLOCK_ORDER);
    const blocks = [...stable, ...dynamic];
    const rendered = blocks.map(renderBlock).join("\n\n");
    const blockHashes = Object.fromEntries(blocks.map((block) => [block.name, block.hash]));
    const stableHash = hashBlocks(stable, this.templateVersion);
    const dynamicHash = hashBlocks(dynamic, this.templateVersion);
    return {
      templateVersion: this.templateVersion,
      prompt: rendered,
      blocks,
      blockHashes,
      stableHash,
      dynamicHash
    };
  }
}

export function hashBlocks(blocks, templateVersion = "prompt.v1") {
  return sha256(
    [
      `template:${templateVersion}`,
      ...blocks.map((block) => `${block.kind}:${block.name}:${block.hash}`)
    ].join("\n")
  );
}

function normalizeBlocks(blocks, kind) {
  if (Array.isArray(blocks)) {
    return blocks
      .filter((block) => block && block.content !== undefined)
      .map((block, index) => normalizeBlock(block.name ?? `block_${index + 1}`, block.content, kind, index));
  }
  return Object.entries(blocks)
    .filter(([, content]) => content !== undefined && content !== null && String(content).length > 0)
    .map(([name, content], index) => normalizeBlock(name, content, kind, index));
}

function normalizeBlock(name, content, kind, index) {
  const text = String(content);
  return {
    name,
    kind,
    content: text,
    index,
    hash: sha256(`${kind}:${name}\n${text}`)
  };
}

function orderBlocks(blocks, preferredOrder) {
  const rank = new Map(preferredOrder.map((name, index) => [name, index]));
  return [...blocks].sort((a, b) => {
    const aRank = rank.has(a.name) ? rank.get(a.name) : preferredOrder.length + a.index;
    const bRank = rank.has(b.name) ? rank.get(b.name) : preferredOrder.length + b.index;
    return aRank - bRank;
  });
}

function renderBlock(block) {
  const label = block.kind === "stable" ? "Stable Block" : "Dynamic Block";
  return `[${label}] ${block.name}\n${block.content}`;
}
