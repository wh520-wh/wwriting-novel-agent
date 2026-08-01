# 2026-08-01 标准化输出与 agent 稳定性落地

- 关联：[[writing-agent-reflection-loop-done]]、[[deepseek-cache-optimization-done]]、[[agent-runtime-refactor-done]]
- 计划：[[2026-08-01-standardized-output-and-agent-stability]]（docs/superpowers/plans/）
- 合并：`64128ae`（merge --no-ff → master，15 commits，25 files，+1233/-138）

## 落地内容

1. **structured-output 统一契约层**（`src/core/structured-output.mjs`）
   - 版本化 schema 注册表（`registerSchema` 幂等）+ `parseStructuredOutput` + 可分类错误码
   - 错误码：`invalid_json | missing_field | enum_violation | empty_content | schema_not_found`（无 truncated，截断检测留给上游按 finish_reason=length 判断）
   - memory/fact-check/writing-intent 已委托；planning/outline 未来按 writing_intent 模式扩展即可

2. **memory/fact-check 解析委托**（`memory-extractor.mjs` / `quality-gates.mjs`）
   - `error` 保持字符串向后兼容（`agent-engine.mjs` 的 `${parsed.error}` 拼接零改动），分类在新增 `error_code`/`error_field`
   - 归一化逻辑 1:1 搬进 schema normalize，现有归一化函数未重写

3. **capability matrix**（`provider-adapters.mjs` `resolveModelCapabilities`）
   - `isReasonerModel` 保留薄封装委托（行为 1:1，L3 cacheKey 稳定）
   - `generate` 按 capability 注入 `response_format=json_object`（DeepSeek JSON Output）
   - `buildMessages` system 注入规则：**首条消息非 system 才注入**（写作循环多轮有 system；聊天首条恒 system 不重注入）
   - 连接测试/L3 缓存不再对思考模型硬编码 `temperature: 0`

4. **写作 agent 多轮 transcript + 崩溃恢复**（`agent-transcript.mjs` + `agent-engine.mjs`）
   - `ToolTranscript`：保存完整消息链（reasoning_content + tool_calls + role=tool 结果），result 超 4000 字符截断，serialize/restore
   - 循环多轮化：首轮编译 prompt，后续轮次 `transcript_messages` 回放（跳过重编译与 cacheKeyManager，`multi_turn` 标记）
   - pending 文件 `memory/.pending-transcript-{ch}-{seg}.json`：每轮 appendAssistant 后落盘（覆盖"模型决策后工具执行前"窗口）、工具回执统一出口落盘、**调用方**（draftNextSegment/reviseChapter）在 checkpoint 与中断检查后清理
   - 恢复：pending 存在即 `restored_transcript` 续写；`trimUnresolvedAssistantTurns` 裁剪尾部未回执轮次（API 形状合法）；append_chapter_segment 幂等 marker 防重放
   - 拒绝反馈进 transcript：带 tool_call id → `role=tool` 回执（防 API 400 + 反馈喂回），无 id → user 消息
   - checkpoint 增 `transcript` 字段备份；`readLastCheckpoint`（project-store）备份用

5. **聊天 agent 原生 tool calling**（Phase 3）
   - `toOpenAITools`（registry params 扁平表转 JSON Schema）+ `buildChapterToolRequest` 接受 `toolRequest.tools`（tool_choice:"auto"）
   - `parseAgentReply` 优先原生 `raw.choices[0].message.tool_calls`，围栏/XML/裸 JSON 降为兜底
   - 聊天回复截断检测：`finish_reason=length` → TRUNCATED_NOTE 标注 + `chat_reply_truncated` warn 事件
   - `writing-intent.mjs`：`writing_intent@v1` schema + `compileWritingIntent`（已注册未接线，前瞻 API）

## 已知注意点

- 聊天带 tools 后走 usesChapterTool 路径：无显式 max_tokens 时默认 4096（截断已检测标注）
- 多轮轮次 `cache_report.json` last_call 为 null（避免幻影条目；entries 快照仍保留真实首轮条目）
- 记忆 vault 不在本机可访问路径，本条记忆写入 `docs/memory/`（如 vault 可用可移入）
- 未推送远端；feature 分支已删除
