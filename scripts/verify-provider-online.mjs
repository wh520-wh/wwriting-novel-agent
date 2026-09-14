import assert from "node:assert/strict";
import { OpenAICompatibleAdapter } from "../src/core/model/openai-compatible.mjs";

// 供应商在线验证（统一 Agent 内核计划 Task 9）：只验证 provider transport，
// 使用新 model/openai-compatible.mjs adapter 发一次最小请求。
const baseUrl = process.env.WWRITING_PROVIDER_BASE_URL;
const model = process.env.WRITING_PROVIDER_MODEL ?? process.env.WWRITING_PROVIDER_MODEL;
const apiKeyEnv = process.env.WWRITING_PROVIDER_API_KEY_ENV ?? "OPENAI_API_KEY";

if (!baseUrl || !model || !process.env[apiKeyEnv]) {
  throw new Error(
    [
      "provider_online_not_configured",
      "Set WWRITING_PROVIDER_BASE_URL, WWRITING_PROVIDER_MODEL, and the API key env named by WWRITING_PROVIDER_API_KEY_ENV or OPENAI_API_KEY."
    ].join(": ")
  );
}

const adapter = new OpenAICompatibleAdapter({
  baseUrl,
  apiKeyEnv
});

const result = await adapter.complete(
  {
    messages: [{ role: "user", content: 'Return exactly this JSON: {"ok":true,"source":"provider-online"}' }],
    stream: false,
    modelConfig: {
      model_name: model,
      max_output_tokens: 80
    }
  }
);

assert.ok(result.text.includes("provider-online") || result.text.includes('"ok"'));
assert.ok(result.usage);

console.log(
  JSON.stringify(
    {
      ok: true,
      providerOnline: true,
      baseUrl,
      model,
      text: result.text.slice(0, 200),
      usage: result.usage
    },
    null,
    2
  )
);
