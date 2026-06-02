import { postJson } from "../api-client.js";
import { assertValidCategory, hasActiveProject } from "./_schema.mjs";

assertValidCategory("writing");

export const writeCommand = {
  name: "write",
  category: "writing",
  description: "把指令作为正式写作任务交给智能体",
  userFacingName: () => "开始/续写",
  userInvocable: true,
  icon: "compose",
  slashKey: "/write",
  altKeys: ["/写作"],
  isConcurrencySafe: false,
  isReadOnly: false,
  isEnabled: () => true,
  canUse: (ctx) => hasActiveProject(ctx),
  run: async (input, ctx) => {
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
  renderResult: (output, _ctx) => ({
    kind: "write-submitted",
    message: output?.message ?? "",
  }),
};
