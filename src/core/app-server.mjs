// src/core/app-server.mjs —— 组合根（统一 Agent 内核计划 Task 9）。
//
// 本文件只做依赖组装：共享项目锁、ProjectAgent（agent/index.mjs 公共 seam）、
// ModelGateway（per-project CostTracker）、HTTP 路由模块，然后启动 HTTP server。
// 不再包含任何 Agent/项目/设置 handler 实现，也不存在任何遗留批处理/队列状态。
//
// 路由归属：
//   - /api/agent/*、/api/project/events（SSE）→ http/agent-routes.mjs（只依赖 agent/index.mjs）
//   - 项目/章节/导出/资料/诊断 → http/project-routes.mjs
//   - 设置/模型/技能 → http/settings-routes.mjs
//   - 静态资源（app-shell）→ 本文件兜底 serveStatic
//
// 成本记账（Rule 9）：跨 Run 成本累计仍由 cost.json 负责。每个项目持有独立的
// ModelGateway + CostTracker（首用时从 cost.json 恢复累计值）；当会话回到 idle
// 且 tracker 有新增调用时，把该项目成本报告写回 cost.json。
import http from "node:http";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppStateSync } from "./app-state.mjs";
import { createProjectLockRegistry } from "./project-lock.mjs";
import { createRouter, resolveReadProjectRoot } from "./http/router.mjs";
import { createAgentRoutes } from "./http/agent-routes.mjs";
import { createProjectRoutes } from "./http/project-routes.mjs";
import { createSettingsRoutes } from "./http/settings-routes.mjs";
import { createProvidersRoutes } from "./http/providers-routes.mjs";
import { createProjectAgent } from "./agent/index.mjs";
import { createWorkspaceStore } from "./workspaces/store.mjs";
import { createModelGateway } from "./model/gateway.mjs";
import { OpenAICompatibleAdapter, ProviderConfigurationError } from "./model/openai-compatible.mjs";
import { runShellCommand } from "./shell/runtime.mjs";
import { CostTracker } from "./cost-tracker.mjs";
import { isPathInside, safeJoin } from "./fs-utils.mjs";
import { applyLocalSecretsToEnv, defaultSecretsRoot, loadLocalSecretsSync } from "./local-secrets.mjs";
import { loadEffectiveWorkspaceConfig } from "./config-runtime.mjs";
import { loadProviderStore } from "./model-provider-store.mjs";
import { testModelConnection as runModelConnectionTest } from "./model-connection-test.mjs";
import { loadDashboardData } from "./app-dashboard.mjs";
import { migrateProjectFile } from "./project-model-migration.mjs";

