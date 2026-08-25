# WWriting Bug Hunt Report Round 2（whfind-bugs，2026-08-25）

流程：本人通读**上一轮未覆盖区域**提出候选 -> 每个候选交由**全新怀疑者子代理**（无共享上下文、被要求默认反驳）独立验证 -> 主循环复核（grep 复核载荷性事实）。

- **确认（经受反驳）：5 个**（全部 low / 被降级；无 major / moderate）
- **驳回（怀疑者或主循环击杀）：3 个**（含主循环自毙 2 个，记录在文末）
- **对比第一轮**（2026-08-24 后端扫：2 major + 3 moderate）：前端约 2.1 万行未发现 major/moderate 级缺陷。十五/十六轮重灾区（前端大拆分 + gsap 退役 + dom-kit 单源化）经此轮验证处于健康状态，防御层（jsdom 行为测试 + 三件套验证门禁 + 架构守卫）发挥了作用。

只读分析，未改动任何核心代码。

---

## 确认的 Bug（全部 low）

### 1.（LOW）SSE 事件流网络级失败无 UI 反馈，连续 5 次失败后静默永久放弃

- **位置**：`src/app-shell/agent/api.js`（catch 块 :343-351 只计数退避、不调 onStreamError；run 循环五连败 return）+ `src/app-shell/agent/index.js:176-179`（onStreamError -> connection_error 事件）
- **现象**：网络级失败（fetch 抛错、非 200）从不触发 `onStreamError`（唯一调用点 dispatchBlock :424，仅服务端 error 帧触发），因此不产生「连接中断」错误卡；退避 1+2+4+8 秒后第 5 次失败即退出重连循环，此后事件流永久死亡，UI 无任何提示，需切会话/切项目/刷新才恢复。
- **怀疑者判定**：downgraded--五连败封顶是 round12 规格 F5 明文要求；「网络抛错不走上报路径」被 `tests/app-shell/agent-api.test.mjs:468` 显式断言钉死为预期行为；Electron 127.0.0.1 回环部署下「网络失败」实际只剩本机服务器不可用（此时其他交互路径也会报错）。残余问题是「活跃 Run 流式更新静默冻结、需用户动作才恢复」的反馈完整性缺口。
- **修复方向**（若做）：五连败放弃前补一次 onStreamError（出「连接中断」卡），或在 giveup 后安排慢速复活探测。

### 2.（LOW）「每章字数上限」是死字段：标签承诺不存在的语义，值不回显、无法清除

- **位置**：`src/app-shell/settings-modal.js:28`（字段定义与标签）+ `src/core/app-dashboard.mjs:142-143`（DTO 不含该字段）+ 保存链路（见下）
- **现象**（怀疑者修正后的完整画像）：
  - 标签承诺「留空 = 不限，按 target × 1.5 估算」--**全库 grep 证实 `max_words_per_chapter` 没有任何消费者**，「target × 1.5」估算不存在于任何代码，只存在于这行标签文案；
  - dashboard DTO 不回传该字段 -> 设置页重开时输入框恒为空（用户设置了 5000 也看不到），陈旧值隐形存于 project.yaml；
  - 一旦设置无法清除：前端 `compactObject`（utils.js:2）丢空串键 + 服务端 `mergeProjectSettings`（settings-runtime.mjs:159-163）跳过 null 值，两层都挡住清空（normalize 层 :383-385 把 ""/null 映射为 null 说明本意支持清空，但 merge 层丢弃 null，与 `mergeNullableSection` :423-433 的安全实现不一致）。
- **影响**：设置卫生 + 标签诚实性问题。写入的值当前无行为后果；但若未来按旧规格（2026-06-12 s2 设计 :98 的 warning-only 门禁）接线消费，存量隐形陈旧值会复活生效。project.yaml 是「系统维护不可手改」文件，UI 是唯一合法写入口。
- **怀疑者判定**：downgraded--机制全部属实（本人已独立 grep 复核消费者缺失），但无行为影响，修法是二选一：把字段接入章节门禁，或直接从 `WRITING_FIELDS` 删除该字段（无消费者，删除是更正确的修复）。

