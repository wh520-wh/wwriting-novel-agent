// 每模型的上下文窗口与输出上限。**不实测**（2026-09-29 用户决定）：
// 取值来自 DeepSeek 官方 API 文档与用户拍板，写死在表里，改它就改这一处。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFICIAL_MODEL_LIMITS, resolveModelLimits,
} from '../../src/model/model-limits.mjs';
import { DEFAULT_BASE_URL } from '../../src/model/config.mjs';

test('官方端点的最新模型给足空间：1M 上下文 + 384K 输出', () => {
  for (const model of ['deepseek-v4-pro', 'deepseek-flash']) {
    const limits = resolveModelLimits({ baseUrl: DEFAULT_BASE_URL, model });
    assert.deepEqual(
      { contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens, source: limits.source },
      { contextWindow: 1_000_000, maxOutputTokens: 393_216, source: 'official' },
    );
  }
});

test('官方端点其它模型：1M 上下文 + 64K 输出', () => {
  const limits = resolveModelLimits({ baseUrl: DEFAULT_BASE_URL, model: 'deepseek-chat' });
  assert.deepEqual(
    { contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens, source: limits.source },
    { contextWindow: 1_000_000, maxOutputTokens: 65_536, source: 'official' },
  );
});

test('官方端点带尾斜杠也算官方端点（normalizeBaseUrl 的同一份语义）', () => {
  assert.equal(resolveModelLimits({ baseUrl: `${DEFAULT_BASE_URL}/`, model: 'deepseek-chat' }).source, 'official');
});

test('非官方端点一律走保守回落：256K 上下文 + 64K 输出', () => {
  const limits = resolveModelLimits({ baseUrl: 'https://gateway.example/v1', model: 'deepseek-v4-pro' });
  // 断言**字面量**而不是 FALLBACK_* 常量：那些常量就是这行返回值的来源，拿它对自己
  // 等于 X === X，改错常量时两边一起变、断言照绿。262_144 / 65_536 是拍板过的落盘事实。
  assert.deepEqual(
    { contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens, source: limits.source },
    { contextWindow: 262_144, maxOutputTokens: 65_536, source: 'fallback' },
  );
});

test('模型名缺失时也走官方端点的 default 行，不抛', () => {
  assert.equal(
    resolveModelLimits({ baseUrl: DEFAULT_BASE_URL, model: null }).maxOutputTokens,
    65_536,
  );
});

test('常量与表自洽（default 行写死官方端点的字面量）', () => {
  // 这里断言**字面量**：default 行本身就是拿 DEFAULT_CONTEXT_WINDOW / DEFAULT_MAX_OUTPUT_TOKENS
  // 构造的，用那两个常量来断言它恒真、改错常量也抓不到。钉字面量才钉得住这张表。
  assert.equal(OFFICIAL_MODEL_LIMITS.default.contextWindow, 1_000_000);
  assert.equal(OFFICIAL_MODEL_LIMITS.default.maxOutputTokens, 65_536);
});
