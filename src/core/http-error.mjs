export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.httpStatus = status;
    this.code = code;
    this.details = details;
  }
}

export function sendError(res, error) {
  if (error instanceof HttpError) {
    res.writeHead(error.httpStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      code: error.code,
      message: error.message,
      // HttpError 的第四个参数（extra）直接平铺进响应体：前端 postJson 从顶层读
      // fields / action 等字段做逐项标红与跳转，不读 details 嵌套层。
      ...(error.details && typeof error.details === "object" ? error.details : {})
    }));
  } else {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      code: "INTERNAL_ERROR",
      message: error.message ?? "服务器内部错误"
    }));
  }
}