### 3.（LOW）抽屉「记忆」分区渲染无错误处理：请求失败时静默残留旧内容

- **位置**：`src/app-shell/drawer-panels.js:30`（renderDrawerBody await renderMemoryPanel 无 catch）+ :391/:406（三个顺序 GET 无 try/catch）；调用点 `app.js:308/359/778` 均 fire-and-forget，仓库无全局 unhandledrejection 处理器
- **现象**：任一 `/api/memory/files/content` 请求失败 -> renderMemoryPanel 在 `replaceChildren`（:410，最后一条语句）之前 reject -> 抽屉正文停留在上一个 tab 的内容（「记忆」高亮下显示别的分区内容），无 toast 无重试提示。
- **怀疑者判定**：downgraded--同文件兄弟路径（version-panel.js:111-122、exportBook、runResearch）都 catch 并提示，本路径是离群；但预期失败（文件缺失）已被服务端 `.catch(() => "")`（project-routes.mjs:389）吸收、本机部署下传输失败与 dashboard 失败同源（后者有 toast）、点击其他 tab 再点回即隐式重试。修复：renderMemoryPanel 逐请求 catch + 错误行提示（对齐兄弟路径）。

### 4.（LOW，文档）WWRITING.md/README 声称章节版本库有 200 版上限，代码是「完整保留，不裁剪」

- **位置**：`WWRITING.md:32`（「每章 200 版上限」）+ `README.md:44`（连带措辞）vs `src/core/project-operations/versions.mjs:3`（头注释「完整保留，不裁剪」；snapshotChapter 无 cap）
- **怀疑者判定**：downgraded 至文档笔误--「完整保留，不裁剪」是第八轮规格明文决策（2026-08-14-round8-spec D3 :83）且被 `tests/project-operations/versions.test.mjs:18` 测试钉死；200 上限是第九轮 C4 决策、**只针对记忆文件**（memory-versions.mjs:10 MEMORY_VERSION_CAP=200 有裁剪）。WWRITING.md:32 是第九轮写文档时与下一行（真有 cap 的记忆库）错误对称产生的笔误。增长速率实际缓慢（仅 commit/finalize/rollback 快照，单档 ≤200K 字符）。
- **修复**：改一行文档（WWRITING.md:32 与 README.md:44 的「每章/每文件 200 版上限」表述）；是否给章节库加裁剪是独立设计决策，走规格流程。

### 5.（LOW，启动失败路径）electron-main waitForServer 非 ok 响应时无 sleep 忙循环

- **位置**：`src/desktop/electron-main.cjs:244-248`（sleep 只在 catch 分支）；对照兄弟实现 `scripts/screenshot-app.cjs:88-92`（delay 在 try/catch 外无条件执行）
- **现象**：fetch 返回非 ok（如 /api/dashboard 500）时既不 return 也不 sleep，以最快速度空转打满事件循环至 8 秒超时抛错。
- **怀疑者判定**：confirmed (low)--机制成立；仅「本机服务器已监听但首屏端点持续报错」（启动注定失败）时可达，终端结果与修好后的版本相同（同样 8 秒后抛错），差异只是有界的 CPU 空转；无测试覆盖。修复：把 sleep 移到 try/catch 外（对齐 screenshot-app.cjs）。

---

## 驳回的候选（过滤器证据）

