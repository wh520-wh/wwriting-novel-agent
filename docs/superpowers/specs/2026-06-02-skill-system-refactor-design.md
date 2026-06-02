# WWriting 技能系统重构设计

**日期:** 2026-06-02
**状态:** v2（修正 v1 的事实错误后定稿）
**范围:** 5 个改动 — 声明式 slash 命令注册表 / 路径条件激活 / 多源发现层 / 全局事件总线 / 输出风格 .md 化
**总方向:** 借鉴 Claude Code（参考源码 E:\claude_code_src-master\claude_code_src-master）的 skills/memdir/tools 三个子系统，把 WWriting 当前散落的 hard-coded slash 命令与缺失的能力（条件激活 / 用户态自定义 / 输出风格可扩展）补齐

---

## 1. 现状盘点（v1 spec 的事实修正）

> **重要修正：** v1 spec 写了 4 处与现状不符的描述，下面以代码实际状态为准。

### 1.1 当前 skill-runtime 已经有（不需要重建）

`src/core/skill-runtime.mjs`（截至 2026-06-02）已经具备：
- ✅ `BUILTIN_SKILLS` 字典（line 10-36，内置 1 个 `suspense-chapter-end`）
- ✅ `normalizeSkillManifest` 校验（line 217-240，校验 name/version/type/scope）
- ✅ Hook 系统（line 256-270，5 个 stage: planning/drafting/reviewing/revising/post_process，3 个 action: append_prompt/check/post_process）
- ✅ 多 manifest 格式（line 272-280，支持 `skill.json` / `skill.yaml` / `skill.yml`）
- ✅ YAML 解析（`parseSkillManifest` 失败时 fallback 到 `parseSkillYaml`）
- ✅ 优先级 + dedup（line 86, 92-99）
- ✅ `loadEnabledSkills` / `listProjectSkills` / `readSkillManifest` 等 API

**这意味着 B4 不是"从零建 Hook 系统"，而是"在现有 skill 内部 hook 之外，加一个全局事件总线"**。

### 1.2 composer.js 当前有 5 个 hard-coded slash 命令

`src/app-shell/composer.js` line 13-17：
- `/write` — 提交正式写作任务
- `/review` — 审稿修订
- `/ask` — 旁路询问
- `/chapters` — 打开右侧章节面板
- `/settings` — 打开设置弹窗

前 3 个走 `/api/commands/submit` 或 `/ask`，后 2 个是 UI 操作（开抽屉/开弹窗）。**所有 5 个都是硬编码**。

### 1.3 `src/app-shell/components/` 没有 `*Skill.js` 文件

实际只有 4 个文件：`activity-strip.js` / `failure-card.js` / `last-seen.js` / `quick-rail.js`。**v1 spec 写的"14 个 *Skill.js"是错的**。skill 的 JS 代码在 `BUILTIN_SKILLS` 字典与各模块的 `import` 中。

### 1.4 真正的缺口

1. **slash 命令硬编码** — composer.js 5 个命令直接写死，新增要改 JS
2. **路径条件激活缺失** — 现有 skill 无 `paths` 字段，所有启用 skill 全量注入模型上下文
3. **用户级 / dist-desktop 源缺失** — `loadEnabledSkills` 只扫 `<projectRoot>/skills/`，不扫 `~/.wwriting/skills/` 和 dist-desktop
4. **没有 realpath dedup** — symlink / OneDrive 双挂载会导致重复
5. **没有全局事件总线** — cost-tracker / event-log / failures-store 通过直接调用耦合，新增订阅者要改所有发起方
6. **没有输出风格可扩展** — prompt 风格写死在 `prompt-compiler.mjs`

---

## 2. 目标

### 用户能感受到的

- 在 `~/.wwriting/skills/<test>/skill.yaml` 写一个技能，**不重启**就能在项目里看到
- 写作类技能按目录自动激活（`paths: ['chapters/poetry/**']` 只在该子目录加载）
- 设置面板多一个"输出风格"下拉，内置创作/审稿两种，用户可以放自己写的 `.md`
- 章节生成失败时 event-log 自动记结构化原因，UI 不用改

### 开发者能感受到的

