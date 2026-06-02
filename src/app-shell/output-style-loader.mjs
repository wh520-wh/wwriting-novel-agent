import * as fs from "node:fs/promises";
import * as path from "node:path";

// 内置 2 种风格(bundled 优先级最低,用户/项目同名会替换)
const BUNDLED_STYLES = [
  {
    name: "creative",
    description: "创作模式:长跑章节生成,强调氛围、人物心理、节奏",
    body: "你正在创作长篇小说。当前目标是写出有沉浸感、人物驱动的章节。\n- 优先呈现人物心理和情绪变化\n- 对话要符合角色设定和场景氛围\n- 每章结尾保留悬念或转折钩子",
    source: "bundled",
  },
  {
    name: "review",
    description: "审稿模式:检查节奏、连贯性、设定一致性",
    body: "你正在审稿当前章节。请重点检查:\n- 节奏是否拖沓或仓促\n- 人物言行是否符合已建立的性格\n- 设定是否前后矛盾(地名、时间线、术语)\n- 字数与目标差距\n- 章节结尾是否有钩子",
    source: "bundled",
  },
];

let cache = null;
let cacheKey = null;

function makeCacheKey({ projectRoot, userHome }) {
  return `${projectRoot ?? ""}::${userHome ?? ""}`;
}

export async function loadOutputStyles({ projectRoot, userHome } = {}) {
  const key = makeCacheKey({ projectRoot, userHome });
  if (cache && cacheKey === key) return cache;

  const styles = [...BUNDLED_STYLES];

  // User-level (~/.wwriting/output-styles/*.md)
  if (userHome) {
    const userDir = path.join(userHome, ".wwriting", "output-styles");
    await loadFromDir(userDir, "user", styles);
  }

  // Project-level (<projectRoot>/.wwriting/output-styles/*.md)
  if (projectRoot) {
    const projectDir = path.join(projectRoot, ".wwriting", "output-styles");
    await loadFromDir(projectDir, "project", styles);
  }

  cache = styles;
  cacheKey = key;
  return styles;
}

async function loadFromDir(dir, source, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = parseStyleFrontmatter(content);
      if (!parsed.name) {
        console.warn(`output-style-loader: skipping ${filePath}: missing name in frontmatter`);
        continue;
      }
      // Remove bundled style with same name (user/project override)
      const idx = out.findIndex((s) => s.name === parsed.name && s.source === "bundled");
      if (idx >= 0) out.splice(idx, 1);
      out.push({
        name: parsed.name,
        description: parsed.description ?? "",
        body: parsed.body,
        source,
        filePath,
      });
    } catch (e) {
      console.warn(`output-style-loader: failed to load ${filePath}: ${e.message}`);
    }
  }
}

function parseStyleFrontmatter(content) {
  // 简易 frontmatter 解析:第一段 --- ... --- 之间的 YAML
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { name: null, description: "", body: content };
  const yamlPart = match[1];
  const body = match[2] ?? "";
  const result = { name: null, description: "", body };
  for (const line of yamlPart.split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, valueRaw] = m;
    const value = valueRaw.replace(/^["']|["']$/g, "").trim();
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
  }
  return result;
}

export function _resetOutputStyleCache() {
  cache = null;
  cacheKey = null;
}

export function listBuiltInStyleNames() {
  return BUNDLED_STYLES.map((s) => s.name);
}
