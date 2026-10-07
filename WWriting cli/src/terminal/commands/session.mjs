// /sessions、/resume、/rename、/archive、/export：会话与导出的命令族。
// 会话依赖（listSessions/resumeSession/pickSession/archiveCurrent/exportSession）全部由
// 组合根注入、ctx 带入——本文件不 import 存储层；表条目见 commands.mjs。
import { sanitizeInput } from '../../model/config.mjs';
import { fact } from '../../fact.mjs';
// 会话行标签的唯一读法（/sessions 与 /resume 挑选列表共用）：住在 session-row.mjs。
import { sessionRowLabel } from '../session-row.mjs';

export const sessionCommands = [
  { name: 'sessions', description: '查看会话列表', run: runSessionsCommand },
  { name: 'resume', description: '切换会话：/resume <会话 ID>', run: runResumeCommand },
  { name: 'rename', description: '给当前会话起名：/rename <标题>', run: runRenameCommand },
  { name: 'archive', description: '归档当前会话并开新会话接续', run: runArchiveCommand },
  { name: 'export', description: '把本会话全部对话导出为 markdown', run: runExportCommand },
];

async function runSessionsCommand(_args, ctx) {
  const { reply, listSessions } = ctx;
  if (typeof listSessions !== 'function') {
    reply('暂不支持查看会话。', { tone: 'warn' });
    return;
  }
  let sessions;
  try {
    sessions = await listSessions();
  } catch (error) {
    reply('读取失败', { tone: 'error', detail: fact(error) });
    return;
  }
  if (!Array.isArray(sessions) || sessions.length === 0) {
    reply('没有可用会话。');
    return;
  }
  for (const session of sessions) {
    reply(sessionRowLabel(session));
  }
}

async function runResumeCommand(args, ctx) {
  const { reply, refuseWhenBusy, resumeSession, chooseSession } = ctx;
  if (typeof resumeSession !== 'function') {
    reply('暂不支持切换会话。', { tone: 'warn' });
    return;
  }
  let target = args;
  // 无参 = 打开交互式挑选（P23，对齐 `claude` 的会话选择）。
  // 挑选器要独占按键，而常驻 readline 会跟着一起吃键，所以让位由**注入方**负责
  // （cli.mjs 里用 input.suspend() → 挑选 → input.resume()，与 /model 向导同一套路）。
  if (target === '') {
    if (refuseWhenBusy('会话挑选等这一轮结束后再打开。')) return;
    if (chooseSession === null) {
      reply('/resume <会话ID>', { tone: 'warn', detail: '当前终端不支持交互式挑选。' });
      return;
    }
    try {
      target = await chooseSession();
    } catch (error) {
      // 挑选器自己抛（例如它内部 suspend() 失败）必须在这里收敛：输入层是
      // `void handler.handle(text)` 调用的，未捕获的抛出会变成**未处理拒绝**（Node 默认终止进程），
      // 而且输入框会被留在 suspend 状态。与下面 resumeSession 失败共用同一句事实。
      reply('切换失败', { tone: 'error', detail: fact(error) });
      return;
    }
    // Esc 取消：什么都不做，也什么都不说。屏幕上刚刚闪过的菜单已经收起来了，
    // 再补一句「已取消」只是噪音（铁律 3：成功不弹 Toast，取消同理）。
    if (typeof target !== 'string' || target === '') return;
  }
  try {
    await resumeSession(target);
    reply('已切换会话', { tone: 'success', detail: target });
  } catch (error) {
    reply('切换失败', { tone: 'error', detail: fact(error) });
  }
}

// /rename：给当前会话起名（规格 2026-10-07 D3）。无参 = 回显当前标题——
// 「我起过名字没有」是这条命令最常见的开场，直接答比甩一句用法更有用。
async function runRenameCommand(args, ctx) {
  const { reply, getController } = ctx;
  const controller = getController();
  const title = sanitizeInput(args);
  if (title === '') {
    const current = typeof controller.snapshot === 'function' ? controller.snapshot()?.title ?? '' : '';
    reply(current === '' ? '还没有标题' : current, { tone: 'info', detail: '用法：/rename <标题>' });
    return;
  }
  if (typeof controller.renameSession !== 'function') {
    reply('暂不支持改名。', { tone: 'warn' });
    return;
  }
  try {
    const result = await controller.renameSession(title);
    reply('已重命名', { tone: 'success', detail: result.title });
  } catch (error) {
    reply('改名失败', { tone: 'error', detail: fact(error) });
  }
}

// /archive：归档当前会话并开新会话接续（规格 2026-10-07 D4）。「收起来」与「继续写」
// 是一次动作——归档后当前会话不再出现在 -c 与挑选列表里，人却还坐在终端前，
// 留在一个已归档的会话里打字只会制造「已归档却还在写」的矛盾状态。
// 忙碌拒绝：归档半轮（终态还没落盘）是假账。
async function runArchiveCommand(_args, ctx) {
  const { reply, refuseWhenBusy, doArchive } = ctx;
  if (doArchive === null) {
    reply('暂不支持归档。', { tone: 'warn' });
    return;
  }
  if (refuseWhenBusy('归档等这一轮结束后再进行。')) return;
  try {
    await doArchive();
    reply('已归档', { tone: 'success', detail: '已开新会话接续' });
  } catch (error) {
    reply('归档失败', { tone: 'error', detail: fact(error) });
  }
}

// /export：把全部对话导出为 markdown 写进创作目录根（规格 2026-10-07 T3）。
// 忙碌拒绝：导出半轮是假账（与 /compact 同一纪律）；0 轮不写文件，与 /compact 的
// empty 态同一句式。成功只报文件名——创作目录就是用户的工作区，路径不必复述。
async function runExportCommand(_args, ctx) {
  const { reply, refuseWhenBusy, exporter } = ctx;
  if (exporter === null) {
    reply('暂不支持导出。', { tone: 'warn' });
    return;
  }
  if (refuseWhenBusy('导出等这一轮结束后再进行。')) return;
  try {
    const result = await exporter.write();
    if (result?.empty === true) {
      reply('还没有可导出的对话');
      return;
    }
    reply('已导出', { tone: 'success', detail: result.name });
  } catch (error) {
    reply('导出失败', { tone: 'error', detail: fact(error) });
  }
}