- 新增 slash 命令 = 写一个 plain object + register，不改 composer.js
- cost-tracker / event-log / failures-store 各自订阅事件总线，互不耦合
- 5 个改动完成后，命令栏、quick-rail、settings-modal、thread-renderer 都从同一份数据拿

---

## 3. 不包含的工作

- **不**做"用户态技能编辑器" GUI（用户能写 .md 就行，编辑器留给后续）
- **不**做 zod / gray-matter / matter-js 依赖（复用现有 `parseSkillYaml`）
- **不**做 Coordinator 多 agent 模式（M3+ 阶段）
- **不**做 4-type 记忆 taxonomy（M3+ 阶段）
- **不**重写 settings-modal 整个面板（只加"输出风格"下拉）
- **不**改 `BUILTIN_SKILLS` 现有的钩子语义（继续按 stage/action 走，新事件总线是补充）

---

## 4. 五个改动（B1 → B5）

### B1. 声明式 Slash 命令注册表

**目标:** 把 composer.js 中硬编码的 5 个 slash 命令抽进数据驱动注册表。

**新建文件:**
- `src/app-shell/command-registry.mjs` — 注册表（Map + signal）
- `src/app-shell/commands/_schema.mjs` — 手写 schema 校验
- `src/app-shell/commands/write.mjs`、`review.mjs`、`ask.mjs`、`chapters.mjs`、`settings.mjs` — 5 个命令
- `src/app-shell/commands/index.mjs` — `registerCommand(...) × 5`
- `tests/command-registry.test.mjs`

**修改文件:**
- `src/app-shell/composer.js` — slash 菜单改为 `listCommands({ userInvocable: true })`，执行改 `getCommand(name).run(input, ctx)`
- `src/app-shell/quick-rail.js` — 快捷按钮从注册表取

**数据形状:**

```js
export const writeCommand = {
  name: 'write',
  category: 'writing',
  description: '把指令作为正式写作任务交给智能体',
  userFacingName: () => '开始/续写',
  userInvocable: true,
  icon: 'compose',
  isConcurrencySafe: false,
  isReadOnly: false,
  isEnabled: () => hasActiveProject(),
  canUse: (ctx) => ctx.projectRoot != null,
  run: async (input, ctx) => {
    return await postJson('/api/commands/submit', { message: input.message, mode: 'write' });
  },
  renderResult: (output, ctx) => ({ kind: 'write-started', message: input.message })
};
```

UI-only 命令（`/chapters` / `/settings`）：

```js
export const chaptersCommand = {
  name: 'chapters',
  category: 'project',
  description: '在右侧面板查看本地章节文件',
  userInvocable: true,
  icon: 'book',
  isReadOnly: true,
  isConcurrencySafe: true,
  run: async (_input, ctx) => {
    ctx.openDrawer('chapters');
    return { kind: 'drawer-opened', panel: 'chapters' };
  }
};
```

**注册表 API:**

```js
registerCommand(cmd)        // 校验 + dedup by name + 广播
unregisterCommand(name)     // 删除 + 广播
getCommand(name)            // 单查
listCommands(filter?)       // 列表 + 过滤
onCommandsChanged(cb)       // 订阅
```

**测试用例:**
- 同名注册:后者覆盖前者,广播 1 次
- 列表过滤:category / userInvocable / isEnabled
- canUse 返 false 抛 `CommandNotAllowed`
- 5 个内置命令的 `run` 在新壳中与原 composer.js 行为一致
- 异常路径:run 抛错不污染 Map

**关键风险:** composer.js 现有 5 个命令的逻辑分散在 line 13-17、line 163-204 等多处,迁移时必须保证 UI-only 命令(`/chapters` `/settings`)和后端命令(`/write` `/review` `/ask`)都正确分发。

---

### B2. 路径条件激活

**目标:** 写作类技能按目录自动激活,不污染其他项目的 prompt。

**修改文件:**
- `src/core/skill-runtime.mjs` — manifest schema 加 `paths: string[]` 字段
- `src/core/agent-engine.mjs` — 注入 skill 前过滤
- `src/app-shell/composer.js` — 提交前对涉及文件路径做条件激活
- `package.json` — 加 `ignore` 依赖

