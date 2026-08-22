// src/core/agent/tools/definitions-fs.mjs —— 文件域五工具的注册定义（第十五轮 Task 5 拆分）。
//
// 承接原 tools.mjs 的 list_files / search_files / read_file / write_file / edit_file
// 五个注册体（机械平移，逻辑不动）。依赖经 h（helpers）注入：工厂闭包辅助与共享
// 常量（toolError/fileAction/redactor/pathExists/isSafeEditContentPath/
// fileProtectedCheck/requireStringArg/optionalStringArg/MAX_TOOL_RESULT_CHARS 等）
// 由 index.mjs 组装后传入；本域私有常量（搜索上限/跳过目录）留在此模块。
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, sha256, writeFileAtomic } from "../../fs-utils.mjs";

const MAX_SEARCH_FILE_BYTES = 1024 * 1024; // search_files 内容搜索跳过的文件大小上限（字节）
const MAX_SEARCH_MATCHES = 50; // search_files 命中上限
const MAX_SEARCH_DEPTH = 12; // search_files 递归深度上限
const SEARCH_SKIP_DIRS = new Set([".wwriting", "node_modules", ".git", "checkpoints", ".versions"]);

export function fsToolDefinitions(h) {
  const {
    toolError, fileAction, redactor,
    isSafeEditContentPath, fileProtectedCheck, requireStringArg,
    optionalStringArg, MAX_TOOL_RESULT_CHARS
  } = h;
  return {
    list_files: {
      interruptible: false,
      description: "列出目录条目（文件名与类型）。path 缺省为项目根目录。",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径（相对项目根或绝对路径），缺省为项目根" }
        },
        additionalProperties: false
      },
      describeAction(args, context) {
        const target = path.resolve(context.projectRoot, args.path ?? ".");
        return fileAction({
          tool: "list_files",
          args,
          context,
          targetPath: target,
          category: "read",
          title: "列出文件",
          description: redactor.redact(String(args.path ?? "."))
        });
      },
      async run(args, context) {
        const target = path.resolve(context.projectRoot, args.path ?? ".");
        if (!(await pathExists(target))) throw toolError("dir_not_found", `目录不存在：${args.path ?? "."}`);
        const entries = await fs.readdir(target, { withFileTypes: true });
        const list = entries
          .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { path: target, entries: list };
      }
    },

    search_files: {
      interruptible: false,
      description: "在目录树中搜索文件名或文本内容，返回命中位置与上下文摘录（上限 50 条）。",
      schema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "要搜索的文字（文件名或内容按普通字符串匹配）" },
          path: { type: "string", description: "搜索起点（相对项目根或绝对路径），缺省为项目根" }
        },
        required: ["query"],
        additionalProperties: false
      },
      describeAction(args, context) {
        const target = path.resolve(context.projectRoot, args.path ?? ".");
        return fileAction({
          tool: "search_files",
          args,
          context,
          targetPath: target,
          category: "read",
          title: "搜索文件",
          description: redactor.redact(String(args.query ?? ""))
        });
      },
      async run(args, context) {
        const query = String(args.query ?? "");
        if (query.trim() === "") throw toolError("bad_args", "参数无效：query 不能为空。", { rule: "bad_args", fields: ["query"] });
        const target = path.resolve(context.projectRoot, args.path ?? ".");
        if (!(await pathExists(target))) throw toolError("dir_not_found", `目录不存在：${args.path ?? "."}`);
        const matches = [];
        const walk = async (dir, depth) => {
          if (matches.length >= MAX_SEARCH_MATCHES || depth > MAX_SEARCH_DEPTH) return;
          let entries;
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (matches.length >= MAX_SEARCH_MATCHES) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
              await walk(full, depth + 1);
            } else if (entry.isFile()) {
              if (entry.name.includes(query)) {
                matches.push({ path: full, kind: "name" });
                continue;
              }
              try {
                const stats = await fs.stat(full);
                if (stats.size > MAX_SEARCH_FILE_BYTES) continue;
                const text = await fs.readFile(full, "utf8");
                const lines = text.split("\n");
                for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i += 1) {
                  const column = lines[i].indexOf(query);
                  if (column >= 0) {
                    matches.push({
                      path: full,
                      kind: "content",
                      line: i + 1,
                      excerpt: lines[i].slice(Math.max(0, column - 40), column + query.length + 40)
                    });
                    break;
                  }
                }
              } catch {
                // 读取失败（二进制/权限）跳过
              }
            }
          }
        };
        await walk(target, 0);
        return { query, total: matches.length, matches };
      }
    },

    read_file: {
      interruptible: false,
      description: "读取文件内容（UTF-8，超过 100_000 字符截断并标注 truncated）。",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "文件路径（相对项目根或绝对路径）" }
        },
        required: ["path"],
        additionalProperties: false
      },
      describeAction(args, context) {
        const target = path.resolve(context.projectRoot, args.path);
        return fileAction({
          tool: "read_file",
          args,
          context,
          targetPath: target,
          category: "read",
          title: "读取文件",
          description: redactor.redact(String(args.path))
        });
      },
      async run(args, context) {
        const target = path.resolve(context.projectRoot, args.path);
        if (!(await pathExists(target))) throw toolError("file_not_found", `文件不存在：${args.path}`);
        const stats = await fs.stat(target);
        if (stats.isDirectory()) throw toolError("not_a_file", `路径是目录：${args.path}`);
        const raw = await fs.readFile(target, "utf8");
        const truncated = raw.length > MAX_TOOL_RESULT_CHARS;
        // 返回侧脱敏口径：文件内容按原样返回给模型（模型需要真实内容工作，且读取是
        // 模型点名发起的）；journal 事件侧（tool_call_started/completed 的 args/result）
        // 由 execute 统一脱敏，保证任何事件离开 ToolRuntime 前不含明文密钥。
        return {
          path: target,
          truncated,
          content: truncated ? raw.slice(0, MAX_TOOL_RESULT_CHARS) : raw
        };
      }
    },

    write_file: {
      interruptible: false,
      description: "原子写入文件（受权限与受保护路径约束）。",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "目标文件路径（相对项目根或绝对路径）" },
          content: { type: "string", description: "要写入的完整内容" },
          expected_checksum: { type: "string", description: "可选：写入前文件的 SHA-256 校验和（取自上一次 write_file/edit_file 返回的 checksum）；不匹配时拒绝（stale_checksum），防止覆盖他人已改动的版本" }
        },
        required: ["path", "content"],
        additionalProperties: false
      },
      describeAction(args, context) {
        const target = path.resolve(context.projectRoot, args.path);
        const action = fileAction({
          tool: "write_file",
          args,
          context,
          targetPath: target,
          category: "write",
          title: "写入文件",
          description: redactor.redact(String(args.path))
        });
        action.safe_edit_target = isSafeEditContentPath(context.projectRoot, target);
        return action;
      },
      protectedCheck: fileProtectedCheck,
      async run(args, context) {
        const target = path.resolve(context.projectRoot, args.path);
        // R5-10：content 必须是字符串——对象/数组参数不得静默写成 "[object Object]"。
        const content = requireStringArg(args, "content", "content");
        if (args.expected_checksum !== undefined && args.expected_checksum !== null && typeof args.expected_checksum !== "string") {
          throw toolError("bad_args", "参数无效：expected_checksum 必须是字符串。", { rule: "bad_args", fields: ["expected_checksum"] });
        }
        if (args.expected_checksum !== undefined && args.expected_checksum !== null) {
          if (!(await pathExists(target))) {
            throw toolError("file_not_found", `文件不存在：${args.path}`);
          }
          const current = await fs.readFile(target, "utf8");
          if (sha256(current) !== args.expected_checksum) {
            throw toolError("stale_checksum", "文件已被其他修改更新，请重新读取后再编辑。", { rule: "stale_checksum" });
          }
        }
        const written = await writeFileAtomic(target, content);
        return { path: target, bytes_written: written.bytes_written, checksum: written.checksum };
      }
    },

    edit_file: {
      interruptible: false,
      description: "在文件中查找唯一文本并替换。匹配多处时需用 occurrence 指定第几处（从 1 开始）。",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "目标文件路径（相对项目根或绝对路径）" },
          find: { type: "string", minLength: 1, description: "要查找的原文片段（必须精确匹配）" },
          replace: { type: "string", description: "替换后的文本（可为空串）" },
          occurrence: { type: "integer", minimum: 1, description: "可选：替换第几处匹配（缺省要求全文唯一）" },
          expected_checksum: { type: "string", description: "可选：写入前文件的 SHA-256 校验和（取自上一次 write_file/edit_file 返回的 checksum）；不匹配时拒绝（stale_checksum），防止覆盖他人已改动的版本" }
        },
        required: ["path", "find"],
        additionalProperties: false
      },
      describeAction(args, context) {
        const target = path.resolve(context.projectRoot, args.path);
        const action = fileAction({
          tool: "edit_file",
          args,
          context,
          targetPath: target,
          category: "write",
          title: "编辑文件",
          description: redactor.redact(String(args.path))
        });
        action.safe_edit_target = isSafeEditContentPath(context.projectRoot, target);
        return action;
      },
      protectedCheck: fileProtectedCheck,
      async run(args, context) {
        const target = path.resolve(context.projectRoot, args.path);
        // R5-10：find/replace 必须是字符串——对象/数组参数不得静默 toString 后改写文件。
        const find = requireStringArg(args, "find", "find");
        const replace = optionalStringArg(args, "replace", "replace"); // replace 可为空串，但必须显式为字符串
        // schema 声明 integer；运行时复核，避免 Number(...) 静默截断小数
        if (args.occurrence !== undefined && args.occurrence !== null) {
          if (!Number.isInteger(Number(args.occurrence)) || Number(args.occurrence) <= 0) {
            throw toolError("bad_args", "参数无效：occurrence 必须是正整数。", { rule: "bad_args", fields: ["occurrence"] });
          }
        }
        if (args.expected_checksum !== undefined && args.expected_checksum !== null && typeof args.expected_checksum !== "string") {
          throw toolError("bad_args", "参数无效：expected_checksum 必须是字符串。", { rule: "bad_args", fields: ["expected_checksum"] });
        }
        if (!(await pathExists(target))) throw toolError("file_not_found", `文件不存在：${args.path}`);
        const content = await fs.readFile(target, "utf8");
        if (args.expected_checksum !== undefined && args.expected_checksum !== null) {
          if (sha256(content) !== args.expected_checksum) {
            throw toolError("stale_checksum", "文件已被其他修改更新，请重新读取后再编辑。", { rule: "stale_checksum" });
          }
        }
        const occurrence = Number(args.occurrence) || 0;
        let index = content.indexOf(find);
        if (index === -1) throw toolError("find_not_found", "未找到要替换的文本。");
        if (occurrence > 0) {
          let at = -1;
          for (let i = 1; i <= occurrence; i += 1) {
            at = content.indexOf(find, at === -1 ? 0 : at + find.length);
            if (at === -1) break;
          }
          if (at === -1) throw toolError("find_not_found", `未找到第 ${occurrence} 处文本。`);
          index = at;
        } else if (content.indexOf(find, index + find.length) !== -1) {
          throw toolError("find_not_unique", "匹配到多处，请用 occurrence 指定第几处。");
        }
        const updated = content.slice(0, index) + replace + content.slice(index + find.length);
        const written = await writeFileAtomic(target, updated);
        return {
          path: target,
          replaced: true,
          occurrence: occurrence || 1,
          bytes_written: written.bytes_written,
          checksum: written.checksum
        };
      }
    }
  };
}