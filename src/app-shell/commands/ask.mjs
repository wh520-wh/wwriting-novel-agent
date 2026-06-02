import { postJson } from "../api-client.js";
import { assertValidCategory, hasActiveProject } from "./_schema.mjs";

assertValidCategory("writing");

export const askCommand = {
  name: "ask",
  category: "writing",
  description: "临时提问，不修改正文、不打断写作",
  userFacingName: () => "旁路询问",
  userInvocable: true,
  icon: "help",
  slashKey: "/ask",
  altKeys: ["/side", "/q"],
  isConcurrencySafe: true,
  isReadOnly: true,
  isEnabled: () => true,
  canUse: (ctx) => hasActiveProject(ctx),
  run: async (input, _ctx) => {
    const question = String(input?.message ?? "").trim();
    if (!question) {
      throw new Error("ask: question is required");
    }
    return await postJson("/api/commands/ask", { question });
  },
  renderResult: (output, _ctx) => ({
    kind: "ask-submitted",
    question: output?.question ?? "",
  }),
};
