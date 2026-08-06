// 测试共享辅助函数。
// createWritingProject：createProject + 置 project.yaml.blueprint_status:"complete"。
// 统一 Agent 内核计划 Rule 9：blueprint_status 是 project.yaml 的持久字段，
// 不再存在旧运行态文件；写作入口只读 project.yaml 判定。
import { createProject, loadProject, saveProject } from "../src/core/project-store.mjs";

export async function createWritingProject(workspaceRoot, options = {}) {
  const result = await createProject(workspaceRoot, options);
  const project = await loadProject(result.projectRoot);
  if (project.blueprint_status !== "complete") {
    await saveProject(result.projectRoot, { ...project, blueprint_status: "complete" });
  }
  return result;
}
