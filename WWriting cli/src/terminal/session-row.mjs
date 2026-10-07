// 会话行的展示事实：状态读法、时间读法、一行会话摘要。
//
// 住址刻意中立：/sessions（命令层）与 /resume 的挑选列表（pickers.mjs）共用同一份行标签，
// 谁也不依赖谁的宿主模块——原先住在 commands.mjs 时，pickers 为一个行标签反向依赖命令层。

// 会话状态 → 人话（会话列表用）。
const SESSION_STATUS = Object.freeze({
  idle: '空闲',
  active: '运行中',
  interrupted: '已中断',
  archived: '已归档',
});

// 会话更新时间 → 人话。只经下面的 sessionRowLabel 出现在屏幕上：
// 同一批会话在两处必须用同一份读法，否则会各说一套时间。
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return typeof iso === 'string' ? iso : '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 会话 → 一行事实：ID + 时间 + 状态 + 轮数。`/sessions` 与 `/resume` 的挑选列表共用这一份。
//
// 为什么必须共用（与 formatTime 同一条理由，但代价更大）：两处各拼一遍已经**当场分叉**过——
// 挑选列表只认 `archived`、其余一律退化成「N 轮」，于是同一批会话在 /sessions 里说「已中断」、
// 在挑选列表里说不出来，而挑选时恰恰需要「哪个是我昨天那个、它还活不活」。
// 「哪个是当前会话」这种**调用侧的语境**留给调用方自己追加，不进这里。
export function sessionRowLabel(session, { includeId = true } = {}) {
  const status = SESSION_STATUS[session?.status] ?? session?.status ?? '';
  const turns = Number.isFinite(session?.turns) ? `${session.turns} 轮` : '';
  // 标题（规格 2026-10-07 D6）：非空时行首——它才是「哪本是哪本书」的第一辨认物；
  // 为空时该段不存在，行与旧实现逐字一致。
  const title = typeof session?.title === 'string' && session.title !== '' ? session.title : '';
  return [title, includeId ? session?.session_id : '', formatTime(session?.updated_at), status, turns]
    .filter((part) => part !== '' && part !== undefined)
    .join('  ');
}
