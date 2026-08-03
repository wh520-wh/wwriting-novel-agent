# Claude Code 2.1.88 模型配置机制调研

**调研对象：** `<LOCAL_PATH>/node_modules/@anthropic-ai/claude-code/`
（`cli.js` 13M 压缩产物 + `cli.js.map` 57M sourcemap，后者内嵌未压缩原始 TS 源码）

**调研目的：** WWriting 刚完成「模型配置与项目解耦」，需要对照一个成熟实现，看还有哪些机制值得借鉴。

**结论提要：** Claude Code 的模型配置**完全不与工作目录绑定**，这一点与 WWriting 改造后的方向一致。它额外做了三件 WWriting 目前没有的事：分层配置带企业策略覆盖、缓存失效的自动检测与打点、模型能力差异的静态能力表 + 分级处理（静默降级 / 提示 / 报错阻止）。

---

## 一、配置存哪：五层合并，策略层最高

### 五个配置来源

代码里有显式枚举（`cli.js:169`）：

```js
cT = ["userSettings","projectSettings","localSettings","flagSettings","policySettings"]
```

对应磁盘位置（`cli.js:190`，函数 `Hj(q)` / `N_6(q)`）：

| 来源 | 路径 | 定位基准 |
| --- | --- | --- |
| `userSettings` | `~/.claude/settings.json` | 用户主目录 `c1()` |
| `projectSettings` | `<项目>/.claude/settings.json` | 项目根 `r1()` |
| `localSettings` | `<项目>/.claude/settings.local.json` | 项目根（gitignore） |
| `flagSettings` | `--settings` 指定的文件 | 命令行 |
| `policySettings` | `<系统托管目录>/managed-settings.json` | `MP()` 系统级目录 |

### 合并顺序与优先级

`HS5()`（`cli.js:191`）按 `cT` 数组顺序遍历，用 deep-merge（`Ol()` → `wL5`，`cli.js:129`）依次覆盖：

```
userSettings → projectSettings → localSettings → flagSettings → policySettings
```

**后合并者覆盖前者，所以 `policySettings`（企业策略）优先级最高**，`flagSettings` 次之。数组字段不是覆盖而是 concat 去重（`k_6`，`cli.js:190`）。

`policySettings` 自身还有四级来源，取第一个非空（`cli.js:191`）：

```
远程托管设置 wl() → 系统 MDM plist/HKLM 注册表 PD6() → managed-settings.json 文件/目录 SK1() → HKCU 用户级注册表 WD6()
```

`managed-settings.json` 所在目录支持 **drop-in 多文件叠加**（`SK1()`）：读目录内全部 `.json`，排序后依次合并。

### 另有一套独立的账户态文件

`~/.claude.json`（`j8()` / `XP()` 读取）与上面五层是**两套不同体系**。存放 `primaryApiKey`、`oauthAccount`、`customApiKeyResponses`、`additionalModelOptionsCache` 等账户级/运行期状态。

> **对照 WWriting：** 目前是 `global_config.json` / `project.yaml` / `local_config.json` / `policy_config.json` 四层（`config-runtime.mjs:29`），加上改造后新增的全局 `~/.wwriting/model-profiles.json` + `secrets.json`。层级思路一致，缺的是「企业策略优先级最高」这一层语义——不过个人本地写作工具用不上，不是缺陷。

---

## 二、模型怎么指定：四级优先级

### 解析函数

`jS()`（`cli.js:300`）：

```js
function jS(){
  let q, K = yx();                    // 运行期内存覆盖
  if (K !== void 0) q = K;
  else {
    let _ = Z7() || {};               // 合并后的 settings
    q = process.env.ANTHROPIC_MODEL || _.model || void 0;
  }
  if (q && !K86(q)) return;           // 企业白名单校验
  return q;
}
```

**优先级：** 运行期覆盖（`/model` 命令）> `ANTHROPIC_MODEL` 环境变量 > settings 文件 `model` 字段 > 内置默认 `If()`

`--model` CLI flag 优先于环境变量（`cli.js:16646`）。启动埋点直接印证三源关系（`cli.js:16657`）：

```js
d("tengu_startup_manual_model_config", {
  cli_flag: H.model,
  env_var: process.env.ANTHROPIC_MODEL,
  settings_file: (N7() || {}).model,
})
```

### 相关环境变量

`ANTHROPIC_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_`（各带 `_NAME`/`_DESCRIPTION`/`_SUPPORTED_CAPABILITIES` 变体）、`CLAUDE_CODE_SUBAGENT_MODEL`、`ANTHROPIC_BASE_URL`。

