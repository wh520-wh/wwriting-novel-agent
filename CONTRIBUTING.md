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

仓库另有一批验收脚本，按需运行：

```bash
npm run verify:unified-agent   # Agent 主链路
npm run verify:app-shell       # 界面外壳
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

1. `npm test` 通过
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
- 单文件体积：逻辑源码超过 1200 行时优先拆分，而不是继续堆叠
- 不引入非必要的依赖

## 许可

向本项目提交贡献即表示你同意以本仓库的 [MIT 许可证](LICENSE) 授权你的贡献。
