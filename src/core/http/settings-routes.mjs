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
import { HttpError } from "../http-error.mjs";
import { loadProject, saveProject } from "../project-store.mjs";
import { loadConfigLayers } from "../config-runtime.mjs";
import { appendEvent } from "../event-log.mjs";
import { loadOutputStyles } from "../output-style-loader.mjs";
import { ensureBuiltinSkill, importProjectSkill, listProjectSkills } from "../skill-runtime.mjs";
import {
  findLocalModelProfile,
  getDefaultLocalModelProfile,
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
import { SettingsValidationError, normalizeSettingsPatch, saveModelSettingsTransaction, updateProjectSettings } from "../settings-runtime.mjs";
import { resolveModelCapabilities, writingRequiredCapabilitiesOk } from "../model/capabilities.mjs";
import { resolveActiveProjectRoot, resolveActiveWriteProjectRoot } from "./router.mjs";

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

function isSafeSkillName(name) {
  return typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(name);
}

export function createSettingsRoutes({
  workspace,
  stateRoot,
  secretsRoot,
  connectionTester = null,
  selection = null
} = {}) {
  if (!secretsRoot) {
    throw new TypeError("createSettingsRoutes 需要注入 secretsRoot");
  }
  // 共享的项目选择状态（composition root 注入同一个可变引用，project-routes 共用）。
  const selectedRef = selection ?? { current: null };
  const ctx = {
    get selected() {
      return selectedRef.current;
    },
    workspace,
    stateRoot
  };

  async function assertNotArchived(projectRoot) {
    const project = await loadProject(projectRoot);
    if (project.archived_at) {
      throw new HttpError(400, "PROJECT_ARCHIVED", "项目已归档（只读）。请先解除归档再执行此操作。");
    }
    return project;
  }

  return {
    // 设置更新：非模型字段校验先于落盘（请求原子）；错误带 fields 供逐项标红。
    "POST /api/settings/update": async ({ body }) => {
      try {
        const projectRoot = await resolveActiveWriteProjectRoot(ctx, body);
        await assertNotArchived(projectRoot);
        const activeModel = body?.active_model && typeof body.active_model === "object"
          ? { ...body.active_model }
          : null;
        const nonModelPatch = { ...body };
        delete nonModelPatch.active_model;
        delete nonModelPatch.projectRoot;
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
        let mergedProject;
        if (activeModel) {
          result = await saveModelSettingsTransaction({ projectRoot, secretsRoot, activeModel });
          mergedProject = result.project;
          if (normalizedNonModelPatch && Object.keys(normalizedNonModelPatch).length > 0) {
            mergedProject = await updateProjectSettings(projectRoot, normalizedNonModelPatch);
          }
          await upsertLocalModelProfile(secretsRoot, mergedProject.active_model);
        } else {
          mergedProject = await updateProjectSettings(projectRoot, normalizedNonModelPatch);
        }

        const config = await loadConfigLayers(projectRoot, mergedProject);
        return {
          ok: true,
          projectRoot,
          project: {
            project_id: mergedProject.project_id,
            active_model: mergedProject.active_model,
            stage_overrides: mergedProject.stage_overrides,
            tool_permissions: mergedProject.tool_permissions ?? {},
            budget_config: mergedProject.budget_config ?? {},
            research_config: mergedProject.research_config ?? {}
          },
          effective_config: config.effective,
          model_profile: buildModelProfile(config.effective.active_model, secretsRoot),
          available_models: await buildAvailableModelProfiles(secretsRoot, config.effective.active_model),
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

    // 模型切换：写作必需能力缺失的模型在写 project.yaml 前拦截（C 档）。
    "POST /api/settings/model-switch": async ({ body }) => {
      try {
        const projectRoot = await resolveActiveWriteProjectRoot(ctx, body);
        await assertNotArchived(projectRoot);
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
        const beforeSwitchProject = await loadProject(projectRoot);
        const caps = resolveModelCapabilities(profile);
        const conflicts = [];
        if (caps.supportsTemperature === false && beforeSwitchProject.active_model?.temperature !== undefined) {
          conflicts.push("该模型不支持温度设置，写作温度不会生效。");
        }
        const project = await updateProjectSettings(projectRoot, { active_model: modelConfigFromLocalProfile(profile) });
        await upsertLocalModelProfile(secretsRoot, project.active_model);
        const config = await loadConfigLayers(projectRoot, project);
        return {
          ok: true,
          projectRoot,
          capabilities: caps,
          conflicts,
          project: {
            project_id: project.project_id,
            active_model: project.active_model,
            tool_permissions: project.tool_permissions ?? {}
          },
          effective_config: config.effective,
          model_profile: buildModelProfile(config.effective.active_model, secretsRoot),
          available_models: await buildAvailableModelProfiles(secretsRoot, config.effective.active_model)
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

    // 技能 enable/disable/import（旧契约：ok/projectRoot/skill/enabled_skills）。
    "POST /api/skills/enable": async ({ body }) => runSkillMutation("enable", body),
    "POST /api/skills/disable": async ({ body }) => runSkillMutation("disable", body),
    "POST /api/skills/import": async ({ body }) => runSkillMutation("import", body)
  };

  async function runSkillMutation(action, body) {
    try {
      const projectRoot = await resolveActiveProjectRoot(ctx);
      await assertNotArchived(projectRoot);
      const project = await loadProject(projectRoot);
      let skillName = body.name;
      if (action === "import") {
        const manifest = await importProjectSkill(projectRoot, body.manifest ?? body);
        skillName = manifest.name;
      }
      if (!isSafeSkillName(skillName)) {
        throw new Error("技能名称无效。");
      }

      if (action === "enable" || action === "import") {
        await ensureBuiltinSkill(projectRoot, skillName);
        const available = await listProjectSkills(projectRoot, {
          ...project,
          enabled_skills: project.enabled_skills ?? []
        });
        if (!available.some((skill) => skill.name === skillName)) {
          throw new Error(`技能未安装：${skillName}`);
        }
        project.enabled_skills = [...new Set([...(project.enabled_skills ?? []), skillName])].sort();
      } else {
        project.enabled_skills = (project.enabled_skills ?? []).filter((name) => name !== skillName);
      }

      await saveProject(projectRoot, project);
      await appendEvent(projectRoot, {
        type: "skill_configuration_changed",
        project_id: project.project_id,
        message: `skill ${action}: ${skillName}`,
        data: { skill: skillName, action }
      });
      return {
        ok: true,
        projectRoot,
        skill: skillName,
        enabled_skills: project.enabled_skills
      };
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error?.message ?? String(error));
    }
  }
}
