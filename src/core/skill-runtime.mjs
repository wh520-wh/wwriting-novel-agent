import fs from "node:fs/promises";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import ignoreLib from "ignore";
import { stripMarkdown } from "./word-count.mjs";
import { pathExists, safeJoin, writeFileAtomic, writeJsonAtomic } from "./fs-utils.mjs";

export function parseSkillPaths(frontmatter) {
  if (!frontmatter || !frontmatter.paths) return undefined;
  const raw = Array.isArray(frontmatter.paths)
    ? frontmatter.paths
    : [frontmatter.paths];
  const patterns = raw
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.endsWith("/**") ? p.slice(0, -3) : p))
    .filter((p) => p.length > 0 && p !== "**");
  if (patterns.length === 0) return undefined;
  return patterns;
}

export async function resolveSkillSources({
  projectRoot,
  userHome,
  resourcesPath,
} = {}) {
  const sources = [
    resourcesPath ? { base: resourcesPath, subdir: "skills", source: "bundled-dist", priority: 1 } : null,
    userHome ? { base: userHome, subdir: path.join(".wwriting", "skills"), source: "user", priority: 2 } : null,
    projectRoot ? { base: projectRoot, subdir: "skills", source: "project", priority: 3 } : null,
  ].filter(Boolean);

  const seen = new Map(); // realpath → first source
  const result = [];

  for (const src of sources) {
    const baseDir = path.join(src.base, src.subdir);
    let entries;
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true });
    } catch {
      continue; // missing or unreadable; skip
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(baseDir, entry.name);
      let realId;
      try {
        realId = await realpath(skillDir);
      } catch {
        continue;
      }
      if (seen.has(realId)) continue;
      seen.set(realId, src.source);
      result.push({
        name: entry.name,
        path: skillDir,
        realId,
        source: src.source,
        priority: src.priority,
      });
    }
  }

  return result;
}

export const ALLOWED_SKILL_TYPES = new Set(["style", "flow-control", "quality-gate", "post-process"]);
export const ALLOWED_HOOK_ACTIONS = new Set(["append_prompt", "check", "post_process"]);
export const ALLOWED_HOOK_STAGES = new Set(["planning", "drafting", "reviewing", "revising", "post_process"]);

export const BUILTIN_SKILLS = {
  "suspense-chapter-end": {
    name: "suspense-chapter-end",
    version: "1.0.0",
    type: "flow-control",
    enabled: true,
    priority: 50,
    scope: "chapter",
    description: "Every chapter should end with a suspense hook.",
    hooks: [
      {
        stage: "planning",
        action: "append_prompt",
        content: [
          "This chapter plan must include an ending suspense hook.",
          "Prefer one of these hook types: a shocking line, a new fact that overturns prior assumptions, or a sudden urgent danger."
        ].join("\n")
      },
      {
        stage: "reviewing",
        action: "check",
        check: "suspense-ending",
        prompt: "Check whether the final 500 visible characters contain a meaningful suspense hook."
      }
    ]
  }
};

export async function ensureBuiltinSkill(projectRoot, skillName) {
  const manifest = BUILTIN_SKILLS[skillName];
  if (!manifest) {
    return null;
  }
  const dirPath = safeJoin(projectRoot, "skills", skillName);
  await fs.mkdir(dirPath, { recursive: true });
  await writeJsonAtomic(safeJoin(dirPath, "skill.json"), manifest);
  return manifest;
}

export async function loadEnabledSkills(projectRoot, project = {}) {
  const enabledNames = new Set(project.enabled_skills ?? []);
  const skills = [];
  for (const name of enabledNames) {
    if (BUILTIN_SKILLS[name]) {
      skills.push(normalizeSkillManifest(BUILTIN_SKILLS[name], `builtin:${name}`));
    }
  }

  // Resolve additional sources via resolveSkillSources (bundled-dist, user, project)
  const userHome = os.homedir();
  const resourcesPath = process.resourcesPath;
  const discovered = await resolveSkillSources({ projectRoot, userHome, resourcesPath });

  for (const source of discovered) {
    const filePath = await findManifestFile(source.path);
    if (!filePath) continue;
    const manifest = await readSkillManifest(filePath);
    const normalized = normalizeSkillManifest(manifest, filePath);
    if (normalized.enabled === false) continue;
    if (enabledNames.size === 0 || enabledNames.has(normalized.name)) {
      skills.push(normalized);
    }
  }

  return sortSkills(dedupeSkills(skills));
}

