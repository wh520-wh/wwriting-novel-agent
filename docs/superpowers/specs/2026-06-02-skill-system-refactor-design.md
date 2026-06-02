# WWriting 技能系统重构设计

**日期:** 2026-06-02
**范围:** 技能 / 命令的声明式注册、frontmatter 协议、条件激活、多源发现、Hook 钩子、输出风格可扩展
**总方向:** 借鉴 Claude Code（参考源码 E:\claude_code_src-master\claude_code_src-master）的 skills/memdir/tools 三个子系统，把 WWriting 当前 14 个硬编码 *Skill.js 文件升级为 frontmatter 驱动的声明式注册表
**依赖:** 无前置（基于已完成的 A/B/C 三组大优化 + M1 稳定基线）

---

## 背景与动机

WWriting 已经完成 3 轮大优化（A 后端可靠性 / B 前端拆分通信 / C 测试补全）和 M1 软件成熟度稳定。当前架构基本对齐 Codex 风格，但**技能系统是明显短板**：

1. `src/app-shell/components/` 下 14 个 `*Skill.js` 全部是硬编码 JS，每个技能新增 / 修改都要改 JS 文件
2. `src/core/skill-runtime.mjs` 的 manifest 是单文件 `manifest.json`，没有 frontmatter 协议，没有路径条件激活
3. 没有 Hook 机制，"生成前备份"、"失败打点"、"完成后记账"这些副作用散落在 `if` 块里
4. 没有输出风格可扩展，模型生成章节的 prompt 风格写死
5. 多源发现能力缺失：用户不能在 `~/.wwriting/skills/` 自定义技能，bundled/项目内/用户三层没有统一优先级

参考源码 E:\claude_code_src-master\claude_code_src-master 的 skills 给了 6 个可借鉴模式（已通过 4 个 Explore agent 并行扫描验证），其中 5 个可低成本落地为 WWriting 的 5 个改动。

---

## 目标

### 用户能感受到的

- 作者可以**写一个 SKILL.md**（frontmatter + Markdown 正文）就新增一个写作助手，**不用改 JS**
- 写作类技能按目录自动激活——例如 `genre-tone-checker` 只在 `chapters/poetry/**` 下被加载，不污染其他项目的 prompt
- 设置面板多一个"输出风格"下拉，内置创作模式/审稿模式，用户也可以放自己写的 `.md`
- 章节生成失败时能在事件日志里看到结构化原因，恢复操作在 UI 上能直接点

### 开发者能感受到的

- "声明一个技能" = 写一个 plain object，**不引入新框架**（不引 zod、gray-matter 等）
- 5 个内置命令（`/continue` `/rewrite` `/polish` `/outline`）从 composer.js 散落的 if 抽进注册表
- 副作用通过 Hook 注册，agent-engine / cost-tracker / event-log 各自订阅，互不耦合
- 5 项改动全部完成时，命令栏、quick-rail、settings-modal、thread-renderer 都从**同一份注册表**拿数据

---

## 不包含的工作

- **不**做"用户态技能编辑器" GUI（用户能用 .md 写就够了，编辑器留给后续）
- **不**做 zod / gray-matter / matter-js 依赖
- **不**做 Coordinator 多 agent 模式（M3+ 阶段）
- **不**做 4-type 记忆 taxonomy（M3+ 阶段）
- **不**做 session 持久化 / write-ahead log（M3+ 阶段）
- **不**重写 settings-modal 整个面板（只加"输出风格"下拉）
- **不**删除 14 个 `components/*Skill.js` 文件（保留为 JS 注册形式，作为 bundled 源）

---

## 五个改动（B1 → B5）

### B1. 声明式 Tool/Command 注册表

**目标:** 把 `composer.js` 里硬编码的 4 个命令抽成纯数据 + 纯工厂的注册表。

**新建文件:**
- `src/core/tool-registry.mjs` — 核心注册表（Map + signal，5 个公开方法）
- `src/core/commands/_schema.mjs` — 手写 schema 校验（4 字段够用，不引 zod）
- `src/core/commands/continue.mjs`、`rewrite.mjs`、`polish.mjs`、`outline.mjs` — 4 个内置命令
- `src/core/commands/index.mjs` — `registerCommand(...) × 4` 一次性注册
- `tests/tool-registry.test.mjs`

