# 第十四轮规格：技能全插件化与网文风格体系（2026-08-22）

- 状态：已实现并收口（2026-08-22，F1-F9 全部落地，全量回归 1915/1915；执行记录见提交历史）
- 输入：技能 v2 切换记录 [[2026-08-07-skill-v2-cutover]]（SKILL.md 契约与四层目录出处）、源码事实摸底（output-style-loader / catalog / prompt 现状，行号见各节）、本轮对话对齐记录（用户拍板项见「决策记录」）
- 一句话：把两处硬编码的风格机制（从不生效的 output_style 全链 + 内置保护名单）整条拆除，写作风格完全落在 SKILL.md 插件体系上，并以「基座 + 修饰 + 流派」三正交轴重写内容重心--网文节奏要快要爽、白话直叙、去 AI 味。

## 决策记录（对齐拍板，逐条可溯）

- **D1**：`output_style` 假机制整条删除。它是死旋钮：有存储、有设置页下拉、有 API，但从不进提示词（全库核实零消费点）。
- **D2**：内置技能不做任何保护，同名覆盖统一由四层优先级裁决（project > global > bundled > builtin）。理由：5 个技巧技能今天就已可被覆盖，保护名单是不一致设计而非全局规则；删除优于添加。
- **D3**：风格细化走「基座 + 修饰」可组合路线，不做横向堆预设、不做参数化滑杆。
- **D4**：`suspense-chapter-end`、`chapter-opening-hook` 两个钩子改修饰类（题材依赖的「必须」对治愈向是错误指令）；其余 3 个手艺技能不动。
- **D5**：零 UI。不加风格展示或选择控件，控制面只有对话。
- **D6**：内容主轴（用户原话归纳）：网文节奏把控--节奏推进要快、要爽、不搞文绉绉的莫须有东西；上一时期产出过于偏文学性、AI 味重，本轮主要目标就是去 AI 味。新技能数量判给规格作者：新修饰 2 个、新流派包 2 个，宁少而准。
- **D7**：流派为第三根正交轴（`genre` 类），与基座/修饰互不绑架；本轮内置悬疑、侦探两个流派包作模式样板，其余流派走插件作者路线。

## 术语

- **基座（category: writing-style）**：行文整体姿态（节奏、心理密度、描写密度），每项目恰一。
- **修饰（category: style-modifier）**：单轴倾向调节（爽点密度、对白占比、钩子），每项目 0-3。
- **流派（category: genre）**：故事类型公约与读者许诺（悬疑的信息差、侦探的公平性），每项目 0-2（通常一个主导）。
- **手艺技能（无 category）**：不分题材的通用写作手艺，模型按适用性判断调用。
- **死旋钮（output_style）**：现存于设置页但从不进提示词的假风格机制，本轮删除对象。

## 目标

- F1 `output_style` 全链删除（loader / store 字段 / 校验 / API / 设置页下拉 / 测试与 fixture）。
- F2 内置保护名单删除（`PROTECTED_BUILTIN_SKILLS`、readonly/protected 语义、skill_reserved 拒绝），同名覆盖纯优先级裁决。
- F3 分类体系落地：三级 category 元数据 + 目录行带类目标签 + category 透传至提示词层。
- F4 选择规则重写：分层定调（流派 -> 基座 -> 修饰）+ 分层 read_skill 时机。
- F5 WWRITING.md 写作风格区三行式（技能/修饰/流派），旧单行格式后向兼容。
- F6 三个基座内容重写：重心移到网文节奏，AI 腔红线短列表下沉每个基座。
- F7 新修饰 2 个：`payoff-pacing`（爽感节奏）、`dialogue-driven`（对白驱动）。
- F8 两个钩子改修饰类：metadata 换 category，措辞从「每章必须」改为条件式。
- F9 新流派包 2 个：`genre-suspense`（悬疑）、`genre-detective`（侦探）。

## 非目标（明确不做）

- 零新 UI：不加分组徽章、风格展示、选择控件；设置页技能 catalog 仅做保护语义移除后的必要调整。
- 不新增其他流派（仙侠/都市/科幻/恐怖等）与其他修饰轴；**抒情散文与去文学化主轴相悖，明确不做**；群像多线、日常治愈、冷硬极简留待后续或插件作者。
- 不建确定性引擎：category 仅供提示词与目录展示，运行时零分支；死的 hooks 惯性 metadata 仅在本轮触碰的文件里顺手清除（F8），不做全库清扫。
- bundled 空层（resources/skills）保留不动；importer 导入流程不动。
- 存量 project.yaml 的 `output_style` 值不迁移，读时静默忽略。
- 手艺技能（avoid-ai-voice / dialogue-not-summary / show-dont-tell）正文不改；红线短列表是收敛副本而非改写其全文（取舍见风险）。

## F1 output_style 全链删除

