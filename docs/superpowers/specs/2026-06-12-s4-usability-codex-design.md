# S4「用得顺」设计 spec — 成书导出 · 项目归档 · 设置分区 · Codex 式交互收口

> 状态：待用户审阅
> 作者：Claude（用户授权自主设计，方向锚点「模仿 Codex」）
> 上游：`2026-06-12-software-maturity-roadmap-v3-design.md` S4 节
> 现状基线：S2a+S3 已闭环（对话 agent、15 工具、确认卡、门禁对话化、统一时间线雏形）

---

## 1. 背景与目标

S3 把产品交互重构为对话 agent，但三类「日常顺手度」缺口仍在：

1. **写完拿不走**：章节散在 `chapters/*.md`，没有一键合成全书的途径。
2. **写完收不起**：项目列表只增不减，完结/弃坑项目与进行中项目混在一起，且没有防误改保护。
3. **配置摸不着**：S3 引入的 `tool_permissions`、`fact_check.hard`、`memory_extraction` 等关键配置没有任何界面入口，只能手改 project.json；现有设置弹窗是「模型平台」单一中心，写作参数、门禁、权限无处安放。

同时，本项目视觉系统从一开始就以 Codex 为蓝本（styles.css 头注释：*"Codex-style conversational agent — visual system"*），但交互层的 Codex 化只完成了一半：有对话和确认卡，**没有** approval 分级、diff 审阅、常驻环境状态、任务卡片化。S4 一并补齐。

**目标一句话**：完结一本书的「最后一公里」（导出、归档）顺手可达，所有配置一目了然，agent 交互达到 Codex 的成熟度（分级授权、diff 审阅、状态透明）。

## 2. 设计原则（Codex 思想的本项目表述)

1. **对话是唯一必经面**：每个新能力先做成 chat 工具（有对话入口），GUI 按钮只是同一工具的快捷方式。导出、归档都遵守。
2. **授权分级是一等公民**（Codex approval modes）：用户随时知道并能切换 agent 的行动自由度——只读 / 确认后修改 / 自动修改。模式指示器放在输入框旁边，不藏在设置里。
3. **Diff 是变更的通用语言**：凡是改正文的确认，以行级红绿 diff 呈现，不再用 before/after 双栏纯文本。
4. **长任务卡片化**：写作运行在时间线里是一张实时卡片（阶段、字数、成本、可展开日志、可停止），不是散落的事件行。
5. **环境状态常驻**：当前模型、本会话成本、授权模式在 composer 区轻量可见，点击即达对应设置。
6. **视觉零新增**：沿用现有 token（暖白、石墨、四状态色），不引入新颜色、新字体、新依赖。

## 3. 方案权衡

| 方案 | 内容 | 取舍 |
|------|------|------|
| **A（推荐，本 spec）** | 三件套（导出/归档/设置分区）+ Codex 交互收口（approval 分级、diff 确认卡、状态条、任务卡、空状态引导） | 设置分区本来就要重排 UI，顺势把交互欠账一次还清；规模约为 S2a+S3 的 60% |
| B（最小） | 只做三件套，交互收口推后 | 便宜 30%，但「用得顺」目标打折——权限分级没有 UI 时 auto 模式无法交付，且下次再动 UI 要重新热身 |
| C（扩张） | A + SSE 流式 + EPUB/DOCX 导出 | SSE 与 EPUB 各自是独立工程（流式传输坑、格式库依赖），违反 YAGNI 与零依赖原则，列候补 |

选 A。B 的「便宜」是假的（设置 UI 重排与权限 UI 强耦合）；C 的增项都有独立候补记录。

## 4. 组件设计

### 4.1 成书导出（book-export）

**核心**：新模块 `src/core/book-export.mjs`，纯函数合成 + IO 分离（与 memory-extractor 同范式）。

