// 工作区私有存储：把一个创作目录映射到应用私有数据下的固定布局。
// 铁律：应用私有数据（workspace.json / sessions / locks / config）绝不进入创作目录；
// Windows 路径大小写不敏感，同一 Windows 路径不同大小写必须得到同一 workspace ID。
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 解析应用私有数据根：优先 APPDATA 环境变量，缺失时回退到用户目录下的 AppData/Roaming。
export function resolveAppDataRoot(env = process.env, homedir = os.homedir()) {
  const appData = typeof env.APPDATA === 'string' ? env.APPDATA.trim() : '';
  if (appData !== '') return appData;
  return path.join(homedir, 'AppData', 'Roaming');
}

// 项目根路径校验：空路径静默落到 cwd 是 bug 之源，直接报中文错误。
function assertProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error('工作区路径不能为空，请用 --cwd 指定创作目录。');
  }
}

// 规范化工作区路径：绝对化；Windows 下再统一小写，保证大小写变体映射到同一身份。
export function canonicalWorkspacePath(projectRoot) {
  assertProjectRoot(projectRoot);
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// 工作区 ID：ws_ + 规范化路径 SHA-256 的前 32 个十六进制字符。
export function workspaceIdForPath(projectRoot) {
  const canonical = canonicalWorkspacePath(projectRoot);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `ws_${digest.slice(0, 32)}`;
}

// 工作区私有目录布局（固定）：
//   <appDataRoot>/WWriting/config.json
//   <appDataRoot>/WWriting/workspaces/<workspace-id>/workspace.json
//   <appDataRoot>/WWriting/workspaces/<workspace-id>/sessions/
//   <appDataRoot>/WWriting/workspaces/<workspace-id>/locks/
// appDataRoot 可注入（测试用临时目录）；默认取 APPDATA，缺失时回退用户目录。
// clock 可注入，返回毫秒时间戳，用于 workspace.json 的 created_at。
export function createWorkspaceStore({ appDataRoot = resolveAppDataRoot(), clock = Date.now } = {}) {
  const wwritingRoot = path.join(appDataRoot, 'WWriting');
  const workspacesRoot = path.join(wwritingRoot, 'workspaces');

  // 目录类型：workspace（含 workspace.json 的根）、sessions、locks。
  const KIND_SUBDIRS = { workspace: '', sessions: 'sessions', locks: 'locks' };

  // 纯计算，不落盘。未知类型抛中文错误。
  function directoryFor(projectRoot, kind = 'workspace') {
    if (!(kind in KIND_SUBDIRS)) {
      throw new Error(`未知的工作区目录类型：${kind}`);
    }
    const sub = KIND_SUBDIRS[kind];
    const workspaceDir = path.join(workspacesRoot, workspaceIdForPath(projectRoot));
    return sub === '' ? workspaceDir : path.join(workspaceDir, sub);
  }

  function sessionsRoot(projectRoot) {
    return directoryFor(projectRoot, 'sessions');
  }

  // 建立该创作目录的私有布局；幂等，绝不覆盖已有 workspace.json。
  // 返回 { workspaceId, workspaceDir, created }；created 表示本次是否新建了 workspace.json。
  async function ensure(projectRoot) {
    assertProjectRoot(projectRoot);
    const workspaceId = workspaceIdForPath(projectRoot);
    const workspaceDir = directoryFor(projectRoot, 'workspace');
    try {
      await mkdir(path.join(workspaceDir, 'sessions'), { recursive: true });
      await mkdir(path.join(workspaceDir, 'locks'), { recursive: true });
    } catch (error) {
      throw new Error(`无法创建工作区私有目录：${workspaceDir}`, { cause: error });
    }

    let created = false;
    const workspaceJson = path.join(workspaceDir, 'workspace.json');
    const config = {
      workspace_id: workspaceId,
      root: canonicalWorkspacePath(projectRoot),
      created_at: new Date(clock()).toISOString(),
    };
    try {
      // flag 'wx'：已存在时不写入，避免并发与重复 ensure 覆盖手工内容。
      await writeFile(workspaceJson, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new Error(`无法写入工作区描述文件：${workspaceJson}`, { cause: error });
      }
    }
    return { workspaceId, workspaceDir, created };
  }

  return { ensure, directoryFor, configPath: path.join(wwritingRoot, 'config.json'), sessionsRoot };
}
