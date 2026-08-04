import { registerCommand } from "../command-registry.mjs";
import { writeCommand } from "./write.mjs";
import { reviewCommand } from "./review.mjs";
import { askCommand } from "./ask.mjs";
import { chaptersCommand } from "./chapters.mjs";
import { modelCommand } from "./model.mjs";
import { settingsCommand } from "./settings.mjs";
import { initCommand } from "./init.mjs";

// 模块加载副作用:一次性注册内置 slash 命令
registerCommand(writeCommand);
registerCommand(reviewCommand);
registerCommand(askCommand);
registerCommand(chaptersCommand);
registerCommand(modelCommand);
registerCommand(settingsCommand);
registerCommand(initCommand);

export {
  writeCommand,
  reviewCommand,
  askCommand,
  chaptersCommand,
  modelCommand,
  settingsCommand,
  initCommand,
};
