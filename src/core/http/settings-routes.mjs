// src/core/http/settings-routes.mjs —— 设置/模型/技能路由
//（统一 Agent 内核计划 Task 7 Step 3；Task 17 cutover 后仅保留 v2 形态）。
//
// 从旧 src/core/app-server.mjs 按职责提取（只读参考，不改旧文件）：settings/update、
// test-connection、model-switch 与 skills catalog/import/delete 的
// handler 逻辑迁入本模块，保持既有非 Agent HTTP 契约（响应形状、错误码与 fields
// 字段级标红语义）。Task 17 cutover 删除 v1 扁平端点（模型保存/选用/删除/清单/
// 密钥）与 v1 存储写路径——模型保存/选用/删除改由 providers-routes（Task 10）承担。
//
// 本模块不创建 ModelClient、锁或 store；secretsRoot/connectionTester 由 composition
// root 注入。能力判定使用 Task 3 新建的 model/capabilities.mjs；旧的
// provider-adapters.mjs 已删除，本模块不依赖旧文件。
//
// Task 21（F10 第十五轮）：业务逻辑下沉域模块——模型档案展示（providerDisplayName/
// modelDisplayName/modelEndpoint/buildModelProfile）、模型切换（switchModelByReference）
// 迁入 settings-runtime.mjs，归档门禁（assertNotArchived）单源迁入 project-listing.mjs；
// 本模块只留参数解构、错误映射与响应序列化。
import { HttpError } from "../http-error.mjs";
import { loadProject } from "../project-store.mjs";
import { loadEffectiveWorkspaceConfig } from "../config-runtime.mjs";
import { appendEvent } from "../event-log.mjs";
import { skillService } from "../skills/index.mjs";
import { loadLocalSecrets } from "../local-secrets.mjs";
import { ModelConfigValidationError, validateModelConfig } from "../model-config-validation.mjs";
import {
  SettingsValidationError,
  buildModelProfile,
  normalizeSettingsPatch,
  saveWorkspaceSettings,
  switchModelByReference,
  updateProjectSettings
} from "../settings-runtime.mjs";
import { assertNotArchived } from "../project-listing.mjs";
import { resolveActiveProjectRoot, resolveReadProjectRoot, resolveWriteProjectRoot } from "./router.mjs";

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
  // 写回 project.yaml（旧文件只读保留为回滚依据）。生产组合根恒注入 workspaceStore。
  workspaceStore,
  // Task 12：skills service seam（src/core/skills/index.mjs）。生产缺省用全局
  // 单例；测试注入临时 root 的 service，避免迁移 marker 写进真实用户目录。
  skills = null
} = {}) {
  if (!secretsRoot) {
    throw new TypeError("createSettingsRoutes 需要注入 secretsRoot");
  }
  if (typeof workspaceStore?.loadSettings !== "function" || typeof workspaceStore?.saveSettings !== "function") {
    throw new TypeError("createSettingsRoutes 需要注入 workspaceStore");
  }
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

  return {
    // 设置更新：非模型字段校验先于落盘（请求原子）；错误带 fields 供逐项标红。
    // 任务 5：写作用域解析不再要求 project.yaml（普通目录同样是合法工作区）；
    // tool_permissions 写入应用私有 workspace settings，其余字段继续走 project.yaml。
    // Task 19（spec 4.3 #13）：active_model 是旧字段，本路由不再接受后静默丢弃——
    // 任何保存/解析之前直接拒绝并指向模型引用 API（POST /api/settings/model-switch
    // 与 providers 两级 CRUD 是唯一模型写入口），不保留双写入口。
    "POST /api/settings/update": async ({ body }) => {
      try {
        if (body && body.active_model !== undefined) {
          throw new HttpError(400, "active_model_use_reference_api", "active_model 已废弃，模型切换请使用模型引用 API（POST /api/settings/model-switch，或供应商/模型 CRUD）。");
        }
        const projectRoot = await resolveWriteProjectRoot({
          requestedRoot: body?.projectRoot ?? undefined,
          expectedProjectRoot: body?.expectedProjectRoot ?? undefined,
          selected: ctx.selected,
          workspace: ctx.workspace,
          stateRoot: ctx.stateRoot
        });
        const before = await assertNotArchived(projectRoot, { workspaceStore });
        const nonModelPatch = { ...body };
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
        if (!normalizedNonModelPatch) {
          throw new HttpError(400, "invalid_settings_patch", "settings update requires a patch.");
        }

        // 任务 5 Step 5：权限保存写应用私有 workspace settings（成对携带模型，
        // 旧 project.yaml 只读保留为回滚依据）。
        if (normalizedNonModelPatch?.tool_permissions) {
          await saveWorkspaceSettings(projectRoot, {
            workspaceStore,
            toolPermissions: { ...before.tool_permissions, ...normalizedNonModelPatch.tool_permissions },
            effectiveConfig: before
          });
        }
        // 其余非模型、非权限字段仍走旧 project.yaml 路径（旧项目兼容）。
        const legacyPatch = { ...(normalizedNonModelPatch ?? {}) };
        delete legacyPatch.tool_permissions;
        if (Object.keys(legacyPatch).length > 0) {
          await updateProjectSettings(projectRoot, legacyPatch);
        }

        const finalEffective = await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore });
        const finalProject = {
          project_id: finalEffective.project_id ?? null,
          active_model: finalEffective.active_model,
          tool_permissions: finalEffective.tool_permissions ?? {},
          budget_config: finalEffective.budget_config ?? {},
          research_config: finalEffective.research_config ?? {}
        };
        return {
          ok: true,
          projectRoot,
          project: finalProject,
          effective_config: finalEffective,
          model_profile: buildModelProfile(finalEffective.active_model, secretsRoot),
          // Task 20 契约：响应只携带 api_key_saved: boolean——settings/update 不落
          // 密钥，恒为 false；不再返回旧 secret_saved / secret_env 字段。
          api_key_saved: false
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
        return await switchModelByReference({ body, projectRoot, secretsRoot, workspaceStore });
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
        if (scope === "project") await assertNotArchived(projectRoot, { workspaceStore });
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
        if (scope === "project") await assertNotArchived(projectRoot, { workspaceStore });
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

  // catalog DTO：active/shadowed 都返回 name/source/description/display_name/
  // category；shadowed 项额外携带 shadow_reason。绝不返回本地绝对 path 给
  // UI（冻结契约 §11 用户不得看到绝对内部存储路径）。
  function toCatalogEntry(skill) {
    const entry = {
      name: skill.name,
      source: skill.source,
      description: skill.description ?? "",
      display_name: skill.display_name ?? skill.name,
      category: skill.category ?? null
    };
    if (typeof skill.shadow_reason === "string" && skill.shadow_reason) {
      entry.shadow_reason = skill.shadow_reason;
    }
    return entry;
  }

  // 技能领域错误 → HTTP：skill_exists=409、skill_not_found=404，其余 400。
  function mapSkillError(error) {
    if (error instanceof HttpError) return error;
    const status = error?.code === "skill_exists" ? 409
      : error?.code === "skill_not_found" ? 404
        : 400;
    return new HttpError(status, error?.code ?? "BAD_REQUEST", error?.message ?? String(error));
  }
}
