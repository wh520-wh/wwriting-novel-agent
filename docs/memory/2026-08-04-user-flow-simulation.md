# 2026-08-04 用户流程模拟回归脚本 + 真实模型链路验证

- 关联：[[2026-08-04-novel-planning-system-and-chat-ui-optimization-design]]（spec）、[[2026-08-04-novel-planning-system-and-chat-ui-optimization]]（plan）
- 分支：`feat/novel-planning-chat-ui`（工作树 `D:\WWriting\.worktrees\novel-planning-chat-ui`，未合并）
- 提交：`45a64e9` 之后（含 agent-transcript 空消息修复）

## 用户流程模拟脚本（新增，硬性维护义务）

`scripts/simulate-user-flow.mjs`，npm script：`npm run sim:user-flow`。

**用途**：模拟用户真实操作全链路（真实模型端到端回归），验证"中间有没有阻断"：

1. 新建项目 → `blueprint_status: none` + 写作被拒（门禁）
2. 触发 `/init` 生成蓝图 → `complete` + 放行
3. 写作第 1 章（runProject 完整流程：drafting → 门禁 → fact-check → 落盘）
4. 连续写作第 2 章
5. chat 对话触发读工具（get_status / list_chapters / read_blueprint）
6. chat 写工具链路（update_blueprint → pending 确认 → approve → 骨架打勾）

**用法**：`DEEPSEEK_API_KEY=sk-xxx node scripts/simulate-user-flow.mjs`（可选 `MODEL_NAME`，默认 `deepseek-v4-flash` 最便宜）。

**★ 维护义务（用户要求）**：修改核心链路代码（project-store / blueprint-init / agent-engine / chat-agent / tool-registry / prompt 注入 / 门禁 / 跑偏核对）后，**必须同步更新本脚本并跑通验证**，保证用户真实调用可用。真实 API 会暴露 mock 测试测不出的协议问题，本脚本是最后防线。

## 真实模型链路验证发现（DeepSeek v4 flash，2026-08-04）

### 1. 空 assistant 消息 → API 400（已修复，代码 bug）

**现象**：写章循环中模型偶发返回空响应（无 content 无 tool_calls），`appendAssistant` 把 `{"role":"assistant"}` 空消息写入 transcript，下一轮请求被 DeepSeek 拒绝：

```
Invalid assistant message: content or tool_calls must be set (HTTP 400)
```

**修复**：`src/core/agent-transcript.mjs` `appendAssistant` 增加过滤——content 空且无 tool_calls 的消息**跳过入史**（模型沉默轮次无决策，跳过不影响语义与 pendingToolCalls 不变式）。回归 72/72 pass；修复后第 1 章真实写作成功。

**教训**：mock 模型不校验消息形状合法性，此类协议 bug 只有真实 API 能暴露——模拟脚本必须保留并持续维护。

### 2. Flash 模型写章稳定性（已知风险，非代码 bug，未修复）

**现象**：第 1 章写作成功（4 个并行工具调用、6121 字、事件链完整）；**第 2 章 blocked（model_output_invalid）**——模型反复把工具名（`append_chapter_segment` / `read_continuity`）或 prompt 内部字段名复述进正文，被 `non_prose_output` 检测拦截 7 次（attempt 1-7）后 3 次失败打满 → blocked。

**判断**：检测逻辑与 blocked 保护机制工作正常（第 1 章成功证明链路 OK）；属 Flash 模型对写章 agent 协议遵循不稳定（模型适配/提示工程问题），后续可考虑写章循环 prompt 强化或模型选择建议。

### 3. 其余链路全部通过

- /init 真实生成（玄幻 32.9s / 都市 42.5s）：题材字段分化命中（主角金手指/能力体系/修为阶层）、原子提交、放行
- compileChapterPrompt 真实注入：outline/setting/主线/角色状态块全部就位
- runFactCheck 真实跑偏核对：模型正确识别"放下复仇去种田"偏离主线（deviation.detected=true + reportHint），不进 needs_revision
- chat 读工具：get_status + list_chapters + read_blueprint 三工具成功，回复质量高
- chat 写工具：update_blueprint → pending → approve → 骨架 `[x] 第1章` 打勾成功
