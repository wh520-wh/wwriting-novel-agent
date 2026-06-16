export const modelCommand = {
  name: "model",
  description: "切换聊天框和当前项目使用的已配置模型",
  userFacingName: () => "切换模型",
  icon: "settings",
  slashKey: "/model",
  uiOnly: false,
  userInvocable: true,
  category: "workspace",
  run: async () => ({ kind: "model-command" })
};
