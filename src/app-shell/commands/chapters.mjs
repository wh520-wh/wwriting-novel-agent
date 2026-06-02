import { assertValidCategory } from "./_schema.mjs";

assertValidCategory("project");

export const chaptersCommand = {
  name: "chapters",
  category: "project",
  description: "在右侧面板查看本地章节文件",
  userFacingName: () => "打开章节",
  userInvocable: true,
  icon: "book",
  slashKey: "/chapters",
  isConcurrencySafe: true,
  isReadOnly: true,
  isEnabled: () => true,
  run: async (_input, ctx) => {
    if (typeof ctx?.openDrawer !== "function") {
      throw new Error("chapters: ctx.openDrawer is required");
    }
    ctx.openDrawer("chapters");
    return { kind: "drawer-opened", panel: "chapters" };
  },
  renderResult: (_output, _ctx) => null,
};
