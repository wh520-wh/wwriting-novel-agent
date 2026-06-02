import { postJson } from "../api-client.js";
import { assertValidCategory, hasActiveProject } from "./_schema.mjs";

assertValidCategory("review");

export const reviewCommand = {
  name: "review",
  category: "review",
  description: "检查节奏、连贯性、设定一致性",
  userFacingName: () => "审稿修订",
  userInvocable: true,
  icon: "check",
  slashKey: "/review",
  altKeys: ["/审稿"],
  isConcurrencySafe: false,
  isReadOnly: false,
  isEnabled: () => true,
  canUse: (ctx) => hasActiveProject(ctx),
  run: async (input, ctx) => {
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
  renderResult: (output, _ctx) => ({
    kind: "review-submitted",
    message: output?.message ?? "",
  }),
};
