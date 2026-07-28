export const PROJECT_THEME_KEYS = Object.freeze([
  "tide",
  "ink",
  "verdant",
  "ember",
  "violet",
]);

function normalizedText(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ");
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const char of Array.from(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function deriveProjectIdentity(input = {}) {
  const project = input.project ?? {};
  const storySeed = normalizedText(project.story_seed);
  const projectRoot = normalizedText(input.projectRoot);
  const rawTitle = normalizedText(project.title);
  if (!rawTitle && !storySeed && !projectRoot) {
    return {
      theme: PROJECT_THEME_KEYS[0],
      monogram: "W",
      title: "未命名小说",
      ariaLabel: "未命名小说的作品封面",
      seed: 0,
    };
  }
  const title = rawTitle || "未命名小说";
  const seed = stableHash(`${title}\u0000${storySeed}\u0000${projectRoot}`);

  return {
    theme: PROJECT_THEME_KEYS[seed % PROJECT_THEME_KEYS.length],
    monogram: Array.from(rawTitle)[0] ?? "W",
    title,
    ariaLabel: `${title}的作品封面`,
    seed,
  };
}
