# 输入区（含上下框线）归输入层所有，渲染器通过 composer 协议借用

终端里输入框的上下两条框线、以及它们占据的行，由
`src/terminal/input.mjs` 的 `drawArea` / `eraseArea` 负责。渲染器不直接画线，
只通过 `takeArea() / giveArea() / setLive()` 与输入层打交道：让位 → 往 scrollback
写内容 → 要回来。

**为什么不能反过来**

readline 每次重绘都会用 `clearScreenDown` 把下方清掉。**只有守着 readline 的那一层
掌握这个时机**——渲染器不知道用户什么时候敲了下一个键。让渲染器自己画框线，
它画的线会在下一次按键时被无声擦掉。

**Considered Options**

- **渲染器自管框线**：早期做法，症状是「终态行之后框再也不出现」、「两个提示符」。
- **输入层独占区域 + 协议借用**（选中）：谁拥有时机，谁拥有那块屏幕。

**Consequences**

- 改这块之前先读技能 `node-inline-live-renderer`。两条已踩过的坑：
  ① `closeBlock` 里**不能再问** `isActive()`——让位之后框已经不在了，要自己记
  `tookArea` 标志；② `cursorColumn()` 必须按提示符的**纯文本**宽度算，
  带色提示符里 `\x1b[36m` 有 9 个字符，按字符数算会让用户敲的字凭空右移 9 格。
- 渲染器**不画任何框线**（`printInputRule` 与 `printStatus({ rule })` 都已删除）。
  加回去会出现两条贴在一起的线。
- 「屏幕画面」是可断言的：`tests/helpers/screen.mjs` 是一个 VT 解释器，把 stdout
  字节流还原成终端最终画面。界面相关的断言要断言画面而不是字节流——每敲一个字都会
  重画框线，字节流里同一字符串会出现好几次，断言它只能证明「写过」。
