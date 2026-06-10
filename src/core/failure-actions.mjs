import { appendEvent } from "./event-log.mjs";
import { loadProject, loadState, saveState } from "./project-store.mjs";
import { updateProjectSettings } from "./settings-runtime.mjs";

// 把故障卡上的用户决定落成真实副作用。
// 返回 { resumeRun, message }：resumeRun=true 表示调用方（app-server）应在没有运行中任务时自动续跑。

export async function applyFailureResolution(projectRoot, { command, args = {} } = {}) {
  switch (command) {
    case "pause-here":
    case "manual-review-handoff":
      return { resumeRun: false, message: "已停在当前位置，等待你手动处理。" };

    case "retry-segment": {
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: "已从当前段重试。" };
    }

    case "retry-with-prompt": {
      const prompt = String(args.prompt ?? "").trim();
      if (prompt) {
        await appendUserInstruction(projectRoot, prompt, command, args);
      }
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: "已按新提示词重试。" };
    }

    case "fill-words": {
      await appendUserInstruction(
        projectRoot,
        `请在不重写全章的前提下补写约 ${args.targetWords} 字，加强当前章节内容；系统会重新统计字数。`,
        command,
        args
      );
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: `已安排补写约 ${args.targetWords} 字。` };
    }

    case "accept-current-words":
    case "skip-segment":
    case "accept-review-current": {
      const state = await loadState(projectRoot);
      const next = resumeableState(state);
      if (["reviewing", "needs_revision", "revising"].includes(next.current_stage)) {
        next.current_stage = "finalizing";
        next.stage_entered_at = new Date().toISOString();
      }
      await saveState(projectRoot, next);
      await appendEvent(projectRoot, {
        type: "quality_gate_overridden",
        chapter_no: next.current_chapter_no ?? null,
        stage: next.current_stage,
        severity: "warn",
        message: command,
        data: { command }
      });
      return { resumeRun: true, message: "已接受当前稿，继续后续流程。" };
    }

    case "apply-review-suggestions": {
      const state = await loadState(projectRoot);
      const next = resumeableState(state);
      if (next.current_stage === "reviewing") {
        next.current_stage = "needs_revision";
        next.stage_entered_at = new Date().toISOString();
      }
      await saveState(projectRoot, next);
      return { resumeRun: true, message: "已安排按审稿建议修订。" };
    }

    case "raise-budget": {
      await updateProjectSettings(projectRoot, {
        budget_config: { max_model_calls: args.newMaxModelCalls }
      });
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: `预算已提高到 ${args.newMaxModelCalls}，继续写作。` };
    }

    case "switch-model": {
      const project = await loadProject(projectRoot);
      await updateProjectSettings(projectRoot, {
        active_model: { ...(project.active_model ?? { provider: "mock" }), model_name: args.modelId }
      });
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: `已切换模型到 ${args.modelId}，继续写作。` };
    }

    default:
      return { resumeRun: false, message: "已记录你的选择。" };
  }
}

async function appendUserInstruction(projectRoot, message, command, args) {
  await appendEvent(projectRoot, {
    type: "user_instruction_received",
    stage: "user_input",
    message,
    data: { source: "failure_card", command, args }
  });
}

async function saveResumeableState(projectRoot) {
  const state = await loadState(projectRoot);
  await saveState(projectRoot, resumeableState(state));
}

// 把 blocked/interrupted/cancelled 状态还原成可续跑状态；其他状态原样返回。
function resumeableState(state) {
  const next = { ...state };
  if (next.current_stage === "blocked") {
    next.current_stage =
      next.blocked_at_stage && next.blocked_at_stage !== "blocked" ? next.blocked_at_stage : "queued";
    next.stage_entered_at = new Date().toISOString();
  }
  if (["blocked", "interrupted", "cancelled", "paused"].includes(next.project_status)) {
    next.project_status = "idle";
  }
  delete next.blocked_reason;
  delete next.blocked_at;
  delete next.blocked_data;
  delete next.blocked_at_stage;
  delete next.interrupted_reason;
  delete next.interrupted_at;
  delete next.cancelled_reason;
  delete next.cancelled_at;
  delete next.paused_at;
  return next;
}