删除清单（行号为当前基线）：

- `src/core/output-style-loader.mjs` 整文件（`BUNDLED_STYLES` 含写死在代码里的 "creative" 正文即硬编码风格本体）；
- `src/core/http/settings-routes.mjs:20` import 与 `:509` `GET /api/output-styles` 路由；
- `src/core/project-store.mjs:49` `output_style: options.output_style ?? "creative"` 默认写入；
- `src/core/settings-runtime.mjs:94-95 / 137-138 / 207-214` 归一化与校验分支；
- `src/app-shell/settings-modal.js`：`/api/output-styles` 拉取（:126 附近）与写作分区「输出风格」label + select + 独立提交键（:369-398 附近，:22 注释一并清理）；写作分区其余控件（每章篇幅、目标章节数）保留；
- 测试与 fixture：`tests/core/output-style-loader.test.mjs` 整删；`tests/app-shell/settings-modal.test.mjs`、`tests/http/project-routes.test.mjs`、`tests/helpers/project-agent-harness.mjs`（fixture `output_style: "creative"`）、`tests/http/app-server-probe.test.mjs` 相应改写；`scripts/simulate-user-flow.mjs:190` fixture 字段删除。
- **第三处死代码（第一性原理审阅补入）**：`src/core/project-memory.mjs` 的 `styleSkill` 解析层（`parseFrontmatterStyleSkill` :137-140 与 `readProjectMemory` 返回字段 :24/:27-28）--把 WWRITING.md frontmatter 的 `writing_style_skill:` 解析成结构化字段，但全库零消费者（`assembleProjectMemoryBlock` 只读 content）。半座死桥，整条删除；`tests/core/project-memory.test.mjs` 的 styleSkill 用例改写；sim fixture frontmatter 的 `writing_style_skill:` 字段（simulate-user-flow.mjs:115）一并删。删除后 F5 三行式是风格组合的唯一记录，不维护 frontmatter schema。

行为口径：存量配置里的 `output_style` 键读时静默忽略，无迁移、无提示。写作分区的风格入口消失后，风格唯一控制面 = 对话（与产品定位一致）。

## F2 保护名单删除，纯四层优先级

- `src/core/skills/catalog.mjs`：`PROTECTED_BUILTIN_SKILLS`（:21-25）删除；保留名称 shadow 分支（:73-79）删除--同名条目走通用层优先级，非 builtin 层覆盖 builtin 属正常 shadow；`enrichSkill`（:96-111）删除 readonly/protected 两个字段（display_name/category 保留）。
- `src/core/skills/index.mjs`：`assertMutableSkillName`（:119-124）删除，`importSkill`（:59-61）与 `removeSkill`（:82）调用点移除；`skill_reserved` 错误码消失。
- `src/core/http/settings-routes.mjs:618-629`：响应不再携带 readonly/protected；`shadow_reason: reserved_builtin` 消失（层优先级 shadow 的通用 reason 保留）。
- `src/app-shell/settings-modal.js` 技能分区重构：取消「内置写作风格」独立无框只读分区（:1079-1082 过滤、:1148-1213 只读行、:1662-1669 测试钩子）；builtin 技能进普通列表，来源标签沿用 `SKILL_SOURCE_LABELS`（:890，内置=「内置」）；shadowed 条目文案去掉「保留名称不可覆盖」（:1139-1140），统一为优先级覆盖口径（:979 已有文案可复用）。
- 行为变化（设计意图，记录在案）：导入名为 `balanced` 等的技能不再 409 拒绝，落 project/global 层后在 catalog 以 shadowed 形态可见覆盖内置版。

## F3 分类体系与 category 透传

- category 值即术语表三个：`writing-style` / `style-modifier` / `genre`；无 category = 通用手艺。全部声明在 SKILL.md `metadata.wwriting.category`，enrichSkill 已读取（catalog.mjs:109），无需解析改动。
- **通路补字段**：`runtime.mjs` `readSkillCatalog`（:311-320）现裁剪为 `{ name, description }`，category 到不了提示词层--改为 `{ name, description, category: skill.category ?? null }`（:317 一处映射）。
- 目录行标签：`prompt.mjs` `assembleSkillCatalogBlock`（:174-186）每行从 `- name: description` 改为 `- [标签] name: description`，标签映射 writing-style->基座、style-modifier->修饰、genre->流派、null->无标签；`SKILL_CATALOG_INTRO`（:163-164）补一句「按基座/修饰/流派分层选择」。

本轮在库成员（分类定稿）：

| category | 技能 |
|---|---|
| writing-style（基座） | balanced、fast-readable、psychological-literary（全部重写，见 F6） |
| style-modifier（修饰） | payoff-pacing*、dialogue-driven*、suspense-chapter-end、chapter-opening-hook |
| genre（流派） | genre-suspense*、genre-detective* |
| 无（手艺） | avoid-ai-voice、dialogue-not-summary、show-dont-tell |

