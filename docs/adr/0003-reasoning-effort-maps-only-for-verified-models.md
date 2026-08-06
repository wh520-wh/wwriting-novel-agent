# 思考强度只对已验证支持的模型真实映射

Composer 中的思考强度（低/中/高）保存为当前项目的默认 `reasoning_effort`（取值 auto/low/medium/high），只对**已验证真实支持**该参数的模型生效：请求体仅当模型能力声明 `reasoningEffortLevels` 且配置非 auto 档位时才携带 `reasoning_effort`；未验证模型（如 MiMo）与"自动"档位一律不发送该参数，界面只显示"自动"且不伪装低/中/高已生效。由于档位在每次请求构造时读取项目设置，其语义与模型/权限切换一致：从下一条用户输入开始生效，不改变正在执行的 Run。

能力判定来源：`src/core/model/capabilities.mjs`（DeepSeek 已验证 thinking 模型声明 `reasoningEffortLevels: ["low","medium","high"]`，其余模型缺省）；档位持久化在项目 `reasoning_effort`，请求注入点在 `src/core/model/openai-compatible.mjs`。
