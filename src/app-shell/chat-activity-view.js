// src/app-shell/chat-activity-view.js
// Task 9: 聊天区实时活动视图。chat_activity SSE 事件 → consume 增量更新：
//  - 同一 activity_id 合并到同一行（details/summary 原生键盘可展开），不重复建行；
//  - output_delta 只追加文本（row.output.textContent +=），不重建 DOM；
//  - thinking 阶段的 output_delta 是隐藏推理，不渲染（只显示人话 label）；
//  - 停止按钮只在 running / requested 可见，终态隐藏。
// 行结构：wrap(data-activity-id, data-state) > details > summary(状态标记 + label) + 字段区 + 输出 <pre>，右侧停止按钮。
// 字段按 参数 → 命令 → 目录 → 退出码 → 耗时 → 错误 顺序出现（与后端 payload 对齐）。

export function createChatActivityView({ root, document: doc = document, onStop = () => {} }) {
  const rows = new Map(); // activity_id -> row

  function consume(event) {
    if (event?.type !== "chat_activity") return;
    let row = rows.get(event.activity_id);
    if (!row) {
      row = buildRow(doc, event, onStop);
      rows.set(event.activity_id, row);
      root.append(row.wrap);
    }
    row.label.textContent = event.label || labelFor(event);
    row.wrap.dataset.state = event.state;
    if (event.args) setField(doc, row, "参数", event.args);
    if (event.command) setField(doc, row, "命令", event.command);
    if (event.cwd) setField(doc, row, "目录", event.cwd);
    // 思考增量（隐藏推理）不上屏；其余增量只追加文本。
    if (event.output_delta && event.phase !== "thinking") row.output.textContent += event.output_delta;
    if (event.exit_code != null) setField(doc, row, "退出码", String(event.exit_code));
    if (event.duration_ms != null) setField(doc, row, "耗时", `${event.duration_ms} ms`);
    if (event.error) setField(doc, row, "错误", event.error);
    row.stop.hidden = !["running", "requested"].includes(event.state);
    row.mark.textContent = markFor(event.state);
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
  stop.addEventListener("click", onStop);
  wrap.append(details, stop);
  return { wrap, label, mark, detail, output, stop, fields: new Map() };
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
