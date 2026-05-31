import { safeJoin, sha256, writeJsonAtomic } from "./fs-utils.mjs";

export class CacheKeyManager {
  constructor(state = {}) {
    this.state = {
      entries: {},
      ...state
    };
  }

  update({ projectId = "default", templateVersion = "prompt.v1", stableHash, stableBlocks = null } = {}) {
    const resolvedStableHash = stableHash ?? sha256(JSON.stringify(stableBlocks ?? []));
    const entryKey = `${projectId}:${templateVersion}`;
    const previous = this.state.entries[entryKey];
    const stableChanged = Boolean(previous && previous.stableHash !== resolvedStableHash);
    const cacheVersion = stableChanged ? previous.cacheVersion + 1 : previous?.cacheVersion ?? 1;
    const entry = {
      projectId,
      templateVersion,
      stableHash: resolvedStableHash,
      previousStableHash: previous?.stableHash ?? null,
      stableChanged,
      stableChangedReason: previous ? (stableChanged ? "stable_hash_changed" : null) : "first_call",
      cacheVersion,
      cacheKey: `${projectId}:${templateVersion}:v${cacheVersion}:${resolvedStableHash.replace(/^sha256:/u, "").slice(0, 16)}`
    };
    this.state.entries[entryKey] = entry;
    return { ...entry };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
}

export async function writeCacheReport(projectRoot, { manager, cacheEntry, compiledPrompt, usageReport, modelConfig } = {}) {
  const report = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    entries: manager?.snapshot?.().entries ?? {},
    last_call: cacheEntry
      ? {
          provider: modelConfig?.provider ?? null,
          model: modelConfig?.model_name ?? null,
          templateVersion: cacheEntry.templateVersion,
          stableHash: cacheEntry.stableHash,
          dynamicHash: compiledPrompt?.dynamicHash ?? null,
          cacheVersion: cacheEntry.cacheVersion,
          cacheKey: cacheEntry.cacheKey,
          promptBlockHashes: compiledPrompt?.blockHashes ?? {},
          promptBlocks: Array.isArray(compiledPrompt?.blocks)
            ? compiledPrompt.blocks.map((block) => ({
                name: block.name,
                kind: block.kind,
                hash: block.hash
              }))
            : [],
          stableChanged: cacheEntry.stableChanged ?? false,
          stableChangedReason: cacheEntry.stableChangedReason ?? null,
          previousStableHash: cacheEntry.previousStableHash ?? null,
          cacheMetricsAvailable: usageReport?.cacheMetricsAvailable ?? false,
          cacheHitRate: usageReport?.cacheHitRate ?? null,
          cachedTokens: usageReport?.cachedTokens ?? 0,
          cacheHitTokens: usageReport?.cacheHitTokens ?? 0
        }
      : null
  };
  await writeJsonAtomic(safeJoin(projectRoot, "cache_report.json"), report);
  return report;
}