export async function listProjectSkills(projectRoot, project = {}) {
  const enabledNames = new Set(project.enabled_skills ?? []);
  const byName = new Map();
  for (const [name, manifest] of Object.entries(BUILTIN_SKILLS)) {
    const skill = normalizeSkillManifest(manifest, `builtin:${name}`);
    byName.set(skill.name, {
      ...skill,
      source_type: "builtin",
      enabled_in_project: enabledNames.has(skill.name)
    });
  }

  const skillRoot = safeJoin(projectRoot, "skills");
  let entries = [];
  try {
    entries = await fs.readdir(skillRoot, { withFileTypes: true });
  } catch {
    // skills 目录不存在，返回内置技能列表
    return sortSkillList([...byName.values()]);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dirPath = safeJoin(skillRoot, entry.name);
    const filePath = await findManifestFile(dirPath);
    if (!filePath) {
      continue;
    }
    const skill = normalizeSkillManifest(await readSkillManifest(filePath), filePath);
    byName.set(skill.name, {
      ...skill,
      source_type: "project",
      source_path: filePath,
      enabled_in_project: enabledNames.has(skill.name)
    });
  }

  return sortSkillList([...byName.values()]);
}

export async function importProjectSkill(projectRoot, manifestSource) {
  const parsed = typeof manifestSource === "string" ? parseSkillManifest(manifestSource, "imported-skill") : manifestSource;
  const manifest = normalizeSkillManifest(parsed, "imported-skill");
  const dirPath = safeJoin(projectRoot, "skills", manifest.name);
  await fs.mkdir(dirPath, { recursive: true });
  await writeFileAtomic(safeJoin(dirPath, "skill.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function collectSkillPromptHooks(projectRoot, project, stage, context = {}) {
  const hooks = await collectHooks(projectRoot, project, stage, "append_prompt", context);
  return {
    content: hooks.map(({ hook }) => hook.content).filter(Boolean).join("\n\n"),
    hooks: hooks.map(({ skill, hook }) => hookSummary(skill, hook))
  };
}

export async function runSkillChecks(projectRoot, project, stage, context = {}) {
  const hooks = await collectHooks(projectRoot, project, stage, "check", context);
  const results = [];
  for (const { skill, hook } of hooks) {
    if (hook.check === "suspense-ending" || skill.name === "suspense-chapter-end") {
      results.push(checkSuspenseEnding(context.content, skill, hook));
    } else {
      results.push({
        gate: `skill:${skill.name}`,
        status: "skipped",
        skill: skill.name,
        hook: hookSummary(skill, hook),
        message: `No local checker is implemented for ${hook.check ?? "unnamed-check"}.`
      });
    }
  }
  return results;
}

export async function runPostProcessHooks(projectRoot, project, context = {}) {
  const hooks = await collectHooks(projectRoot, project, "post_process", "post_process", context);
  let content = String(context.content ?? "");
  const results = [];
  for (const { skill, hook } of hooks) {
    if (hook.content) {
      const separator = content.endsWith("\n") ? "\n" : "\n\n";
      content = `${content}${separator}${String(hook.content).trim()}\n`;
      results.push({
        gate: `skill:${skill.name}:post_process`,
        status: "applied",
        skill: skill.name,
        hook: hookSummary(skill, hook),
        mode: "append"
      });
    } else {
      results.push({
        gate: `skill:${skill.name}:post_process`,
        status: "skipped",
        skill: skill.name,
        hook: hookSummary(skill, hook),
        message: "No local post_process content was provided."
      });
    }
  }
  return {
    content,
    results,
    hooks: hooks.map(({ skill, hook }) => hookSummary(skill, hook))
  };
}

export async function collectHooks(projectRoot, project, stage, action, context = {}) {
  const skills = await loadEnabledSkills(projectRoot, project);
  const matches = [];
  for (const skill of skills) {
    for (const hook of skill.hooks) {
      if (hook.stage !== stage || hook.action !== action) {
        continue;
      }
      if (!matchesConditions(hook.conditions, context)) {
        continue;
      }
      matches.push({ skill, hook });
    }
  }
  matches.sort((a, b) => (a.hook.priority ?? a.skill.priority) - (b.hook.priority ?? b.skill.priority));
  return matches;
}

export function normalizeSkillManifest(manifest, source = "inline") {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`Invalid skill manifest at ${source}: expected object`);
  }
  const skill = {
    ...manifest,
    enabled: manifest.enabled !== false,
    priority: Number.isFinite(manifest.priority) ? manifest.priority : 100,
    hooks: Array.isArray(manifest.hooks) ? manifest.hooks.map((hook) => normalizeHook(hook, manifest, source)) : []
  };
  if (!isSafeSkillName(skill.name)) {
    throw new Error(`Invalid skill name at ${source}: ${skill.name ?? "missing"}`);
  }
  if (!skill.version || typeof skill.version !== "string") {
    throw new Error(`Invalid skill version at ${source}`);
  }
  if (!ALLOWED_SKILL_TYPES.has(skill.type)) {
    throw new Error(`Invalid skill type at ${source}: ${skill.type}`);
  }
  if (!skill.scope) {
    skill.scope = "chapter";
  }
  return skill;
}

export async function readSkillManifest(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  return parseSkillManifest(source, filePath);
}

export function parseSkillManifest(source, sourceName = "inline") {
  try {
    return JSON.parse(source);
  } catch {
    // JSON 解析失败，尝试 YAML 格式
    return parseSkillYaml(source, sourceName);
  }
}

