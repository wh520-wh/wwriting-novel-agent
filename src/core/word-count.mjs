export function stripMarkdown(source) {
  return String(source ?? "")
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^\s{0,3}#{1,6}\s+.*$/gmu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/[*_`>#|[\](){}~-]/gu, " ");
}

export function countEffectiveWords(source) {
  const visible = stripMarkdown(source);
  const han = visible.match(/\p{Script=Han}/gu) ?? [];
  const withoutHan = visible.replace(/\p{Script=Han}/gu, " ");
  const latin = withoutHan.match(/[A-Za-z]+(?:'[A-Za-z]+)?/gu) ?? [];
  const numbers = withoutHan.match(/\d+/gu) ?? [];
  return han.length + latin.length + numbers.length;
}
