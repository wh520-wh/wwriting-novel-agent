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
//     （与白名单内 run_not_found 拼 runId 同构），不拼异常。
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
  "model_profile_not_found"
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
const NODE_ERROR_CODE_RE = /^(?:E[A-Z]+|ERR_[A-Z0-9_]+|UV_[A-Z0-9_]+)$/u;

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
