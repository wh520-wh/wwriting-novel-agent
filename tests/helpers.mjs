// 测试共享辅助函数。
// createWritingProject：创建标准写作项目。Task 8：不再置 blueprint_status——
// 新项目 project.yaml 不再携带该字段；OUTLINE.md/SETTING.md 是普通权威项目文件。
import { createProject } from "../src/core/project-store.mjs";

export async function createWritingProject(workspaceRoot, options = {}) {
  return createProject(workspaceRoot, options);
}
