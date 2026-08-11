// src/core/http/settings-routes.mjs —— 设置/模型/技能路由
//（统一 Agent 内核计划 Task 7 Step 3；Task 17 cutover 后仅保留 v2 形态）。
//
// 从旧 src/core/app-server.mjs 按职责提取（只读参考，不改旧文件）：settings/update、
// test-connection、model-switch、output-styles 与 skills catalog/import/delete 的
// handler 逻辑迁入本模块，保持既有非 Agent HTTP 契约（响应形状、错误码与 fields
// 字段级标红语义）。Task 17 cutover 删除 v1 扁平端点（模型保存/选用/删除/清单/
// 密钥）与 v1 存储写路径——模型保存/选用/删除改由 providers-routes（Task 10）承担。
//
// 本模块不创建 ModelClient、锁或 store；secretsRoot/connectionTester 由 composition
// root 注入。能力判定使用 Task 3 新建的 model/capabilities.mjs；旧的
// provider-adapters.mjs 已删除，本模块不依赖旧文件。
//
// 导出共享 helper 给 project-routes.mjs（模型档案展示）。
import os from "node:os";
import { HttpError } from "../http-error.mjs";
import { loadProject } from "../project-store.mjs";
import { loadConfigLayers, loadEffectiveWorkspaceConfig } from "../config-runtime.mjs";
import { appendEvent } from "../event-log.mjs";
import { loadOutputStyles } from "../output-style-loader.mjs";
import { skillService } from "../skills/index.mjs";
import { loadLocalSecrets, loadLocalSecretsSync } from "../local-secrets.mjs";
import { ModelConfigValidationError, validateModelConfig } from "../model-config-validation.mjs";
import {
  SettingsValidationError,
  normalizeSettingsPatch,
  saveWorkspaceSettings,
  updateProjectSettings
} from "../settings-runtime.mjs";
import { resolveModelCapabilities, writingRequiredCapabilitiesOk } from "../model/capabilities.mjs";
import { loadProviderStore } from "../model-provider-store.mjs";
import { toRequestConfig } from "../model-reference.mjs";
import { resolveActiveProjectRoot, resolveReadProjectRoot, resolveWriteProjectRoot } from "./router.mjs";

// ---------------------------------------------------------------------------
// 模型档案展示 helper（旧 app-server 语义保留；project-routes 复用）
// ---------------------------------------------------------------------------

export function providerDisplayName(activeModel = {}) {
  const provider = activeModel?.provider ?? "openai-compatible";
  const baseUrl = String(activeModel?.base_url ?? "").toLowerCase();
  const envName = activeModel?.api_key_env ?? "";
  // 用户声明的厂商显示名（provider_label）优先——这是「已配置」列表里模型身份
  // 的权威来源（2026-08-11 新增，借鉴 WHnovel 自由 name 但结构化：展示名 =
  // 厂商名 + 模型 ID）。未声明时才回落到按真实地址推断。
  const declaredLabel = typeof activeModel?.provider_label === "string" ? activeModel.provider_label.trim() : "";
  if (declaredLabel) {
    return declaredLabel;
  }
  // 官方端点判定只看真实地址（包含匹配，兼容 /v1、端口与大小写变体），不凭
  // model_name 前缀猜——第三方中转（如 opencode.ai）上挂 deepseek-/mimo- 名号的
  // 模型不是官方，必须和官方条目在「已配置」列表里区分开（2026-08-11 修复）。
  if (baseUrl.includes("api.deepseek.com") || envName === "DEEPSEEK_API_KEY") {
    return "DeepSeek 官方";
  }
  if (baseUrl.includes("xiaomimimo.com") || envName === "XIAOMI_MIMO_API_KEY") {
    return "小米 MiMo 官方";
  }
  // 自定义兼容端点：显示厂商名 + 主机，与官方条目可区分。
  if (provider === "openai-compatible") {
    const host = baseUrlHost(baseUrl);
    return host ? `OpenAI 兼容 · ${host}` : provider;
  }
  return provider;
}

function baseUrlHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

export function modelDisplayName(activeModel = {}) {
  const label = providerDisplayName(activeModel);
  const modelName = activeModel?.model_name ?? "";
  return modelName ? `${label} / ${modelName}` : label;
}