function normalizeHook(hook, manifest, source) {
  if (!hook || typeof hook !== "object") {
    throw new Error(`Invalid hook in ${manifest.name ?? source}`);
  }
  if (!ALLOWED_HOOK_STAGES.has(hook.stage)) {
    throw new Error(`Invalid hook stage in ${manifest.name ?? source}: ${hook.stage}`);
  }
  if (!ALLOWED_HOOK_ACTIONS.has(hook.action)) {
    throw new Error(`Invalid hook action in ${manifest.name ?? source}: ${hook.action}`);
  }
  return {
    ...hook,
    priority: Number.isFinite(hook.priority) ? hook.priority : manifest.priority ?? 100
  };
}

async function findManifestFile(dirPath) {
  for (const name of ["skill.json", "skill.yaml", "skill.yml"]) {
    const filePath = path.join(dirPath, name);
    if (await pathExists(filePath)) {
      return filePath;
    }
  }
  return null;
}

function parseSkillYaml(source, sourceName) {
  const result = {};
  let currentHook = null;
  let blockTarget = null;
  let blockKey = null;
  let blockIndent = 0;

  for (const rawLine of String(source).split(/\r?\n/u)) {
    if (blockTarget) {
      const indent = leadingSpaces(rawLine);
      if (rawLine.trim() === "") {
        blockTarget[blockKey] += "\n";
        continue;
      }
      if (indent >= blockIndent) {
        blockTarget[blockKey] += `${rawLine.slice(blockIndent)}\n`;
        continue;
      }
      blockTarget[blockKey] = blockTarget[blockKey].trimEnd();
      blockTarget = null;
      blockKey = null;
    }

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed === "hooks:") {
      result.hooks = [];
      continue;
    }
    if (result.hooks && trimmed.startsWith("- ")) {
      currentHook = {};
      result.hooks.push(currentHook);
      parseKeyValueInto(currentHook, trimmed.slice(2), rawLine, (target, key, indent) => {
        blockTarget = target;
        blockKey = key;
        blockIndent = indent + 2;
      });
      continue;
    }
    if (currentHook && leadingSpaces(rawLine) > 0) {
      parseKeyValueInto(currentHook, trimmed, rawLine, (target, key, indent) => {
        blockTarget = target;
        blockKey = key;
        blockIndent = indent + 2;
      });
      continue;
    }
    parseKeyValueInto(result, trimmed, rawLine, (target, key, indent) => {
      blockTarget = target;
      blockKey = key;
      blockIndent = indent + 2;
    });
  }

  if (blockTarget) {
    blockTarget[blockKey] = blockTarget[blockKey].trimEnd();
  }
  if (!result.hooks) {
    throw new Error(`Invalid skill YAML at ${sourceName}: missing hooks`);
  }
  return result;
}

function parseKeyValueInto(target, text, rawLine, startBlock) {
  const match = text.match(/^([A-Za-z_][\w-]*):\s*(.*)$/u);
  if (!match) {
    return;
  }
  const [, key, rawValue] = match;
  if (rawValue === "|") {
    target[key] = "";
    startBlock(target, key, leadingSpaces(rawLine));
    return;
  }
  target[key] = parseScalar(rawValue);
}

function parseScalar(rawValue) {
  const value = rawValue.trim();
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function checkSuspenseEnding(content, skill, hook) {
  const visible = stripMarkdown(content ?? "");
  const tail = visible.slice(-500);
  const hasHook = /[?？!！]|突然|真相|危险|秘密|震惊|消失|线索|命运|敲门|身后|倒计时|secret|danger|clue|suddenly|vanished|truth/iu.test(tail);
  return {
    gate: `skill:${skill.name}`,
    status: hasHook ? "passed" : "failed",
    skill: skill.name,
    hook: hookSummary(skill, hook),
    checked_chars: Math.min(500, visible.length),
    instruction: hasHook
      ? null
      : "The final 500 visible characters do not contain a clear suspense hook. Append a concise ending beat with a new danger, reversal, secret, or unresolved question."
  };
}

function matchesConditions(conditions, context) {
  if (!conditions || typeof conditions !== "object") {
    return true;
  }
  if (conditions.min_chapter_no !== undefined && Number(context.chapter_no ?? 0) < conditions.min_chapter_no) {
    return false;
  }
  if (conditions.max_chapter_no !== undefined && Number(context.chapter_no ?? 0) > conditions.max_chapter_no) {
    return false;
  }
  return true;
}

function sortSkills(skills) {
  return [...skills].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

function sortSkillList(skills) {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

function dedupeSkills(skills) {
  const byName = new Map();
  for (const skill of skills) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

function hookSummary(skill, hook) {
  return {
    skill: skill.name,
    stage: hook.stage,
    action: hook.action,
    priority: hook.priority ?? skill.priority
  };
}

function isSafeSkillName(name) {
  return typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(name);
}

function leadingSpaces(value) {
  return value.match(/^ */u)?.[0].length ?? 0;
}