**修改文件:**
- `src/app-shell/composer.js` — 命令解析改用 `getCommand(name) + run(input, ctx)`
- `src/app-shell/quick-rail.js` — 快捷按钮从 `listCommands({ userInvocable: true })` 拿清单

**数据形状（每个命令 = 普通对象）:**

```js
export const continueCommand = {
  name: 'continue',
  category: 'writing',                          // writing | editing | review | research | project
  description: '继续当前章节的写作',
  userFacingName: () => '继续写作',
  userInvocable: true,
  shortcut: 'Ctrl+Shift+C',                     // 可选
  input: {                                       // 简单 schema
    chapterId: { type: 'string', required: true }
  },
  isConcurrencySafe: false,                     // 同时只能一个 continue
  isReadOnly: false,
  isEnabled: () => hasActiveProject(),           // 特性门控
  canUse: (ctx) => ctx.currentChapter != null,  // 运行时权限
  allowedTools: ['read', 'word_count'],          // 白名单,空数组=全部
  run: async (input, ctx) => { /* 实际执行 */ },
  renderResult: (output, ctx) => { /* 可选,给 thread-renderer */ }
};
```

**注册表 API:**

```js
// src/core/tool-registry.mjs
registerCommand(cmd)       // 校验 + dedup by name + 广播
unregisterCommand(name)    // 删除 + 广播
getCommand(name)           // 单查
listCommands(filter?)      // 列表 + 过滤(category / userInvocable / isEnabled)
onCommandsChanged(cb)      // 订阅 + 返回 unsubscribe
```

**迁移步骤:**
1. 从 `composer.js` 现有逻辑里提取 4 个命令的 `run` 函数壳（参数/返回值不变）
2. 新建 `tool-registry.mjs`，不动 UI
3. 改 composer 解析路径为 `getCommand('xxx')` + `run(input, ctx)`
4. quick-rail 改用 `listCommands`
5. 跑 `verify:app-clickability` 验证 4 个命令仍可点可跑

**测试用例:**
- 注册同名命令时后者覆盖前者，广播 1 次 changed
- `listCommands({ category: 'writing' })` 只返 writing 类
- `listCommands({ userInvocable: false })` 过滤掉
- `isEnabled` 返回 false 的命令不进入列表
- `canUse(ctx)` 在 run 之前被调用，返 false 抛 `CommandNotAllowed`
- `onCommandsChanged(cb)` register/unregister 各触发 1 次
- 4 个内置命令 `run` 行为与原 composer.js 一致

---

### B2. 路径条件激活

**目标:** 写作类技能按目录自动激活，不污染其他项目的 prompt。

**修改文件:**
- `src/core/skill-runtime.mjs` — manifest schema 加 `paths: string[]` 字段（gitignore 风格）
- `src/app-shell/composer.js` — 提交前调用激活函数
- `package.json` — 新增 `ignore` 依赖

**新增 export:**
```js
// src/core/skill-runtime.mjs
parseSkillPaths(frontmatter)        // string[] | undefined
activateConditionalSkillsForPaths(filePaths, projectRoot)
listActiveSkills()                  // 当前激活列表
```

**核心逻辑:**
- 加载时：带 `paths` 的技能进 `conditionalSkills: Map`，不挂载到活跃列表
- composer 提交消息前：对涉及文件路径调 `activateConditionalSkillsForPaths`
- 命中后移入 `activeSkills`，名字进 `activatedNames: Set`（跨缓存清除保留）

**测试文件:** `tests/skill-runtime-paths.test.mjs`

**用例:**
- 解析 `paths: ['chapters/poetry/**']` → 转 `['chapters/poetry']`（去 `/**`）
- 全部 `**` 降级为 `undefined`（等价无约束）
- 越界路径（绝对路径、`../`）不匹配
- 命中后 conditional → active，名字进 activatedNames
- 清缓存后 activatedNames 仍保留（防回弹）

---

### B3. 多源发现层

**目标:** bundled / user / project 三层有统一优先级与 dedup，挡 OneDrive 双挂载的 symlink 重复。