小模型取值（`cli.js:300`）：`function PH(){ return process.env.ANTHROPIC_SMALL_FAST_MODEL || g06() }`

### 企业白名单与 ID 重映射

`availableModels`（settings schema，`cli.js:188`）——管理员列出允许选择的模型，支持族名模糊匹配（写 `"opus"` 放行所有 opus 版本）。`K86()` 做校验，`x88()` 过滤 `/model` 菜单候选项。

`modelOverrides`（`cli.js:188`）——把官方 ID 重映射为自有部署 ID（如 Bedrock inference profile ARN）：

```js
function ezq(q){ let K = N7().modelOverrides; if(!K) return q;
  let _ = {...q};
  for (let [z,Y] of Object.entries(K)) { let $ = tzq[z]; if($ && Y) _[$] = Y }
  return _ }
```

---

## 三、API Key 存哪：macOS 用 Keychain，Windows/Linux 明文

### 后端选择

`cli.js:456`：

```js
function c3(){ if (process.platform === "darwin") return RCq(hCq, Gv1); return Gv1 }
```

`Gv1` 是明文后端。**Windows 和 Linux 一律明文存 `~/.claude/.credentials.json`**，写入时 `chmod 0600`（代码里是 `ke9(_,384)`，384 = 0o600），并返回警告：

```js
return { success: !0, warning: "Warning: Storing credentials in plaintext." }
```

macOS 走系统 `security add-generic-password` CLI，失败则 fallback 回明文（埋点 `tengu_api_key_saved_to_config`）。

### 认证来源优先级

`qS()`（`cli.js:456`）：

```
ANTHROPIC_AUTH_TOKEN → CLAUDE_CODE_OAUTH_TOKEN → CCR OAuth 文件 → apiKeyHelper → Keychain/明文里的 claude.ai OAuth token
```

### apiKeyHelper：外部命令供 key

Settings 字段（`cli.js:188`）：

```
apiKeyHelper: "Path to a script that outputs authentication values"
```

执行一条 shell 命令，把 stdout 当 API key。**带信任门禁**（`cli.js:456`）：

```
apiKeyHelper executed before workspace trust is confirmed
```

未确认工作区信任前阻止执行，防恶意仓库通过 settings 注入命令。

> **对照 WWriting：** 你的 `secrets.json` 是明文 + `chmod 0600`，与 Claude Code 在 Windows 上的做法**完全一致**。项目 CLAUDE.md 里「本地个人使用优先保障可见可确认」的取舍，跟官方在 Windows 上的实际行为是同一档。这条不用改。
>
> 值得注意的是 `apiKeyHelper` 的信任门禁思路：**配置文件里能指定被执行的命令时，必须先确认来源可信**。WWriting 目前没有这类「配置驱动执行」的入口，暂无风险，但若将来加类似能力要记得这一点。

---

## 四、有没有「模型清单」概念：有，但不是用户预设

搜 `modelProfile` / `modelConfig` / `knownModels` — **全部无匹配**。存在的是三层不同东西：

1. **内置注册表** `n66`（`cli.js:300`）——族名到各 provider 具体 ID 的映射，代码内部引用用：

```js
n66 = { haiku35:WJ1, haiku45:DJ1, sonnet35:PJ1, ..., opus46:G06 }
G06 = { firstParty:"claude-opus-4-6", bedrock:"us.anthropic.claude-opus-4-6-v1",
        vertex:"claude-opus-4-6", foundry:"claude-opus-4-6" }
```

2. **企业白名单** `availableModels` —— 管理员限定可选范围，不是用户自建清单。

3. **历史使用缓存** `additionalModelOptionsCache`（存于 `~/.claude.json`）—— `/model` 菜单会把用过的自定义模型追加进候选项。**这一条最接近 WWriting 的 `model-profiles.json`**，但它是被动累积的缓存，不是用户显式管理的清单（没有删除 UI）。

`/model` 菜单里的族名简写（`cli.js:300`）：

```js
Fz6 = ["sonnet","opus","haiku","best","sonnet[1m]","opus[1m]","opusplan"]
```

> **对照 WWriting：** 你的 `model-profiles.json` 带显式增删改和默认指针，**比 Claude Code 的被动缓存更完整**。原因也合理：Claude Code 的模型是官方固定几个，WWriting 要支持任意 openai-compatible 供应商，必须让用户自己管清单。这个设计不用改。

---

## 五、换模型：立即生效，会写盘，几乎不清状态

