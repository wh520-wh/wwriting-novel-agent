// 版本号：应用身份的唯一来源。
//
// 真相源是 package.json 的 version；这里复述一份供运行期直接读取——避免 import JSON 时
// 各版本 Node 对断言语法（with { type: 'json' } / assert）支持不一致。
// tests/version.test.mjs 会断言两者一致：改一处漏改另一处立刻红，所以不存在漂移。
//
// 版本号出现在三处：终端头部面板（每次启动）、`wwriting --version`、`/help`。
export const APP_NAME = 'WWriting';

// 首个版本。语义化版本三段：破坏性.功能.修正。
export const VERSION = '0.1.0';

// 名称 + 版本的一行，头部面板与 --version 共用，保证两处永远同一个写法。
export function versionLine() {
  return `${APP_NAME} ${VERSION}`;
}
