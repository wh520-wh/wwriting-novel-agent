// src/app-shell/components/version-panel.js —— 第九轮：版本时间线面板
//（阅读器/抽屉章节/记忆分区三处共用；纯 DOM 工厂，doc 可注入便于单测）。
export function createVersionPanel({ doc = document } = {}) {
  const host = doc.createElement("div");
  host.className = "version-panel";
  host.dataset.versionPanel = "";
  host.hidden = true;
  let generation = 0;

  function notice(text) {
    const p = doc.createElement("div");
    p.className = "version-panel-notice";
    p.textContent = text;
    return p;
  }

  function renderRows(versions, callbacks) {
    const list = doc.createElement("div");
    list.className = "version-list";
    let previewGeneration = 0;
    for (const v of versions) {
      // Round10：行 = div[role=button]（行内含真实恢复 button，不能嵌套 button）；
      // 预览经 openPreview() 单一路径，click 与 Enter/Space 共用。
      const row = doc.createElement("div");
      row.className = "version-row";
      row.dataset.versionRow = String(v.version);
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      // Round10：行可访问名明确为预览动作（恢复按钮有自己的名字，两者互不混淆）。
      row.setAttribute("aria-label", `版本 v${v.version}，点击预览`);
      const head = doc.createElement("span");
      head.className = "version-row-head";
      head.textContent = `v${v.version} · ${sourceLabel(v.source)} · ${new Date(v.timestamp).toLocaleString("zh-CN")}`;
      row.append(head);
      // Round10：恢复 = 真实 button；agentRunning 时真正 disabled。
      const restore = doc.createElement("button");
      restore.type = "button";
      restore.className = "btn btn--sm";
      restore.dataset.restoreButton = String(v.version);
      restore.textContent = "恢复此版";
      if (callbacks.agentRunning) {
        restore.disabled = true;
        restore.textContent = "写作中";
      } else {
        restore.addEventListener("click", (event) => {
          event.stopPropagation();
          // 第一次进入确认态，第二次调用原 onRestore（业务契约不变）。
          // Round10：恢复请求失败 → 按钮复位 + 面板 notice，不留未处理 rejection。
          if (restore.dataset.restoreConfirm === String(v.version)) {
            restore.disabled = true;
            Promise.resolve().then(() => callbacks.onRestore(v.version)).catch((error) => {
              if (!callbacks.isCurrent()) return;
              restore.disabled = false;
              restore.textContent = "恢复此版";
              delete restore.dataset.restoreConfirm;
              host.append(notice(error?.message ?? "恢复失败。"));
            });
            return;
          }
          restore.textContent = "确认恢复？";
          restore.dataset.restoreConfirm = String(v.version);
        });
      }
      row.append(restore);
      const preview = async () => {
        const currentPreview = ++previewGeneration;
        try {
          const { content } = await callbacks.getContent(v.version);
          if (!callbacks.isCurrent() || currentPreview !== previewGeneration) return;
          let preview = host.querySelector("[data-version-preview]");
          if (!preview) {
            preview = doc.createElement("div");
            preview.className = "version-preview prose";
            host.append(preview);
          }
          preview.dataset.versionPreview = String(v.version);
          preview.textContent = content;
        } catch (error) {
          if (!callbacks.isCurrent() || currentPreview !== previewGeneration) return;
          // Round10：预览失败进面板 notice。
          host.append(notice(error?.message ?? "加载版本失败。"));
        }
      };
      row.addEventListener("click", () => void preview());
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void preview();
        }
      });
      list.append(row);
    }
    return list;
  }

  function sourceLabel(source) {
    return ({ baseline: "基线", commit: "提交", revision: "入账", rollback: "回滚", pre_rollback: "回滚前存档" })[source] ?? source ?? "未知";
  }

  host.open = async function open({ title, getVersions, getContent, onRestore, agentRunning = false }) {
    const currentGeneration = ++generation;
    const isCurrent = () => currentGeneration === generation && !host.hidden;
    host.hidden = false;
    host.replaceChildren();
    const head = doc.createElement("div");
    head.className = "version-panel-head";
    head.textContent = `${title} · 历史版本`;
    host.append(head);
    if (agentRunning) host.append(notice("写作进行中，暂停后恢复。"));
    try {
      const { versions } = await getVersions();
      if (!isCurrent()) return;
      if (!Array.isArray(versions) || versions.length === 0) {
        host.append(notice("暂无历史版本。"));
        return;
      }
      host.append(renderRows(versions, { getContent, onRestore, agentRunning, isCurrent }));
    } catch (error) {
      if (!isCurrent()) return;
      host.append(notice(error?.message ?? "加载版本失败。"));
    }
  };
  host.close = function close() {
    generation += 1;
    host.hidden = true;
  };
  return host;
}