export function createAppShellServer({
  workspaceRoot = path.resolve("."),
  selectedProjectRoot = null,
  staticRoot = path.resolve("src", "app-shell"),
  secretsRoot = process.env.WWRITING_SECRETS_ROOT ?? defaultSecretsRoot(),
  stateRoot = null,
  port = 4173,
  testLoadDashboardData = null,
  testModelConnection = null,
  // Task 12：skills service seam。缺省全局单例；测试注入临时 root 的 service，
  // 避免迁移 marker 写进真实用户目录。
  skills = null,
  // Task 15（visual acceptance）：确定性 gateway 注入点，与 testLoadDashboardData
  // 同级。生产调用不传该参数、行为不变；传入时取代默认 per-project ModelGateway
  // 组装，由测试控制器提供可暂停/恢复的 gateway（scripts/capture-visual-acceptance.cjs）。
  testGatewayFactory = null
} = {}) {
  const workspace = path.resolve(workspaceRoot);
  const localSecretsRoot = path.resolve(secretsRoot);
  const appStateRoot = path.resolve(stateRoot ?? secretsRoot);
  // 计划 Task 4 Step 5：应用私有 workspace store 只在这里创建一次（stable workspace
  // id + <stateRoot>/workspaces/<id>/ 私有数据），注入 project/settings routes 与
  // Agent journal 存储根；各模块不得自行拼 stateRoot/workspaces 路径。
  const workspaceStore = createWorkspaceStore({ stateRoot: appStateRoot });
  const dashboardLoader = testLoadDashboardData
    ?? ((workspaceRootArg, options = {}) => loadDashboardData(workspaceRootArg, {
      ...options,
      skillService: skills ?? undefined,
      // Task 6：把 ProjectAgent 注入 dashboard 组装，loadDashboardData 内部把
      // agent.sessions(projectRoot) 并入响应；未注入/调用失败 → sessions:[]。
      // agent 在下方创建（组合根），本闭包只在请求时被调用，届时已就绪。
      agent,
      // Task 1：dashboard 读路径与写路径同源——注入应用私有 workspaceStore，
      // loadDashboardData 用 loadEffectiveWorkspaceConfig 覆盖 effective config。
      workspaceStore,
      // Task 6（模型迁移）：dashboard 读路径触发快照→引用迁移 + migration_notice
      // 透出；loadDashboardData 只有注入 secretsRoot 才产生迁移写盘。
      secretsRoot: localSecretsRoot
    }));
  const connectionTester = testModelConnection ?? runModelConnectionTest ?? null;
  applyLocalSecretsToEnv(loadLocalSecretsSync(localSecretsRoot));

  // 共享的项目选择状态（project-routes / settings-routes 注入同一可变引用）。
  const selection = { current: selectedProjectRoot ? path.resolve(selectedProjectRoot) : null };
  if (!selection.current) {
    // 持久会话：未显式指定项目时，恢复上次打开且仍有效的工作区。只检查目录存在
    //（计划 Task 4 Step 5：不检查 project.yaml）。
    const lastProjectRoot = loadAppStateSync(appStateRoot).lastProjectRoot;
    if (lastProjectRoot && existsSync(lastProjectRoot)) {
      selection.current = lastProjectRoot;
    }
  }

  // 任务 6：启动自动恢复路径同样迁移 project.yaml/私有 settings 快照→引用（一次性、
  // 幂等；mock 归零、匹配全局清单转引用、其余保持字面）。createAppShellServer 是
  // 同步工厂，不能在此 await；也刻意不预先在后台跑——后台写会与项目目录的直接读写
  //（测试/外部进程）竞态。迁移挂到首屏请求（GET /，Electron 启动必 loadURL）上，
  // 首次请求时执行一次并等待完成，保证首屏渲染前 project.yaml 已是引用形态；
  // 后续请求由下方 once 标记跳过（幂等，省去冗余读盘）。dashboard/open 响应路径
  // 各自触发迁移（带 migration_notice 透出），重复触发幂等无害。
  let startupModelMigration = null;
  let startupMigrationRan = false;
  if (selection.current) {
    // once 标记：GET / 每次进来都会调用本闭包，但迁移只应执行一次。check-then-set
    // 同步完成，并发首屏请求也不会重复执行；失败不重试（dashboard/open 路径随后
    // 仍会各自触发迁移）。
    startupModelMigration = () => {
      if (startupMigrationRan) return Promise.resolve();
      startupMigrationRan = true;
      return migrateProjectFile(selection.current, {
        workspaceStore,
        secretsRoot: localSecretsRoot
      }).catch(() => {});
    };
  }

  // 脱敏密钥清单：本地 secrets 的所有值（命令/输出/事件脱敏用）。
  const secrets = Object.values(loadLocalSecretsSync(localSecretsRoot)).filter(
    (value) => typeof value === "string" && value.length > 0
  );

  const projectLocks = createProjectLockRegistry();
  // 任务 5：组合根统一的有效工作区配置解析（应用私有 settings 优先 + 旧 project.yaml
  // 只读兼容输入 + 全局默认模型兜底）。Runtime 每模型轮调用（不缓存整份配置），
  // gateway adapter 每次模型调用调用——模型/权限切换在下一轮自然生效。
  const resolveEffectiveConfig = (projectRoot) =>
    effectiveWorkspaceConfigFor(projectRoot, { workspaceStore, secretsRoot: localSecretsRoot });
  const modelGateway = createAppModelGateway({ resolveEffectiveConfig });
  // Task 15：gatewayFactory 注入点。缺省走默认 per-project ModelGateway 组装
  //（含 CostTracker/cost.json 记账）；testGatewayFactory 注入时整个替换。
  const gatewayFactory =
    typeof testGatewayFactory === "function"
      ? testGatewayFactory
      : (projectRoot) => modelGateway.gatewayFor(projectRoot).gateway;

  // ProjectAgent：唯一 Agent seam。shell 接真实 Shell 运行时；每个项目持有独立
  // gateway（per-project 成本记账），provider 适配按请求 modelConfig 分发。
  // 计划 Task 3/4：journal 落应用私有 storageRoot（workspaceStore.agentRootFor），
  // 绝不写回项目内 .wwriting/agent。Task 5：模型/权限配置经 resolveEffectiveConfig
  // 注入 runtime，每轮读取（不再缓存整份配置）。
  const agent = createProjectAgent({
    gatewayFactory,
    shell: runShellCommand,
    projectLocks,
    secrets,
    agentStorageRootFor: (projectRoot) => workspaceStore.agentRootFor(projectRoot),
    workspaceConfigLoader: resolveEffectiveConfig,
    ...(skills ? { skills } : {})
  });

  // 路由组装：各 route module 返回 handler 表（"METHOD /path" -> handler）。
  const router = createRouter();
  const routeModules = [
    createAgentRoutes({
      agent,
      // /api/agent/* 与 /api/project/events 的作用域校验（Task 9 评审闭环）：
      // 与 project-routes 同一套注册语义（当前选中/工作区内/最近列表 + 磁盘目录
      // 可访问，不要求 project.yaml），未注册路径 400 INVALID_WORKSPACE_SCOPE，
      // journal 不得对任意路径惰性建目录。selected 在请求时读取（selection 是
      // 共享可变引用）。
      resolveProjectRoot: (projectRoot) => resolveReadProjectRoot({
        requestedRoot: projectRoot,
        selected: selection.current,
        workspace,
        stateRoot: appStateRoot
      })
    }),
    createProjectRoutes({
      workspace,
      stateRoot: appStateRoot,
      secretsRoot: localSecretsRoot,
      projectLocks,
      agent,
      dashboardLoader,
      selection,
      workspaceStore
    }),
    createSettingsRoutes({
      workspace,
      stateRoot: appStateRoot,
      secretsRoot: localSecretsRoot,
      connectionTester,
      selection,
      // 计划 Task 4 Step 5：注入同一个 workspaceStore（Task 5 起写应用私有 settings）。
      workspaceStore,
      ...(skills ? { skills } : {})
    }),
    createProvidersRoutes({ secretsRoot: localSecretsRoot })
  ];
  for (const module of routeModules) {
    for (const [pattern, handler] of Object.entries(module)) {
      const separatorIndex = pattern.indexOf(" ");
      if (separatorIndex <= 0) continue;
      router.add(pattern.slice(0, separatorIndex), pattern.slice(separatorIndex + 1), handler);
    }
  }
  // 本地单机关停端点（Electron before-quit 使用）。
  router.add("POST", "/api/shutdown", async () => ({ ok: true, message: "shutting down" }));

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/") {
      // 任务 6：打开应用首页先完成启动自动恢复路径的快照→引用迁移（见 selection
      // 恢复块注释）。迁移后再渲染首屏。
      if (startupModelMigration) await startupModelMigration();
    }
    if (url.pathname.startsWith("/api/")) {
      void router.handle(request, response).catch(() => {});
      return;
    }
    void serveStatic(url.pathname, response, { staticRoot });
  });

  // 优雅关停：把每个已知项目的未落盘成本报告写回 cost.json，flush 完成后再
  // 执行调用方 close 回调（成本落盘纳入关停完成路径，不 fire-and-forget）。
  const originalClose = server.close.bind(server);
  server.close = (callback) => originalClose(() => {
    void flushAllCostReports().finally(() => callback?.());
  });

  async function flushAllCostReports() {
    for (const [projectRoot, entry] of modelGateway.entriesMap) {
      try {
        await writeCostReportIfDirty(entry, projectRoot);
      } catch {
        // 关停时成本写失败不阻断关闭
      }
    }
  }

  return server;
}

