// 一条用户可理解的事实。
//
// 铁律 3：错误只呈现一条用户能读懂的事实，错误码 / 堆栈 / 英文 message 只进折叠详情。
// 本项目各模块抛出的错误文本本来就是中文人话，所以「含汉字就直接用，否则兜一句通用事实」。
//
// 这个判断原来在 cli.mjs、terminal/commands.mjs、agent/agent-loop.mjs 各写了一份，
// 引导页又需要第四份——留四份必然漂移（比如有人把正则改成只认常用汉字），所以收成一份。
// fallback 由调用方给：不同场景的兜底话术本来就不同。
export function fact(error, fallback = '操作没有完成，请稍后重试。') {
  const message = typeof error?.message === 'string' ? error.message : '';
  return /[\u4e00-\u9fff]/.test(message) ? message : fallback;
}
