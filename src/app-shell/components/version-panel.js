// src/app-shell/components/version-panel.js —— 第九轮：版本时间线面板
//（阅读器/抽屉章节/记忆分区三处共用；纯 DOM 工厂，doc 可注入便于单测）。
export function createVersionPanel({ doc = document, ctx = null }) {
  const host = doc.createElement("div");
  host.className = "version-panel";
  host.dataset.versionPanel = "";
  host.hidden = true;
  let state = null;

  function notice(text) {
    const p = doc.createElement("div");
    p.className = "version-panel-notice";
    p.textContent = text;
    return p;
  }

  function renderRows(versions, callbacks) {
    const list = doc.createElement("div");
    list.className = "version-list";
    for (const v of versions) {
      const row = doc.createElement("button");
      row.type = "button";
      row.className = "version-row";
      row.dataset.versionRow = String(v.version);
      const head = doc.createElement("span");
      head.className = "version-row-head";
      head.textContent = `v${v.version} · ${sourceLabel(v.source)} · ${new Date(v.timestamp).toLocaleString("zh-CN")}`;
      row.append(head);
      const restore = doc.createElement("span");
      restore.className = "version-restore";
      restore.dataset.restoreButton = String(v.version);
      restore.textContent = "恢复此版";
      if (callbacks.agentRunning) {
        restore.disabled = true;
        restore.textContent = "写作中";
      } else {
        restore.addEventListener("click", (event) => {
          event.stopPropagation();
          restore.textContent = "确认恢复？";
          restore.dataset.restoreConfirm = String(v.version);
          restore.addEventListener("click", (event2) => {
            event2.stopPropagation();
            callbacks.onRestore(v.version);
          }, { once: true });
        });
      }
      row.append(restore);
      row.addEventListener("click", async () => {
        if (callbacks.previewBusy) return;
        callbacks.previewBusy = true;
        const { content } = await callbacks.getContent(v.version);
        let preview = host.querySelector("[data-version-preview]");
        if (!preview) {
          preview = doc.createElement("div");
          preview.className = "version-preview prose";
          host.append(preview);
        }
        preview.dataset.versionPreview = String(v.version);
        preview.textContent = content;
        callbacks.previewBusy = false;
      });
      list.append(row);
    }
    return list;
  }

  function sourceLabel(source) {
    return ({ baseline: "基线", commit: "提交", revision: "入账", rollback: "回滚", pre_rollback: "回滚前存档" })[source] ?? source ?? "未知";
  }

  host.open = async function open({ title, kind, chapterNo = null, file = null, getVersions, getContent, onRestore, agentRunning = false }) {
    state = { title, kind, chapterNo, file };
    host.hidden = false;
    host.replaceChildren();
    const head = doc.createElement("div");
    head.className = "version-panel-head";
    head.textContent = `${title} · 历史版本`;
    host.append(head);
    if (agentRunning) host.append(notice("写作进行中，暂停后恢复。"));
    try {
      const { versions } = await getVersions();
      if (!Array.isArray(versions) || versions.length === 0) {
        host.append(notice("暂无历史版本。"));
        return;
      }
      host.append(renderRows(versions, { getContent, onRestore, agentRunning }));
    } catch (error) {
      host.append(notice(error?.message ?? "加载版本失败。"));
    }
  };
  host.close = function close() {
    host.hidden = true;
    state = null;
  };
  return host;
}