**修改文件:**
- `src/core/skill-runtime.mjs` — 新增 `resolveSkillSources`、重构 `loadSkills`

**5 个来源（按优先级降序）:**

| 优先级 | 路径 | 类型 |
|---|---|---|
| 1 | `dist-desktop/resources/skills/` | bundled 出厂 |
| 2 | `~/.wwriting/skills/` | user 用户级 |
| 3 | `<projectRoot>/.wwriting/skills/` | project 项目级 |
| 4 | plugin | 留接口（暂不实现） |
| 5 | bundled 内置 | 由 B1 注册的 JS 命令 |

**核心逻辑:**
- `fs.promises.realpath` 做身份识别
- `seenFileIds: Map<realpath, source>` first-wins 去重
- 暴露 `resolveSkillSources({ projectRoot, userHome })`

**测试文件:** `tests/skill-runtime-sources.test.mjs`

**用例:**
- 5 个来源扫描顺序与优先级
- symlink 指向同一文件 → 只保留第一个
- 缺某一来源（用户没建 `~/.wwriting/skills/`）不报错
- 启动扫盘 < 100ms（基准：1 个项目 5 个 SKILL.md）

---

### B4. Hook 清单

**目标:** 把"生成前备份"、"失败打点"、"完成后记账"从散落 if 抽到统一注册。

**新建文件:**
- `src/core/hooks-registry.mjs` — 注册表 + 触发器
- `tests/hooks-registry.test.mjs`

**修改文件:**
- `src/core/agent-engine.mjs` — 2 处 fire（写章节前 + 模型调用后）
- `src/core/cost-tracker.mjs` — 订阅 `PostModelCall`
- `src/core/event-log.mjs` — 订阅 `OnTaskFailed`
- `src/core/failures-store.mjs` — 订阅 `OnTaskFailed`（如需）

**5 个事件枚举:**

```js
export const HOOK_EVENTS = Object.freeze({
  PreChapterWrite:   'PreChapterWrite',
  PostChapterWrite:  'PostChapterWrite',
  PreModelCall:      'PreModelCall',
  PostModelCall:     'PostModelCall',
  OnTaskFailed:      'OnTaskFailed'
});
```

**API:**

```js
registerHook(event, fn)    // 注册监听
fireHook(event, payload)   // 触发,Promise.allSettled
unregisterHook(event, fn)  // 注销
```

**fireHook 行为:**
- `Promise.allSettled` 等待所有 hook
- 单 hook 抛错 → 收集到 `result.errors[]`，主流程继续
- 返回 `{ ok: boolean, errors: Array<{event, error, hookName?}> }`

**集成点:**

| 事件 | 触发位置 | 第一个内置订阅者 |
|---|---|---|
| `PreChapterWrite` | `agent-engine.mjs` 写章节前 | 自动备份项目到 `drafts/backup/<timestamp>/` |
| `PostChapterWrite` | `agent-engine.mjs` 写章节后 | event-log 记一条完成事件 |
| `PreModelCall` | `agent-engine.mjs` 调模型前 | （暂留接口，扣预算提示用） |
| `PostModelCall` | `agent-engine.mjs` 调模型后 | cost-tracker 累加 |
| `OnTaskFailed` | `agent-engine.mjs` / `task-queue.mjs` 失败时 | event-log + failures-store |

**测试用例:**
- 多个 hook 注册同一事件 → 全部触发
- 抛错的 hook 不影响其他
- 注销后不再触发
- async hook 也被 await

---

### B5. 输出风格 .md 化

**目标:** 用户可在 `~/.wwriting/output-styles/*.md` 自定义 prompt 风格。

**新建文件:**
- `src/app-shell/output-style-loader.mjs` — 3 来源加载 + frontmatter 解析
- `tests/output-style-loader.test.mjs`

**修改文件:**
- `src/app-shell/settings-modal.js` — 加"输出风格"下拉
- `src/core/prompt-compiler.mjs` — 拼装 system prompt 时追加当前风格
- `src/core/app-state.mjs` — `settings.outputStyle` 字段

**3 个来源:**

| 优先级 | 路径 |
|---|---|
| 1 | `bundled` 内置 2 种（创作模式、审稿模式） |
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
- 用户切换风格后,下次 prompt-compiler 看到新值

