// src/app-shell/chat-activity-view.js
// Task 9: 聊天区实时活动视图。chat_activity SSE 事件 → consume 增量更新：
//  - 同一 activity_id 合并到同一行（details/summary 原生键盘可展开），不重复建行；
//  - output_delta 只追加文本（row.output.textContent +=），不重建 DOM；
//  - thinking 阶段的 output_delta 是隐藏推理，不渲染（只显示人话 label）；
//  - 停止按钮只在 running / requested 可见，终态隐藏；点击即禁用防连点（M-2）。
// 行结构：wrap(data-activity-id, data-state) > details > summary(状态标记 + label) + 字段区 + 输出 <pre>，右侧停止按钮。
// 字段按 参数 → 命令 → 目录 → 退出码 → 耗时 → 错误 顺序出现（与后端 payload 对齐）。
//
// 上限（I-2）：长会话防止行数与输出无限累积——
//  - 行数超过 MAX_ROWS 时移除最早的终态行（运行中的行保留不删）；
//  - 单行输出超过 MAX_OUTPUT_CHARS 时截断保留尾部，前置「输出过长已截断」提示。

const MAX_ROWS = 20;
const MAX_OUTPUT_CHARS = 64 * 1024;
const OUTPUT_TRUNCATED_MARK = "（输出过长已截断）\n";
const TERMINAL_STATES = ["succeeded", "failed", "cancelled"];

export function createChatActivityView({ root, document: doc = document, onStop = () => {} }) {
  const rows = new Map(); // activity_id -> row

  function consume(event) {
    if (event?.type !== "chat_activity") return;
    let row = rows.get(event.activity_id);
    if (!row) {
      row = buildRow(doc, event, onStop);
      rows.set(event.activity_id, row);
      root.append(row.wrap);
      trimRows();
    }
    row.label.textContent = event.label || labelFor(event);
    row.wrap.dataset.state = event.state;
    if (event.args) setField(doc, row, "参数", event.args);
    if (event.command) setField(doc, row, "命令", event.command);
    if (event.cwd) setField(doc, row, "目录", event.cwd);
    // 思考增量（隐藏推理）不上屏；其余增量只追加文本（超限截断保留尾部）。
    if (event.output_delta && event.phase !== "thinking") appendOutput(row, event.output_delta);
    if (event.exit_code != null) setField(doc, row, "退出码", String(event.exit_code));
    if (event.duration_ms != null) setField(doc, row, "耗时", `${event.duration_ms} ms`);
    if (event.error) setField(doc, row, "错误", event.error);
    const active = ["running", "requested"].includes(event.state);
    row.stop.hidden = !active;
    // M-2: 终态事件到达才恢复停止按钮（点击后已禁用，防连点第二个 409 弹错误 toast）。
    if (!active) row.stop.disabled = false;
    row.mark.textContent = markFor(event.state);
  }

  // I-2: 行数超限时移除最早的终态行；没有终态行（全部运行中）则不裁剪。
  function trimRows() {
    if (rows.size <= MAX_ROWS) return;
    for (const [id, row] of rows) {
      if (TERMINAL_STATES.includes(row.wrap.dataset.state)) {
        row.wrap.remove();
        rows.delete(id);
        return;
      }
    }
  }

  // I-2: 输出累积超限时截断保留尾部并前置提示；buffer 单处维护避免逐 delta 重读 textContent。
  function appendOutput(row, delta) {
    row.outputBuf = (row.outputBuf ?? "") + delta;
    if (row.outputBuf.length > MAX_OUTPUT_CHARS) {
      row.outputBuf = row.outputBuf.slice(row.outputBuf.length - MAX_OUTPUT_CHARS);
      row.truncated = true;
    }
    row.output.textContent = row.truncated ? OUTPUT_TRUNCATED_MARK + row.outputBuf : row.outputBuf;
  }

  function clear() {
    for (const row of rows.values()) row.wrap.remove();
    rows.clear();
  }

  return { consume, clear };
}

// 详情字段：已存在则只更新文本，不重建 DOM；按首次出现顺序排列。
function setField(doc, row, name, value) {
  let content = row.fields.get(name);
  if (!content) {
    const field = doc.createElement("div");
    field.className = "chat-activity-field";
    const key = doc.createElement("strong");
    key.textContent = name;
    content = doc.createElement("pre");
    field.append(key, content);
    row.detail.append(field);
    row.fields.set(name, content);
  }
  content.textContent = String(value);
}

function buildRow(doc, event, onStop) {
  const wrap = doc.createElement("div");
  wrap.className = "chat-activity-item";
  wrap.dataset.activityId = event.activity_id;
  const details = doc.createElement("details");
  const summary = doc.createElement("summary");
  const mark = doc.createElement("span");
  mark.className = "chat-activity-mark";
  const label = doc.createElement("span");
  label.className = "chat-activity-label";
  summary.append(mark, label);
  const detail = doc.createElement("div");
  detail.className = "chat-activity-fields";
  const output = doc.createElement("pre");
  output.className = "chat-activity-output";
  details.append(summary, detail, output);
  const stop = doc.createElement("button");
  stop.type = "button";
  stop.className = "chat-stop-btn";
  stop.textContent = "停止";
  // M-2: 防重——点击即禁用（连点第二个会拿到 409 弹错误 toast），
  // 收到终态事件（consume 里恢复）或 onStop 拒绝（错误路径）才恢复可点。
  stop.addEventListener("click", () => {
    if (stop.disabled) return;
    stop.disabled = true;
    try {
      Promise.resolve(onStop()).catch(() => { stop.disabled = false; });
    } catch {
      stop.disabled = false;
    }
  });
  wrap.append(details, stop);
  return { wrap, label, mark, detail, output, stop, fields: new Map(), outputBuf: "", truncated: false };
}

// 无 label 时的兜底人话：按 phase / state 推导（thinking 只显示 label 行）。
export function labelFor(event) {
  if (event.phase === "thinking") return "思考中";
  if (event.state === "waiting_confirmation") return "等待确认";
  if (event.state === "cancelled") return "已停止";
  if (event.state === "failed") return "操作失败";
  if (event.phase === "editing") return "编辑文件中";
  if (event.phase === "command") return "运行命令中";
  return "调用工具中";
}

export function markFor(state) {
  if (state === "succeeded") return "✓";
  if (state === "failed") return "✗";
  if (state === "cancelled") return "已停止";
  return "•";
}
