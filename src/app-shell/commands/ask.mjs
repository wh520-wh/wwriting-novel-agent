import { postJson } from "../api-client.js";

export const askCommand = {
  name: "ask",
  description: "临时提问，不修改正文、不打断写作",
  userFacingName: () => "旁路询问",
  icon: "help",
  slashKey: "/ask",
  userInvocable: true,
  category: "compose",
  run: async (input, _ctx) => {
    const question = String(input?.message ?? "").trim();
    if (!question) {
      throw new Error("ask: question is required");
    }
    return await postJson("/api/commands/ask", { question });
  },
};