**新增 export（在 `skill-runtime.mjs`）:**

```js
parseSkillPaths(frontmatter)                  // string[] | undefined
activateConditionalSkillsForPaths(filePaths, projectRoot, currentSkills)
listConditionalSkills()                       // 当前未激活列表
listActivatedSkills()                         // 已被激活的（跨缓存清除保留）
```

**核心逻辑:**

- 加载时: 带 `paths` 的 skill 进 `conditionalSkills: Map`,不挂载到活跃列表
- composer 提交消息前: 对涉及文件路径调 `activateConditionalSkillsForPaths`,命中后移入 `activeSkills`,名字进 `activatedNames: Set`
- 缓存清除时 `activatedNames` 保留(防回弹)

**路径解析规则（从 Claude Code 借鉴）:**
- 切多行 → 去 `/**` 后缀 → 全部是 `**` 降级为 undefined
- 越界/绝对/外部路径不匹配
- gitignore 风格匹配(用 `ignore` 库)

**测试文件:** `tests/skill-runtime-paths.test.mjs`

**用例:**
- `paths: ['chapters/poetry/**']` → `['chapters/poetry']`
- 全部 `**` 降级为 undefined
- 命中后 conditional → active
- 越界路径不匹配
- 清缓存后 activatedNames 仍保留

---

### B3. 多源发现层

**目标:** bundled / user / project 三层有统一优先级与 dedup,挡 OneDrive 双挂载的 symlink 重复。

**修改文件:**
- `src/core/skill-runtime.mjs` — 新增 `resolveSkillSources`,重构 `loadEnabledSkills`

**5 个来源（按优先级降序）:**

| 优先级 | 路径 | 来源类型 |
|---|---|---|
| 1 | `process.resourcesPath/skills/` | bundled 出厂(dist-desktop 资源目录) |
| 2 | `~/.wwriting/skills/` | user 用户级 |
| 3 | `<projectRoot>/skills/` | project 项目级(已有) |
| 4 | plugin (留接口) | — |
| 5 | BUILTIN_SKILLS 字典 | bundled 内置(已有) |

**核心逻辑:**
- `fs.promises.realpath` 做身份识别
- `seenFileIds: Map<realpath, source>` first-wins 去重
- 暴露 `resolveSkillSources({ projectRoot, userHome, resourcesPath })`

**Windows 特定处理:**
- `process.resourcesPath` 在打包后指向 `dist-desktop/win-unpacked/resources/`
- 用户级路径用 `os.homedir()` 拼 `.wwriting/skills/`
- 缺某一来源不报错,降级跳过

**测试文件:** `tests/skill-runtime-sources.test.mjs`

**用例:**
- 5 个来源扫描顺序与优先级
- symlink 指向同一文件 → 只保留第一个
- 缺用户级目录不报错
- 启动扫盘 < 100ms(基准:1 项目 5 个 skill)

---

### B4. 全局事件总线

**目标:** 把"模型调用后记账"、"任务失败打点"、"章节写入备份"这些**跨模块副作用**从直接调用改为订阅。

> **与 v1 设计的区别:** 不重建 hook 系统。现有 skill-runtime 内部的 stage/action hook(line 256-270)继续保留,新事件总线是**平行的**全局事件层。

**新建文件:**
- `src/core/event-bus.mjs` — 注册表 + 触发器
- `tests/event-bus.test.mjs`

**修改文件:**
- `src/core/agent-engine.mjs` — 3 处 fire(model-call / chapter-write / task-failed)
- `src/core/cost-tracker.mjs` — 订阅 `model-call:complete` 替代直接调用
- `src/core/event-log.mjs` — 订阅 `task:failed` / `chapter:written`
- `src/core/failures-store.mjs` — 订阅 `task:failed` 替代直接调用

**事件枚举（5 个就够）:**

```js
export const CORE_EVENTS = Object.freeze({
  ModelCallStart:   'model-call:start',     // 调模型前
  ModelCallComplete:'model-call:complete',  // 调模型后(含 usage)
  ChapterWritten:   'chapter:written',      // 章节写入落盘后
  TaskFailed:       'task:failed',          // 任务失败
  BackupNeeded:     'backup:needed'         // 触发自动备份
});
```

