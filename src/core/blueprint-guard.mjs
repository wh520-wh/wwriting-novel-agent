import { hasChapterArtifacts, loadState } from "./project-store.mjs";

// 写作入口门禁（spec §1.4）：blueprint_status 为 "complete" 或 "legacy" 才允许写作。
// - "none" / "partial"：蓝图未完成，拒绝并提示先完成 /init。
// - 字段缺失（文件存在）：由 loadState 动态计算（有章节产物 → legacy 放行，无产物 → none 拒绝），
//   不因字段不存在而误伤存量项目，也不让门禁形同虚设。
// - agent_state.json 不存在（loadState 返回 null，最旧的升级前项目）：本处按章节证据兜底——
//   有章节产物视为 legacy 放行（打 warn 便于发现），无章节产物拒绝。
// - legacy 放行时打 warn 并带 spec §1.4 P2-5 提示（"建议运行 /init 补齐"），让用户知道可补蓝图。
const LEGACY_HINT = "本书尚无规划蓝图，建议运行 /init 补齐";

export async function assertBlueprintReady(projectRoot) {
  const state = await loadState(projectRoot);
  const status = state?.blueprint_status;
  if (status === undefined || status === null) {
    if (await hasChapterArtifacts(projectRoot)) {
      console.warn(`[blueprint-guard] agent_state.json 不存在但有章节产物，视为 legacy 放行（${LEGACY_HINT}）: ${projectRoot}`);
      return;
    }
    throw new Error("请先完成 /init 生成大纲与设定");
  }
  if (status === "legacy") {
    console.warn(`[blueprint-guard] legacy 项目放行（${LEGACY_HINT}）: ${projectRoot}`);
    return;
  }
  if (status !== "complete") {
    throw new Error("请先完成 /init 生成大纲与设定");
  }
}
