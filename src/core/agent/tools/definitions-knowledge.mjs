// src/core/agent/tools/definitions-knowledge.mjs —— knowledge 域注册定义（第十五轮 Task 5 拆分）。
//
// 承接原 tools.mjs 的 read_skill / count_text / update_memory 注册体（机械平移，
// 逻辑不动）。依赖经 h 注入（baseAction/fileAction/deepAction/redactor/toolError/
// requireStringArg/requirePositiveIntArg/executeCountText/projectOperations/skills）；
// normalizeMemoryUpdateArgs 是共享纯函数（src/core/memory-extractor.mjs，同时被
// continuity-store 消费），按模块级依赖直接 import，不进 h。
import path from "node:path";
import { normalizeMemoryUpdateArgs } from "../../memory-extractor.mjs";

export function knowledgeToolDefinitions(h) {
  const {
    baseAction, fileAction, deepAction, redactor, toolError,
    requireStringArg, requirePositiveIntArg, executeCountText,
    projectOperations, skills
  } = h;
  return {
    read_skill: {
      interruptible: false,
      description: "读取已发现 Agent Skill 的 SKILL.md 或其安全资源。",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          resource: { type: "string", description: "默认 SKILL.md；也可为 references/...、scripts/...、assets/..." }
        },
        required: ["name"],
        additionalProperties: false
      },
      describeAction(args, context) {
        return baseAction({
          category: "read",
          scope: "project",
          targetClass: "project-root",
          grantKey: "read:project:project-root",
          title: "读取技能",
          description: redactor.redact(String(args.name ?? "")),
          targets: []
        });
      },
      async run(args, context) {
        const name = requireStringArg(args, "name", "name");
        if (typeof skills?.read !== "function") {
          throw toolError("not_wired", "工具不可用。", { rule: "not_wired", tool: "read_skill" });
        }
        const resource =
          typeof args.resource === "string" && args.resource.trim() !== "" ? args.resource : "SKILL.md";
        // 只能按 active catalog name 解析；realpath containment、1MiB 文本上限与
        // 二进制 asset 处理在 skill-file.readSkillResource 内执行；本版本不执行 scripts。
        const result = await skills.read({ projectRoot: context.projectRoot, name, resource });
        return { ...result };
      }
    },

    count_text: {
      interruptible: false,
      description:
        "统计工作区内 Markdown 或纯文本文件的客观字数；minimum/target 只计算差额，不判定通过或失败。" +
        "返回的 effective_count（中文字符 + 英文单词 + 数字记号）与 commit_chapter/finalize_revision 记录的 actual_words 为同一口径。",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "文件路径（相对项目根或绝对路径），仅限工作区内 .md/.txt 文件" },
          minimum: { type: "integer", minimum: 0, description: "可选：字数下限，只用于计算差额，不代表程序门禁" },
          target: { type: "integer", minimum: 0, description: "可选：字数目标，只用于计算差额，不代表程序门禁" }
        },
        required: ["path"],
        additionalProperties: false
      },
      describeAction(args, context) {
        // 缺省路径只用于动作分类（read 项目内自动放行）；真实路径校验与 bad_args
        // 在 run()（executeCountText 的 requireStringArg）完成。权限 action 的
        // description 显示「统计文本字数」（brief Step 3）。
        const target = path.resolve(context.projectRoot, args.path ?? ".");
        return fileAction({
          tool: "count_text",
          args,
          context,
          targetPath: target,
          category: "read",
          title: "统计文本字数",
          description: "统计文本字数"
        });
      },
      async run(args, context) {
        return executeCountText(args, context);
      }
    },

    update_memory: {
      interruptible: false,
      description: "把本章新增或被修正的客观设定（事实/时间线/角色）增量合并进设定档案（memory/continuity.json，系统校验章节存在后原子落盘并重渲染 continuity.md）。只交新增或修正项，系统去重并标记冲突；只收客观设定，不收主观评价；摘要与工作日志不归本工具管（请用 write_file/edit_file 更新 book_summary.md 与 WORKLOG.md）。",
      schema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          chapter_no: { type: "integer", minimum: 1 },
          facts: { type: "array" },
          timeline: { type: "array" },
          characters: { type: "array" }
        },
        required: ["project_id", "chapter_no"],
        additionalProperties: false
      },
      describeAction(args) {
        const action = deepAction({ title: "更新设定档案", description: `第 ${args.chapter_no} 章设定` });
        action.category = "write";
        action.grant_key = "write:project:project-root";
        action.safe_edit_target = true;
        return action;
      },
      async run(args, context) {
        const projectId = requireStringArg(args, "project_id", "project_id");
        const chapterNo = requirePositiveIntArg(args, "chapter_no", "chapter_no");
        const op = projectOperations?.updateMemoryFromExtraction;
        if (typeof op !== "function") {
          throw toolError("not_wired", "工具不可用。", { rule: "not_wired", tool: "update_memory" });
        }
        const extraction = normalizeMemoryUpdateArgs(args);
        const result = await op({ projectRoot: context.projectRoot, chapterNo, extraction });
        return { ...(result ?? {}), chapter_no: chapterNo };
      }
    },

    read_continuity: {
      interruptible: false,
      description: "获取前情简报：近两章开头/落点摘录、相关设定精选（近 5 章事实/角色状态/时间线）与未回收伏笔（按埋设章排序）。动笔写任何章节之前必须先调用。传 entity 时返回该实体的完整事实档案；chapter_no 缺省为最新入账章节 + 1。",
      schema: {
        type: "object",
        properties: {
          chapter_no: { type: "integer", minimum: 1, description: "可选：当前目标章节号，缺省 = 最新入账章节 + 1" },
          entity: { type: "string", description: "可选：按实体名查全量事实档案（与章节前情简报互斥）" }
        },
        additionalProperties: false
      },
      describeAction(args, context) {
        return baseAction({
          category: "read",
          scope: "project",
          targetClass: "project-root",
          grantKey: "read:project:project-root",
          title: "查询前情",
          description: typeof args.entity === "string" && args.entity
            ? redactor.redact(`实体：${args.entity}`)
            : `第 ${args.chapter_no ?? "下一"} 章前情简报`,
          targets: []
        });
      },
      async run(args, context) {
        const op = projectOperations?.readContinuityBriefing;
        if (typeof op !== "function") {
          throw toolError("not_wired", "工具不可用。", { rule: "not_wired", tool: "read_continuity" });
        }
        return op({
          projectRoot: context.projectRoot,
          chapterNo: Number.isInteger(args.chapter_no) ? args.chapter_no : null,
          entity: typeof args.entity === "string" && args.entity.trim() !== "" ? args.entity.trim() : null
        });
      }
    }
  };
}