---

## 数据流

### 启动

```
1. dist-desktop 扫盘 resolveSkillSources()
   → realpath dedup
   → simple-yaml 解析每个 SKILL.md
   → schema 校验（_schema.mjs）
   → registerCommand() × N
   → commandsChanged.emit()
2. bundled 内置 4 命令 registerCommand()
3. quick-rail 订阅 commandsChanged，重渲染
4. settings-modal 加载 output-style 清单
```

### 用户提交 `/continue`

```
1. composer.parse('/continue') → { name: 'continue', input: {} }
2. getCommand('continue') → cmd
3. cmd.isEnabled() ? 继续 : 拒绝
4. activateConditionalSkillsForPaths(涉及文件, projectRoot)
5. fireHook('PreChapterWrite', { path, content: null })   // 备份
6. cmd.canUse(ctx) ? 继续 : 抛 CommandNotAllowed
7. cmd.run(input, ctx) → output
8. fireHook('PostChapterWrite', { path, content })
9. cmd.renderResult(output, ctx) → UI 增量
10. thread-renderer 渲染
```

### 用户保存新 SKILL.md

```
1. watcher 检测到 .wwriting/skills/xxx/SKILL.md 变更
2. skill-runtime 失效该路径缓存
3. resolveSkillSources() 重扫
4. registerCommand 增量 / 注销
5. commandsChanged.emit() → quick-rail / composer 重新拿清单
```

### 错误处理统一

| 层 | 错误 | 行为 |
|---|---|---|
| 注册表层 | 重复名 / 缺字段 | 抛 `CommandValidationError`（构造 fail-fast） |
| 运行时 | canUse 返 false | 抛 `CommandNotAllowed`（UI toast） |
| 业务层 | run 抛错 | 包成 `{ ok: false, error }` 返，不污染 Map |
| Hook | 单 hook 抛错 | 收集到 `result.errors[]`，主流程继续 |
| 加载 | 单 SKILL.md 解析失败 | 跳过 + console.warn，不让坏文件阻塞全部 |

---

## 文件变更总览

### 新建

