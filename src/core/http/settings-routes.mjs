// src/core/http/settings-routes.mjs —— 设置/模型/技能路由
//（统一 Agent 内核计划 Task 7 Step 3）。
//
// 从旧 src/core/app-server.mjs 按职责提取（只读参考，不改旧文件）：settings/update、
// test-connection、model-secret/models/model-switch/model-profile/model-select/
// model-remove、output-styles 与 skills enable/disable/import 的 handler 逻辑迁入
// 本模块，保持既有非 Agent HTTP 契约（响应形状、错误码与 fields 字段级标红语义）。
//
// 本模块不创建 ModelClient、锁或 store；secretsRoot/connectionTester 由 composition
// root 注入。能力判定使用 Task 3 新建的 model/capabilities.mjs（Task 9 将删除旧的
// provider-adapters.mjs，本模块不依赖旧文件）。
//
// 导出共享 helper 给 project-routes.mjs（模型档案展示与全局模型同步）。
import os from "node:os";
import path from "node:path";
import { HttpError } from "../http-error.mjs";
import { loadProject, saveProject } from "../project-store.mjs";
import { loadConfigLayers, loadEffectiveWorkspaceConfig } from "../config-runtime.mjs";
import { appendEvent } from "../event-log.mjs";
import { loadOutputStyles } from "../output-style-loader.mjs";
import { skillService } from "../skills/index.mjs";
import {
  findLocalModelProfile,
  loadLocalModelProfiles,
  upsertLocalModelProfile
} from "../local-model-profiles.mjs";
import { loadLocalSecrets, loadLocalSecretsSync } from "../local-secrets.mjs";
import {
  GlobalModelSettingsError,
  refreshProjectModelFromGlobal,
  removeGlobalModelProfile,
  saveGlobalModelProfile,
  selectGlobalModelProfile
} from "../global-model-settings.mjs";
import { ModelConfigValidationError, validateModelConfig } from "../model-config-validation.mjs";
import {
  SettingsValidationError,
  normalizeSettingsPatch,
  saveModelSettingsTransaction,
  saveWorkspaceSettings,
  updateProjectSettings
} from "../settings-runtime.mjs";
import { resolveModelCapabilities, writingRequiredCapabilitiesOk } from "../model/capabilities.mjs";
import { resolveActiveProjectRoot, resolveReadProjectRoot, resolveWriteProjectRoot } from "./router.mjs";

// ---------------------------------------------------------------------------
// 模型档案展示 helper（旧 app-server 语义保留；project-routes 复用）
// ---------------------------------------------------------------------------

export function modelConfigFromLocalProfile(profile = {}) {
  const { id, saved_at, ...config } = profile;
  return config;
}

export function providerDisplayName(activeModel = {}) {
  const provider = activeModel?.provider ?? "mock";
  const baseUrl = activeModel?.base_url ?? "";
  const envName = activeModel?.api_key_env ?? "";
  const modelName = activeModel?.model_name ?? "";
  if (provider === "mock") {
    return "Mock";
  }
  if (baseUrl === "https://api.deepseek.com" || envName === "DEEPSEEK_API_KEY" || modelName.startsWith("deepseek-")) {
    return "DeepSeek 官方";
  }
  if (baseUrl === "https://api.xiaomimimo.com/v1" || envName === "XIAOMI_MIMO_API_KEY" || modelName.startsWith("mimo-")) {
    return "小米 MiMo 官方";
  }
  return provider;
}

export function modelDisplayName(activeModel = {}) {
  return `${providerDisplayName(activeModel)} / ${activeModel?.model_name ?? "mock-writer"}`;
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

export function sameModelProfile(left = {}, right = {}) {
  if (!left || !right) return false;
  return (
    left.provider === right.provider &&
    left.model_name === right.model_name &&
    (left.base_url ?? "") === (right.base_url ?? "") &&
    (left.api_key_env ?? "") === (right.api_key_env ?? "")
  );
}

export function buildModelProfile(activeModel = {}, secretsRoot, options = {}) {
  const provider = activeModel?.provider ?? "mock";
  const modelName = activeModel?.model_name ?? "mock-writer";
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
    id: options.id ?? modelName,
    saved_to: options.saved_to ?? "project.yaml",
    capabilities: resolveModelCapabilities(activeModel),
    // 价格与温度一并带回：设置面板无项目时用全局默认模型渲染表单，
    // 缺这两个字段会显示成空白（价格已保存却看不见）。
    pricing: activeModel?.pricing ?? null,
    temperature: activeModel?.temperature ?? null
  };
}

