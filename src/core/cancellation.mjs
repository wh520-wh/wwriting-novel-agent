export class ProjectCancelledError extends Error {
  constructor(reason = "cancelled") {
    super(String(reason || "cancelled"));
    this.name = "ProjectCancelledError";
    this.reason = String(reason || "cancelled");
  }
}

export function isCancellationError(error, signal) {
  return Boolean(
    signal?.aborted ||
    error instanceof ProjectCancelledError ||
    error?.name === "AbortError"
  );
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new ProjectCancelledError(signal.reason ?? "cancelled");
  }
}
