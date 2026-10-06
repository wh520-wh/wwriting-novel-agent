// 让位下的选择器会话：suspend → selector.ask → 恢复 → 取消语义归一。
//
// 「从一组选项里挑一个」的交互（命令菜单 / /resume 挑选 / 权限确认卡）都用方向键选择器，
// 而选择器要独占按键——常驻 readline 必须先让位。这个「让位 + ask + 把 null 读成语义」的
// 套路原先在 cli.mjs 里手工重复了三处，漏包一次 withInputSuspended 就会出现双读取者吃键
// （那种故障没有任何测试能抓到）。收进来之后：让位只有一个出口，取消语义由每个调用方
// 显式声明（菜单 = 不动草稿 / 挑选 = 静默取消 / 确认卡 = 按拒绝读），不再靠注释分辨。
import { sessionRowLabel } from './commands.mjs';

// createMenuPicker({ selector, withInputSuspended }) → pick(options)
//   selector          createSelector 的返回值（{ ask, canAsk }）。
//   withInputSuspended 组合根的让位入口（input-yield 的持有计数在这里兑现）。
//   pick({ title, items, hint, summary, cancelSummary, maxRows, canceled })
//     → Promise<{ item, index } | canceled>
//     canceled 是「用户取消时返回什么」——null/undefined 一律归一到它。
//     错误原样冒泡：挑选界面抛错该怎么呈现是调用方的策略（命令层收敛成事实，菜单提示读取失败）。
export function createMenuPicker({ selector, withInputSuspended } = {}) {
  if (!selector || typeof selector.ask !== 'function') {
    throw new Error('菜单挑选需要一个选择器（selector.ask）。');
  }
  if (typeof withInputSuspended !== 'function') {
    throw new Error('菜单挑选需要一个让位入口（withInputSuspended）。');
  }
  return async function pick({
    title = null,
    items = [],
    hint = undefined,
    summary = undefined,
    cancelSummary = null,
    maxRows = 10,
    canceled = null,
  } = {}) {
    // 不传的选项保持 undefined，让 selector.ask 用它自己的默认值（默认提示语 / 默认 summary）。
    const picked = await withInputSuspended(() => selector.ask({ title, items, hint, summary, cancelSummary, maxRows }));
    return picked ?? canceled;
  };
}

// 会话摘要数组 → 挑选列表的 items（`/resume` 无参时用）。
// 与 /sessions 共用同一份行标签（sessionRowLabel）——两处各拼一遍已经当场分叉过一次。
// 「（当前）」是挑选列表才有的语境，在这里追加；说明行放会话 ID（挑选时需要核对）。
//
// 裸启动会**先建一个空会话**（P23），用户立刻退出就留下一个 0 轮的壳。这种壳不进挑选列表——
// 否则用久了列表里全是「0 轮」的噪音，真正有内容的会话反而难找。它仍然在 /sessions 里可见
// （那条命令是「查看」，不是「挑选」），也仍然能用 --resume <ID> 打开，
// 所以这不是丢数据，只是不把噪音推到用户面前。
// 已归档的会话同理（规格 2026-10-07 D5）：归档就是「收起来」，挑选列表是「接着写」的入口；
// 当前会话即使已归档也保留（刚 /archive 切走的瞬间它还在屏幕上）。
export function sessionPickerItems(sessions, currentId = null) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session.session_id === currentId
      || ((session.turns ?? 0) > 0 && session.status !== 'archived'))
    .map((session) => ({
      id: session.session_id,
      label: `${sessionRowLabel(session, { includeId: false })}${session.session_id === currentId ? '  （当前）' : ''}`,
      description: session.session_id,
    }));
}
