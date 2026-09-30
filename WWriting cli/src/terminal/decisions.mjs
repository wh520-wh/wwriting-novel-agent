// 权限确认的作答语义：选项表、文本翻译、方向键确认卡，与「确认已失效」那句事实。
//
// 为什么单独一个模块：一次普通确认的「用户侧语义」原先摊在 cli.mjs（选择器作答 + deny 读法 +
// 重入保护）与 commands.mjs（文字作答 choiceFor）两处，「确认已失效」这句事实写了两遍。
// 收进来之后：选项与翻译只有这一份（铁律 4 的三个普通选项、铁律 11 的「不宣传数字直选」、
// 铁律 4 的极端抄写关卡），选择器路径与文字路径共用同一张翻译表与同一句失效事实。
import { fact } from '../fact.mjs';
import { MENU_CURSOR } from './select.mjs';

// 普通确认的三个选项：**唯一的事实来源**（铁律 11）。
// 选择器的 items 与文本映射都从这一份长出来，于是标签与选项不会各说一套。
// 顺序就是选择器里的顺序：一次允许 / 本条输入允许同类操作 / 拒绝（铁律 4 的三个普通选项）。
export const DECISION_CHOICES = Object.freeze([
  Object.freeze({ choice: 'once', label: '一次允许' }),
  Object.freeze({ choice: 'input', label: '本条输入允许同类操作' }),
  Object.freeze({ choice: 'deny', label: '拒绝' }),
]);

// 文本作答的映射，由 DECISION_CHOICES 长出来（标签 → choice），再补两处同义词与三个数字别名：
//   · `允许` 是最短的自然说法，也是**卡片提示里用的那个词**（renderer 里那行纯文字提示）；
//   · `deny` 是英文习惯；
//   · 数字 1/2/3 是**不对外宣传的历史别名**——卡片与选择器提示里一律不出现数字（铁律 11），
//     保留它只为不弄坏既有的「按文本作答」路径（非 TTY / 管道 / 验收用例就是打 1 作答的）。
// 用 Object.create(null)：查表时不会从 Object.prototype 上捡到 `constructor` 这类键。
const DECISION_WORDS = (() => {
  const table = Object.create(null);
  for (const { choice, label } of DECISION_CHOICES) table[label] = choice;
  table['允许'] = 'once';
  table['deny'] = 'deny';
  table['1'] = 'once';
  table['2'] = 'input';
  table['3'] = 'deny';
  return Object.freeze(table);
})();

// 把「待确认」上的一次输入翻译成权限层的选择。
//   write   ：一次允许 / 本条输入允许同类操作 / 拒绝（或 `允许`/`deny`；数字 1/2/3 是隐藏别名）
//   extreme ：必须完全等于当次确认文字，或明确拒绝（YOLO 与模型都不得代填，铁律 4）。
//             它是有意为之的抄写关卡，不受铁律 11 约束，这里也不动。
export function choiceFor(decision, text) {
  if (decision.level === 'extreme') {
    if (typeof decision.confirmation_text === 'string' && text === decision.confirmation_text) {
      return { choice: 'confirm', text };
    }
    if (text === '拒绝' || text === 'deny' || text === '2') return { choice: 'deny', text: null };
    return null;
  }
  const choice = DECISION_WORDS[text];
  return choice === undefined ? null : { choice, text: null };
}

// 「确认已失效」这句事实的唯一住址：这条确认已被别处作废（Run 结束 / 输入切换），如实说，不抛。
// 选择器路径（确认卡）与文字路径（answerDecision）都从这一个函数取——改一个字只会改这一处。
export function reportStaleDecision(notify, error) {
  notify('确认已失效', { tone: 'warn', detail: fact(error) });
}

// createDecisionCard({ pick, decide, notify }) → onDecision(pending)
//   pick    createMenuPicker 的入口（让位 + 方向键选择器）；这台终端给不出选择器时组合根传
//           null 路径——事件桥根本不会调用本卡（canAsk 为假时 onDecision 是 null）。
//   decide  ({ decisionId, choice, text }) => Promise：控制器的决策口。
//   notify  (text, options) => void：屏幕上的两条事实（确认已失效 / 确认失败）。
//
// 卡片的按键语义（原样保留，一条都不许动）：
//   · Esc / Ctrl+C 在卡里都等于**拒绝**——选择器在场时 readline 已让位，Ctrl+C 到不了打断
//     处理器；把「没答」落在拒绝这一侧是安全设计，绝不能当成「允许」。
//   · cancelSummary 留一行拒绝记录：Esc 是一次真实的决定，不该和「什么都没发生」长得一样。
//   · summary 用默认（`❯ <选项>`）：**答了什么必须留在屏上**——这是权限决定，事后要能看出
//     当时选的是哪一项。
export function createDecisionCard({ pick, decide, notify } = {}) {
  if (typeof pick !== 'function') throw new Error('确认卡需要 pick（让位下的选择器入口）。');
  if (typeof decide !== 'function') throw new Error('确认卡需要 decide（控制器的决策口）。');
  if (typeof notify !== 'function') throw new Error('确认卡需要 notify（屏幕事实出口）。');

  let answering = false; // 重入保护：同一时刻只开一个选择器，一条待确认只答一次

  return async function onDecision(pending) {
    if (answering) return;
    answering = true;
    try {
      // items 的形状是 `[{ id, label }]`（select.mjs 的契约），id 直接就是权限层的 choice。
      const items = DECISION_CHOICES.map(({ choice, label }) => ({ id: choice, label }));
      const denyLabel = items.find(({ id }) => id === 'deny').label;
      const picked = await pick({
        // title 传 null：卡片那一行（`需要确认：<什么>`）刚刚已经写进 scrollback，
        // 再让选择器打同一句话就是同一行显示两遍。卡片是**记录**，选择器那块是临时的。
        title: null,
        items,
        hint: '↑/↓ 选择 · 回车确认 · Esc/Ctrl+C 拒绝',
        cancelSummary: `${MENU_CURSOR} ${denyLabel}`,
        canceled: null,
      });
      // 取消（null）按**拒绝**读：「没答」必须落在安全的一侧（不给权限）。
      const choice = picked === null ? 'deny' : picked.item.id;
      try {
        await decide({ decisionId: pending.decision_id, choice, text: null });
      } catch (error) {
        // 与命令层文字作答同一句事实（reportStaleDecision），如实说，不抛。
        reportStaleDecision(notify, error);
      }
    } catch (error) {
      // 选择器自己抛：收敛成一条事实，绝不让它变成未处理拒绝（Node 默认终止进程）。
      notify('确认失败', { tone: 'warn', detail: fact(error) });
    } finally {
      answering = false;
    }
  };
}