// ---------------------------------------------------------------------------
// ModelGateway 组装：provider 分发 adapter + per-project gateway/cost tracker
// ---------------------------------------------------------------------------

// 任务 5 Step 4：有效工作区配置 + 引用解析。解析收进最底层 loadEffectiveWorkspaceConfig：
// 引用→完整配置（provider 恒 openai-compatible，与 gateway adapter 分发一致），失败
// 降级全局默认模型+note（resolution_note 字段供界面提示）。全局默认模型兜底同时
// 注入 Runtime 的 workspaceConfigLoader 与 gateway adapter，保证 request.modelConfig
// 与 adapter 的 provider 分发一致（v1 getDefaultLocalModelProfile 已在 Task 17 cutover
// 删除；projects/init 与运行时兜底都改走 v2 store）。
async function effectiveWorkspaceConfigFor(projectRoot, { workspaceStore, secretsRoot }) {
  return loadEffectiveWorkspaceConfig(projectRoot, {
    workspaceStore,
    modelStoreLoader: () => loadProviderStore(secretsRoot)
  });
}

function createAppModelGateway({ resolveEffectiveConfig }) {
  const entries = new Map(); // projectRoot -> { gateway, costTracker, lastWrittenCalls }

  function gatewayFor(projectRoot) {
    const key = path.resolve(projectRoot);
    let entry = entries.get(key);
    if (!entry) {
      // 首用时从项目 cost.json 恢复跨 Run 累计值。
      const summary = readJsonSyncSafe(safeJoin(key, "cost.json"));
      const costTracker = new CostTracker({ summary });
      // 每项目一个 provider 分发 adapter：runtime 请求虽然携带每轮 fresh 的
      // modelConfig（runtime.mjs modelConfigOf），但这里仍每次重读有效工作区配置
      // 决定 provider 与 adapter 参数——运行中切换模型后下一次调用自然走新配置
      //（组合根职责，长驻服务器语义）。任务 5：有效配置 = 应用私有 settings 优先
      // + 旧 project.yaml 只读兼容 + 全局默认模型兜底；不再直接读 project.yaml。
      const dispatchAdapter = {
        // Task 8：未配置模型 = active_model null，绝不自动回落 mock。有效配置读取
        // 失败同样视为未配置（宁可报配置错误，也不静默走假模型）。mock 分发已删除，
        // 用户面任何位置都不再出现 mock。
        async complete(request, { signal } = {}) {
          let active = null;
          try {
            const effective = await resolveEffectiveConfig(key);
            active = effective.active_model && typeof effective.active_model.provider === "string"
              ? effective.active_model
              : null;
          } catch {
            // 有效配置读取失败：视为未配置，抛配置错误（不回落 mock）
            active = null;
          }
          if (!active || active.provider !== "openai-compatible") {
            throw new ProviderConfigurationError("未配置模型：请先在模型设置中选择模型。");
          }
          const adapter = new OpenAICompatibleAdapter({
            baseUrl: active.base_url,
            apiKeyEnv: active.api_key_env
          });
          return adapter.complete(request, { signal });
        }
      };
      const gateway = createModelGateway({ adapter: dispatchAdapter, costTracker });
      entry = { gateway, costTracker, lastWrittenCalls: costTracker.getSummary().calls ?? 0 };
      entries.set(key, entry);
    }
    return entry;
  }

  return {
    gatewayFor,
    entriesMap: entries
  };
}

