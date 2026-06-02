// 共享 helpers for command definitions
// 不引 zod,手写最小校验

export const ALLOWED_CATEGORIES = new Set([
  "writing",
  "editing",
  "review",
  "research",
  "project",
]);

export function assertValidCategory(category) {
  if (!ALLOWED_CATEGORIES.has(category)) {
    throw new Error(
      `Invalid command category: ${category}. Must be one of: ${[...ALLOWED_CATEGORIES].join(", ")}`
    );
  }
}

export function hasActiveProject(ctx) {
  if (!ctx) return false;
  if (typeof ctx.getCurrentProjectRoot === "function") {
    return ctx.getCurrentProjectRoot() != null;
  }
  return false;
}
