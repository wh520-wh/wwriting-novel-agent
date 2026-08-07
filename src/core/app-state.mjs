import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { workspaceIdForPath } from "./workspaces/store.mjs";

const STATE_FILE = "app-state.json";
const MAX_RECENTS = 12;

function stateFile(stateRoot) {
  return path.join(path.resolve(stateRoot), STATE_FILE);
}

function normalizeState(parsed) {
  const recentProjects = Array.isArray(parsed?.recentProjects)
    ? parsed.recentProjects
        .filter((item) => item && typeof item.projectRoot === "string")
        .map((item) => ({
          projectRoot: path.resolve(item.projectRoot),
          // 旧 app-state.json 没有 workspace_id：按路径补齐稳定 id；已有则保留。
          workspace_id: typeof item.workspace_id === "string"
            ? item.workspace_id
            : workspaceIdForPath(item.projectRoot),
          title: typeof item.title === "string" ? item.title : path.basename(item.projectRoot),
          story_seed: typeof item.story_seed === "string" ? item.story_seed : "",
          openedAt: typeof item.openedAt === "string" ? item.openedAt : null
        }))
    : [];
  return {
    lastProjectRoot: typeof parsed?.lastProjectRoot === "string" ? path.resolve(parsed.lastProjectRoot) : null,
    recentProjects
  };
}

export function loadAppStateSync(stateRoot) {
  try {
    const raw = fs.readFileSync(stateFile(stateRoot), "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    warnStateReadFailure(error);
    return { lastProjectRoot: null, recentProjects: [] };
  }
}

export async function loadAppState(stateRoot) {
  try {
    const raw = await fsp.readFile(stateFile(stateRoot), "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    warnStateReadFailure(error);
    return { lastProjectRoot: null, recentProjects: [] };
  }
}

export async function saveAppState(stateRoot, state) {
  const root = path.resolve(stateRoot);
  await fsp.mkdir(root, { recursive: true });
  const normalized = normalizeState(state);
  await fsp.writeFile(stateFile(root), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function recordRecentProject(stateRoot, project) {
  if (!project || typeof project.projectRoot !== "string" || project.projectRoot.trim().length === 0) {
    return loadAppState(stateRoot);
  }
  const resolvedRoot = path.resolve(project.projectRoot);
  const state = await loadAppState(stateRoot);
  const entry = {
    projectRoot: resolvedRoot,
    workspace_id: workspaceIdForPath(resolvedRoot),
    title: typeof project.title === "string" && project.title.trim() ? project.title : path.basename(resolvedRoot),
    story_seed: typeof project.story_seed === "string" ? project.story_seed : "",
    openedAt: new Date().toISOString()
  };
  const existingIndex = state.recentProjects.findIndex((item) => samePath(item.projectRoot, resolvedRoot));
  let recentProjects;
  if (existingIndex >= 0) {
    // 已有项目：原地更新标题/种子/openedAt，不挪动位置——避免每次点击都把项目顶到最上。
    recentProjects = state.recentProjects.slice();
    recentProjects[existingIndex] = { ...recentProjects[existingIndex], ...entry };
  } else {
    // 新项目：放到最前，超出 MAX_RECENTS 裁掉队尾最旧的。
    recentProjects = [entry, ...state.recentProjects].slice(0, MAX_RECENTS);
  }
  return saveAppState(stateRoot, { lastProjectRoot: resolvedRoot, recentProjects });
}

export async function forgetRecentProject(stateRoot, projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const state = await loadAppState(stateRoot);
  const recentProjects = state.recentProjects.filter((item) => !samePath(item.projectRoot, resolvedRoot));
  const lastProjectRoot = samePath(state.lastProjectRoot, resolvedRoot)
    ? recentProjects[0]?.projectRoot ?? null
    : state.lastProjectRoot;
  return saveAppState(stateRoot, { lastProjectRoot, recentProjects });
}

export function samePath(a, b) {
  if (!a || !b) {
    return false;
  }
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function warnStateReadFailure(error) {
  if (error?.code === "ENOENT") {
    return;
  }
  console.warn("[app-state] 读取状态失败:", error?.message ?? error);
}
