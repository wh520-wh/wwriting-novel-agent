import { postJson } from "../api-client.js";

// /init 斜杠命令（spec §1.4）：用户显式触发蓝图初始化。
// 服务端自动分发：新项目（blueprint_status=none）直接生成 OUTLINE.md + SETTING.md，
// legacy 项目（已有章节无蓝图）走反推生成。
export const initCommand = {
  name: "init",
  description: "生成/补齐本书的大纲与设定（OUTLINE.md + SETTING.md）",
  userFacingName: () => "规划蓝图",
  icon: "book",
  slashKey: "/init",
  userInvocable: true,
  category: "workspace",
  run: async (input, _ctx) => {
    const requirements = String(input?.message ?? "").trim();
    return await postJson("/api/projects/init-blueprint", {
      projectRoot: input?.projectRoot,
      requirements,
    });
  },
};
