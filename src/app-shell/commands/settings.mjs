export const settingsCommand = {
  name: "settings",
  description: "配置供应商、API Key、预算与联网",
  userFacingName: () => "模型设置",
  icon: "settings",
  slashKey: "/settings",
  uiOnly: true,
  userInvocable: true,
  category: "workspace",
  run: async (_input, ctx) => {
    if (typeof ctx?.openSettingsModal !== "function") {
      throw new Error("settings: ctx.openSettingsModal is required");
    }
    ctx.openSettingsModal();
    return { kind: "modal-opened", modal: "settings" };
  },
};
