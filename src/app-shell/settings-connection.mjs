// Pure helpers for the model connection test feature.
// Extracted into a separate module so they can be exercised in node:test
// without pulling in DOM-bound code (settings-modal.js, etc.).

// Translate a server `/api/settings/test-connection` payload into a single
// user-facing status string. Pure: no DOM, no I/O.
export function formatConnectionStatus(result) {
  if (!result) return "";
  if (result.ok) {
    const latency = Number.isFinite(result.latency_ms) ? result.latency_ms : null;
    return latency === null ? "连接成功" : `连接成功 · ${latency} ms`;
  }
  if (typeof result.message === "string" && result.message.length > 0) {
    return result.message;
  }
  return "";
}

// 对话模型选择器选项（Task 16）：从全局供应商清单（GET /api/settings/providers 的
// 扁平 store）派生。只列启用供应商（status !== "disabled"）与其启用模型
// （enabled !== false）；value = `${provider.id}/${model.id}` 引用形态，
// label = `${provider.name} / ${model.model_name}`，命中 store.default_model 的项
// 标 isDefault。无任何可用模型时返回单个「未配置」占位（value ""）——选择器据此
// 给出可点击入口直达模型设置页。
export function buildModelPickerOptions(store = {}) {
  const options = [];
  const defaultModel = store?.default_model ?? null;
  for (const provider of Array.isArray(store.providers) ? store.providers : []) {
    if (!provider || provider.status === "disabled") continue;
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || model.enabled === false) continue;
      options.push({
        value: `${provider.id}/${model.id}`,
        label: `${provider.name} / ${model.model_name}`,
        isDefault: Boolean(
          defaultModel &&
          defaultModel.provider_id === provider.id &&
          defaultModel.model_id === model.id
        )
      });
    }
  }
  if (options.length === 0) {
    return [{ value: "", label: "未配置", isDefault: false }];
  }
  return options;
}

// 迁移提示 toast（Task 16）：dashboard 响应带 migration_notice: true（Task 6 快照
// →引用迁移实际发生）时弹一次「旧配置已升级」。模块级一次性标志——SPA 页面加载内
// 只提示一次（页面加载即模块重载，标志随之重置）；后续请求即使再次返回
// migration_notice 也不再打扰。
let migrationNoticeShown = false;
export function handleDashboardMigrationNotice(data, toast) {
  if (data?.migration_notice !== true || typeof toast !== "function") return;
  if (migrationNoticeShown) return;
  migrationNoticeShown = true;
  toast("旧配置已升级");
}
