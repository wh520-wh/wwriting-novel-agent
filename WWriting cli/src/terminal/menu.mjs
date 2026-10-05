// 斜杠联想菜单的纯函数内核（工单 04）：命令位置判据、前缀过滤、循环高亮与补全产出。
// 这一层的纪律：
//   - 菜单判据是斜杠命令解析器（commands.mjs parseSlashCommand）判据的**子集**：
//     菜单不开的行，解析器怎么判照旧；菜单开了的行（行首斜杠、无任何空白），
//     解析器 trim 后同样落在「斜杠命令」分支上——两者永不分叉，谁也不替谁猜。
//   - 只认调用方注入的命令清单（name + description，与 /help 同源）；
//     本层不 import 命令表，保持「输入层不拖命令处理」的依赖方向。
//   - 全部纯函数：不碰 stdout、不碰 readline，渲染（05）与按键（06）在这里之上。

// 菜单当前状态：open = 是否显示；matches = 命中的命令（保持清单顺序）；
// index = 高亮位（对越界/非法值做循环钳制）；completion = 高亮项的补全文本（带尾空格，
// 补全后 token 结束、菜单收起——调用方靠这个尾空格进入「参数输入态」）。
// 非命令位置的行一律 { open: false, matches: [] }，index 归零、completion 为 null。
export function slashMenu({ line, commands, selected = 0 }) {
  const text = typeof line === 'string' ? line : '';
  // 命令位置 = 整行以 / 开头且没有任何空白（\s 涵盖全角空格、NBSP 等粘贴残留）。
  // 有空白说明 token 已结束、用户在打参数——那是解析器与补全都不再插手的领域。
  const inCommandPosition = text.startsWith('/') && !/\s/.test(text);
  const matches = inCommandPosition
    ? (Array.isArray(commands) ? commands : []).filter(
      (command) => typeof command?.name === 'string' && command.name.startsWith(text),
    )
    : [];
  const open = matches.length > 0;
  const index = open ? cycleIndex(selected, 0, matches.length) : 0;
  return {
    open,
    matches,
    index,
    completion: open ? `${matches[index].name} ` : null,
  };
}

// 循环高亮：delta 为任意整数（±1 之外也允许），结果落在 [0, total)；
// total 非法（空表）回 0，selected 非法（NaN/缺省）按 0 计。
export function cycleIndex(selected, delta, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const base = Number.isFinite(selected) ? Math.trunc(selected) : 0;
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return (((base + step) % total) + total) % total;
}

// 菜单底部固定一行的按键提示（选择器 DEFAULT_HINT 家族形态）。计入菜单封顶行数；
// 菜单态的回车 = 提交原文，与全 app 五处选择器的「回车确认」相反——这行必须说清。
export const MENU_HINT = '↑/↓ 选择 · Tab 补全 · Esc 收起';
