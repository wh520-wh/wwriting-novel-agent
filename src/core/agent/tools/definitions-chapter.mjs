// src/core/agent/tools/definitions-chapter.mjs —— 章节域五个深工具注册定义（第十五轮 Task 5 拆分）。
//
// 承接原 tools.mjs 的 update_plan / append_chapter_segment / commit_chapter /
// finalize_revision / rollback_chapter 注册体（机械平移，逻辑不动）。依赖全部经 h
// 注入：deepAction/toolError/requireStringArg/requirePositiveIntArg/appendEvent/
// redactor/PLAN_STATUSES 与 projectOperations（Task 5 创建的注入依赖，未接线时
// 抛「工具不可用。」technical.not_wired）。
export function chapterToolDefinitions(h) {
  const {
    deepAction, toolError, requireStringArg, requirePositiveIntArg,
    appendEvent, redactor, PLAN_STATUSES, projectOperations
  } = h;
  return {
    update_plan: {
      interruptible: false,
      description: "更新当前任务的可见执行计划（全量替换整表）。每项需稳定 id；状态只允许 pending/in_progress/completed，最多一个 in_progress。",
      schema: {
        type: "object",
        properties: {
          explanation: { type: "string", description: "可选：计划说明" },
          items: {
            type: "array",
            minItems: 1,
            description: "计划步骤（全量替换；增删改都通过替换整表表达，id 在多次更新间保持稳定）",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1, description: "稳定标识：同一计划步骤在多次更新间复用同一 id" },
                step: { type: "string", minLength: 1, description: "可验证的执行步骤" },
                status: { type: "string", enum: [...PLAN_STATUSES], description: "pending | in_progress | completed" },
                description: { type: "string", description: "可选：步骤补充说明" }
              },
              required: ["id", "step", "status"],
              additionalProperties: false
            }
          }
        },
        required: ["items"],
        additionalProperties: false
      },
      describeAction() {
        const action = deepAction({ title: "更新计划", description: "更新可见执行计划" });
        action.safe_edit_target = false;
        return action;
      },
      async run(args, context) {
        const items = args.items;
        if (!Array.isArray(items) || items.length === 0) {
          throw toolError("bad_args", "参数无效：items 不能为空。", { rule: "bad_args", fields: ["items"] });
        }
        const normalized = items.map((item, index) => {
          if (item == null || typeof item.id !== "string" || item.id.trim() === "") {
            throw toolError("bad_args", `参数无效：items[${index}].id 必须是非空字符串。`, { rule: "bad_args", fields: [`items[${index}].id`] });
          }
          if (item == null || typeof item.step !== "string" || item.step.trim() === "") {
            throw toolError("bad_args", `参数无效：items[${index}].step 必须是字符串。`, { rule: "bad_args", fields: [`items[${index}].step`] });
          }
          if (!PLAN_STATUSES.includes(item.status)) {
            throw toolError("bad_args", `参数无效：items[${index}].status 只允许 pending/in_progress/completed。`, {
              rule: "bad_args",
              fields: [`items[${index}].status`]
            });
          }
          if (item.description !== undefined && typeof item.description !== "string") {
            throw toolError("bad_args", `参数无效：items[${index}].description 必须是字符串。`, { rule: "bad_args", fields: [`items[${index}].description`] });
          }
          const entry = { id: item.id, step: item.step, status: item.status };
          if (typeof item.description === "string") entry.description = item.description;
          return entry;
        });
        const seenIds = new Set();
        for (const item of normalized) {
          if (seenIds.has(item.id)) {
            throw toolError("bad_args", `参数无效：计划项 id 重复：${item.id}。`, { rule: "bad_args", fields: ["items"] });
          }
          seenIds.add(item.id);
        }
        if (normalized.filter((item) => item.status === "in_progress").length > 1) {
          throw toolError("bad_args", "参数无效：最多一个 in_progress 计划项。", { rule: "bad_args", fields: ["items"] });
        }
        const explanation = typeof args.explanation === "string" ? args.explanation : null;
        // 事件侧统一脱敏：plan 文本可能内嵌密钥；
        // 返回给模型的 items 保持原样（模型看得到自己写的计划）
        await appendEvent({
          type: "plan_updated",
          run_id: context.run_id,
          payload: {
            explanation: explanation === null ? null : redactor.redact(explanation),
            items: normalized.map((item) => {
              const entry = { id: item.id, step: redactor.redact(item.step), status: item.status };
              if (item.description !== undefined) entry.description = redactor.redact(item.description);
              return entry;
            })
          }
        });
        return { updated: true, items: normalized };
      }
    },

    append_chapter_segment: {
      interruptible: true, // 章节草稿原子写可中断（project operations 负责安全点）
      description: "把一章的一段正文追加到章节草稿（原子写；正式提交只能通过 commit_chapter）。",
      schema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "项目 id" },
          chapter_no: { type: "integer", minimum: 1, description: "章节号（从 1 开始）" },
          segment_no: { type: "integer", minimum: 1, description: "段落号（从 1 开始，同一章内递增）" },
          content: { type: "string", minLength: 1, description: "本段正文" }
        },
        required: ["project_id", "chapter_no", "segment_no", "content"],
        additionalProperties: false
      },
      describeAction(args) {
        const action = deepAction({ title: "追加章节段落", description: `第 ${args.chapter_no} 章第 ${args.segment_no} 段` });
        action.category = "write";
        action.grant_key = "write:project:project-root";
        action.safe_edit_target = true;
        return action;
      },
      async run(args, context) {
        const projectId = requireStringArg(args, "project_id", "project_id");
        const chapterNo = requirePositiveIntArg(args, "chapter_no", "chapter_no");
        const segmentNo = requirePositiveIntArg(args, "segment_no", "segment_no");
        const content = requireStringArg(args, "content", "content");
        const op = projectOperations?.appendChapterSegment;
        if (typeof op !== "function") {
          throw toolError("not_wired", "工具不可用。", { rule: "not_wired", tool: "append_chapter_segment" });
        }
        const result = await op({
          projectRoot: context.projectRoot,
          projectId,
          chapterNo,
          segmentNo,
          content,
          signal: context.signal
        });
        return { ...(result ?? {}), chapter_no: chapterNo, segment_no: segmentNo };
      }
    },

    commit_chapter: {
      interruptible: false, // 正式章节事务是原子提交，不可中断
      description: "正式提交一章：真实字数记录、正式文件、章节索引、章节记忆与 checkpoint 一致更新（只保留存储安全约束，不做字数/标题/技能内容门禁）。结果中的 memory_checklist 是固定的记忆维护提醒：提交后必须依次 update_memory（含伏笔）→ 更新 book_summary.md → 更新 WORKLOG.md。actual_words 与 count_text 的 effective_count 为同一口径（中文字符 + 英文单词 + 数字记号）。",
      schema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "项目 id" },
          chapter_no: { type: "integer", minimum: 1, description: "章节号（从 1 开始）" },
          expected_draft_checksum: { type: "string", description: "可选：期望草稿校验和（防止提交漂移后的旧草稿）" }
        },
        required: ["project_id", "chapter_no"],
        additionalProperties: false
      },
      describeAction(args) {
        const action = deepAction({ title: "提交章节", description: `第 ${args.chapter_no} 章` });
        action.category = "write";
        action.grant_key = "write:project:project-root";
        action.safe_edit_target = true;
        return action;
      },
      async run(args, context) {
        const projectId = requireStringArg(args, "project_id", "project_id");
        const chapterNo = requirePositiveIntArg(args, "chapter_no", "chapter_no");
        const op = projectOperations?.commitChapter;
        if (typeof op !== "function") {
          throw toolError("not_wired", "工具不可用。", { rule: "not_wired", tool: "commit_chapter" });
        }
        const result = await op({
          projectRoot: context.projectRoot,
          projectId,
          chapterNo,
          expectedDraftChecksum: typeof args.expected_draft_checksum === "string" ? args.expected_draft_checksum : null
        });
        // 正式提交链接项目 checkpoint：journal 只记录引用
        await appendEvent({
          type: "checkpoint_linked",
          run_id: context.run_id,
          payload: {
            chapter_no: chapterNo,
            checkpoint_id: result?.checkpoint_id ?? null
          }
        });
        return { ...(result ?? {}), chapter_no: chapterNo };
      }
    },

    finalize_revision: {
      interruptible: false, // 确认修订是原子入账事务，不可中断
      description:
        "确认正式章节文件的修订并重新入账：重算字数/校验和、更新章节索引/章节记忆/checkpoint，并记录修订事件。结果中的 memory_checklist 是固定的记忆维护提醒：入账后必须依次 update_memory（含伏笔）→ 更新 book_summary.md → 更新 WORKLOG.md。",
      schema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "项目 id" },
          chapter_no: { type: "integer", minimum: 1, description: "章节号（从 1 开始）" },
          expected_checksum: { type: "string", description: "可选：期望正式文件校验和（防止入账漂移后的内容）" }
        },
        required: ["project_id", "chapter_no"],
        additionalProperties: false
      },
      describeAction(args) {
        const action = deepAction({ title: "确认修订章节", description: `第 ${args.chapter_no} 章` });
        action.category = "write";
        action.grant_key = "write:project:project-root";
        action.safe_edit_target = true;
        return action;
      },
      async run(args, context) {
        const projectId = requireStringArg(args, "project_id", "project_id");
        const chapterNo = requirePositiveIntArg(args, "chapter_no", "chapter_no");
        const expectedChecksum = typeof args.expected_checksum === "string" ? args.expected_checksum : null;
        const op = projectOperations?.finalizeChapter;
        if (typeof op !== "function") {
          throw toolError("not_wired", "工具不可用。", { rule: "not_wired", tool: "finalize_revision" });
        }
        const result = await op({
          projectRoot: context.projectRoot,
          projectId,
          chapterNo,
          expectedChecksum
        });
        // 确认修订链接项目 checkpoint：journal 只记录引用
        await appendEvent({
          type: "checkpoint_linked",
          run_id: context.run_id,
          payload: {
            chapter_no: chapterNo,
            checkpoint_id: result?.checkpoint_id ?? null
          }
        });
        return { ...(result ?? {}), chapter_no: chapterNo };
      }
    },

    rollback_chapter: {
      interruptible: false, // 回滚是原子写回 + 重新入账事务，不可中断
      description:
        "把章节回滚到指定版本（缺省 = 上一版）：写回正式文件、重新入账、存档回滚版本；覆盖前当前内容自动存为回滚前存档（可再恢复）。结果中的 memory_checklist 是固定的记忆维护提醒：回滚后必须依次 update_memory（含伏笔）→ 更新 book_summary.md → 更新 WORKLOG.md。",
      schema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "项目 id" },
          chapter_no: { type: "integer", minimum: 1, description: "章节号（从 1 开始）" },
          version: { type: "integer", minimum: 1, description: "可选：要恢复到的版本号（缺省 = 上一版）" }
        },
        required: ["project_id", "chapter_no"],
        additionalProperties: false
      },
      describeAction(args) {
        const action = deepAction({ title: "回滚章节", description: `第 ${args.chapter_no} 章${args.version ? ` 到版本 ${args.version}` : " 到上一版"}` });
        action.category = "write";
        action.grant_key = "write:project:project-root";
        action.safe_edit_target = true;
        return action;
      },
      async run(args, context) {
        const projectId = requireStringArg(args, "project_id", "project_id");
        const chapterNo = requirePositiveIntArg(args, "chapter_no", "chapter_no");
        const op = projectOperations?.rollbackChapter;
        if (typeof op !== "function") {
          throw toolError("not_wired", "工具不可用。", { rule: "not_wired", tool: "rollback_chapter" });
        }
        const version = args.version === undefined || args.version === null ? null : Number(args.version);
        const result = await op({
          projectRoot: context.projectRoot,
          projectId,
          chapterNo,
          version
        });
        // 与 commit/finalize 对齐：回滚同样链接项目 checkpoint（checkpoint_linked 事件流）
        await appendEvent({
          type: "checkpoint_linked",
          run_id: context.run_id,
          payload: {
            chapter_no: chapterNo,
            checkpoint_id: result?.checkpoint_id ?? null
          }
        });
        return { ...(result ?? {}), chapter_no: chapterNo };
      }
    }
  };
}