export const initCommand = {
  name: "init",
  description: "检查并完善项目大纲、设定与写作说明",
  userFacingName: () => "初始化项目理解",
  icon: "book",
  slashKey: "/init",
  userInvocable: true,
  category: "workspace",
  run: async () => ({ ok: true })
};
