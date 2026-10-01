// 权限分级与授权生命周期（铁律 4）：
//   read    自动放行，不弹确认；
//   write   默认确认，可选「一次允许 / 本条输入允许同类操作 / 拒绝」，YOLO 可跳过；
//   extreme 删除、项目外访问、清空会话数据——必须输入当次显示的精确确认文字，
//           YOLO 与模型都不得代填，也没有任何普通授权可以绕过。
// 授权作用域只有一条规则：「本条输入允许同类操作」只绑定当前 input_id，
// 输入切换、Run 结束、停止都要清空。
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 权限错误：code 供调用方判断，message 是一条中文事实。
export class PermissionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'PermissionError';
    this.code = code;
    this.details = details;
  }
}

export const READ_TOOLS = Object.freeze([
  'list_files',
  'read_file',
  'search_files',
  'count_text',
  'read_skill',
  // update_plan 只写应用私有的计划状态（事件日志），不碰创作目录——与读取同级，自动放行。
  'update_plan',
  // 章节提交只写应用私有的版本库与前情账本，不改创作文件——同样自动放行（回滚才会动文件，在 write 侧）。
  'commit_chapter',
  'read_continuity',
  'style_stats',
]);
export const WRITE_TOOLS = Object.freeze([
  'write_file',
  'edit_file',
  // 追加正文与回滚章节都会改写创作目录里的文件——与写入同级，需要确认。
  'append_chapter_segment',
  'rollback_chapter',
]);
export const EXTREME_TOOLS = Object.freeze([
  'delete_file',
  'delete_dir',
  'clear_session',
  'clear_history',
  'reset_session',
  'run_command',
]);

const CHOICES = Object.freeze({
  write: Object.freeze(['once', 'input', 'deny']),
  extreme: Object.freeze(['confirm', 'deny']),
});

// 极端确认文字的动词：只影响用户看到的那句话，不影响判定。
const CONFIRM_VERBS = Object.freeze({
  delete_file: '删除',
  delete_dir: '删除',
  clear_session: '清空',
  clear_history: '清空',
  reset_session: '清空',
});

