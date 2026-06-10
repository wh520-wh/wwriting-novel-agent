import { postJson } from "../api-client.js";

export const writeCommand = {
  name: "write",
  description: "把指令作为正式写作任务交给智能体",
  userFacingName: () => "开始/续写",
  icon: "compose",
  slashKey: "/write",
  userInvocable: true,
  category: "compose",
  run: async (input, _ctx) => {
    const message = String(input?.message ?? "").trim();
    if (!message) {
      throw new Error("write: message is required");
    }
    return await postJson("/api/commands/submit", {
      message,
      mode: "write",
      fromSideQuestion: false,
    });
  },
};