*为新增。命名用 `genre-` 前缀避免与修饰类 `suspense-chapter-end` 在目录中混淆。

## F4 选择规则重写

`prompt.mjs` `STYLE_SELECTION_RULE`（:168-169）整段替换为：

> 写作前分层定调：① 流派--题材属于悬疑、侦探等类型时选对应流派技能（可叠加，通常一个主导）；② 基座--恰选一个写作风格技能，用户明确指定则从之，未指定时按题材、目标读者、节奏判断，重大歧义再询问；③ 修饰--按需加 0-3 个单轴修饰，明显矛盾的不并选；流派包内的推荐组合仅作参考。确定后写入 WWRITING.md 写作风格区（技能/修饰/流派三行，修饰与流派无则省略），并分层调用 read_skill 读取全文：流派技能在规划章节结构前读，基座与修饰在动笔写正文前读。风格技能不改变普通聊天语气。

加载时序即「先大方向后小方向一步一步」：流派（规划期）-> 基座 + 修饰（动笔期）-> 手艺（自查/审稿期）。渐进加载机制（摘要常驻、正文按需）零改动。

**承重不变量（写明防误改）**：「恰选一个基座」不是软建议--F6 的 AI 腔红线随基座正文必载，基座若可缺省，红线保证即静默失效。任何把基座改为可选的后续提案，必须同时回答红线如何必载。

## F5 WWRITING.md 三行式

写作风格区定稿格式（模型按规则维护）：

```
## 写作风格

技能：fast-readable
修饰：dialogue-driven
流派：genre-detective
```

- 三行统一用技能 ID（catalog 技能名），不用显示名--read_skill 调用与机器解析都按 ID；`技能：` 行的值必须是 catalog 内 writing-style 技能名，修饰/流派行同理（对应 category 的技能名）。
- 修饰/流派行无内容时整行省略。
- 旧格式后向兼容：存量 WWRITING.md 的单行 `- 技能：fast-readable` 视作仅基座、无修饰无流派，不做迁移；模型下次按新规则自然改写。
- `scripts/simulate-user-flow.mjs` 的 `WWRITING_CONTENT` fixture（:113-132）与相关断言随新格式更新。

## F6 三个基座内容重写（本轮产品价值主体）

**共享底线（写进每个基座「避免」段，随基座必载）--AI 腔红线短列表**，自 avoid-ai-voice 收敛五条：三连排比堆砌；段尾总结句收束情绪；模糊修饰词连发（仿佛、似乎、不禁、不由得、莫名、悄然、缓缓、微微、瞬间、顿时）；抒情长句连发，情绪改由具体动作与实物承载；空转的环境与心理描写，每段必须有新信息、动作或情绪推进。另加一条白话基线：能用口语说清的不用书面腔，不文绉绉。

分基座论点：

1. **fast-readable（快节奏易读）--缺省重心，网文标准节奏**。目标：信息进入快、冲突到达早、因果清楚、段落易扫读，读者随时知道人物要什么、阻力是什么、局面为何改变。写法：场景尽快进入异常/目标/威胁/冲突；删除不影响局面的寒暄与准备动作；句长与段落自然变化，紧张处收紧。避免：铺垫章、环境空转、心理独白超过一小段。
2. **balanced（均衡）--重定位为「标准网文节奏」**。事件推进与人物变化并重，但节奏底线与 fast-readable 同源：每个场景必须推进局面，人物弧光是推进中的副产品而非停下来的专项描写。旧版「均衡」含有的文学化描摹配额取消。
3. **psychological-literary（心理文学）--收紧边界，心理服务张力**。保留基座（心理深化是真实需求与基座间细化的落点），但明令：心理刻画由现场刺激触发、落回动作或决定，不得拖慢节奏、不得堆内心独白；心理是让读者看到人物怎样理解眼前事实并做出带后果的选择，不是停下来解释人物。

三个基座 frontmatter 的 `readonly: true` 删除（D2 连带）。

## F7 新修饰 2 个

- **payoff-pacing（爽感节奏）**：期待-兑现循环（每个场景立一个期待，章内或近期兑现）；爽点密度纪律（约每千字一个可感推进：打脸、反转、突破、认可）；兑现不拖欠，立了的期待要有账期并还账；铺垫最短化。避免：兑现前反复延宕吊胃口、爽点无代价化（无阻力即无爽感）。
- **dialogue-driven（对白驱动）**：交锋、试探、谈判、信息交换优先用对白完成；叙述让位为对白服务，动作与表情穿插打断长对白；对白来自人物当下目的与信息差。与 dialogue-not-summary 手艺衔接：质量规则在手艺技能，占比与功能归本修饰。避免：用叙述概括本可以演出来的交锋、对白轮次空转不推进信息或关系。