### 生效时机

`sNY()`（`cli.js:6734`）：

```js
function A(O){
  z((H) => ({...H, mainLoopModel:O, mainLoopModelForSession:null}));
  let w = `Set model to ${$8.bold(Nq8(O))}`;
  K(w);
}
```

同步改内存状态，**下一次请求就用新模型**，不需要重启。

### 会持久化到 userSettings

状态订阅 diff（`cli.js:7962`，`Ss()`）：

```js
if (q.mainLoopModel !== K.mainLoopModel && q.mainLoopModel !== null)
   W7("userSettings", { model: q.mainLoopModel }), YP(q.mainLoopModel);
```

`/model` 切换会写回 `~/.claude/settings.json`。另有一条**只当前会话不写盘**的通道 `mainLoopModelForSession`（UI 里显示为 "session override from plan mode"，`cli.js:6735`）。

### 切换时清理了什么

**几乎不清。** 只清理与模型直接联动的状态：

- 新模型不支持 fast mode 时自动关掉 `fastMode`（`cli.js:6734`）
- `mainLoopModelForSession` 清为 `null`

`clearSessionCaches`（`Cq7()`，`cli.js:5317`）确实存在，但**只在 `--continue`/`--resume` 恢复会话时调用**，`/model` 路径不触发。对话历史、prompt cache 都不动。

### 切换时的用户提示

| 场景 | 文案 |
| --- | --- |
| 成功 | `Set model to <名字>`，可能追加 `· Fast mode ON/OFF` 或 `· Billed as extra usage` |
| 不在企业白名单 | `Model '<name>' is not available. Your organization restricts model selection.` |
| 1M 上下文无权限 | `Opus 4.6 with 1M context is not available for your account. Learn more: ...` |
| 模型不存在 | `Model '<name>' not found` / `Failed to validate model: <message>` |

---

## 六、缓存失效：只检测打点，不告诉普通用户

**这是本次调研最有价值的发现。**

### 有专门的缓存断裂检测模块

`src/services/api/promptCacheBreakDetection.ts`（sourcemap idx=2374）。`PreviousState.model` / `PendingChanges.modelChanged` 是一等字段，专门记录模型是否变化：

```ts
const modelChanged = model !== prev.model
if (systemPromptChanged || toolSchemasChanged || modelChanged || ...) {
  ...
  previousModel: prev.model,
  newModel: model,
}
```

检测阈值：`cache_read_tokens` 比上次下降超过 `MIN_CACHE_MISS_TOKENS = 2_000` 且降幅 >5%，生成人类可读原因：

```ts
if (changes.modelChanged) {
  parts.push(`model changed (${changes.previousModel} → ${changes.newModel})`)
}
```

### 但只写 debug 日志

