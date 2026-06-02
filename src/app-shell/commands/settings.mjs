import { assertValidCategory } from "./_schema.mjs";

assertValidCategory("project");

export const settingsCommand = {
  name: "settings",
  category: "project",
  description: "配置供应商、API Key、预算与联网",
  userFacingName: () => "模型设置",
  userInvocable: true,
  icon: "settings",
  slashKey: "/settings",
  isConcurrencySafe: true,
  isReadOnly: true,
  uiOnly: true,
  isEnabled: () => true,
  run: async (_input, ctx) => {
    if (typeof ctx?.openSettingsModal !== "function") {
      throw new Error("settings: ctx.openSettingsModal is required");
    }
    ctx.openSettingsModal();
    return { kind: "modal-opened", modal: "settings" };
  },
  renderResult: (_output, _ctx) => null,
};