**API:**

```js
on(event, fn)        // 订阅
off(event, fn)       // 取消订阅
emit(event, payload) // 触发,Promise.allSettled
```

**emit 行为:**
- `Promise.allSettled` 等待所有订阅者
- 单订阅者抛错 → 收集到 `result.errors[]`,主流程继续
- 返回 `{ ok: boolean, errors: Array<{event, error, listener}> }`

**集成点迁移:**

| 旧调用 | 新订阅 |
|---|---|
| cost-tracker.recordUsage() 直接调用 | cost-tracker 订阅 `model-call:complete` |
| failures-store.appendFailure() 直接调用 | failures-store 订阅 `task:failed` |
| event-log.appendEvent() 直接调用 | event-log 订阅 `task:failed` / `chapter:written` |
| agent-engine 写章节前手动备份 | 订阅 `backup:needed` 的 listener 写备份 |

**测试用例:**
- 多订阅者全部触发
- 抛错的订阅者不影响其他
- 注销后不再触发
- async 订阅者被 await
- emit 的 errors 数组结构

**关键风险:** 现有 cost-tracker / event-log / failures-store 是**同步**直接调用,迁移到异步订阅可能改变行为(原本写入失败抛错,现在吞错)。**必须保证订阅者用 try/catch 自己处理**。

---

### B5. 输出风格 .md 化

**目标:** 用户可在 `~/.wwriting/output-styles/*.md` 自定义 prompt 风格。

**新建文件:**
- `src/app-shell/output-style-loader.mjs` — 3 来源加载 + frontmatter 解析
- `tests/output-style-loader.test.mjs`

**修改文件:**
- `src/app-shell/settings-modal.js` — 加"输出风格"下拉
- `src/core/prompt-compiler.mjs` — 拼装 system prompt 追加当前风格
- `src/core/app-state.mjs` — `settings.outputStyle` 字段

**3 个来源:**

| 优先级 | 路径 |
|---|---|
| 1 | bundled 内置 2 种(创作模式、审稿模式) |
| 2 | `~/.wwriting/output-styles/*.md` |
| 3 | `<projectRoot>/.wwriting/output-styles/*.md` |

**frontmatter 字段:**

```yaml
---
name: 创作模式
description: 长跑章节生成时使用,强调氛围与人物心理
keep-coding-instructions: false
---
正文作为 prompt 片段,追加到 system prompt 末尾
```

**测试用例:**
- 3 来源加载顺序与优先级
- frontmatter 缺 name 跳过 + warn
- body 为空仍能加载
- 切换风格后下次 prompt-compiler 看到新值

---

## 5. 数据流

### 启动

```
1. resolveSkillSources() 扫 5 个来源
   → realpath dedup
   → simple-yaml / parseSkillYaml 解析
   → normalizeSkillManifest 校验
   → 加载到内存
2. bundled 内置 5 个 slash 命令 registerCommand()
3. quick-rail / composer 订阅 commandsChanged
4. settings-modal 加载 output-style 清单
5. event-bus 启动
```

### 用户提交 `/write`

```
1. composer.parse('/write foo bar') → { name: 'write', input: { message: 'foo bar' } }
2. getCommand('write') → cmd
3. cmd.isEnabled() ? 继续 : 拒绝
4. activateConditionalSkillsForPaths(涉及文件, projectRoot)
5. cmd.canUse(ctx) ? 继续 : 抛 CommandNotAllowed
6. emit('model-call:start', { model, messages })
7. cmd.run(input, ctx) → output
8. emit('model-call:complete', { usage, model })
9. emit('chapter:written', { path, content })
10. cmd.renderResult(output, ctx) → UI 增量
11. thread-renderer 渲染
```

### 用户保存新 skill.yaml

```
1. watcher 检测到 .wwriting/skills/xxx/skill.yaml 变更
2. skill-runtime 失效该路径缓存
3. resolveSkillSources() 重扫
4. 增量 register / unregister
5. commandsChanged.emit() → quick-rail / composer 重新拿清单
```

### 错误处理统一

