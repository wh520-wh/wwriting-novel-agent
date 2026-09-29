# 首次引导按「config.json 不存在」触发，不按「未配置」触发

引导只在配置文件根本不存在时出现（判据是 `loadModelConfig().configExists`，
不是 `configured`）。跳过引导会写下一份只有 `{ provider, base_url }` 的最小配置，
用来标记「问过了」。

**为什么不能按 `configured` 触发**

跳过引导的人，配置里就是没有 Key，`configured` 永远为假——按它触发，这些人
**每次启动都会被再问一遍**。

**Consequences**

- 「未配置」不是错误路径。没配 Key 照样能发消息，发送时事件桥把
  `MODEL_NOT_CONFIGURED` 映射成短状态「未配置」+ 一条中文事实。
  **绝不能为了让用户去配置而拦住发送**——这是产品立场，不是容错。
- 模型名不写死在代码里：引导调 `GET <baseUrl>/models` 取真实列表。
  换厂商或换模型时，引导一行都不用改。
- 厂商与模型用上下键选择器（`src/terminal/select.mjs`），**不要退回「输入序号」**。
  真实事故：用户把 `deepseek-flash` 输进了厂商步、把 API Key 粘进了模型名那一格。
  引导还必须能从被写坏的配置里把 Key 捞回来（`salvageKeyFromModel`）。
