# 贡献指南

感谢你有兴趣参与 WWriting Novel Agent。

## 环境要求

- Node.js >= 24.0.0（见 `package.json` 的 `engines`）
- Windows 10/11（当前打包与验收流程以 Windows 为主）

## 本地开发

```bash
git clone https://github.com/wh520-wh/wwriting-novel-agent.git
cd wwriting-novel-agent
npm ci
npm test          # 跑单元与集成测试
npm run app:shell # 启动 Web 外壳调试
npm run desktop:electron  # 启动 Electron 桌面端
```

## 运行测试

```bash
npm test
```

测试使用 Node 内置的 `node --test`，没有外部测试框架。新增测试必须对应用户可见行为、数据安全不变量或曾经复现的回归，不要为提高覆盖率而添加。

记录于：2026-09-26｜状态：当前有效｜依据：项目作者明确要求。项目由非技术背景作者通过 vibecoding 推进，贡献时先说明作者能看到的变化。额度与时间有限：优先复用和删除冗余，只做必要的有效测试与验收；相关检查通过后，不为流程形式重复全量门禁或增设抽象、配置和报告。

仓库另有一批验收脚本，按需运行：

```bash
npm run verify:unified-agent   # Agent 主链路
npm run verify:app-clickability # 界面外壳（真实 Electron 点击）
npm run verify:local           # 本地全量验收
```

## 提交规范

提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <description>
```

常用 `type`：`feat` / `fix` / `docs` / `refactor` / `test` / `chore`。

一次提交只做一件事。不要把格式化、重命名与逻辑改动混在同一次提交里。

## 提交前检查

1. 按影响运行相关检查，报告实际命令和结果；桌面与 CLI 分别验证。纯文档改动检查链接、状态与数字来源，不为形式重跑运行时全量测试
2. 涉及界面或流程的改动，说明验证方式与实际结果
3. 新增文件不包含个人路径、密钥或本地环境信息

## Pull Request

- 在描述里说明**改了什么**、**为什么改**、**如何验证**
- 关联相关 issue
- 保持改动聚焦；大范围重构请先开 issue 讨论
- 若改动影响数据安全或恢复行为，请在描述中显式指出

## 代码约定

- 语言：源文件使用 ESM（`.mjs` / `.js`），Electron 主进程使用 `.cjs`
- 样式：与周边代码保持一致，不引入与现有风格冲突的格式化规则
- 单文件体积：逻辑源码最多 1200 行且 51200 字节（LF 归一）；接近上限先删重复，再按实际边界拆分
- 不引入非必要的依赖

## 文档入口

记录于：2026-10-08｜状态：当前有效｜依据：文档职责收口。

继续维护先读[项目状态顶部](docs/memory/project-progress.md#当前状态)，按[文档索引](docs/design/README.md)定位现行规格、使用说明、领域词汇与设计理由。当前验证结果集中在项目状态；历史日志不冒称本轮结果。产品行为调整同步统一行为规格书，根 README 的使用说明同步中英文。

## 许可

向本项目提交贡献即表示你同意以本仓库的 [MIT 许可证](LICENSE) 授权你的贡献。
