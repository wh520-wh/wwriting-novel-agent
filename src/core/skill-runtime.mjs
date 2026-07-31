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

const conditionalSkills = new Map(); // name → { manifest, patterns }
const activatedNames = new Set();

export function registerProjectSkill({ projectRoot, name, version, type, paths, hooks }) {
  if (!name) throw new Error("registerProjectSkill: name required");
  const patterns = parseSkillPaths({ paths });
  if (!patterns) return null; // unconditional skills don't need activation
  conditionalSkills.set(name, {
    name,
    version,
    type,
    patterns,
    projectRoot: projectRoot ?? null,
    hooks: Array.isArray(hooks) ? hooks : [],
    matcher: ignoreLib().add(patterns),
  });
  return { name, patterns };
}

export function _resetConditionalSkills() {
  conditionalSkills.clear();
  activatedNames.clear();
}

export function activateConditionalSkillsForPaths(filePaths, projectRoot) {
  const activated = [];
  if (!Array.isArray(filePaths) || filePaths.length === 0) return activated;
  for (const [name, entry] of conditionalSkills) {
    if (activatedNames.has(name)) continue;
    if (entry.projectRoot && projectRoot && entry.projectRoot !== projectRoot) continue;
    for (const fp of filePaths) {
      if (!fp || typeof fp !== "string") continue;
      // absolute paths: skip (caller should pass relative)
      if (fp.startsWith("/") || /^[a-zA-Z]:[\\\/]/.test(fp)) continue;
      if (entry.matcher.ignores(fp)) {
        activatedNames.add(name);
        activated.push(name);
        break;
      }
    }
  }
  return activated;
}

export function listActivatedSkills() {
  return [...activatedNames];
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
    description: "每章结尾都要留下悬念钩子：震惊性话语、推翻认知的新事实或突然逼近的危险。",
    hooks: [
      {
        stage: "planning",
        action: "append_prompt",
        content: [
          "本章计划必须包含一个结尾悬念钩子。",
          "优先使用以下类型：一句令人震惊的话、一个推翻此前认知的新事实、或一个突然逼近的危险。"
        ].join("\n")
      },
      {
        stage: "reviewing",
        action: "check",
        check: "suspense-ending",
        prompt: "Check whether the final 500 visible characters contain a meaningful suspense hook."
      }
    ]
  },

  "chapter-opening-hook": {
    name: "chapter-opening-hook",
    version: "1.0.0",
    type: "flow-control",
    enabled: true,
    priority: 40,
    scope: "chapter",
    description: "每章开头必须用正在发生的事抓人：动作、冲突或悬念开场，不写天气和环境铺垫。",
    hooks: [
      {
        stage: "planning",
        action: "append_prompt",
        content: [
          "本章开头前两句话必须进入一个正在发生的事件（人物行动、冲突、悬念或意外）。",
          "禁止以天气、环境描写或背景说明开场。"
        ].join("\n")
      },
      {
        stage: "reviewing",
        action: "check",
        check: "chapter-opening",
        prompt: "检查正文开头约 150 个可见字符内是否有一个正在发生的动作、冲突或悬念。"
      }
    ]
  },

  "avoid-ai-voice": {
    name: "avoid-ai-voice",
    version: "1.0.0",
    type: "quality-gate",
    enabled: true,
    priority: 30,
    scope: "chapter",
    description: "去除 AI 腔：不堆排比、不用模糊修饰词和总结式收尾，读起来像人写的。",
    hooks: [
      {
        stage: "drafting",
        action: "append_prompt",
        content: [
          "去除 AI 腔，这些写法一律不用：",
          "1) 三连排比堆砌（如“他握住刀，握住恨，握住……”）；",
          "2) 段尾用总结句收束情绪（如“她终于明白了……”）；",
          "3) 模糊修饰词连发（仿佛、似乎、不禁、不由得、莫名、悄然、缓缓、微微、瞬间、顿时、一股莫名的、一种说不出的）；",
          "4) 抒情长句连续不断，情绪改用具体动作和实物承载；",
          "5) “如果说……那么……”式的议论句式。"
        ].join("\n")
      },
      {
        stage: "reviewing",
        action: "check",
        check: "ai-voice",
        prompt: "统计正文中模糊修饰词（仿佛/似乎/不禁/不由得/莫名/悄然/缓缓/微微/瞬间/顿时等）的出现密度，判断是否超标。"
      }
    ]
  },

  "dialogue-not-summary": {
    name: "dialogue-not-summary",
    version: "1.0.0",
    type: "quality-gate",
    enabled: true,
    priority: 40,
    scope: "chapter",
    description: "对话推进剧情：人物各有声音、不重复已知信息；本章对话占比合理。",
    hooks: [
      {
        stage: "drafting",
        action: "append_prompt",
        content: [
          "对话规则：",
          "1) 每段对话必须有目的：推进情节、暴露人设或制造冲突；",
          "2) 禁止用对话复述读者已知的信息（“如你所知……”式）；",
          "3) 人物各有口头禅和句式，不要所有人一个腔调；",
          "4) 对话配动作与反应（表情、停顿、小动作），避免“他说道”“她答道”连发。"
        ].join("\n")
      },
      {
        stage: "reviewing",
        action: "check",
        check: "dialogue-ratio",
        prompt: "计算本章引号内对话占总可见字符的比例，对话过少或过多都要标记。"
      }
    ]
  },

  "show-dont-tell": {
    name: "show-dont-tell",
    version: "1.0.0",
    type: "style",
    enabled: true,
    priority: 50,
    scope: "chapter",
    description: "展示而非陈述：用动作、反应和细节表现情绪与性格，不直接贴标签。",
    hooks: [
      {
        stage: "drafting",
        action: "append_prompt",
        content: [
          "展示而非陈述：不直接宣告情绪或性格（如“他很生气”“她是个善良的人”）。",
          "改用具体动作、身体反应、环境细节和他人反应：",
          "例：他摔上门，钥匙在锁孔里断成两截——而不是：他很生气。",
          "例：她蹲下来把碎纸一片片捡起，摆回信封——而不是：她是个细心的人。"
        ].join("\n")
      },
      {
        stage: "revising",
        action: "append_prompt",
        content: "修订时检查：正文中是否还有直接宣告情绪、性格或结论的句子？把它们改写成具体动作与细节。"
      }
    ]
  }
};

