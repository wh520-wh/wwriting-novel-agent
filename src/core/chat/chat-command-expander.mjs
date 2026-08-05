const AGENTS_TEMPLATE = `# 项目写作说明

## 故事意图
本书要提供的核心体验、主题与读者预期。

## 文风与叙事
叙事视角、语言密度、节奏、对白和描写偏好。

## 不能违背的约束
已确定的创作边界、禁忌和不可随意改写的内容。

## 事实来源
OUTLINE.md、SETTING.md、已完成正文与其他资料发生冲突时的处理原则。

## 人物与世界规则
只有跨多个文件才能理解、且后续写作必须长期遵守的规则。

## 工作方式
开始写作、核对连续性、修改蓝图和完成章节时应采用的流程。

## 完成前检查
每次写作或修改完成前必须核对的项目特有事项。`;

export function expandChatCommand({ command = null, message = "", args = "" } = {}) {
  const userMessage = String(message).trim();
  if (command !== "init") return { userMessage, modelInstruction: userMessage, command: null };
  const extra = String(args).trim();
  return {
    userMessage,
    command: "init",
    modelInstruction: `你正在执行一次可重复的项目初始化与一致性检查。自行读取和搜索项目并按事实决定先做什么；软件没有预先检查蓝图、章节或设定，也不要求固定工具顺序。

检查并在有证据时创建、补齐或谨慎改进 OUTLINE.md、SETTING.md、AGENTS.md。已有有效内容优先保留；不要为了套模板整体覆盖，不确定的事实要明确标出，重大冲突先说明依据和影响。

AGENTS.md 面向后续写作 Agent，应短、具体、可验证。只保留适用于本项目的章节，省略空项、通用写作常识和可自行发现的文件树。可参考模板：

${AGENTS_TEMPLATE}

用户本次补充要求：${extra || "无。请完成常规项目理解与一致性检查。"}

完成时报告：检查过什么、修改了什么、哪些文件无需修改以及仍无法确定的事项。`
  };
}
