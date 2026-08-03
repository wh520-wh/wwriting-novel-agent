import { loadState } from "./project-store.mjs";

// 写作入口门禁（spec §1.4）：blueprint_status 为 "complete" 或 "legacy" 才允许写作。
// - "none" / "partial"：蓝图未完成，拒绝并提示先运行 /init。
// - 字段缺失（旧项目 / 手写夹具）视为 legacy：spec §1.4 的 legacy 语义允许旧项目写作，
//   不因字段不存在而误伤存量项目与测试夹具。
export async function assertBlueprintReady(projectRoot) {
  const state = await loadState(projectRoot);
  const status = state?.blueprint_status;
  if (status === undefined || status === null) {
    return;
  }
  if (status !== "complete" && status !== "legacy") {
    throw new Error("蓝图未完成，请先运行 /init 生成大纲与设定");
  }
}