function readJsonSyncSafe(target) {
  try {
    if (!existsSync(target)) return null;
    return JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 成本落盘：会话回到 idle 且 tracker 有新增调用时写 cost.json
// ---------------------------------------------------------------------------

async function writeCostReportIfDirty(entry, projectRoot) {
  const calls = entry.costTracker.getSummary().calls ?? 0;
  if (calls === entry.lastWrittenCalls) return;
  await entry.costTracker.writeProjectReport(projectRoot);
  entry.lastWrittenCalls = calls;
}

// ---------------------------------------------------------------------------
// 静态资源（旧 app-server serveStatic 语义保留）：app-shell 文件与 /shared/ 模块
// ---------------------------------------------------------------------------

// marked 的浏览器 ESM 构建路径锚定在本仓库 node_modules（与运行时 workspaceRoot
// 配置无关——测试会把 workspaceRoot 指向临时目录，生产也可能传项目根）。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARKED_ESM_PATH = path.join(repoRoot, "node_modules", "marked", "lib", "marked.esm.js");

async function serveStatic(pathname, response, { staticRoot }) {
  // 只允许 /vendor/marked.esm.js 这一个白名单路径映射到 node_modules 里的
  // marked ESM 构建（浏览器 import map 的 "marked" 裸说明符指向它）；
  // node_modules 整体不作为静态目录暴露，其余 /vendor/* 一律 404。
  if (pathname === "/vendor/marked.esm.js") {
    try {
      const content = await fs.readFile(MARKED_ESM_PATH);
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(content);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("未找到");
    }
    return;
  }
  const sharedPrefix = "/shared/";
  const isSharedModule = pathname.startsWith(sharedPrefix);
  const root = pathname.startsWith(sharedPrefix)
    ? path.resolve(staticRoot, "..", "shared")
    : path.resolve(staticRoot);
  const requested = pathname === "/"
    ? "/index.html"
    : pathname.startsWith(sharedPrefix)
      ? pathname.slice(sharedPrefix.length - 1)
      : pathname;
  if (isSharedModule && ![".js", ".mjs"].includes(path.extname(requested))) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("未找到");
    return;
  }
  const target = path.resolve(root, `.${requested}`);
  if (!isPathInside(root, target)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("禁止访问");
    return;
  }
  try {
    const content = await fs.readFile(target);
    response.writeHead(200, {
      "content-type": contentType(target),
      "cache-control": "no-store"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("未找到");
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/html; charset=utf-8";
}
