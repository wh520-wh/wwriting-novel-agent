import { postJson } from "../api-client.js";

export const reviewCommand = {
  name: "review",
  description: "检查节奏、连贯性、设定一致性",
  userFacingName: () => "审稿修订",
  icon: "check",
  slashKey: "/review",
  userInvocable: true,
  category: "compose",
  run: async (input, _ctx) => {
    const message = String(input?.message ?? "").trim();
    if (!message) {
      throw new Error("review: message is required");
    }
    return await postJson("/api/commands/submit", {
      message,
      mode: "review",
      fromSideQuestion: false,
    });
  },
};
