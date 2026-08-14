// src/core/http/router.mjs —— 路由表与统一错误适配（统一 Agent 内核计划 Task 7）。
//
// 本模块是 HTTP 层的基础设施，职责固定为：
//   - pathname/method 匹配（支持 `:param` 路径段，如 /api/agent/input/:inputId/priority）；
//   - JSON body 解析（坏 JSON / 超大 body → 简短用户错误）；
//   - 统一错误适配（ProjectAgent / 领域模块抛出的带 code 错误 → HTTP 状态码）；
//   - 共享的项目作用域解析（read/write 项目根解析，旧 app-server 语义保留）。
//
// 依赖方向（计划 "Dependency Direction"）：HTTP 文件不得 import agent 内部文件；
// 本模块只依赖稳定基础模块（http-error / fs-utils / app-state / app-dashboard）。
// 路由模块（agent-routes/project-routes/settings-routes）返回纯 handler（注入依赖），
// 不自行创建 ModelClient、锁或 store；路由表由 Task 9 的 composition root 组装。
//
// handler 约定：handler({ request, response, params, query, body })。
//   - 返回对象 → router 以 200 + JSON 响应（cache-control: no-store）；
//   - 返回 undefined → handler 已自行写响应（如 SSE 端点）；
//   - 抛出错误 → router 统一适配为 JSON 错误响应。
import path from "node:path";
import { HttpError, sendError } from "../http-error.mjs";
import { loadAppState, samePath } from "../app-state.mjs";
import { validateProjectRoot, validateWorkspaceRoot } from "../app-dashboard.mjs";
import { isPathInside } from "../fs-utils.mjs";

const MAX_BODY_BYTES = 200_000;

// ---------------------------------------------------------------------------
// 统一错误适配：错误 code → HTTP 状态码映射表。
// ProjectAgent（agent/index.mjs 公共接口）抛出的错误统一带 code（见 runtime.mjs
// 的 fail(code, message) 与 tools.mjs 的 toolError），HTTP 层按表格映射为简短
// 用户错误；HttpError 原样透传；未知名错误一律 500。
// ---------------------------------------------------------------------------

const STATUS_400_CODES = new Set([
  // agent 输入校验
  "invalid_project_root",
  "empty_input",
  "invalid_source",
  "invalid_input_id",
  "invalid_decision_id",
  "invalid_choice",
  "invalid_run_id",
  "bad_args",
  "confirmation_mismatch",
  // Task 5 会话 CRUD：sessionId/title 校验
  "invalid_session_id",
  "invalid_session_title",
  // 项目/设置领域
  "invalid_settings_patch",
  "INVALID_WORKSPACE_SCOPE",
  "PROJECT_ARCHIVED",
  "model_unsupported",
  "configuration_missing"
]);

const STATUS_404_CODES = new Set([
  "no_project",
  "no_active_run",
  "decision_not_found",
  "run_not_found",
  "dir_not_found",
  "file_not_found",
  "model_profile_not_found",
  // Task 5 会话 CRUD：显式 sessionId 指向不存在的会话
  "session_not_found"
]);

const STATUS_409_CODES = new Set([
  "run_stopping",
  "interrupt_pending",
  "input_not_queued",
  "decision_terminal",
  "decision_superseded",
  // retry 已终结（completed/cancelled 等不可恢复状态）的 Run：当前状态不允许该操作
  "run_not_recoverable",
  "PROJECT_SCOPE_CHANGED",
  // Task 5 多会话串行门：其他会话运行中（project_busy，前端禁用发送键）/
  // 该会话自身运行中（session_busy，前端提示删除冲突；运行中检查仅 deleteSession 有）
  "project_busy",
  "session_busy"
]);

const STATUS_503_CODES = new Set(["model_probe_unavailable"]);
const STATUS_504_CODES = new Set(["stop_timeout"]);

export function errorToHttp(error) {
  if (error instanceof HttpError) return error;
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : null;
  const message = typeof error?.message === "string" && error.message.length > 0
    ? error.message
    : "服务器内部错误";
  if (code) {
    if (STATUS_400_CODES.has(code)) return new HttpError(400, code, message);
    if (STATUS_404_CODES.has(code)) return new HttpError(404, code, message);
    if (STATUS_409_CODES.has(code)) return new HttpError(409, code, message);
    if (STATUS_503_CODES.has(code)) return new HttpError(503, code, message);
    if (STATUS_504_CODES.has(code)) return new HttpError(504, code, message);
  }
  return new HttpError(500, code ?? "INTERNAL_ERROR", message);
}

// ---------------------------------------------------------------------------
// JSON body 解析与 JSON 响应（旧 app-server 语义保留）
// ---------------------------------------------------------------------------

export async function readJsonBody(request) {
  let source = "";
  for await (const chunk of request) {
    source += chunk.toString("utf8");
    if (source.length > MAX_BODY_BYTES) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求体过大");
    }
  }
  if (source.trim() === "") return {};
  try {
    return JSON.parse(source);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "请求体不是合法 JSON。");
  }
}

