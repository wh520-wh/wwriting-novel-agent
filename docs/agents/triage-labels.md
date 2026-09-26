# Triage Labels

记录于：2026-09-26｜状态：当前有效｜依据：setup-matt-pocock-skills 首次配置（用户选定「保留默认五个」）

这些技能用五个规范的分诊角色（canonical triage roles）说话。本文件把这五个角色映射到本仓库 issue tracker 中实际使用的标签串。

| 角色（mattpocock/skills） | 本仓库的标签串 | 含义 |
| ------------------------- | -------------- | ---- |
| `needs-triage`            | `needs-triage` | 待维护者评估 |
| `needs-info`              | `needs-info`   | 等待报告者补充信息 |
| `ready-for-agent`         | `ready-for-agent` | 规格完整，可交给 AFK agent 执行 |
| `ready-for-human`         | `ready-for-human` | 需要人来实现 |
| `wontfix`                 | `wontfix`      | 不予处理 |

当某个技能提到一个角色（例如「apply the AFK-ready triage label」）时，使用上表右列对应的标签串。

## 本仓库的落地方式

本仓库用**本地 markdown** 追踪（见 `docs/agents/issue-tracker.md`），所以这些「标签」不是 GitHub 标签，而是 issue 文件里靠上位置的 `Status:` 行取值：

```markdown
Status: needs-triage
```

- 五个值即上表左列，逐字使用，不自造新值
- GitHub 上**未创建**这五个标签，也不要为它们去建 GitHub 标签
- 需要新增角色时，先改本文件，再使用