| 文件 | 行数预估 | 职责 |
|---|---|---|
| `src/core/tool-registry.mjs` | ~120 | 注册表 + signal |
| `src/core/commands/_schema.mjs` | ~60 | 手写 schema 校验 |
| `src/core/commands/continue.mjs` | ~40 | |
| `src/core/commands/rewrite.mjs` | ~40 | |
| `src/core/commands/polish.mjs` | ~40 | |
| `src/core/commands/outline.mjs` | ~40 | |
| `src/core/commands/index.mjs` | ~20 | 一次性注册 |
| `src/core/hooks-registry.mjs` | ~100 | 5 事件 + fire |
| `src/app-shell/output-style-loader.mjs` | ~120 | 3 来源加载 |
| `tests/tool-registry.test.mjs` | ~200 | B1 |
| `tests/skill-runtime-paths.test.mjs` | ~150 | B2 |
| `tests/skill-runtime-sources.test.mjs` | ~150 | B3 |
| `tests/hooks-registry.test.mjs` | ~150 | B4 |
| `tests/output-style-loader.test.mjs` | ~120 | B5 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/core/skill-runtime.mjs` | 加 parseSkillPaths / activateConditionalSkillsForPaths / resolveSkillSources |
| `src/app-shell/composer.js` | 改命令解析为注册表查询 + fireHook |
| `src/app-shell/quick-rail.js` | 改用 listCommands |
| `src/app-shell/settings-modal.js` | 加"输出风格"下拉 |
| `src/core/prompt-compiler.mjs` | 拼装 system prompt 追加 outputStyle |
| `src/core/agent-engine.mjs` | 2 处 fireHook + 1 处订阅 OnTaskFailed |
| `src/core/cost-tracker.mjs` | 订阅 PostModelCall |
| `src/core/event-log.mjs` | 订阅 OnTaskFailed |
| `src/core/app-state.mjs` | settings.outputStyle 字段 |
| `src/core/failures-store.mjs` | 订阅 OnTaskFailed（如需） |
| `package.json` | 加 `ignore` 依赖 |

**保留不动:**
- `src/app-shell/components/*Skill.js` 14 个文件（保留为 bundled 源）
- `src/core/simple-yaml.mjs`（复用 frontmatter 解析）

---

## 验证策略

### 每完成一个子项立即跑

```powershell
node --test tests/<新测试>.test.mjs
npm run verify:app-shell
npm run verify:app-clickability
```

### 全部完成后

```powershell
npm test                # 60+ 测试
npm run verify:local    # 包含打包
```

### B1 专项验证

`verify:app-clickability` 必须显式覆盖 4 个命令：
- `/continue` 触发后能在 thread-renderer 看到"继续生成"块
- `/rewrite` 触发后能看到重写后的内容
- `/polish` 触发后能看到润色后内容
- `/outline` 触发后能看到新大纲

如果测试脚本未覆盖这 4 个命令的端到端点击，**必须在迁移前先扩展 verify-app-clickability.cjs**。

### B4 专项验证

- 章节生成前必须看到 `drafts/backup/<timestamp>/` 目录被创建
- 故意触发一次失败（mock 模型返回 401），fireHook 收到 OnTaskFailed 事件
- event-log 出现对应的失败记录

---

## 实施顺序与依赖

```
B1 (注册表) ──────┐
                  ├─→ B2 (条件激活, 依赖 B1 的 activeSkills 概念)
B3 (多源发现) ────┘
                  └─→ B4 (Hook, 独立)
                       └─→ B5 (输出风格, 独立, 最后做)
```

- B1 完成后: `verify:app-clickability` 验证 4 命令
- B3 完成后: bundled 出厂技能可被 `.wwriting/skills/` 覆盖
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

## 风险登记与控制

| 风险 | 等级 | 控制 |
|---|---|---|
| 注册表迁移破坏 4 个内置命令 | 高 | B1 完成后强制跑 `verify:app-clickability` 验证 4 个命令 |
| 多源扫盘启动时间变长 | 中 | 实测 < 100ms 才接；超时降级到 bundled-only |
| Hook 死循环（A 触发 B 触发 A） | 中 | 集成点只 fire 一次，不订阅自己 fire 的事件；事件名白名单 |
| 路径条件激活让作者意外看不到技能 | 中 | settings-modal 提供"显示全部技能"开关，默认按 paths 过滤 |
| SKILL.md 错误格式污染提示 | 低 | 注册时 schema 校验 + 加载时 fail-soft |
| `ignore` 库版本兼容 | 低 | 锁版本到 `^5.3.0`，npm 维护活跃 |
| 输出风格切换导致 prompt 抖动 | 低 | 在 prompt-compiler 拼装层加注释说明这是"风格片段" |

---

## 成功标准

### 功能验收

- [ ] `verify:app-clickability` 通过（4 个内置命令 + settings-modal 输出风格下拉）
- [ ] `verify:app-shell` 通过
- [ ] `npm test` 通过（54 → 60+ 测试）
- [ ] `verify:local` 通过
- [ ] 在 `~/.wwriting/skills/<test>/SKILL.md` 写一个测试技能，能在项目里被加载

### 架构验收

- [ ] `composer.js` 不再硬编码 4 个命令
- [ ] 副作用通过 Hook 订阅，无散落 if
- [ ] `quick-rail.js` / `settings-modal.js` 都从注册表拿数据
- [ ] 用户能在 `~/.wwriting/output-styles/` 写自定义风格

### 文档验收

- [ ] 用户文档加一节"如何写自定义技能"
- [ ] developer 文档加一节"如何新增内置命令"
- [ ] README 提到"技能系统"作为可扩展点

---

## 后续方向（非本轮）

- **M3+ 阶段:** 4-type 记忆 taxonomy + findRelevantMemories sideQuery
- **M3+ 阶段:** Coordinator 多 agent 模式（章节大纲 fan-out）
- **M3+ 阶段:** Session 持久化 / write-ahead log
- **M3+ 阶段:** 路径校验双层（prefix 快拒 + realpath 兜底）
- **M3+ 阶段:** TaskCreateTool / TaskUpdateTool blocks/blockedBy 拓扑