display_name 分别为「爽感节奏」「对白驱动」；category: style-modifier。

## F8 两个钩子改修饰类

- metadata 增 `category: style-modifier`；**死的 `hooks:` 惯性字段在本轮触碰的两个文件里删除**（运行时早已不解释，留着误导把内置技能当范本的插件作者）；未触碰的技能文件不动（范围纪律）。
- 正文措辞条件化：`suspense-chapter-end` 首句「本章计划必须包含结尾悬念钩子」->「本修饰生效时，本章结尾留下悬念钩子…」；`chapter-opening-hook` 同理。指令内容（震惊话语/推翻认知的新事实/逼近的危险；动作冲突开场不写天气铺垫）不变。
- 语义效果：治愈向等不组合即不生效，模型不再需要「忍住不照做」。

## F9 新流派包 2 个

结构五段统一：类型公约 / 结构纪律 / 信息管理 / 禁区 / 推荐组合（仅参考）。

- **genre-suspense（悬疑）**：公约--威胁具象且持续在场，读者比人物多知道一点或早一步（信息差是燃料）。纪律--威胁升级曲线，每章至少推一步「离真相或离危险更近」。信息管理--什么藏、什么半露、何时揭；反转靠重释已示信息，不靠新造设定（反转不欺骗）。禁区--故弄玄虚的空转章、威胁凭空消失再凭空回来。推荐组合：fast-readable + suspense-chapter-end。
- **genre-detective（侦探）**：公约--公平性原则，破案所依赖的线索必须在揭示前展示给读者，红鲱鱼有度。功能位--侦探（推理引擎）、助手（读者代理）、嫌疑人阵列（各有秘密）。纪律--案件-调查-中间揭示-二次危机-解谜-验证的经典节拍。禁区--侦探靠作者没给的信息破案、嫌疑人纸片化。推荐组合：任一基座 + dialogue-driven（讯问/对峙场景）。

display_name「悬疑」「侦探」；category: genre。

## 任务拆分（建议实现序）

1. F1 删除 output_style 全链（源码 5 处 + 测试 5 处 + sim fixture），prove-dead 先行 grep 建立基线。
2. F2 保护名单删除（catalog / index / settings-routes / settings-modal 分区重构 + 4 个测试文件）。
3. F3+F4 机制接线：runtime category 透传一行 + prompt 目录标签与 INTRO + STYLE_SELECTION_RULE 替换。
4. F6 三基座重写（内容主体，AI 红线下沉）。
5. F7+F8 修饰两新两改。
6. F9 流派两包。
7. F5 WWRITING.md 三行式 + sim 断言更新。
8. 回归收口：`npm test` 全量 + UI 三件套（settings-modal 改动触发）+ prove-dead 清零 + 内容人工验收。

## 验收策略

- prove-dead 全库清零：`output_style|outputStyle|output-style|BUNDLED_STYLES|loadOutputStyles|PROTECTED_BUILTIN_SKILLS|reserved_builtin|skill_reserved|writing_style_skill|styleSkill|parseFrontmatterStyleSkill`（src/ 与 tests/，模拟脚本一并）。
- `npm test` 全量绿；UI 改动触发三件套：`verify:app-clickability` / `verify:app-shell` / `verify:desktop-shell`。
- `sim:user-flow` 断言更新后跑通：WWRITING.md 三行式（fixture :113-132），且已选基座在动笔前经 read_skill 读取（事件序断言）；流派分层加载时机在 sim 场景纳入流派后才可断言，本轮不强制。
- 内容人工验收（自动化不覆盖，产品价值所在）：① 同一段大纲新旧体系各写一版对照，新版明显更快、更爽、AI 味更低；② 同一段悬疑大纲在 genre-suspense 组合下产出体现信息差纪律与「反转不欺骗」，且节奏不塌。

## 风险与权衡

- **同名覆盖开放**：用户导入 `balanced` 同名技能将 shadow 内置版（catalog 可见，非静默）。D2 设计意图，5 个技巧技能已在此模式下长期运行。
- **AI 红线四份副本**（3 基座各一份收敛短列表 + avoid-ai-voice 全文）存在漂移可能。接受：短列表仅 5 行，换「随基座必载」的强度保证；升级路径--若漂移实害，改选择规则强制动笔前同读 avoid-ai-voice。`ponytail:` 该取舍应在基座模板注释留痕。
- **选择规则变长**：常驻 system prompt 增约百余 token（静态文本）；渐进加载结构不变，正文仍按需读取。
- **基座重写是行为变化**：进行中项目下次 read_skill 即读到新文风（这正是本轮目标）；旧 WWRITING.md 单行格式后向兼容，无迁移。
- **新修饰/流派的内容质量**无法由测试保证，靠人工验收两条款兜底；不达标则内容返工而非机制返工。