export function modelEndpoint(baseUrl) {
  if (!baseUrl) {
    return "";
  }
  try {
    return new URL("chat/completions", String(baseUrl).endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  } catch {
    return "";
  }
}

export function buildModelProfile(activeModel = {}, secretsRoot, options = {}) {
  // Task 8：未配置模型 = active_model null（用户面不再以 mock 兜底）。
  // 显式 provider/model_name 之外的形状（空对象/null）一律按未配置展示，
  // 绝不出现 "Mock" 字样。
  const isConfigured = Boolean(
    activeModel &&
    typeof activeModel === "object" &&
    !Array.isArray(activeModel) &&
    (activeModel.model_name || activeModel.provider)
  );
  if (!isConfigured) {
    return {
      provider: null,
      provider_label: null,
      model_name: null,
      base_url: "",
      endpoint: "",
      api_key_env: null,
      api_key_saved: false,
      api_key_masked: "",
      is_mock: false,
      display: "未配置",
      model_label: "未配置",
      id: options.id ?? null,
      saved_to: options.saved_to ?? "project.yaml",
      capabilities: null,
      pricing: null,
      temperature: null
    };
  }
  const provider = activeModel?.provider ?? "openai-compatible";
  const modelName = activeModel?.model_name ?? null;
  const apiKeyEnv = activeModel?.api_key_env ?? null;
  const secretValue = apiKeyEnv ? loadLocalSecretsSync(secretsRoot)[apiKeyEnv] ?? process.env[apiKeyEnv] ?? "" : "";
  return {
    provider,
    provider_label: providerDisplayName(activeModel),
    model_name: modelName,
    base_url: activeModel?.base_url ?? "",
    endpoint: provider === "openai-compatible" ? modelEndpoint(activeModel?.base_url) : "",
    api_key_env: apiKeyEnv,
    api_key_saved: Boolean(secretValue),
    api_key_masked: secretValue ? `••••${secretValue.slice(-4)}` : "",
    is_mock: provider === "mock",
    display: modelDisplayName(activeModel),
    model_label: modelDisplayName(activeModel),
    id: options.id ?? modelName,
    saved_to: options.saved_to ?? "project.yaml",
    capabilities: resolveModelCapabilities(activeModel),
    // 价格与温度一并带回：设置面板无项目时用全局默认模型渲染表单，
    // 缺这两个字段会显示成空白（价格已保存却看不见）。
    pricing: activeModel?.pricing ?? null,
    temperature: activeModel?.temperature ?? null
  };
}

// 技能目录名（HTTP 层兜底校验：与 seam 的 assertSafeSkillDirName 语义一致，
// 允许中文等任意非空单段名，拒绝路径分隔符与 . / .. 防穿越）。
function assertSkillNameParam(name) {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === ".." || /[\\/]/u.test(name) || name.includes("\0")) {
    throw new HttpError(400, "skill_invalid_name", `非法技能名: ${name}`);
  }
  return name;
}