| 候选 | 驳回理由（怀疑者击杀点） |
|---|---|
| 工具轮的里程碑叙述在下一轮 `model_turn_started` 被清空、从不进入 conversation（state.js handleModelTurnStarted 不定稿 + run-pipeline 只对纯文本轮发 completed） | **三层测试钉死为预期行为**：`tests/app-shell/agent-surface.test.mjs:1448`（测试名「新模型轮次清除工具轮次的临时正文」）、`tests/agent/project-agent.test.mjs:656`、`tests/agent/journal-recovery.test.mjs:1834`（「model_turn_started 为新 Provider 轮次重置临时正文」）；round12 引入 N1 叙述时有意识保留该契约（sim 脚本注释与计划 :1871 留痕：N2 淡化标记只覆盖 waiting_user 定稿/队列消费路径）。叙述 delta 永久留在 journal、也不进 provider-history transcript（工具轮 assistant 记录 content:null）。**有效碎屑**：state.js:500-502 注释「正常序列里本事件之前不会有未闭合 delta」与钉死测试构造的正常序列直接矛盾，属注释失实可顺手修正；「Run 终态后保留过场叙述」是 feature request 不是 bug fix。 |
| loadEarlier 的 finally 无代次守卫（切会话后 restoreScrollAnchor/setLoadingEarlier 打到新视图） | 主循环自毙：view.reset() 清 earlierAnchor/loadingEarlier（timeline.mjs reset :497-516），迟到 finally 的两个调用均为幂等空操作。 |
| composer switchModel 保存后 apply 读 `data?.project?.tool_permissions` / `data?.capabilities?.reasoningEffortLevels` 疑似响应形状不匹配 | 主循环自毙：switchModelByReference 返回形状实测匹配（settings-runtime.mjs:600-612 含 project.tool_permissions 与 capabilities=caps，caps 带 reasoningEffortLevels）。 |

---

## 覆盖范围与方法说明

- **通读**（本轮新增，全部为 2026-08-24 报告明示的未覆盖区）：app-shell 前端全部（agent/index/state/api/work-items/context-ring/reasoning-ticker + view 四分区 + app/settings-modal/settings-modal-skills/model-settings-page/session-sidebar/drawer-panels/dom-kit/motion-runtime/markdown-lite/theme-privacy/settings-connection/permission-tiers/chapter-presentation/project-scope/slash-commands/utils/api-client/icons + components 四件 + shared 两件）；desktop Electron 壳全部；core 余部（research-tools/research-adapters/book-export/project-store/app-dashboard/model-connection-test/project-operations 三小件）；scripts（simulate-user-flow 全文、serve-app-shell/audit-cost/verify-desktop-shell 全文、verify-app-clickability 骨架）。
- **通读但由怀疑者顺带覆盖**：settings-runtime（project_profile 链）、run-pipeline（assistant 事件发射）、journal-handlers。
- **未覆盖**（预算耗尽，留待下轮）：scripts/ 的 capture-visual-acceptance.cjs（2880 行）、capture-all-ui.cjs（1272 行）、verify-unified-agent.mjs（1922 行）三个大号开发工具的内部逻辑；benchmark-agent-journal.mjs；src/core/app-state.mjs、chapter-artifact.mjs、chapter-memory.mjs、project-listing.mjs、project-model-migration.mjs、project-memory.mjs、project-diagnostics.mjs、model-presets/config-validation 等小块（多份在十六轮修复中已被带读过）。均为低危面（开发工具或已带读小模块）。
- 每个候选由独立怀疑者子代理（默认反驳立场、五问验证、三步结构）审核，共 6 个候选：5 确认（全降级至 low）/ 1 驳回；另有 2 个主循环自毙候选未进怀疑者（理由见驳回表）。降级率 5/6 偏高，原因是本轮只在通读中提交高置信候选且前端整体质量确实好于上一轮的后端内核。

## 与既有遗留清单的关系

本轮发现与十六轮登记遗留（whfind-bugs #6/#7、脱敏名单可变容器、retry-after-cancel 覆盖、makeEvent 工厂、session-sidebar 维护契约注释订正）互不重叠，可同轮顺带收口；新增同类的「注释失实」碎屑一项（state.js:500-502，见驳回表第一条）。