export async function serveJson(response, data, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// 项目作用域解析（旧 app-server resolveReadProjectRoot 等语义保留）。
// ctx = { selected, workspace, stateRoot }；selected 是共享的可变引用
//（composition root 传入 { current: string|null }，open/init/forget 更新它）。
// ---------------------------------------------------------------------------

export async function resolveActiveProjectRoot({ selected }) {
  if (!selected) {
    throw new Error("当前没有可用项目。");
  }
  const target = path.resolve(selected);
  await validateProjectRoot(target);
  return target;
}

// 读请求作用域（计划 Task 4 Step 3）：请求携带的 projectRoot 优先，缺省回落当前
// 选中项目。目标必须已注册（当前选中/工作区内/最近列表），且磁盘目标仍是可访问
// 目录；project.yaml 不再是聊天资格条件。未注册 → 400 INVALID_WORKSPACE_SCOPE；
// 已注册但目录当前不可访问 → 404 WORKSPACE_UNAVAILABLE。
export async function resolveReadProjectRoot({ requestedRoot, selected, workspace, stateRoot }) {
  const target = requestedRoot ?? selected;
  if (!target) {
    throw new HttpError(404, "no_project", "当前没有打开的项目");
  }
  const resolvedTarget = path.resolve(target);
  let registered = samePath(selected, resolvedTarget);
  if (!registered && workspace && isPathInside(path.resolve(workspace), resolvedTarget)) {
    registered = true;
  }
  if (!registered) {
    const state = await loadAppState(stateRoot);
    registered = state.recentProjects.some((project) => samePath(project.projectRoot, resolvedTarget));
  }
  if (!registered) {
    throw new HttpError(400, "INVALID_WORKSPACE_SCOPE", "请求的工作区未注册");
  }
  try {
    return await validateWorkspaceRoot(resolvedTarget);
  } catch {
    throw new HttpError(404, "WORKSPACE_UNAVAILABLE", "工作文件夹当前无法访问，请重新选择。");
  }
}

// 写请求作用域：读作用域之外还要求请求/期望项目与当前选中一致，避免项目切换
// 瞬间写入落到错误项目；不一致返回 409 PROJECT_SCOPE_CHANGED。
export async function resolveWriteProjectRoot({ requestedRoot, expectedProjectRoot, selected, workspace, stateRoot }) {
  const target = await resolveReadProjectRoot({ requestedRoot, selected, workspace, stateRoot });
  const expected = expectedProjectRoot ?? target;
  if (!samePath(expected, selected) || !samePath(target, selected)) {
    throw new HttpError(409, "PROJECT_SCOPE_CHANGED", "项目已切换，请确认后重试");
  }
  return target;
}

// 写端点统一入口：从 ctx 取 selected/workspace/stateRoot，从 body 取请求/期望项目。
export async function resolveActiveWriteProjectRoot(ctx, body = {}) {
  const projectRoot = await resolveWriteProjectRoot({
    requestedRoot: body?.projectRoot ?? undefined,
    expectedProjectRoot: body?.expectedProjectRoot ?? undefined,
    selected: ctx.selected,
    workspace: ctx.workspace,
    stateRoot: ctx.stateRoot
  });
  await validateProjectRoot(projectRoot);
  return projectRoot;
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

function matchSegments(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length) return null;
  const params = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const pattern = patternSegments[i];
    if (pattern.startsWith(":")) {
      let value;
      try {
        value = decodeURIComponent(pathSegments[i]);
      } catch {
        // 畸形 % 编码（如 %zz）：decodeURIComponent 抛 URIError。绝不能让请求悬挂
        // 或产生 unhandled rejection——映射为简短 400 用户错误。
        throw new HttpError(400, "BAD_REQUEST", "路径编码无效。");
      }
      params[pattern.slice(1)] = value;
    } else if (pattern !== pathSegments[i]) {
      return null;
    }
  }
  return params;
}

export function createRouter() {
  const routes = [];
  return {
    // add("POST", "/api/agent/input/:inputId/priority", handler)
    add(method, pattern, handler) {
      routes.push({
        method,
        segments: pattern.split("/").filter(Boolean),
        handler
      });
    },
    // 匹配 + body 解析 + 统一错误适配。匹配本身也可能抛错（畸形 % 编码路径），
    // 因此匹配循环与 handler 调用都必须在同一 try 内，保证任何失败都转为
    // JSON 错误响应而不是悬挂连接。
    async handle(request, response) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathSegments = url.pathname.split("/").filter(Boolean);
      try {
        let matched = null;
        for (const route of routes) {
          if (route.method !== request.method) continue;
          const params = matchSegments(route.segments, pathSegments);
          if (params !== null) {
            matched = { route, params };
            break;
          }
        }
        if (!matched) {
          sendError(response, new HttpError(404, "NOT_FOUND", "接口不存在。"));
          return;
        }
        const query = Object.fromEntries(url.searchParams.entries());
        const body = await readJsonBody(request);
        const result = await matched.route.handler({
          request,
          response,
          params: matched.params,
          query,
          body
        });
        if (result !== undefined && !response.writableEnded) {
          await serveJson(response, result);
        }
      } catch (error) {
        // 响应可能已被客户端断开（SSE/长连接 abort 后 write 抛错）：不能再写错误体。
        try {
          if (!response.writableEnded && !response.destroyed) {
            sendError(response, errorToHttp(error));
          }
        } catch {
          // 连接已不可写，忽略
        }
      }
    }
  };
}