```ts
const summary = `[PROMPT CACHE BREAK] ${reason} [source=${querySource}, call #${state.callCount}, cache read: ${prevCacheRead} → ${cacheReadTokens}, ...]`
logForDebugging(summary, { level: 'warn' })
logEvent('tengu_prompt_cache_break', ...)
```

**只在 `--debug` 下可见，不会弹给普通用户「换模型会导致缓存失效、费用上升」这类提示。**

### compact 有豁免，换模型没有

`notifyCompaction()` 会在压缩后主动重置缓存基线，避免正常下降被误判：

```ts
export function notifyCompaction(querySource, agentId) {
  const state = ...
  if (state) { state.prevCacheReadTokens = null }
}
```

**换模型没有对应的豁免路径**——它只会被记录为 break 原因之一。说明官方把「换模型导致缓存失效」当成需要观测的真实成本事件，而非预期内的正常波动。

> **对照 WWriting：** 你有跨章 ~10% / 章内 ~67% 的缓存命中率，是实打实的成本资产。Claude Code 承认换模型必然打破缓存，并专门建了检测机制去观测它——但选择不打扰用户。
>
> WWriting 的处境不同：写小说是长跑，一本书几十章，缓存价值累积得更多，且用户是自己付钱、对成本敏感。**这里比 Claude Code 更值得给用户一句提示。**

---

## 七、模型能力差异：静态能力表 + 三级处理

### 判定方式：字符串匹配模型名，不做动态探测

`src/utils/thinking.ts`：

```ts
export function modelSupportsThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) return supported3P
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}
```

`src/utils/betas.ts` 的 `modelSupportsISP()` 同款逻辑。

### 三级处理策略

**A. 静默降级（多数情况）** —— 关掉功能，只写 debug 日志：

| 能力 | 处理 | 来源 |
| --- | --- | --- |
| thinking | 返回 false，不发 thinking 参数，无提示 | `utils/thinking.ts` |
| interleaved thinking | 不加 beta header，无提示 | `utils/betas.ts` |
| tool_reference（工具搜索） | 关闭 + debug 日志 | `utils/toolSearch.ts:~421` |
| auto mode（YOLO 分类器） | 关闭 + debug warn | `utils/permissions/permissionSetup.ts:~1176` |
| cached microcompact | 跳过该通道，退回 autocompact | `services/compact/microCompact.ts:~276` |

**B. 降级并告知** —— fast mode 自动关闭时，在切换消息末尾追加 `· Fast mode OFF`（三处一致：`commands/fast/fast.tsx`、`commands/model/model.tsx`、`components/PromptInput/PromptInput.tsx`）。

**C. 报错阻止** —— 用户主动操作触发的强约束：

- 1M 上下文无权限：拒绝切换并报错（`commands/model/model.tsx:~153`）
- `--advisor` 指定但模型不支持：**报错退出进程**（`main.tsx:~2125`）

```ts
if (!modelSupportsAdvisor(resolvedInitialModel)) {
  process.stderr.write(chalk.red(`Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`))
  process.exit(1)
}
```

- PDF 读取不支持：工具层明确报错（`tools/FileReadTool/FileReadTool.ts:~981`）

### 有一条「中途改配置要二次确认」的先例

`components/ThinkingToggle.tsx`：

```
Changing thinking mode mid-conversation will increase latency and may reduce quality.
For best results, set this at the start of a session.
Do you want to proceed?
```

**这是全代码库里唯一一处「中途改设置需要用户确认」的地方**，理由正是「会降低质量」。

> **对照 WWriting：** 你的 `resolveModelCapabilities`（`provider-adapters.mjs:575`）+ `PROVIDER_CAPABILITY_RESOLVERS` 注册表机制，跟 Claude Code 是同一套思路——静态能力表、按 provider 注册 resolver。架构上没落后。
>
> 差在**处理分级**：WWriting 目前基本只有「静默降级」一档。Claude Code 对用户主动操作触发的不兼容会报错阻止，对影响质量的中途变更会二次确认。

---

## 八、上下文跨模型延续

### context window 纯函数式，随当前模型重算

`utils/context.ts` 的 `getContextWindowForModel(model, betas)` 每次调用都按传入 model 重算（1M 后缀检测 → 服务端能力缓存 → beta header → 内部表 → 默认 200k 兜底）。**不记忆上一个模型的窗口大小。**

### 切到小窗口模型会立刻触发压缩

`services/compact/autoCompact.ts`：

```ts
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
}
```

`autoCompactIfNeeded` 内用 `toolUseContext.options.mainLoopModel` 取当前模型。**从 1M 模型切回 200k 模型，下一轮就会用新的更小阈值重判，直接触发 auto-compact。** 代码没为此写特殊分支，是阈值函数天然随参数变化的结果。

### 历史消息本身不因换模型清空

`/model` 只改 `mainLoopModel` / `mainLoopModelForSession` 两个字段，不碰 `messages`。只有 fallback 或 auto-compact 才动历史。

---

## 九、Fallback 降级链

### 触发条件严格

`services/api/withRetry.ts:~260`：

```ts
if (is529Error(error) &&
    (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
     (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))) {
  consecutive529Errors++
  if (consecutive529Errors >= MAX_529_RETRIES) {   // 3 次
    if (options.fallbackModel) {
      throw new FallbackTriggeredError(options.model, options.fallbackModel)
    }
  }
}
```

只在连续 3 次 529（overloaded）后触发，且限非订阅用户 + 非自定义 Opus 模型。`--fallback-model` 不能与主模型相同（`cli.js:~16624` 有校验报错）。

### 会明确告知用户

`query.ts:~943`：

```ts
// use 'warning' level so users see the notification without needing verbose mode
yield createSystemMessage(
  `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
  'warning',
)
```

### fallback 时的清理动作（比 /model 彻底得多）

1. 清空本轮 assistant/tool 消息，整个请求重放（避免孤立 tool_use/tool_result）
2. 丢弃重建 `StreamingToolExecutor`（防 orphan tool_result 带旧 id 泄漏）
3. 更新 `toolUseContext.options.mainLoopModel = fallbackModel`
4. 剥离 thinking 签名块——**签名与模型绑定，跨模型重放会 400**：

```ts
// Thinking signatures are model-bound: replaying a protected-thinking
// block (e.g. capybara) to an unprotected fallback (e.g. opus) 400s.
messagesForQuery = stripSignatureBlocks(messagesForQuery)
```

5. 打点 `tengu_model_fallback_triggered`

> **对照 WWriting：** 第 4 条值得留意。WWriting 用 DeepSeek 推理模型时，如果 transcript 里存了推理块，换到非推理模型可能同样出问题。这是个具体的兼容隐患。
>
> WWriting 目前**没有 fallback 机制**。写作是长任务，中途供应商超载会直接失败。这是个可以考虑的方向，但优先级不如前面几条。

---

## 十、给 WWriting 的对照结论

### 已经做对、不用改的

| 项 | 状态 |
| --- | --- |
| 模型配置与工作目录解耦 | ✅ 与 Claude Code 同向，改造后一致 |
| API Key 明文 + 0600 权限 | ✅ 与 Claude Code 在 Windows 上完全同款 |
| 分层配置合并 | ✅ 四层机制思路一致 |
| 静态能力表 + provider resolver 注册 | ✅ 架构与 Claude Code 同款 |
| 显式管理的模型清单（增删改 + 默认指针） | ✅ 比 Claude Code 的被动缓存更完整 |
| 换模型立即生效、不清历史 | ✅ 与 Claude Code 一致 |

### 值得补的，按价值排序

**1. 换模型时告知缓存代价（最值）**

Claude Code 专门建了检测机制观测「换模型打破缓存」，但选择不提示用户。WWriting 的处境更该提示：一本书几十章，缓存命中率 67%（章内），用户自付费。

切换时给一句人话即可：「换成 XX 后，这本书的缓存要重新攒，接下来一两章成本会略高。」

参考：`promptCacheBreakDetection.ts` 的 `modelChanged` 判定 + compact 有豁免而换模型没有的设计取向。

**2. 能力不兼容要分级处理，不能全静默**

Claude Code 对用户主动操作触发的不兼容会**报错阻止**（1M 无权限、advisor 不支持直接 exit(1)），WWriting 目前基本只有静默降级一档。

具体：换到不支持 `temperature` 的模型时，若项目里设了写作温度，应提示「这个模型不吃温度设置」，而非静默忽略让用户以为参数生效了。

参考：`commands/model/model.tsx:~153`（报错阻止）、`utils/toolSearch.ts:~421`（静默 + debug 日志的边界）。

**3. 章节中间不给换模型**

Claude Code 有唯一一处「中途改设置需二次确认」的先例（`ThinkingToggle.tsx`），理由是「会降低质量」。写作场景更严重——一章正在写时换模型，等于两个模型接力写同一章，最容易出接缝。

建议限制成「当前章写完再生效」，或至少二次确认。

**4. 推理块跨模型兼容性检查**

`query.ts` 的 `stripSignatureBlocks` 揭示了一个具体坑：thinking 签名与模型绑定，跨模型重放会 400。WWriting 用 DeepSeek 推理模型时，transcript 里的推理内容换模型后可能同样出问题。

值得验证一次：DeepSeek reasoner 写了几章后切到非推理模型，transcript 重放是否报错。

**5. 每本书记住自己的模型（可选）**

Claude Code 的模型是全局单值 + 会话级临时覆盖。WWriting 已经是「项目存快照 + 全局改动写回同步」，比它更贴合多项目场景。

但要注意一个语义问题：现在改全局会同步到所有项目。如果用户希望「A 书用便宜模型、B 书用贵模型」，当前的写回同步只在 `model_name` 相同时才覆盖字段，不会跨模型串改——这个行为是对的，但值得在 UI 上让用户看明白「这本书用的是哪个」。

**6. Fallback 降级链（低优先级）**

WWriting 目前没有。写作是长任务，供应商超载会直接失败。Claude Code 的做法是连续 3 次 529 才降级，且明确告知用户。可作为后续方向，优先级低于前三条。

---

## 附：调研方法备注

`cli.js` 是压缩混淆产物，变量名不可读，但**字符串常量完整保留**，可直接 `rg` 搜文案和 schema 描述定位。

`cli.js.map` 内嵌 `sourcesContent`，含未压缩原始 TS/TSX 源码，是更好的证据来源。但该文件物理上只有 4764 行（整个 map 是几个巨型 JSON 单行），无法按行定位，需先用脚本解析 JSON 再按源文件内容检索。

两个文件都极大（13M / 57M），**不可整体读取**，必须 `rg` + `-C` 上下文，或 `Read` 带精确 offset/limit。
