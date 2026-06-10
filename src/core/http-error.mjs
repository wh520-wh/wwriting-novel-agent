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
      ...(error.details ? { details: error.details } : {})
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