export function createSettingsRoutes({
  workspace,
  stateRoot,
  secretsRoot,
  connectionTester = null,
  selection = null,
  // 计划 Task 4 Step 5：组合根注入同一个 workspaceStore（应用私有 settings 真相源）。
  // 任务 5：模型切换与权限保存写入 <stateRoot>/workspaces/<id>/settings.json，不再
  // 写回 project.yaml（旧文件只读保留为回滚依据）。未注入时回退预任务 5 的
  // project.yaml 写路径（旧组合根兼容，见 tests/http/project-routes.test.mjs）。
  workspaceStore = null,
  // Task 12：skills service seam（src/core/skills/index.mjs）。生产缺省用全局
  // 单例；测试注入临时 root 的 service，避免迁移 marker 写进真实用户目录。
  skills = null
} = {}) {
  if (!secretsRoot) {
    throw new TypeError("createSettingsRoutes 需要注入 secretsRoot");
  }
  const hasWorkspaceStore = Boolean(workspaceStore && typeof workspaceStore.saveSettings === "function");
  const skillServiceRef = skills ?? skillService;
  // 共享的项目选择状态（composition root 注入同一个可变引用，project-routes 共用）。
  const selectedRef = selection ?? { current: null };
  const ctx = {
    get selected() {
      return selectedRef.current;
    },
    workspace,
    stateRoot
  };

  // 归档校验对普通目录（无 project.yaml）宽容：应用私有 settings 不保存归档状态，
  // 归档只来自旧 project.yaml（有效配置合并后 archived_at 反映旧文件），普通目录
  // 恒为未归档。返回读取到的有效配置/项目对象供调用方复用。
  async function assertNotArchived(projectRoot) {
    const project = hasWorkspaceStore
      ? await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore })
      : await loadProject(projectRoot);
    if (project.archived_at) {
      throw new HttpError(400, "PROJECT_ARCHIVED", "项目已归档（只读）。请先解除归档再执行此操作。");
    }
    return project;
  }

  // Task 16：模型切换（引用形态）——校验 { provider_id, model_id } 在 v2 清单中
  // 存在且供应商/模型均启用 + 写作能力 C 档，然后写项目引用到应用私有 settings。
  // 响应为引用契约（active_model = 引用），不再返回旧 available_models/model_profile。
  async function switchModelByReference({ body, projectRoot }) {
    const providerId = String(body?.provider_id ?? "").trim();
    const modelId = String(body?.model_id ?? "").trim();
    if (!providerId || !modelId) {
      throw new HttpError(400, "invalid_model_reference", "provider_id 与 model_id 均必填。");
    }
    const store = await loadProviderStore(secretsRoot);
    const provider = store.providers.find((p) => p.id === providerId);
    const model = provider?.models.find((m) => m.id === modelId);
    if (!provider || !model) {
      throw new HttpError(404, "model_profile_not_found", `未找到已配置模型：${providerId}/${modelId}`);
    }
    if (provider.status === "disabled") {
      throw new HttpError(400, "provider_disabled", "该供应商已停用，无法切换。");
    }
    if (model.enabled === false) {
      throw new HttpError(400, "model_disabled", "该模型已停用，无法切换。");
    }
    const literal = toRequestConfig(provider, model);
    if (!writingRequiredCapabilitiesOk(literal)) {
      throw new HttpError(400, "model_unsupported", "该模型不支持工具调用，无法用于小说写作。");
    }
    const reference = { provider_id: provider.id, model_id: model.id };
    const before = await assertNotArchived(projectRoot);
    const caps = resolveModelCapabilities(literal);
    const conflicts = [];
    if (caps.supportsTemperature === false && before.active_model?.temperature !== undefined) {
      conflicts.push("该模型不支持温度设置，写作温度不会生效。");
    }
    if (hasWorkspaceStore) {
      // 任务 5 Step 5：统一走 saveWorkspaceSettings——成对携带 active_model（引用）
      // 与 tool_permissions（保留当前有效权限）；运行时按 modelStoreLoader 解析。
      await saveWorkspaceSettings(projectRoot, { workspaceStore, activeModel: reference });
    } else {
      // 旧组合根（未注入 workspaceStore）没有模型解析链路，无法存裸引用——按清单
      // 解析成字面配置写入。toRequestConfig 输出含 provider_id/model_id，解析器会把
      // 它重新解释为引用：行为与直接写引用等价（Task 16 质量审查修正注释）。
      await updateProjectSettings(projectRoot, { active_model: literal });
    }
    const effective = hasWorkspaceStore
      ? await loadEffectiveWorkspaceConfig(projectRoot, {
          workspaceStore,
          modelStoreLoader: () => loadProviderStore(secretsRoot)
        })
      : (await loadConfigLayers(projectRoot, await loadProject(projectRoot))).effective;
    return {
      ok: true,
      projectRoot,
      active_model: reference,
      capabilities: caps,
      conflicts,
      project: {
        project_id: effective.project_id ?? null,
        active_model: effective.active_model,
        tool_permissions: effective.tool_permissions ?? {}
      },
      effective_config: effective
    };
  }

  return {
    // 设置更新：非模型字段校验先于落盘（请求原子）；错误带 fields 供逐项标红。
    // 任务 5：写作用域解析不再要求 project.yaml（普通目录同样是合法工作区）；
    // tool_permissions 写入应用私有 workspace settings，其余字段继续走 project.yaml。
    "POST /api/settings/update": async ({ body }) => {
      try {
        const projectRoot = await resolveWriteProjectRoot({
          requestedRoot: body?.projectRoot ?? undefined,
          expectedProjectRoot: body?.expectedProjectRoot ?? undefined,
          selected: ctx.selected,
          workspace: ctx.workspace,
          stateRoot: ctx.stateRoot
        });
        await assertNotArchived(projectRoot);
        const activeModel = body?.active_model && typeof body.active_model === "object"
          ? { ...body.active_model }
          : null;
        const nonModelPatch = { ...body };
        delete nonModelPatch.active_model;
        delete nonModelPatch.projectRoot;
        delete nonModelPatch.expectedProjectRoot;
        let normalizedNonModelPatch = null;
        if (Object.keys(nonModelPatch).length > 0) {
          try {
            normalizedNonModelPatch = normalizeSettingsPatch(nonModelPatch);
          } catch (settingsError) {
            if (settingsError instanceof SettingsValidationError) {
              throw new HttpError(400, settingsError.code, settingsError.message);
            }
            throw settingsError;
          }
        }
        if (!activeModel && !normalizedNonModelPatch) {
          throw new HttpError(400, "invalid_settings_patch", "settings update requires a patch.");
        }

        if (hasWorkspaceStore) {
          // 任务 5 Step 5：权限保存写应用私有 workspace settings（成对携带模型，
          // 旧 project.yaml 只读保留为回滚依据）。
          if (normalizedNonModelPatch?.tool_permissions) {
            const before = await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore });
            await saveWorkspaceSettings(projectRoot, {
              workspaceStore,
              toolPermissions: { ...before.tool_permissions, ...normalizedNonModelPatch.tool_permissions }
            });
          }
          // 其余非模型、非权限字段仍走旧 project.yaml 路径（旧项目兼容）。
          const legacyPatch = { ...(normalizedNonModelPatch ?? {}) };
          delete legacyPatch.tool_permissions;
          if (Object.keys(legacyPatch).length > 0) {
            await updateProjectSettings(projectRoot, legacyPatch);
          }
        } else if (normalizedNonModelPatch && Object.keys(normalizedNonModelPatch).length > 0) {
          // 旧组合根（未注入 workspaceStore）：整包继续写 project.yaml（预任务 5 行为）。
          await updateProjectSettings(projectRoot, normalizedNonModelPatch);
        }

        let finalProject;
        let finalEffective;
        if (hasWorkspaceStore) {
          finalEffective = await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore });
          finalProject = {
            project_id: finalEffective.project_id ?? null,
            active_model: finalEffective.active_model,
            tool_permissions: finalEffective.tool_permissions ?? {},
            budget_config: finalEffective.budget_config ?? {},
            research_config: finalEffective.research_config ?? {}
          };
        } else {
          const mergedProject = await loadProject(projectRoot);
          const config = await loadConfigLayers(projectRoot, mergedProject);
          finalEffective = config.effective;
          finalProject = {
            project_id: mergedProject.project_id,
            active_model: mergedProject.active_model,
            tool_permissions: mergedProject.tool_permissions ?? {},
            budget_config: mergedProject.budget_config ?? {},
            research_config: mergedProject.research_config ?? {}
          };
        }
        return {
          ok: true,
          projectRoot,
          project: finalProject,
          effective_config: finalEffective,
          model_profile: buildModelProfile(finalEffective.active_model, secretsRoot),
          secret_saved: false,
          secret_env: null
        };
      } catch (error) {
        if (error instanceof ModelConfigValidationError) {
          throw new HttpError(400, error.code, error.message, { fields: error.fields });
        }
        if (error instanceof SettingsValidationError) {
          throw new HttpError(400, error.code, error.message);
        }
        if (error instanceof HttpError) {
          throw error;
        }
        const code = error?.code ?? "settings_update_failed";
        const status = code === "settings_rollback_failed" ? 500 : 400;
        throw new HttpError(status, code, error?.message ?? String(error));
      }
    },

    // 模型切换：写作必需能力缺失的模型在写配置前拦截（C 档）。
    // 任务 5：普通目录（无 project.yaml）同样可以切换模型；切换写入应用私有
    // workspace settings，不再写回 project.yaml（旧文件只读保留为回滚依据）。
    // Task 16：接受引用形态 { provider_id, model_id }——校验二者在 v2 清单中可用
    // 且供应商/模型启用，然后写项目引用（应用私有 settings）。Task 17 cutover 后
    // 只接受引用形态，旧 { model_id } 形态由 400 invalid_model_reference 拒绝。
    "POST /api/settings/model-switch": async ({ body }) => {
      try {
        const projectRoot = await resolveWriteProjectRoot({
          requestedRoot: body?.projectRoot ?? undefined,
          expectedProjectRoot: body?.expectedProjectRoot ?? undefined,
          selected: ctx.selected,
          workspace: ctx.workspace,
          stateRoot: ctx.stateRoot
        });
        return await switchModelByReference({ body, projectRoot });
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, "model_switch_failed", error?.message ?? String(error));
      }
    },

    // 连接测试：候选模型（双形态——新设置页「供应商+模型」{ provider, model } 或旧
    // 表单 { active_model }）+ 临时 api_key 完全不入项目/secret 文件；只读探测后
    // 追加一条不含密钥的审计事件。缺字段/缺密钥映射 configuration_missing；
    // 探测超时（Task 11/B6）返回 504 request_timeout，不再被误分类为 499 取消。
    "POST /api/settings/test-connection": async ({ body }) => {
      if (!connectionTester) {
        throw new HttpError(503, "model_probe_unavailable", "模型连接探测尚未配置。");
      }
      // B3：不再监听 request close——router 的 readJsonBody 已消费完请求体，close
      // 早已触发，该检测不可达；客户端断开由 fetch 侧（信号中止）处理。信号仍传给
      // tester，供未来真正可中止的传输层使用。
      const abortController = new AbortController();
      try {
        let projectRoot = null;
        if (selectedRef.current) {
          projectRoot = await resolveActiveProjectRoot(ctx).catch(() => null);
        }
        // Task 11：请求体双形态归一化。新设置页（Task 15）按「供应商+模型」调用：
        //   { provider: { base_url, api_key_env }, model: { model_name }, api_key? }
        // 旧表单沿用 { active_model, api_key }（api_key 也支持内嵌在 active_model）。
        // 归一化到统一 candidate 形状再走既有校验；字段缺失交给 validateModelConfig
        // 产出逐字段 fields 标红（见下方 catch）。
        const candidate = body?.provider && body?.model
          ? {
              provider: "openai-compatible",
              base_url: body.provider.base_url,
              api_key_env: body.provider.api_key_env,
              model_name: body.model.model_name,
              api_key: body.api_key
            }
          : body?.active_model
            ? {
                ...body.active_model,
                // 顶层 api_key 优先，缺省保留 active_model 内嵌的 api_key（旧放法）
                ...(typeof body.api_key === "string" ? { api_key: body.api_key } : {})
              }
            : null;
        if (!candidate) {
          throw new HttpError(400, "configuration_missing", "请填写接口地址和模型名称。");
        }
        const project = projectRoot ? await loadProject(projectRoot).catch(() => null) : null;
        const projectId = project?.project_id ?? null;

        let validated;
        try {
          validated = validateModelConfig(candidate);
        } catch (error) {
          if (error instanceof ModelConfigValidationError) {
            throw new HttpError(400, error.code, error.message, { fields: error.fields });
          }
          throw error;
        }

        const stored = await loadLocalSecrets(secretsRoot);
        const transientApiKey = typeof candidate.api_key === "string" && candidate.api_key.length > 0
          ? candidate.api_key
          : null;
        const secrets = { ...stored };
        if (transientApiKey) {
          secrets[validated.api_key_env] = transientApiKey;
        }
        if (!secrets[validated.api_key_env]) {
          throw new HttpError(400, "configuration_missing", "请先在 Windows 环境变量中配置 API Key");
        }

        const persistedConfig = {
          provider: validated.provider,
          model_name: validated.model_name,
          base_url: validated.base_url,
          api_key_env: validated.api_key_env
        };

        const result = await connectionTester({
          config: persistedConfig,
          secrets,
          signal: abortController.signal
        });

        let baseUrlOrigin = "";
        try {
          baseUrlOrigin = new URL(validated.base_url).origin;
        } catch {
          baseUrlOrigin = "";
        }

        if (projectRoot) {
          await appendEvent(projectRoot, {
            type: "model_connection_tested",
            project_id: projectId,
            stage: "settings",
            severity: result?.ok ? "info" : "warn",
            message: result?.ok ? "模型连接成功" : `模型连接失败：${result?.code ?? "unknown"}`,
            data: {
              ok: result?.ok === true,
              provider: persistedConfig.provider,
              model_name: persistedConfig.model_name,
              base_url_origin: baseUrlOrigin,
              code: result?.code ?? null,
              latency_ms: typeof result?.latency_ms === "number" ? result.latency_ms : null
            }
          });
        }

        // Task 11/B6：探测超时 → 504 request_timeout（旧行为经 AbortError 误分类
        // 为 499 client_closed_request）。审计事件已在上方落一条 warn，再以明确
        // 状态码抛给前端（Task 15 设置页据此区分超时与取消）。
        if (result?.code === "request_timeout") {
          throw new HttpError(504, "request_timeout", "模型服务器响应超时（30 秒）");
        }

        return {
          ok: result?.ok === true,
          code: result?.code ?? null,
          message: result?.message ?? null,
          provider: persistedConfig.provider,
          model_name: persistedConfig.model_name,
          latency_ms: typeof result?.latency_ms === "number" ? result.latency_ms : null,
          projectRoot
        };
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        // Task 11/B6：注入的 tester 直接抛 ProviderTransportError(reason="timeout")
        // 时同样映射 504（与 result.code === "request_timeout" 路径一致）。
        // 下方两个分支对真实 tester 属防御/不可达：testModelConnection 只 return 不
        // throw，B3 后路由自身 signal 从不中止；保留以兼容注入 tester 与未来可中止传输层。
        if (error?.reason === "timeout") {
          throw new HttpError(504, "request_timeout", "模型服务器响应超时（30 秒）");
        }
        // 调用方取消保留 499 映射：客户端中途断开由 fetch 侧中止信号、经 tester
        // 原样上抛 AbortError（B3 移除 close 监听后本路由不再自行检测断开）。
        if (error && (error.name === "AbortError" || error.code === DOMException.ABORT_ERR)) {
          throw new HttpError(499, "client_closed_request", "连接测试已取消");
        }
        throw new HttpError(400, "test_connection_failed", error?.message ?? String(error));
      }
    },

    // 输出样式：只暴露 name/description/source，剥离 filePath 与大 body。
    "GET /api/output-styles": async () => {
      try {
        const projectRoot = selectedRef.current ?? null;
        const styles = await loadOutputStyles({ projectRoot, userHome: os.homedir() });
        const lite = styles.map((s) => ({
          name: s.name,
          description: s.description ?? "",
          source: s.source
        }));
        return { ok: true, styles: lite };
      } catch (error) {
        throw new HttpError(500, "output_styles_failed", error?.message ?? String(error));
      }
    },

    // 技能（Task 13：catalog/import/delete 替代 enable/disable；无启停集合）。
    "GET /api/skills/catalog": async ({ query }) => {
      try {
        const projectRoot = await resolveCatalogProjectRoot(ctx, query.projectRoot);
        const [catalogData, migrationErrors] = await Promise.all([
          skillServiceRef.catalog({ projectRoot }),
          skillServiceRef.migrationErrors({ projectRoot })
        ]);
        return {
          ok: true,
          has_project: Boolean(projectRoot),
          project_root: projectRoot,
          active: catalogData.active.map(toCatalogEntry),
          shadowed: catalogData.shadowed.map(toCatalogEntry),
          migration_errors: migrationErrors,
          errors: catalogData.errors
        };
      } catch (error) {
        throw error instanceof HttpError
          ? error
          : new HttpError(500, "skills_catalog_failed", error?.message ?? String(error));
      }
    },

    // Task 8 Step 5：只读技能详情 API（渐进加载 read_skill 的服务端底座）。
    // 注册必须位于 "GET /api/skills/catalog" 之后（router 按注册顺序首匹配，
    // 先注册静态路径避免 "catalog" 被 :name 吞掉）。无项目时 builtin/global
    // 技能仍可读（resolveCatalogProjectRoot 失败回落 null，与 catalog 同语义）。
    "GET /api/skills/:name": async ({ params, query }) => {
      try {
        const projectRoot = await resolveCatalogProjectRoot(ctx, query.projectRoot);
        const name = assertSkillNameParam(params.name);
        const resource = await skillServiceRef.read({ projectRoot, name, resource: "SKILL.md" });
        return { ok: true, name, content: resource.content };
      } catch (error) {
        throw mapSkillError(error);
      }
    },

    "POST /api/skills/import": async ({ body }) => {
      try {
        const sourcePath = String(body?.source_path ?? "").trim();
        if (!sourcePath) {
          throw new HttpError(400, "invalid_skill_source", "请选择要导入的技能文件夹或 ZIP 包。");
        }
        const scope = body?.scope === "global" ? "global" : "project";
        const replace = body?.replace === true;
        const projectRoot = scope === "project" ? await resolveActiveProjectRoot(ctx) : null;
        if (scope === "project") await assertNotArchived(projectRoot);
        const imported = await skillServiceRef.importSkill({ projectRoot, source: sourcePath, scope, replace });
        return {
          ok: true,
          skill: imported.name,
          scope,
          projectRoot,
          source: imported.source
        };
      } catch (error) {
        throw mapSkillError(error);
      }
    },

    "DELETE /api/skills/:name": async ({ params, body }) => {
      try {
        const name = assertSkillNameParam(params.name);
        const scope = body?.scope === "global" ? "global" : "project";
        const projectRoot = scope === "project" ? await resolveActiveProjectRoot(ctx) : null;
        if (scope === "project") await assertNotArchived(projectRoot);
        const removed = await skillServiceRef.removeSkill({ projectRoot, name, scope });
        return { ok: true, ...removed };
      } catch (error) {
        throw mapSkillError(error);
      }
    }
  };

  // catalog 路由不要求必须有项目：无项目时只返回 global/builtin/bundled 层。
  // 项目根解析复用 dashboard 的注册语义（当前选中/工作区内/最近列表 + 磁盘
  // project.yaml）——catalog 虽只读，但 ensureMigrated 会写迁移 backup，不能让
  // 任意 projectRoot 查询触发对任意目录的迁移写入。
  async function resolveCatalogProjectRoot(ctxRef, requestedRoot) {
    try {
      return await resolveReadProjectRoot({
        requestedRoot,
        selected: ctxRef.selected,
        workspace: ctxRef.workspace,
        stateRoot: ctxRef.stateRoot
      });
    } catch {
      return null;
    }
  }

  // catalog DTO：active/shadowed 都返回 name/source/description/readonly/protected/
  // display_name/category；shadowed 项额外携带 shadow_reason（reserved_builtin 由
  // UI 用于区分「保留名称不可覆盖」与普通优先级覆盖）。绝不返回本地绝对 path 给
  // UI（冻结契约 §11 用户不得看到绝对内部存储路径）。
  function toCatalogEntry(skill) {
    const entry = {
      name: skill.name,
      source: skill.source,
      description: skill.description ?? "",
      readonly: skill.readonly === true,
      protected: skill.protected === true,
      display_name: skill.display_name ?? skill.name,
      category: skill.category ?? null
    };
    if (typeof skill.shadow_reason === "string" && skill.shadow_reason) {
      entry.shadow_reason = skill.shadow_reason;
    }
    return entry;
  }

  // 技能领域错误 → HTTP：skill_exists=409、skill_not_found=404、skill_reserved=403，
  // 其余 400。
  function mapSkillError(error) {
    if (error instanceof HttpError) return error;
    const status = error?.code === "skill_exists" ? 409
      : error?.code === "skill_not_found" ? 404
        : error?.code === "skill_reserved" ? 403
          : 400;
    return new HttpError(status, error?.code ?? "BAD_REQUEST", error?.message ?? String(error));
  }
}
