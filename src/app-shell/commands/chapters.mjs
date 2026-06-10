export const chaptersCommand = {
  name: "chapters",
  description: "在右侧面板查看本地章节文件",
  userFacingName: () => "打开章节",
  icon: "book",
  slashKey: "/chapters",
  uiOnly: true,
  userInvocable: true,
  category: "workspace",
  run: async (_input, ctx) => {
    if (typeof ctx?.openDrawer !== "function") {
      throw new Error("chapters: ctx.openDrawer is required");
    }
    ctx.openDrawer("chapters");
    return { kind: "drawer-opened", panel: "chapters" };
  },
};