export async function buildAvailableModelProfiles(secretsRoot, activeModel = null) {
  const store = await loadLocalModelProfiles(secretsRoot);
  const models = [...store.models];
  if (
    activeModel?.provider &&
    activeModel?.provider !== "mock" &&
    activeModel?.model_name &&
    !models.some((model) => sameModelProfile(model, activeModel))
  ) {
    models.unshift(activeModel);
  }
  return models.map((model) => ({
    ...buildModelProfile(model, secretsRoot, { id: model.id ?? model.model_name, saved_to: "model-profiles.json" }),
    active: sameModelProfile(model, activeModel)
  }));
}

async function globalModelListPayload(secretsRoot) {
  const store = await loadLocalModelProfiles(secretsRoot);
  const defaultModel = store.models.find((model) => model.id === store.default_model_id) ?? store.models[0] ?? null;
  return {
    default_model: defaultModel
      ? buildModelProfile(defaultModel, secretsRoot, { id: defaultModel.id, saved_to: "model-profiles.json" })
      : null,
    models: await buildAvailableModelProfiles(secretsRoot, defaultModel)
  };
}

// 字段级错误必须原样带上 fields，界面要逐个输入框标红。
function sendGlobalModelError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof ModelConfigValidationError) {
    return new HttpError(400, error.code, error.message, { fields: error.fields });
  }
  if (error instanceof GlobalModelSettingsError) {
    return new HttpError(400, error.code, error.message);
  }
  return new HttpError(500, "global_model_save_failed", error?.message ?? "模型设置保存失败。");
}

