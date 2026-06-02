import { registerCommand } from "../command-registry.mjs";
import { writeCommand } from "./write.mjs";
import { reviewCommand } from "./review.mjs";
import { askCommand } from "./ask.mjs";
import { chaptersCommand } from "./chapters.mjs";
import { settingsCommand } from "./settings.mjs";

// 模块加载副作用:一次性注册 5 个内置 slash 命令
registerCommand(writeCommand);
registerCommand(reviewCommand);
registerCommand(askCommand);
registerCommand(chaptersCommand);
registerCommand(settingsCommand);

export {
  writeCommand,
  reviewCommand,
  askCommand,
  chaptersCommand,
  settingsCommand,
};
