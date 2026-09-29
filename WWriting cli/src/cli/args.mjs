// 启动参数解析：只处理本计划列出的参数
// （--cwd / --resume / -c|--continue / --help / --version / 位置消息），
// 不引入任何依赖。所有错误以 ArgsError 抛出，消息为简体中文人话，由入口统一呈现。
import path from 'node:path';

import { versionLine } from '../version.mjs';

// 参数错误：入口捕获后只向用户呈现 message，不打印堆栈。
export class ArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgsError';
  }
}

// 帮助文本：展示版本、启动形式与全部选项。
export const USAGE_TEXT = `${versionLine()} —— 把长篇小说写作当作工程来管理。

用法：wwriting [选项] ["消息"]

启动形式：
  wwriting                     开一个全新会话
  wwriting "消息"              用一条消息开始全新会话
  wwriting -c                  接着最近的会话继续
  wwriting --resume <会话ID>   恢复指定会话

选项：
  --cwd <目录>        在指定目录工作
  -c, --continue      接着最近的会话继续
  --resume <会话ID>   恢复指定会话
  -v, --version       显示版本号
  -h, --help          显示本帮助

会话内命令：/init /model /effort /reasoning /sessions /resume /now /stop /help /quit
`;

// 解析启动参数。
// argv 为去除 node 与脚本路径后的参数列表；cwd 为解析 --cwd 的基准目录（默认当前目录）。
// 返回 { cwd, prompt, resume, continueLatest, help, version }；互斥与缺失值抛 ArgsError。
export function parseArgs(argv, cwd = process.cwd()) {
  let help = false;
  let version = false;
  let continueExplicit = false;
  let prompt = null;
  let resume = null;
  let resultCwd = cwd;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '-h':
      case '--help':
        help = true;
        break;
      // --version 与 --help 同级：都是「看完就走」，不参与互斥检查，也不启动 Agent。
      case '-v':
      case '--version':
        version = true;
        break;
      case '--cwd': {
        const value = argv[i + 1];
        // 取值前守卫：缺值、空串或以 - 开头都视为未提供值，避免吞掉后续参数静默做错。
        if (value === undefined || value === '' || value.startsWith('-')) {
          throw new ArgsError('参数 --cwd 需要一个目录，例如：wwriting --cwd D:\\novel');
        }
        resultCwd = path.resolve(resultCwd, value);
        i += 1;
        break;
      }
      case '--resume': {
        const value = argv[i + 1];
        // 取值前守卫：同上，--resume --continue 不得把参数名当成会话 ID。
        if (value === undefined || value === '' || value.startsWith('-')) {
          throw new ArgsError('参数 --resume 需要一个会话 ID，例如：wwriting --resume abc123');
        }
        resume = value;
        i += 1;
        break;
      }
      case '-c':
      case '--continue':
        continueExplicit = true;
        break;
      default:
        if (token.startsWith('-')) {
          throw new ArgsError(`无法识别的参数：${token}。运行 wwriting --help 查看可用参数。`);
        }
        if (prompt !== null) {
          throw new ArgsError(`一次只能提供一个消息，多余的："${token}"`);
        }
        prompt = token;
    }
  }

  // 互斥检查：--cwd 可与一切组合；消息、--resume、-c 三者只能取其一。
  // --help / --version 优先：它们是「看完就走」，跳过互斥检查。
  // 这个守卫必须留着：`wwriting -h --continue "消息"` 的语义是「打印帮助」，
  // 不是「三样都给了，抛错」。
  if (!help && !version) {
    if (prompt !== null && continueExplicit) {
      throw new ArgsError('不能同时提供消息和 -c：直接给出消息即开始全新会话，接着上次会话请用 wwriting -c。');
    }
    if (prompt !== null && resume !== null) {
      throw new ArgsError('不能同时提供消息和 --resume：开始新会话请直接给出消息，恢复会话请用 wwriting --resume <会话ID>。');
    }
    if (resume !== null && continueExplicit) {
      throw new ArgsError('不能同时使用 --resume 和 -c：恢复指定会话用 --resume，接着最近会话用 -c。');
    }
  }

  // P23：**裸启动 = 开一个全新会话**（反转了此前的默认）。
  // 「接着上次」必须由 -c 显式表达——什么都不写被当成「接着上次」，
  // 会让用户在不知情的情况下续上一个几个月前的会话。
  const continueLatest = continueExplicit;
  return { cwd: resultCwd, prompt, resume, continueLatest, help, version };
}
