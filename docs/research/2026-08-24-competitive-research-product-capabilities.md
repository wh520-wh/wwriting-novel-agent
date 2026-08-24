# Competitive Research: 产品能力专题——权限确认 UX / 导出排版 / 设定集信息模型（合并版）

- 日期：2026-08-24；模式：Standard（4 个取证对象：Claude Code 权限系统、EPUBCheck、Campfire Writing、Scrivener 编译；NovelCrafter Codex 作交叉引用）
- 决策问题：权限档位与规则怎么设计才算完备；"导出成书"要做到什么程度才算达标；设定集（世界观信息模型）应覆盖哪些实体类型。

## Executive Conclusion

Claude Code 的权限系统已演进为**六档模式 + 工具级规则语法 + deny→ask→allow 求值序** [E1][E2][E3]——WWriting 的四档（只读自动/确认/YOLO/极端精确确认）覆盖了其中三档语义，缺的是**显式"只读规划档"**（plan mode：只探索不落盘）[E1]，这恰好是审稿子代理（报告 6 P0）需要的运行档位。导出方面，行业标准是 **EPUB 3.3 + epubcheck 官方校验器**（DAISY/W3C 维护，BSD-3）[E4]，Scrivener 的 Compile（Word/PDF/Epub/Kindle/FDX）是格式覆盖基线 [E5]，Campfire 甚至把"上传 EPUB 出版"独立成面板 [E6]——WWriting 的确定性导出补 epub + 校验即可达标。设定集的信息模型上，Campfire 18 模块（时间线/日历/地图/造语）划出上限 [E6]，NovelCrafter Codex 的自动追踪 + 跨系列共享是智能下限 [E7]——WWriting 用 Markdown 文件 + 索引可先覆盖时间线与角色两个最高频实体。明确的 non-goal：不做交互式地图与造语软件级模块。

## Current Product Baseline

WWriting：权限四档（只读自动、普通副作用确认、`本条输入允许同类操作`按输入粒度授权、YOLO、极端操作精确确认文字；Shell 进程树停止、流式脱敏）；确定性导出（本地导出流程，不经模型，具体格式以 Markdown 为主）；项目记忆 WWRITING.md 索引权威文件，无专门设定集实体模型。

## Competitor Comparison

| Source | 领域 | Evidence | Lesson | Do Not Copy |
| --- | --- | --- | --- | --- |
| Claude Code 权限 | 权限 UX | [E1][E2][E3] | 六档模式（default/acceptEdits/plan/auto/dontAsk/bypassPermissions）；规则语法 `Bash(npm *)` 通配、`Edit(src/**)` gitignore 式路径、`WebFetch(domain:*.example.com)` 域规则；求值序 deny→ask→allow 且"rule specificity doesn't change the order"；allow 需工作区信任后生效、deny/ask 立即生效 | auto 档的"分类器审批后台安全检查"复杂度 |
| EPUBCheck | 导出校验 | [E4] | EPUB 官方一致性校验器（W3C/DAISY），CLI 或 Java 库，校验 EPUB 2/3 对 3.3 规范；BSD-3 | Java 运行时依赖（可用其 Docker 或包装） |
| Scrivener Compile | 导出格式基线 | [E5] | Word/RTF/PDF/Final Draft/Epub/Kindle 一次编译多格式；快照+对比；自动备份 | 交互复杂度 |
| Campfire Writing | 设定集上限 | [E6] | 18 模块：角色/时间线/日历/地图/造语/物种…；订阅低至 $0.50/月 + 买断并存；EPUB 出版面板独立于写作软件 | 模块过多导致的结构绑架 |

## Cross-Market Patterns

- **权限 table stakes**：模式分档 + 工具级 allow/ask/deny 规则 + 明确求值序 + "deny 永远立即生效" [E1][E2][E3]。
- **导出 table stakes**：EPUB 为发行通用语 [E4][E6]；Word/PDF 为审稿通用语 [E5]；导出必须可离线、确定性。
- **设定集信息模型谱系**：文件派（WWRITING.md/权威文件）→ 结构化追踪派（Codex 自动追踪、跨系列共享 [E7]）→ 模块化上限派（Campfire 18 模块 [E6]）。时间线与角色是所有方案的公共子集。
- **Non-goal**：交互式地图编辑器、造语（conlang）软件、云端出版分销。

## Prioritized Roadmap

### P0

增加显式"只读/审稿档"会话模式：模型只能读与检索，任何写操作/副作用被拒绝并记入 Journal（对标 plan mode 的"只读探索"语义 [E1]）。该档位同时是审稿子代理的运行容器（与报告 6 P0 衔接）。验收信号：只读档下注入写请求的测试中操作被拒绝并留痕，且 UI 明示当前档位。

### P1

1. 权限规则文件化：项目/全局可定义 allow/ask/deny 三列表 + 通配符（工具名(参数模式)），求值序 deny→ask→allow，多来源规则合并而非覆盖（对标 [E2][E3]）。验收信号：规则文件被加载并有通配/合并/求值序的单元测试。
2. 确定性导出补 epub：生成 EPUB 3.3 并以 epubcheck 校验 0 错误后落盘（对标 [E4][E5]）。验收信号：导出菜单产出 .epub，CI 或验收脚本跑 epubcheck 通过。

### P2

设定集轻量实体模型：以技能模板生成 `timeline.md`（时间线/大事记）与 `characters.md`（角色状态）并入 WWRITING.md 索引，写前装配、章节提交时由模型追加更新（对标 Codex 追踪思想 [E7]，上限意识见 [E6]）。验收信号：/init 或技能可建立两类文件，验收语料断言写前上下文包含它们。

## Research Limits and Next Validation

- World Anvil 官网 403（反爬），设定集上限仅以 Campfire 取证；Campfire 模块级定价与导出格式未在首页展开。
- Claude Code 的 auto 档"后台安全检查"机制细节未取证（仅模式名与一句描述）。
- EPUBCheck 以 Java 运行为主，对 WWriting（Node/Electron）的集成方式（子进程 JAR/Docker/纯 JS 替代）需实测选型。
- 下一步验证：实测 epubcheck 对 WWriting 自产 EPUB 的报告；只读档做一次 20 条指令的红队测试（含诱导写盘的措辞）。
