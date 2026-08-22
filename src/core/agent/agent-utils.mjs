// src/core/agent/agent-utils.mjs -- agent 包微工具单源（第十五轮 F1）。
// fail：抛出型（journal/journal-segments/context-checkpoints 既有语义）。
// codedError：构造带 code 的 Error 并返回（runtime.fail/compactionError/
// checkpointError 三处同构，调用方自行 throw）。
import { randomUUID } from "node:crypto";

export function fail(message) {
  throw new Error(message);
}

export function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function defaultClock() {
  return Date.now();
}

export function defaultIdFactory() {
  return randomUUID();
}

// clock 允许返回毫秒时间戳或 ISO-8601 字符串；统一归一化为 ISO-8601。
export function normalizeAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail(`非法时间值: ${String(value)}`);
  return date.toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
