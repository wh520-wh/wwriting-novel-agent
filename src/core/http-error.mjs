export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.httpStatus = status;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 统一公共错误文案（计划 Task 4 Step 6；SPEC §11）。
//
// 响应 body 的 message 只使用 publicErrorMessage()：用户不得看到 ENOENT、绝对
// 路径、堆栈、Node.js 原始错误或内部文件名。只有 SAFE_PUBLIC_ERROR_CODES 白名单
// 内的 code（程序写死、不拼底层异常的用户错误）原样透传 message；Node 文件错误码
// 映射为固定中文文案；其余一律返回通用文案。原始 error.message/stack/路径只进
// console.warn/诊断日志，不回传浏览器。
// ---------------------------------------------------------------------------

// 只收录由程序写死且不拼底层异常的用户错误 code。
//
// 除计划 Task 4 列出的 agent/作用域 code 外，补充两个同样满足「程序写死、不拼底层
// 异常」标准的既有领域 code（tests/app-server-global-model.test.mjs 依赖它们的
// message 透传，且这些 message 是模型切换/选用时唯一可读原因）：
//   - model_unsupported：固定文案「该模型不支持工具调用…」，不拼异常；
//   - model_profile_not_found：`未找到已配置模型：${modelId}`，只拼用户标识
//     （与白名单内 run_not_found 拼 runId 同构），不拼异常；
//   - model_disabled：固定文案「已停用的模型不能设为默认。」，与 model_unsupported
//     同标准（设置页「设为默认」被拒时需向用户展示具体原因）。
// 压缩领域六个 code（五个在 agent-routes.mjs 的 COMPACTION_ERROR_MESSAGE 固定文案，
// compaction_failed_blocked 为 submit 路径 runtime 侧 fail 固定文案——T24 whfind-bugs
// #5 追加）同样程序写死、不拼底层异常——白名单放行后特定文案才能到达用户（否则
// 一律收敛为通用文案，用户看不到「压缩任务不存在」这类可读原因）。
// 凡是 handler 用 error?.message 包底层的 code（如 project_open_failed 的兜底
// catch）一律不收录，避免原始错误文本随白名单透传。
export const SAFE_PUBLIC_ERROR_CODES = new Set([
  "empty_input",
  "invalid_project_root",
  "INVALID_WORKSPACE_SCOPE",
  "WORKSPACE_UNAVAILABLE",
  "PROJECT_SCOPE_CHANGED",
  "invalid_choice",
  "run_not_found",
  "model_unsupported",
  "model_disabled",
  "model_profile_not_found",
  // Task 20：invalid_api_key_env 两个文案均为程序写死、不拼底层异常（同
  // model_disabled 标准）。设置页密钥保存被拒时用户必须看到具体原因——「请先填写
  // API 密钥环境变量名。」是粘贴明文密钥时的唯一可读引导（前端据此弹指引 toast，
  // 否则会被收敛为通用脱敏文案，指引在真实后端永远不可达）。
  "invalid_api_key_env",
  // Task 19（spec 4.3 #13）：settings/update 拒绝旧 active_model 字段——固定文案
  // 指向模型引用 API（POST /api/settings/model-switch 与 providers CRUD），
  // 前端只展示 data.message 不做 code 分支，必须透传才能让用户看到迁移指引。
  "active_model_use_reference_api",
  "invalid_compaction_id",
  "compaction_not_found",
  "compaction_not_retryable",
  "compaction_in_flight",
  "compaction_no_run",
  // T24（whfind-bugs #5）：compaction_failed_blocked——压缩 failed 态 submit 诚实
  // 拒绝，runtime.mjs 侧 fail 固定文案「请先重试或取消压缩」必须到达直连 API 客户端。
  "compaction_failed_blocked",
  // Task 5 会话 CRUD：全部程序写死、不拼底层异常（project_busy/session_busy 的
  // 可读原因「另一个对话正在运行/该会话正在运行」必须能到达用户，与压缩领域
  // 六个 code 同标准）。invalid_session_id/title 由路由层写死中文文案。
  "invalid_session_id",
  "invalid_session_title",
  "session_not_found",
  "project_busy",
  "session_busy"
]);

export function publicErrorMessage(error) {
  if (error instanceof HttpError && SAFE_PUBLIC_ERROR_CODES.has(error.code)) return error.message;
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error?.code)) {
    return "无法读取工作区文件，请检查文件夹是否仍可访问后重试。";
  }
  return "操作未完成，请重试；若问题持续，请打开诊断信息。";
}

// Node 系统错误码（fs/uv/ERR_*）不得作为响应 code 暴露；程序写死的领域 code
//（HttpError 与 agent 领域小写 code）原样保留，前端依赖它们做分支处理。
const NODE_ERROR_CODE_RE = /^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+|UV_[A-Z0-9_]+)$/u;

export function safePublicErrorCode(error) {
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : null;
  return code && !NODE_ERROR_CODE_RE.test(code) ? code : "INTERNAL_ERROR";
}

export function sendError(res, error) {
  const message = publicErrorMessage(error);
  const code = safePublicErrorCode(error);
  if (message !== error?.message || code !== error?.code) {
    // 原始错误详情只进诊断日志（SPEC §11）：不回传浏览器。系统错误（fs/uv）额外
    // 带栈定位失败点；handler 写死的 HttpError 只记一条 message。
    console.warn(`[http] 错误响应已脱敏（code=${code}）: ${error?.message ?? String(error)}`);
    if (NODE_ERROR_CODE_RE.test(String(error?.code ?? "")) && typeof error?.stack === "string" && error.stack.length > 0) {
      console.warn(`[http] 原始堆栈: ${error.stack.split("\n").slice(0, 5).join("\n")}`);
    }
  }
  if (error instanceof HttpError) {
    res.writeHead(error.httpStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      code,
      message,
      // HttpError 的第四个参数（extra）直接平铺进响应体：前端 postJson 从顶层读
      // fields / action 等字段做逐项标红与跳转，不读 details 嵌套层。
      ...(error.details && typeof error.details === "object" ? error.details : {})
    }));
  } else {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      code: code ?? "INTERNAL_ERROR",
      message
    }));
  }
}
