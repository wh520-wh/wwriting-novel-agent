// 任务计划工具：模型把「这一轮要做的多步任务」整表替换成一份可见的计划（P10 的终端形态）。
//
// 契约对齐上游统一行为规格书 §4.2/§4.9 的「任务计划」条：
//   - **整表替换**：每次调用都给出完整步骤列表，被省略的步骤立即消失——不是增量合并；
//   - 计划是应用私有状态（事件日志），不进创作目录（铁律 8），不需要用户确认（无副作用）；
//   - 终端的「回看态」就是 scrollback：每次更新把最新整表落进 scrollback，
//     /plan 随时可再看当前一份（对齐上游「Run 结束保留供回看」）。
//
// 本模块只做校验与归一；事件落盘（plan_updated）与展示（printPlan）分别在
// agent-loop 与 renderer，各归其位。

// 工具错误：message 是一条中文事实，code 供调用方判断（铁律 3）。
export class PlanToolError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'PlanToolError';
    this.code = code;
    this.details = details;
  }
}

export const PLAN_STATUSES = Object.freeze(['pending', 'in_progress', 'completed']);

// 步骤数量与文案长度都设上限：计划是给人扫一眼的，不是第二份正文。
const MAX_PLAN_STEPS = 30;
const MAX_STEP_CHARS = 200;

// update_plan({ steps }) → { plan, total, done }。
// steps 每项 { summary, status? }；status 缺省 pending。
// 校验只拦「没法展示」的输入（空、非数组、缺 summary、未知 status），
// 不做「只能一个 in_progress」这类语义约束——那是模型的判断，不是格式的对错。
export function updatePlan({ steps } = {}) {
  if (!Array.isArray(steps)) {
    throw new PlanToolError('任务计划需要一组步骤。', 'TOOL_PLAN_STEPS_INVALID', { received: typeof steps });
  }
  if (steps.length > MAX_PLAN_STEPS) {
    throw new PlanToolError(`任务计划的步骤不能超过 ${MAX_PLAN_STEPS} 个。`, 'TOOL_PLAN_TOO_MANY_STEPS', {
      count: steps.length,
    });
  }
  const plan = steps.map((step, index) => {
    const summary = typeof step?.summary === 'string' ? step.summary.trim() : '';
    if (summary === '') {
      throw new PlanToolError(`第 ${index + 1} 个步骤缺少说明。`, 'TOOL_PLAN_STEP_INVALID', { index });
    }
    const status = step?.status === undefined || step?.status === null ? 'pending' : step.status;
    if (!PLAN_STATUSES.includes(status)) {
      throw new PlanToolError(`第 ${index + 1} 个步骤的状态不认识。`, 'TOOL_PLAN_STEP_INVALID', {
        index,
        status,
      });
    }
    return { summary: summary.slice(0, MAX_STEP_CHARS), status };
  });
  const done = plan.reduce((count, item) => (item.status === 'completed' ? count + 1 : count), 0);
  return { plan, total: plan.length, done };
}
