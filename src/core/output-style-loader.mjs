import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSimpleYaml } from "./simple-yaml.mjs";

// 内置 1 种风格(bundled 优先级最低,用户/项目同名会替换)。
// Task 10：review output style 已删除（审稿改由自然语言驱动模型完成），
// 不得仅改文案保留同一模式。
const BUNDLED_STYLES = [
  {
    name: "creative",
    description: "创作模式:长跑章节生成,强调氛围、人物心理、节奏",
    body: "你正在创作长篇小说。当前目标是写出有沉浸感、人物驱动的章节。\n- 优先呈现人物心理和情绪变化\n- 对话要符合角色设定和场景氛围\n- 每章结尾保留悬念或转折钩子",
    source: "bundled",
  },
];

export async function loadOutputStyles({ projectRoot, userHome } = {}) {
  const styles = [...BUNDLED_STYLES];

  if (userHome) {
    await loadFromDir(path.join(userHome, ".wwriting", "output-styles"), "user", styles);
  }
  if (projectRoot) {
    await loadFromDir(path.join(projectRoot, ".wwriting", "output-styles"), "project", styles);
  }

  return styles;
}

async function loadFromDir(dir, source, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = parseStyleFile(content);
      if (!parsed.name) {
        console.warn(`output-style-loader: skipping ${filePath}: missing name in frontmatter`);
        continue;
      }
      // User/project override a bundled style of the same name.
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

function parseStyleFile(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: null, description: "", body: content };
  const meta = parseSimpleYaml(match[1]);
  return {
    name: typeof meta.name === "string" ? meta.name : null,
    description: typeof meta.description === "string" ? meta.description : "",
    body: match[2] ?? "",
  };
}