| 层 | 错误 | 行为 |
|---|---|---|
| 注册表 | 重复名 / 缺字段 | 抛 `CommandValidationError`(构造 fail-fast) |
| 运行时 | canUse 返 false | 抛 `CommandNotAllowed`(UI toast) |
| 业务 | run 抛错 | 包成 `{ ok: false, error }` 返,不污染 Map |
| 事件总线 | 单订阅者抛错 | 收集到 `result.errors[]`,主流程继续 |
| 加载 | 单 SKILL.md 解析失败 | 跳过 + console.warn,不让坏文件阻塞全部 |

---

## 6. 文件变更总览

### 新建

| 文件 | 行数预估 | 职责 |
|---|---|---|
| `src/app-shell/command-registry.mjs` | ~120 | slash 命令注册表 + signal |
| `src/app-shell/commands/_schema.mjs` | ~60 | 手写 schema 校验 |
| `src/app-shell/commands/write.mjs` | ~40 | |
| `src/app-shell/commands/review.mjs` | ~40 | |
| `src/app-shell/commands/ask.mjs` | ~40 | |
| `src/app-shell/commands/chapters.mjs` | ~30 | UI-only |
| `src/app-shell/commands/settings.mjs` | ~30 | UI-only |
| `src/app-shell/commands/index.mjs` | ~20 | 一次性注册 |
| `src/core/event-bus.mjs` | ~100 | 全局事件总线 + 5 事件 |
| `src/app-shell/output-style-loader.mjs` | ~120 | 3 来源加载 |
| `tests/command-registry.test.mjs` | ~200 | B1 |
| `tests/skill-runtime-paths.test.mjs` | ~150 | B2 |
| `tests/skill-runtime-sources.test.mjs` | ~150 | B3 |
| `tests/event-bus.test.mjs` | ~150 | B4 |
| `tests/output-style-loader.test.mjs` | ~120 | B5 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/app-shell/composer.js` | slash 菜单改用注册表 + 路径条件激活 |
| `src/app-shell/quick-rail.js` | 改用 listCommands |
| `src/app-shell/settings-modal.js` | 加"输出风格"下拉 |
| `src/core/skill-runtime.mjs` | 加 parseSkillPaths / activateConditionalSkillsForPaths / resolveSkillSources |
| `src/core/agent-engine.mjs` | 3 处 emit 事件 |
| `src/core/cost-tracker.mjs` | 订阅 `model-call:complete` 替代直接调用 |
| `src/core/event-log.mjs` | 订阅 `task:failed` / `chapter:written` |
| `src/core/failures-store.mjs` | 订阅 `task:failed` |
| `src/core/prompt-compiler.mjs` | 拼装 system prompt 追加 outputStyle |
| `src/core/app-state.mjs` | `settings.outputStyle` 字段 |
| `package.json` | 加 `ignore` 依赖 |

**保留不动:**
- `BUILTIN_SKILLS` 字典与现有 stage/action hook 语义
- 14 个 `app-state` 事件总线
- 现有 4 个 `app-shell/components/*.js`

---

## 7. 验证策略

### 每完成一个子项立即跑

```powershell
node --test tests/<新测试>.test.mjs
npm run verify:app-shell
npm run verify:app-clickability
```

### 全部完成后

```powershell
npm test                # 54 → 60+ 测试
npm run verify:local    # 包含打包
```

### B1 专项验证

`verify:app-clickability` 必须显式覆盖 5 个 slash 命令:
- `/write` 触发后能在 thread-renderer 看到"写作任务已提交"块
- `/review` 触发后能看到审稿任务
- `/ask` 触发后能进入旁路询问
- `/chapters` 触发后右侧抽屉打开
- `/settings` 触发后设置弹窗打开

如果现有 verify-app-clickability.cjs 未覆盖这 5 个端到端,迁移前**先扩展测试脚本**。

### B4 专项验证

- 故意触发一次模型 401 → event-bus 收到 `task:failed`,cost-tracker 不累加(因为是失败),event-log 记失败
- 章节生成成功 → event-bus 收到 `chapter:written` + `model-call:complete`,cost-tracker 累加
- 验证 `emit` 的 `result.errors[]` 在订阅者抛错时不污染主流程

---

## 8. 实施顺序与依赖

```
B1 (slash 注册表) ─────┐
                       ├─→ B2 (条件激活, 依赖 B1 的 activeSkills 概念)
B3 (多源发现层) ───────┘
                       └─→ B4 (事件总线, 独立, 任何时候可插入)
                            └─→ B5 (输出风格, 独立, 最后做)
```

- B1 完成后: `verify:app-clickability` 验证 5 个 slash 命令
- B3 完成后: bundled 出厂技能可被 `~/.wwriting/skills/` 覆盖
- B2 在 B1 + B3 基础上做,才有"激活的技能"概念
- B4 完全独立,任何时候可插入
- B5 完全独立,放最后(最不影响)

**推荐节奏:**
- 第 1-2 天: B1
- 第 3 天: B3
- 第 4-5 天: B2
- 第 6-7 天: B4
- 第 8 天: B5
- 第 9 天: 完整 `verify:local` + 交付报告

---

## 9. 风险登记与控制

| 风险 | 等级 | 控制 |
|---|---|---|
| B1 迁移破坏 5 个 slash 命令 | 高 | B1 完成后强制跑 `verify:app-clickability` 验证 5 个命令;迁移前先扩展测试脚本覆盖 5 个端到端 |
| B2 路径过滤让作者看不到需要的技能 | 中 | settings-modal 提供"显示全部技能"开关,默认按 paths 过滤 |
| B3 多源扫盘启动时间变长 | 中 | 实测 < 100ms 才接;超时降级到 bundled-only |
| B4 异步订阅改变原本同步行为 | 高 | 订阅者必须自己 try/catch;主流程不依赖订阅者结果;测试覆盖异常路径 |
| B4 死循环(A 触发 B 触发 A) | 中 | 事件名白名单 + 集成点只 emit 不订阅自己 emit 的事件 |
| B5 输出风格切换导致 prompt 抖动 | 低 | prompt-compiler 加注释说明风格片段位置;bundled 默认风格确保总有值 |
| `ignore` 库版本兼容 | 低 | 锁版本到 `^5.3.0` |
| SKILL.md / skill.yaml 错误格式污染 | 低 | normalizeSkillManifest 校验 + 加载时 fail-soft |

---

## 10. 成功标准

### 功能验收

- [ ] `verify:app-clickability` 通过(5 个 slash 命令 + settings-modal 输出风格下拉)
- [ ] `verify:app-shell` 通过
- [ ] `npm test` 通过(54 → 60+ 测试)
- [ ] `verify:local` 通过
- [ ] 在 `~/.wwriting/skills/<test>/skill.yaml` 写一个测试技能,能在项目里被加载

### 架构验收

- [ ] `composer.js` 不再硬编码 5 个 slash 命令
- [ ] cost-tracker / event-log / failures-store 订阅事件总线,不再被直接调用
- [ ] `quick-rail.js` / `settings-modal.js` 都从注册表拿数据
- [ ] 用户能在 `~/.wwriting/output-styles/` 写自定义风格

### 兼容性验收(关键)

- [ ] 现有 `BUILTIN_SKILLS` 与 stage/action hook 语义不变
- [ ] 现有 `app-state` 事件总线不被替换(事件总线是新增,不是替代)
- [ ] 14 个硬编码 `*Skill.js` 概念(实际不存在)不影响,真实 4 个 components 文件不动

### 文档验收

- [ ] 用户文档加一节"如何写自定义技能(skill.yaml)"
- [ ] 用户文档加一节"如何写自定义输出风格(.md)"
- [ ] developer 文档加一节"如何新增 slash 命令"
- [ ] README 提到"技能系统"作为可扩展点

---

## 11. 后续方向(非本轮)

- **M3+ 阶段:** 4-type 记忆 taxonomy + findRelevantMemories sideQuery
- **M3+ 阶段:** Coordinator 多 agent 模式(章节大纲 fan-out)
- **M3+ 阶段:** Session 持久化 / write-ahead log
- **M3+ 阶段:** 路径校验双层(prefix 快拒 + realpath 兜底)
- **M3+ 阶段:** TaskCreateTool / TaskUpdateTool blocks/blockedBy 拓扑
