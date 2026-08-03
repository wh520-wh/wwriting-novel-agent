// 测试共享辅助函数。
// createWritingProject：createProject + 置 blueprint_status:"complete"。
// 蓝图门禁（spec §1.4）落地后，新建项目默认 "none" 会被写作入口拒绝；
// 真实走写作入口的测试需要先把项目标为蓝图完成。
import { createProject, loadState, saveState } from "../src/core/project-store.mjs";

export async function createWritingProject(workspaceRoot, options = {}) {
  const result = await createProject(workspaceRoot, options);
  const state = await loadState(result.projectRoot);
  state.blueprint_status = "complete";
  await saveState(result.projectRoot, state);
  return result;
}