// 内置写作技能包：新建项目时提示一键启用；UI 上按此名单提供“全部启用”。
export const DEFAULT_SKILL_PACK = Object.keys(BUILTIN_SKILLS).sort();

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

const SKILL_CHECKERS = {
  "suspense-ending": checkSuspenseEnding,
  "chapter-opening": checkChapterOpening,
  "ai-voice": checkAiVoice,
  "dialogue-ratio": checkDialogueRatio
};

export async function runSkillChecks(projectRoot, project, stage, context = {}) {
  const hooks = await collectHooks(projectRoot, project, stage, "check", context);
  const results = [];
  for (const { skill, hook } of hooks) {
    const checker = SKILL_CHECKERS[hook.check ?? ""] ?? SKILL_CHECKERS[skill.name];
    if (checker) {
      results.push(checker(context.content, skill, hook));
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
  const skills = Array.isArray(context.skills) ? context.skills : await loadEnabledSkills(projectRoot, project);
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

function checkChapterOpening(content, skill, hook) {
  const visible = stripMarkdown(content ?? "");
  const head = visible.slice(0, 150);
  const hasHook = /突然|猛然|骤然|撞|摔倒|跌|喊|吼|尖叫|枪|刀|剑|血|杀|死|逃|追|夺|抓|打|踢|砸|跪|耳光|疼|痛|冷汗|颤抖|危险|秘密|真相|消失|失踪|线索|阴谋|威胁|求救|救命|来不及|难道|怎么回事|震惊|愣住|呆住|脸色|[?？!！]/iu.test(head);
  return {
    gate: `skill:${skill.name}`,
    status: hasHook ? "passed" : "failed",
    skill: skill.name,
    hook: hookSummary(skill, hook),
    checked_chars: head.length,
    instruction: hasHook
      ? null
      : "开头约 150 字没有正在发生的事件。把章节开头改成人物正在进行的动作或冲突：第一句就进入场面（一个动作、一句对话、一处异动），天气与背景说明移到正文中段。"
  };
}

const AI_VOICE_WORDS = ["仿佛", "似乎", "不禁", "不由得", "莫名", "悄然", "缓缓", "微微", "瞬间", "顿时", "一股莫名的", "一种说不出的"];

function checkAiVoice(content, skill, hook) {
  const visible = stripMarkdown(content ?? "");
  const counts = [];
  let total = 0;
  for (const word of AI_VOICE_WORDS) {
    const matches = visible.split(word).length - 1;
    if (matches > 0) {
      total += matches;
      counts.push(`${word}×${matches}`);
    }
  }
  // 3000 字章节允许约 8 处；密度上限 = 每 350 字 1 处。取两者中更宽松者，避免短章节误杀。
  const threshold = Math.max(8, Math.floor(visible.length / 350));
  const over = total > threshold;
  return {
    gate: `skill:${skill.name}`,
    status: over ? "failed" : "passed",
    skill: skill.name,
    hook: hookSummary(skill, hook),
    checked_chars: visible.length,
    ai_voice_total: total,
    ai_voice_detail: counts.join("，"),
    instruction: over
      ? `模糊修饰词超标（共 ${total} 处：${counts.join("，")}）。改写：这类词多数直接删去不损语义；“不禁/不由得”改成具体的动作反应；“瞬间/顿时”用时间与动作的先后顺序替代。`
      : null
  };
}

function checkDialogueRatio(content, skill, hook) {
  const visible = stripMarkdown(content ?? "");
  const quoteRe = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/gu;
  const dialogueChars = [...visible.matchAll(quoteRe)].reduce((sum, match) => sum + match[0].length, 0);
  const ratio = visible.length > 0 ? dialogueChars / visible.length : 0;
  const percent = Math.round(ratio * 100);
  const tooFew = ratio < 0.08;
  const tooMany = ratio > 0.7;
  const status = tooFew || tooMany ? "failed" : "passed";
  let instruction = null;
  if (tooFew) {
    instruction = `本章对话占比过低（约 ${percent}%）：情节全靠叙述推进。补一段有目的的对话——让人物当面发生冲突、讨价还价或交换秘密，把信息放进对话与动作里。`;
  } else if (tooMany) {
    instruction = `本章几乎全是对话（约 ${percent}%）：缺动作与场景描写。给关键对话配表情、停顿、动作反应和周围环境，让场面立体。`;
  }
  return {
    gate: `skill:${skill.name}`,
    status,
    skill: skill.name,
    hook: hookSummary(skill, hook),
    checked_chars: visible.length,
    dialogue_ratio: Math.round(ratio * 1000) / 10,
    instruction
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