// 读项目前先把全局模型的最新字段刷回 project.yaml。同步失败绝不能挡住界面。
export async function syncProjectModelFromGlobal(projectRoot, secretsRoot) {
  if (!projectRoot || !secretsRoot) return;
  try {
    await refreshProjectModelFromGlobal(projectRoot, secretsRoot, {
      readProject: loadProject,
      writeProject: saveProject
    });
  } catch (error) {
    console.warn("[settings-routes] 同步全局模型配置失败:", error?.message ?? error);
  }
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

        let result = null;
        // 模型保存（旧契约保留：写 project.yaml + secrets + env，供未注入
        // workspaceStore 的旧组合根使用；当前前端模型保存走 model-profile /
        // model-switch，本路径无活跃消费者）。
        if (activeModel) {
          result = await saveModelSettingsTransaction({ projectRoot, secretsRoot, activeModel });
          await upsertLocalModelProfile(secretsRoot, result.project.active_model);
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
            stage_overrides: finalEffective.stage_overrides ?? { enabled: false },
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
            stage_overrides: mergedProject.stage_overrides,
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
          available_models: await buildAvailableModelProfiles(secretsRoot, finalEffective.active_model),
          secret_saved: result?.secret_saved ?? false,
          secret_env: result?.secret_env ?? null
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

    // 模型密钥：请求 env 优先，缺省回落当前项目 active model 的 env。
    "GET /api/settings/model-secret": async ({ query }) => {
      try {
        let envName = query.env ?? null;
        if (!envName) {
          const projectRoot = await resolveActiveProjectRoot(ctx);
          const project = await loadProject(projectRoot);
          const config = await loadConfigLayers(projectRoot, project);
          envName = config.effective?.active_model?.api_key_env ?? null;
        }
        const value = envName ? loadLocalSecretsSync(secretsRoot)[envName] ?? process.env[envName] ?? "" : "";
        return { ok: true, env: envName, value };
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, "model_secret_failed", error?.message ?? String(error));
      }
    },

    "GET /api/settings/models": async () => {
      try {
        let activeModel = null;
        if (selectedRef.current) {
          const projectRoot = await resolveActiveProjectRoot(ctx).catch(() => null);
          if (projectRoot) {
            const project = await loadProject(projectRoot).catch(() => null);
            const config = project ? await loadConfigLayers(projectRoot, project).catch(() => null) : null;
            activeModel = config?.effective?.active_model ?? project?.active_model ?? null;
          }
        }
        const store = await loadLocalModelProfiles(secretsRoot);
        const defaultModel = store.models.find((model) => model.id === store.default_model_id) ?? store.models[0] ?? null;
        return {
          ok: true,
          default_model: defaultModel ? buildModelProfile(defaultModel, secretsRoot, { id: defaultModel.id, saved_to: "model-profiles.json" }) : null,
          models: await buildAvailableModelProfiles(secretsRoot, activeModel)
        };
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, "settings_models_failed", error?.message ?? String(error));
      }
    },

    // 模型切换：写作必需能力缺失的模型在写配置前拦截（C 档）。
    // 任务 5：普通目录（无 project.yaml）同样可以切换模型；切换写入应用私有
    // workspace settings，不再写回 project.yaml（旧文件只读保留为回滚依据）。
    "POST /api/settings/model-switch": async ({ body }) => {
      try {
        const projectRoot = await resolveWriteProjectRoot({
          requestedRoot: body?.projectRoot ?? undefined,
          expectedProjectRoot: body?.expectedProjectRoot ?? undefined,
          selected: ctx.selected,
          workspace: ctx.workspace,
          stateRoot: ctx.stateRoot
        });
        const modelId = String(body.model_id ?? body.modelId ?? body.model_name ?? "").trim();
        if (!modelId) {
          throw new HttpError(400, "invalid_model_id", "model_id is required.");
        }
        const profile = await findLocalModelProfile(secretsRoot, modelId);
        if (!profile) {
          throw new HttpError(404, "model_profile_not_found", `未找到已配置模型：${modelId}`);
        }
        if (!writingRequiredCapabilitiesOk(profile)) {
          throw new HttpError(400, "model_unsupported", "该模型不支持工具调用，无法用于小说写作。");
        }
        const before = await assertNotArchived(projectRoot);
        const caps = resolveModelCapabilities(profile);
        const conflicts = [];
        if (caps.supportsTemperature === false && before.active_model?.temperature !== undefined) {
          conflicts.push("该模型不支持温度设置，写作温度不会生效。");
        }
        const nextModel = modelConfigFromLocalProfile(profile);
        if (hasWorkspaceStore) {
          // 任务 5 Step 5：模型切换统一走 saveWorkspaceSettings——成对携带
          // active_model 与 tool_permissions（保留当前有效权限）。
          await saveWorkspaceSettings(projectRoot, { workspaceStore, activeModel: nextModel });
        } else {
          // 旧组合根（未注入 workspaceStore）：写 project.yaml（预任务 5 行为）。
          await updateProjectSettings(projectRoot, { active_model: nextModel });
        }
        await upsertLocalModelProfile(secretsRoot, nextModel);
        const effective = hasWorkspaceStore
          ? await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore })
          : (await loadConfigLayers(projectRoot, await loadProject(projectRoot))).effective;
        return {
          ok: true,
          projectRoot,
          capabilities: caps,
          conflicts,
          project: {
            project_id: effective.project_id ?? null,
            active_model: effective.active_model,
            tool_permissions: effective.tool_permissions ?? {}
          },
          effective_config: effective,
          model_profile: buildModelProfile(effective.active_model, secretsRoot),
          available_models: await buildAvailableModelProfiles(secretsRoot, effective.active_model)
        };
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, "model_switch_failed", error?.message ?? String(error));
      }
    },

    // 保存模型到全局清单：不需要项目。api_key 只落 secrets 与 process.env。
    "POST /api/settings/model-profile": async ({ body }) => {
      try {
        const candidate = body?.active_model && typeof body.active_model === "object" && !Array.isArray(body.active_model)
          ? body.active_model
          : null;
        if (!candidate) {
          throw new HttpError(400, "invalid_active_model", "请填写模型信息后再保存。");
        }
        const { activeModel } = await saveGlobalModelProfile({ secretsRoot, activeModel: candidate });
        return {
          ok: true,
          model_profile: buildModelProfile(activeModel, secretsRoot, {
            id: activeModel.model_name,
            saved_to: "model-profiles.json"
          }),
          ...(await globalModelListPayload(secretsRoot))
        };
      } catch (error) {
        throw sendGlobalModelError(error);
      }
    },

    // 选用 / 删除共用：按 model_id 改全局清单后回最新清单。选用受写作能力门禁。
    "POST /api/settings/model-select": async ({ body }) => {
      try {
        const modelId = String(body?.model_id ?? body?.modelId ?? "").trim();
        if (!modelId) {
          throw new HttpError(400, "invalid_model_id", "请先选择一个模型。");
        }
        const profile = await findLocalModelProfile(secretsRoot, modelId);
        if (profile && !writingRequiredCapabilitiesOk(profile)) {
          throw new HttpError(400, "model_unsupported", "该模型不支持工具调用，无法用于小说写作。");
        }
        await selectGlobalModelProfile(secretsRoot, modelId);
        return { ok: true, ...(await globalModelListPayload(secretsRoot)) };
      } catch (error) {
        throw sendGlobalModelError(error);
      }
    },

    "POST /api/settings/model-remove": async ({ body }) => {
      try {
        const modelId = String(body?.model_id ?? body?.modelId ?? "").trim();
        if (!modelId) {
          throw new HttpError(400, "invalid_model_id", "请先选择一个模型。");
        }
        await removeGlobalModelProfile(secretsRoot, modelId);
        return { ok: true, ...(await globalModelListPayload(secretsRoot)) };
      } catch (error) {
        throw sendGlobalModelError(error);
      }
    },

    // 连接测试：候选 active_model + 临时 api_key 完全不入项目/secret 文件；
    // 只读探测后追加一条不含密钥的审计事件。缺字段/缺密钥映射 configuration_missing。
    "POST /api/settings/test-connection": async ({ body, request, response }) => {
      if (!connectionTester) {
        throw new HttpError(503, "model_probe_unavailable", "模型连接探测尚未配置。");
      }
      const abortController = new AbortController();
      const onRequestClose = () => {
        if (!response.writableEnded) {
          abortController.abort(new DOMException("client closed request", "AbortError"));
        }
      };
      request.once("close", onRequestClose);
      try {
        try {
          let projectRoot = null;
          if (selectedRef.current) {
            projectRoot = await resolveActiveProjectRoot(ctx).catch(() => null);
          }
          const candidate = body?.active_model && typeof body.active_model === "object"
            ? { ...body.active_model }
            : null;
          if (!candidate) {
            throw new HttpError(400, "configuration_missing", "active_model is required.");
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

          return {
            ok: result?.ok === true,
            code: result?.code ?? null,
            message: result?.message ?? null,
            provider: persistedConfig.provider,
            model_name: persistedConfig.model_name,
            latency_ms: typeof result?.latency_ms === "number" ? result.latency_ms : null,
            projectRoot
          };
        } finally {
          // 无论成功/失败/取消，都清理请求关闭监听（旧实现只在探测成功后清理，
          // 校验失败路径会遗留监听直到请求关闭——虽无害但不一致）。
          // 499 client_closed_request 是客户端中途断开的有意映射，见下方 catch。
          request.removeListener("close", onRequestClose);
        }
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
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
  // display_name/category；绝不返回本地绝对 path 给 UI（冻结契约 §11 用户不得看到
  // 绝对内部存储路径）。
  function toCatalogEntry(skill) {
    return {
      name: skill.name,
      source: skill.source,
      description: skill.description ?? "",
      readonly: skill.readonly === true,
      protected: skill.protected === true,
      display_name: skill.display_name ?? skill.name,
      category: skill.category ?? null
    };
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