// 工具名归一：模型可能给出 writeFile / write-file，统一成 write_file 再比对。
function normalizeToolName(tool) {
  if (typeof tool !== 'string') return '';
  return tool
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

// 路径包含判定：Windows 大小写不敏感，比较前统一小写。
// 这是安全判定，全局只有这一份：文件工具 import 它，绝不各写一份。
export function isInside(root, child) {
  const compare = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const relative = path.relative(compare(root), compare(child));
  if (relative === '') return true;
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(relative);
}

// 项目外访问一律算极端操作：连读取都不例外。
function isOutsideProject(target, projectRoot) {
  if (typeof target !== 'string' || target.trim() === '') return false;
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') return true;
  return !isInside(path.resolve(projectRoot), path.resolve(projectRoot, target));
}

export function classifyOperation({ tool, target, projectRoot } = {}) {
  if (isOutsideProject(target, projectRoot)) return 'extreme';
  const name = normalizeToolName(tool);
  if (EXTREME_TOOLS.includes(name)) return 'extreme';
  if (READ_TOOLS.includes(name)) return 'read';
  if (WRITE_TOOLS.includes(name)) return 'write';
  // 未知工具收紧为极端：宁可多问一次，也不默认放行。
  return 'extreme';
}

// 当次确认文字：由权限层自己生成，带随机 token，模型与 YOLO 都没有入口指定它。
function makeConfirmationText(tool, idFactory) {
  const verb = CONFIRM_VERBS[normalizeToolName(tool)] ?? '执行';
  const token = String(idFactory()).replace(/[^0-9a-z]/gi, '').slice(0, 6).toLowerCase();
  return `确认${verb} ${token === '' ? '000000' : token}`;
}

export function createPermissionState({ yolo = false, clock = Date.now, idFactory = randomUUID } = {}) {
  let yoloMode = Boolean(yolo);
  let inputId = null;
  const grants = new Set(); // 只存 write 级的「同类操作」授权，key 为 write:<tool>
  const decisions = new Map(); // decision_id -> decision（含已作废/已处理，用于给出准确的失效原因）

  function settle(decision, { allowed, choice = null, reason = null }) {
    decision.status = 'done';
    decision.resolve({
      allowed,
      level: decision.level,
      decisionId: decision.decision_id,
      choice,
      reason,
    });
  }

  // 作废所有待确认：Run 结束、停止、输入切换都走这里，绝不留下可继续执行的确认。
  function cancelPending(reason) {
    for (const decision of decisions.values()) {
      if (decision.status === 'pending') settle(decision, { allowed: false, reason });
    }
  }

  function beginInput({ inputId: nextInputId = null, yolo: nextYolo } = {}) {
    // 先清掉更早一代的作废记录，再作废当前这批：这一代留着，好在误答时说出「属于上一条输入」。
    for (const [id, decision] of decisions) {
      if (decision.status !== 'pending') decisions.delete(id);
    }
    cancelPending('input_changed');
    grants.clear();
    inputId = nextInputId;
    if (typeof nextYolo === 'boolean') yoloMode = nextYolo;
    return { inputId };
  }

  function clearInput() {
    cancelPending('cancelled');
    grants.clear();
    inputId = null;
  }

  function isYolo() {
    return yoloMode;
  }

  function setYolo(value) {
    yoloMode = Boolean(value);
    return yoloMode;
  }

  // 同类授权只认当前输入：换一条输入、清空、或者查询别的 input_id 都拿不到授权。
  function grantFor({ inputId: requested = null, tool } = {}) {
    if (requested !== null && requested !== undefined && requested !== inputId) return false;
    return grants.has(`write:${normalizeToolName(tool)}`);
  }

  function pending() {
    const list = [];
    for (const decision of decisions.values()) {
      if (decision.status !== 'pending') continue;
      list.push({
        decision_id: decision.decision_id,
        input_id: decision.input_id,
        level: decision.level,
        tool: decision.tool,
        target: decision.target ?? null,
        choices: decision.choices,
        confirmation_text: decision.confirmation_text ?? null,
        created_at: decision.created_at,
      });
    }
    return list;
  }

  function createDecision({ tool, target, level }) {
    const decisionId = `dec_${String(idFactory())}`;
    const decision = {
      decision_id: decisionId,
      input_id: inputId,
      level,
      tool,
      target: target ?? null,
      choices: CHOICES[level],
      confirmation_text: level === 'extreme' ? makeConfirmationText(tool, idFactory) : null,
      created_at: new Date(clock()).toISOString(),
      status: 'pending',
      resolve: null,
    };
    const promise = new Promise((resolve) => {
      decision.resolve = resolve;
    });
    decisions.set(decisionId, decision);
    return { decision, promise };
  }

  async function request({ inputId: requestedInputId, tool, target, projectRoot } = {}) {
    // 输入切换即失效：只要 request 带来的 input_id 与当前不同，就按新输入重置。
    if (requestedInputId !== undefined && requestedInputId !== null && requestedInputId !== inputId) {
      beginInput({ inputId: requestedInputId });
    }
    const level = classifyOperation({ tool, target, projectRoot });

    if (level === 'read') {
      return { allowed: true, level, decisionId: null, choice: null, reason: 'auto' };
    }
    if (level === 'write') {
      if (grantFor({ tool })) return { allowed: true, level, decisionId: null, choice: null, reason: 'granted' };
      // YOLO 只跳过普通确认；extreme 分支根本走不到这里。
      if (yoloMode) return { allowed: true, level, decisionId: null, choice: null, reason: 'yolo' };
    }

    const { decision, promise } = createDecision({ tool, target, level });
    return promise;
  }

  function decide({ decisionId, choice, text } = {}) {
    const decision = decisions.get(decisionId);
    if (!decision) {
      throw new PermissionError('这条确认已经失效，请重新执行该操作。', 'PERMISSION_DECISION_NOT_FOUND', {
        decisionId,
      });
    }
    if (decision.input_id !== inputId) {
      throw new PermissionError('这条确认属于上一条输入，已经失效。', 'PERMISSION_DECISION_EXPIRED', {
        decisionId,
        decisionInputId: decision.input_id,
      });
    }
    if (decision.status !== 'pending') {
      throw new PermissionError('这条确认已经处理过了。', 'PERMISSION_DECISION_CLOSED', { decisionId });
    }

    if (decision.level === 'extreme') {
      if (choice === 'deny') {
        settle(decision, { allowed: false, choice: 'deny' });
        return { decisionId, choice: 'deny', allowed: false };
      }
      if (choice !== 'confirm') {
        throw new PermissionError('极端操作只能输入确认文字或拒绝。', 'PERMISSION_INVALID_CHOICE', {
          decisionId,
          choice,
          expected: CHOICES.extreme,
        });
      }
      // 精确确认：完全相等才算数，不 trim、不折大小写、不忽略空白。
      if (text !== decision.confirmation_text) {
        throw new PermissionError('确认文字不一致，请照提示原文输入。', 'PERMISSION_CONFIRMATION_MISMATCH', {
          decisionId,
        });
      }
      settle(decision, { allowed: true, choice: 'confirm', reason: 'confirmed' });
      return { decisionId, choice: 'confirm', allowed: true };
    }

    if (choice === 'once') {
      settle(decision, { allowed: true, choice: 'once' });
      return { decisionId, choice: 'once', allowed: true };
    }
    if (choice === 'input') {
      grants.add(`write:${normalizeToolName(decision.tool)}`);
      settle(decision, { allowed: true, choice: 'input' });
      return { decisionId, choice: 'input', allowed: true };
    }
    if (choice === 'deny') {
      settle(decision, { allowed: false, choice: 'deny' });
      return { decisionId, choice: 'deny', allowed: false };
    }
    throw new PermissionError('不支持的确认选项。', 'PERMISSION_INVALID_CHOICE', {
      decisionId,
      choice,
      expected: CHOICES.write,
    });
  }

  return { beginInput, request, decide, grantFor, clearInput, isYolo, setYolo, pending };
}
