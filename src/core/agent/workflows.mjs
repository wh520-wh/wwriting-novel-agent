// src/core/agent/workflows.mjs —— 工作流政策（统一 Agent 内核计划 Task 6）。
//
// 深模块内部实现：四种工作流政策（general/chapter/init/review）集中在这里，
// 供 runtime 装配 prompt 时选择层文本、过滤允许的深工具、选择 dynamic context
// 并判断 Run 是否可终结。workflow 只能通过 enter_workflow 工具改变（workflow_changed
// 事件由 tools.mjs 的该工具写入 journal）；本模块不提供任何直接改工作流的 API。
//
// 嵌套拒绝规则（canEnterWorkflow）：
//   - 从 general 可以进入任意工作流；
//   - 从任意工作流可以回到 general；
//   - review 政策文本明确允许"回到 general 或 chapter 后执行修复"，
//     因此 review → chapter 是唯一被认可的深→深修复路径；
//   - 其余深→深切换（chapter→init、init→chapter、chapter→review 等）一律拒绝，
//     同一工作流内的空切换（含 general→general）同样拒绝。
//
// 每个政策记录固定形状：
//   promptId            —— 对应 prompt.mjs WORKFLOW_POLICIES 的键（层文本选择）
//   allowedDeepTools    —— 该工作流下允许暴露给模型的深工具名（general 六工具恒可用）
//   contextSelector     —— (ctx) -> Promise<[{ source, content }]> 动态上下文选择
//   completionEvaluator —— (ctx) -> boolean 该工作流下 Run 是否可终结
import { inspectChapterContext } from "../project-operations/chapter.mjs";

export const WORKFLOW_NAMES = Object.freeze(["general", "chapter", "init", "review"]);

// 中文章节号解析：支持阿拉伯数字与常见中文数字（一~九十九）。
const CN_DIGITS = Object.freeze({
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9
});
const CN_SINGLE_RE = /^[一二三四五六七八九]$/u;

export function parseChapterNoFromText(text) {
  const match = /第\s*([0-9]+|[一二三四五六七八九十]+)\s*章/u.exec(String(text ?? ""));
  if (!match) return null;
  const raw = match[1];
  if (/^[0-9]+$/u.test(raw)) {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 ? value : null;
  }
  if (raw === "十") return 10;
  const tens = /^([一二三四五六七八九])?十(?:([一二三四五六七八九]))?$/u.exec(raw);
  if (tens) return (tens[1] ? CN_DIGITS[tens[1]] : 1) * 10 + (tens[2] ? CN_DIGITS[tens[2]] : 0);
  if (CN_SINGLE_RE.test(raw)) return CN_DIGITS[raw];
  return null;
}

// 当前输入文本是否提到目标章节（chapter 工作流的上下文选择器用）。
// 无法解析时返回 null（不注入任何动态上下文，不打断模型自主读取）。
async function selectChapterContext({ projectRoot, inputText }) {
  const chapterNo = parseChapterNoFromText(inputText);
  if (chapterNo === null) return [];
  try {
    const context = await inspectChapterContext({ projectRoot, chapterNo });
    return [
      {
        source: "chapter-context",
        content: JSON.stringify(
          {
            requested_chapter_no: chapterNo,
            status: context.status,
            is_committed: context.is_committed,
            actual_words: context.actual_words,
            draft_exists: context.draft_exists,
            final_exists: context.final_exists,
            completed_chapter_nos: context.completed_chapter_nos,
            next_chapter_no: context.next_chapter_no
          },
          null,
          2
        )
      }
    ];
  } catch {
    return [];
  }
}

// 完成条件求值：模型以文本结束当前输入（无工具调用）且队列清空后 Run 终结。
// 当前各工作流共享同一宽松判定——正式完成不变量（字数/质量/连续性门禁、章节索引
// 与 checkpoint 一致更新）由 project operations 的提交事务守护，政策文本也已要求
// 模型在未满足条件时不得声称完成。completionEvaluator 作为政策字段保留，供未来
// 按工作流收紧终结条件（例如 chapter 要求最近一次 commit 成功才允许终结）；
// 收紧时注意不要让 mock/真实模型在脚本耗尽时无限循环（当前宽松判定避免该风险）。
function defaultCompletionEvaluator() {
  return true;
}

export const WORKFLOW_POLICY_RECORDS = Object.freeze({
  general: Object.freeze({
    promptId: "general",
    allowedDeepTools: Object.freeze(["update_plan", "enter_workflow"]),
    contextSelector: async () => [],
    completionEvaluator: defaultCompletionEvaluator
  }),

  chapter: Object.freeze({
    promptId: "chapter",
    allowedDeepTools: Object.freeze(["update_plan", "enter_workflow", "append_chapter_segment", "commit_chapter"]),
    contextSelector: selectChapterContext,
    completionEvaluator: defaultCompletionEvaluator
  }),

  init: Object.freeze({
    promptId: "init",
    allowedDeepTools: Object.freeze(["update_plan", "enter_workflow", "commit_blueprint"]),
    // init 政策要求模型自主决定读取顺序，不预先注入项目文件内容
    contextSelector: async () => [],
    completionEvaluator: defaultCompletionEvaluator
  }),

  review: Object.freeze({
    promptId: "review",
    allowedDeepTools: Object.freeze(["update_plan", "enter_workflow"]),
    contextSelector: async () => [],
    completionEvaluator: defaultCompletionEvaluator
  })
});

export function workflowPolicy(workflowName) {
  return WORKFLOW_POLICY_RECORDS[workflowName] ?? WORKFLOW_POLICY_RECORDS.general;
}

// 嵌套拒绝（见文件头规则）。current/target 均为 WORKFLOW_NAMES 之一。
export function canEnterWorkflow(current, target) {
  if (current === target) return false; // 空切换
  if (current === "general") return true;
  if (target === "general") return true;
  return current === "review" && target === "chapter"; // 政策文本认可的修复路径
}