- `composeBook(chapters, { title, format })` → `{ filename, content }`（纯函数）：
  - 输入：按 `chapter_no` 升序的 `[{ chapter_no, title, content }]`（只取 `status === "completed"`，跳过缺文件章并记入结果的 `skipped` 数组）。
  - md 格式：`# 书名` + 每章 `## 第 N 章 标题`；剥离正文内首个行首标题（`#{1,3} 第N章…`，复用 quality-gates 的标题正则）避免双标题。
  - txt 格式：书名 + 空行 + 每章「第 N 章 标题」+ 正文，章间双空行；剥离全部 markdown 标记（`#`、`**`、`` ` ``，简单正则即可）。
  - 文件名：`<slug>-<YYYYMMDD>.<ext>`（同日重复导出直接覆盖——导出是纯产物，可重复生成）。
- `exportBook(projectRoot, { format, fromChapter?, toChapter? })`（IO 入口）：读 chapter_index → composeBook → 写 `exports/<filename>`（目录不存在则建）→ 返回 `{ path, chapters, words, skipped }`。
- **chat 工具** `export_book`（kind: write，第 16 个工具）：args `{ format: "md"|"txt"（默认 md）, from_chapter?, to_chapter? }`。走常规确认卡（确认卡正文：将合成 N 章约 X 字 → `exports/xxx.md`）；auto 模式下免确认（见 4.3）。
- **GUI 入口**：抽屉「章节」tab 顶部加「导出成书」按钮 → 直接调 `/api/...`？否——按原则 1，按钮等价于在 composer 预填并发送「导出全书为 md」，复用对话链路（实现上调 `sendChatMessage("导出全书")`），让确认卡与历史记录自然成立。斜杠命令 `/export` 同效。
- **完成呈现**：工具结果卡（现有 tool 卡）+ assistant 总结消息含路径；Electron 环境下抽屉按钮旁出现「打开导出文件夹」（`shell.openPath`，复用现有「打开本地文件夹」的 IPC 通道）。

### 4.2 项目归档（archive）

**核心**：归档 = 元数据状态，不动文件。

- `project.json` 增字段 `archived_at: ISO 字符串 | null`（缺省 null）。`settings-runtime` 的 patch 白名单加 `archived_at`（仅接受 null 或合法 ISO）。
- **chat 工具** `archive_project`（kind: write）：args `{ archived: true|false }`。运行中项目（runJobs 有活 job）拒绝归档（error: `project_busy`，人话）。
- **归档语义（只读化）**：`archived_at` 非空时：
  - chat 层：`checkToolPermission` 增规则——archived 项目拒绝一切 write/control 工具，**唯 `archive_project` 豁免**（用于解除归档）；消息：「项目已归档（只读）。先解除归档再修改。」
  - server 层：`/api/run/*`、`/api/commands/submit`、`/api/queue/*` 写端点对 archived 项目返回 400 同文案（防 GUI 绕过）。
  - 读全部正常（对话查询、阅读器、导出豁免吗？——**导出豁免**：归档书正是最该导出的，export_book 加入归档豁免名单，与 archive_project 并列）。
- **左栏呈现**：项目列表分两组——进行中（现状不变）+ 底部「已归档 N」折叠组（默认收起，点击展开；条目灰化 + 📦 前缀样式用现有 `--faint` token）。归档项目打开后 topbar 状态 pill 显示「已归档」（`--ghost` 色），composer 占位文案变为「项目已归档（只读）。对话查询可用；解除归档后才能修改。」
- **GUI 入口**：设置「危险区」分区的「归档此项目」按钮（同样走 sendChatMessage 预填，确认卡把关）。

### 4.3 设置分区 + 授权分级（approval modes）

**设置弹窗重构**：左侧 provider 列表改为**两层导航**——顶部 6 个分区项，「模型与密钥」分区内保留现有 provider 列表与 detail（整体平移，不重写其内部逻辑）。

| 分区 | 内容 | 来源 |
|------|------|------|
| 模型与密钥 | 现有 provider 列表 + detail（API key、模型 ID、价格三字段） | 平移 |
| 写作参数 | target_chapters、min/target/max words、输出风格（outputStyle 下拉平移） | 平移 + max_words 新增控件 |
| 质量门禁 | fact_check.enabled 开关、fact_check.hard 开关（带说明：硬模式发现矛盾直接打回修订）、memory_extraction.enabled 开关、title gate 显示「内建 · 始终开启」只读行 | 新增（引擎逻辑已有，纯 UI） |
| 权限与确认 | 授权模式三档单选（见下） | 新增 |
| 联网搜索 | search_endpoint、search_api_key_env | 平移 |
| 危险区 | 「归档此项目」按钮、「打开项目文件夹」 | 新增 |

**授权模式四档**（映射到既有 `tool_permissions`，settings-runtime 已支持 patch；对应 Codex 的 read-only / approval / auto / full-access）：

| 档位 | tool_permissions 值 | 行为 |
|------|--------------------|------|
| 只读 | `{ read_only: true, auto_edit: false, yolo: false }` | agent 只能查询；写/控制工具直接人话拒绝（现状已实现） |
| 确认后修改（**默认**） | `{ read_only: false, auto_edit: false, yolo: false }` | 现状：write/control 落 pending 确认卡 |
| 自动修改 | `{ read_only: false, auto_edit: true, yolo: false }` | write 工具跳过 pending 直接执行；control 工具（start/pause/resolve）仍走确认 |
| **YOLO（全权限）** | `{ read_only: false, auto_edit: true, yolo: true }` | **write + control 全部免确认自动执行**：agent 可自主改正文、排队、启停写作、处理故障卡，零打断 |

- `normalizeToolPermissions` 增 `auto_edit`、`yolo` 两个布尔字段；UI 四档单选互斥写入上表组合值。
- **优先级（安全优先）**：`read_only` > `safe_edit:false`（禁编辑） > 归档只读 > `yolo` > `auto_edit`。矛盾配置时取限制更强者——例如 yolo=true 但项目已归档，仍然只读。
- **YOLO 的硬底线（不可被 yolo 绕过）**：checkpoint 前置（每次 edit 仍有快照可回滚）、`chapter_busy` 守卫、`find` 唯一性校验、预算熔断（max_model_calls / cost budget）、settings 裸密钥拒绝。YOLO 免的是「确认」，不免「校验」。
- **composer 旁模式指示器**（Codex 标志性交互）：composer-bar 左侧新增模式 pill（如「✓ 确认后修改」），点击弹出四档浮层即点即换（复用设置弹窗现有的保存端点提交 tool_permissions patch，无需进设置弹窗）；YOLO 态 pill 用 `--amber` 警示色显示「⚡ YOLO」；archived 项目时 pill 显示「📦 已归档」不可点。设置「权限与确认」分区的 YOLO 选项附警示文案：「agent 将自主修改正文、启停写作、处理故障，不再询问；改动有 checkpoint 可回滚，成本受预算熔断保护。」

### 4.4 时间线 Codex 化

1. **diff 确认卡**：`edit_chapter` 确认卡的 preview 从 before/after 双栏改为**行级 diff**——新增 `src/app-shell/diff-view.js`，自写行级 LCS（约 40 行，零依赖），删除行红底（`--red-soft`）、新增行绿底（`--green-soft`）、等宽字体。preview 数据契约不变（before/after 字符串），diff 在前端计算。非 edit 类确认卡（导出、归档、排队）维持文字说明卡。
2. **运行任务卡**：升级现有 live block（thread-renderer 已有机制）为任务卡：标题行（第 N 章 · 阶段 chips：规划→起草→审稿→定稿，当前阶段高亮）、副行（实时字数 / 本章成本）、右上停止按钮（复用 /api/run/stop）、展开区（最近 10 条事件，复用现有事件行渲染）。数据全部来自现有 dashboard 轮询，无新端点。
3. **环境状态条**：composer-bar 左侧（模式 pill 旁）两枚轻 pill：模型名（点击 → 设置·模型与密钥）、本会话成本「¥0.0X」（chat usage 累计，复用 cost 数据；costAvailable=false 时隐藏金额只显示 token——沿用现有 cost-honesty 守则）。
4. **空状态引导**（Codex suggested prompts）：新项目 thread 为空时渲染 3 张建议卡：「排 5 章试写」「这本书的设定是什么？」「目前花了多少钱？」——点击即 sendChatMessage 对应文案。有任何历史后不再出现。

### 4.5 交互细节

- **键盘**：Esc 在有 pending 确认卡时等价点击「取消」（焦点不在输入框内时）；模式浮层 Esc 关闭；其余沿用现状（Enter 发送、Shift+Enter 换行、斜杠菜单）。
- **错误一致性**：归档拒绝、auto 模式执行失败等全部走现有 toast + thread 错误行模式，不新增错误 UI 形态。
- **clickability 探针同步扩展**（CLAUDE.md 硬防线）：导出按钮、归档组展开、设置 6 分区导航逐个、授权模式 pill 与三档浮层、diff 确认卡按钮、空状态建议卡。

## 5. 数据契约

```jsonc
// project.json 增量
{
  "archived_at": null,                          // ISO 字符串 | null
  "tool_permissions": { "read_only": false, "safe_edit": true, "auto_edit": false, "yolo": false }
}

// export_book 工具
// args:   { "format": "md" | "txt", "from_chapter": 1, "to_chapter": 100 }   // 范围可省
// result: { "path": "exports/slug-20260612.md", "chapters": 100, "words": 312450, "skipped": [] }

// archive_project 工具
// args:   { "archived": true }
// result: { "archived": true, "archived_at": "2026-06-12T…" }

// 导出文件命名：<slug>-<YYYYMMDD>.<md|txt>，同日覆盖
```

stage 标签：导出/归档不调模型，无新 stage。

## 6. 明确不做（v1 候补）

EPUB/DOCX 导出、项目硬删除（归档已覆盖收纳需求，删除有数据风险）、暗色主题、SSE 流式（沿袭候补）、导出模板自定义、项目列表拖拽排序、归档项目批量操作、YOLO 的细粒度白名单（按工具单独放行——四档已覆盖主场景）。

## 7. 验收标准

1. **导出**（真实项目）：对话「导出全书」→ 确认卡 → exports/ 文件生成，章节数与顺序正确、无双标题；`/export` 与抽屉按钮同效；txt 格式无 markdown 残留。
2. **归档**：对话归档 → 确认 → 左栏入归档组；归档后 edit_chapter/queue_chapters 被人话拒绝、对话查询与导出仍可用；解除归档全恢复；运行中归档被拒（project_busy）。
3. **设置分区**：6 分区全部可达且保存生效；fact_check.hard 在 UI 开启后，引擎真实走 needs_revision（已有 applyFactCheckHardFail 链路）。
4. **授权分级**：四档切换即时生效——auto 档下 edit_chapter 不落 pending 直接执行且写 checkpoint；YOLO 档下 control 工具（如 start_run）也免确认直接执行，且 checkpoint/chapter_busy/预算熔断仍然生效；只读档人话拒绝；模式 pill 与实际配置一致，YOLO 态呈 amber 警示。
5. **diff 确认卡**：edit_chapter 确认卡显示行级红绿 diff，批准后文件变更与 diff 一致。
6. **既有防线**：`npm test`、`verify:mvp`、`verify:longrun`、`verify:app-shell`、`verify:app-clickability`（含 §4.5 新探针）、`verify:local` 全过。
7. **真实 API 短跑**：场景 D 补入 verify:chat-online——「把大纲第 2 章改成 X 然后写到第 2 章」（顺带闭环 spec §12 条 3 的指挥落地欠账）+ 场景 E 导出与归档拒绝路径。

## 8. 风险与控制

| 风险 | 控制 |
|------|------|
| 设置弹窗重构引发「点不动」回归 | clickability 探针随分区同步扩展（CLAUDE.md 既有硬防线）；provider detail 整体平移不重写 |
| auto_edit 模式误改正文 | 仅 write 类自动、control 仍确认；checkpoint 前置不变；模式 pill 常驻可见随手切回 |
| YOLO 模式 agent 失控（连环改文/反复启停） | 确认免了但校验全在：checkpoint 可回滚、find 唯一性、chapter_busy、maxToolRounds=8、预算熔断；pill amber 警示常驻；归档/read_only 优先级压过 yolo |
| 归档只读化有绕过路径 | chat 层 + server 写端点双重拦截；clickability 加归档态探针 |
| 行级 diff 实现 bug 导致预览误导 | 纯函数 + 单测覆盖（增/删/改/无变化/全替换五用例）；批准执行仍走 edit_chapter 原校验链（find 唯一性），diff 仅是呈现层 |
| 导出大书（百章）卡 UI | 导出在 server 端同步执行（文件 IO 毫秒级，无模型调用），无需进度条；实测 100 章 < 1s |

## 9. 阶段产物

1. 本 spec（用户审阅通过后生效）。
2. writing-plans 实施计划：`docs/superpowers/plans/2026-06-XX-s4-usability-codex.md`。
3. 交付报告：含验收 7 条逐条证据 + 真实 API 场景 D/E 结果 + spec §12 条 3 欠账闭环声明。
