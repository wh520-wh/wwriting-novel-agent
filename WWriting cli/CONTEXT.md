# WWriting CLI

把长篇小说写作当工程来管理的命令行 Agent。单一对话面：写作、审核、命令共用一个输入框。本词汇表收录项目专属术语，随术语被敲定逐条增补。

## Language

### 技能（skills）

**技能 (Skill)**:
一份可被 Agent 发现并按需读取的写作规则包：一个目录 + 一份带 frontmatter（`name`、`description`，可选 `metadata.wwriting` 分类）的 SKILL.md。
_Avoid_: 技巧、插件、prompt 模板

**技能清单 (Catalog)**:
一次发现后得到的全体技能记录：生效项（active）、被覆盖项（shadowed）、解析失败项（errors）。
_Avoid_: 技能列表、技能目录（指清单时）

**发现根 (Source Root)**:
技能的来源层：内置（仓库 `src/skills`）、全局（`~/.wwriting/skills`）、项目（`<项目根>/skills`）。同名时优先级 项目 > 全局 > 内置。
_Avoid_: 技能路径

**被覆盖 (Shadowed)**:
跨发现根同名的低优先级副本：不生效，也不可经 read_skill 读取。
_Avoid_: 冲突、禁用

**渐进读取 (Progressive Loading)**:
技能正文绝不常驻 system prompt；目录块只注入 name/description/分类标签的摘要，全文经 read_skill 工具按需读取。
_Avoid_: 按需注入、懒加载

**基座 (writing-style)**:
恰选一个的写作风格技能，定行文姿态。
_Avoid_: 主风格、风格包

**修饰 (style-modifier)**:
按需叠加 0–3 个的单轴技法技能（如开头钩子、对话驱动、结尾悬念）。
_Avoid_: 附加风格

**流派 (genre)**:
按题材选定的类型公约技能，约束大纲与分章，规划章节结构前读取；可叠加，通常一个主导。
_Avoid_: 题材包

**写作风格区**:
WWRITING.md 里记录选型结果的小节：技能/修饰/流派三行，修饰与流派无则省略。
_Avoid_: 风格小节、风格配置
