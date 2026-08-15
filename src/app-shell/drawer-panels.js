import { icon } from "./icons.js";
import { formatNumber, formatYuan, formatTime, translateStage, translateSourceKind, translateEventType } from "./utils.js";
import { postJson, getJson } from "./api-client.js";
import { renderCostPanel as renderCostPanelComponent } from "./components/cost-panel.js";
import { createVersionPanel } from "./components/version-panel.js";

// 抽屉面板（统一 Agent 内核计划 Task 9）：只保留项目领域事实（章节/模型/资料/
// 成本）。删除运行面板与审查面板——运行事实只在 Agent 对话当前轮展示；“导出成书”
// 直接 POST 确定性导出 route，不再经聊天发送。Task 13：技能管理迁入设置弹窗的
// 「Agent 技能」分区，抽屉不再有技能 tab / 列表 / 启停按钮。
export function createDrawerPanels(ctx) {
  // ctx provides: refs, getDrawerTab, setDrawerTab, getDashboard, loadDashboard,
  //   openReader, openSettingsModal, showToast, showActionError, closeDrawer

  async function renderDrawerBody() {
    const dashboard = ctx.getDashboard();
    const drawerTab = ctx.getDrawerTab();
    if (!dashboard || !dashboard.hasProject) {
      ctx.refs.drawerBody.replaceChildren(drawerEmpty("打开或新建一部小说后显示。"));
      return;
    }
    if (drawerTab === "chapters") renderChapterPanel(dashboard);
    else if (drawerTab === "model") renderModelPanel(dashboard);
    else if (drawerTab === "research") renderResearchPanel(dashboard);
    else if (drawerTab === "memory") await renderMemoryPanel(dashboard);
    else renderCostPanel(dashboard);
  }

  function drawerEmpty(text) {
    const empty = document.createElement("div");
    empty.className = "dpanel-empty";
    empty.textContent = text;
    return empty;
  }

  function dpanel(titleText, pillText) {
    const panel = document.createElement("div");
    panel.className = "dpanel";
    const head = document.createElement("div");
    head.className = "dpanel-head";
    const h4 = document.createElement("h4");
    h4.textContent = titleText;
    head.append(h4);
    if (pillText != null) {
      const pill = document.createElement("span");
      pill.className = "pill mono";
      pill.textContent = pillText;
      head.append(pill);
    }
    const body = document.createElement("div");
    body.className = "dpanel-body";
    panel.append(head, body);
    return { panel, body };
  }

  function renderChapterPanel(data) {
    const summary = data.summary;
    const { panel, body } = dpanel("章节目录", `${summary.completedChapters}/${summary.targetChapters}`);
    body.style.padding = "6px";

    // 导出工具条：确定性导出直接 POST /api/projects/export-book。
    const toolbar = document.createElement("div");
    toolbar.className = "export-toolbar";
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "small-button export-btn";
    exportBtn.textContent = "导出成书";
    exportBtn.addEventListener("click", () => {
      void exportBook(data, exportBtn);
    });
    toolbar.append(exportBtn);
    if (window.wwritingDesktop?.revealPath) {
      const revealBtn = document.createElement("button");
      revealBtn.type = "button";
      revealBtn.className = "small-button export-reveal-btn";
      revealBtn.textContent = "打开导出文件夹";
      revealBtn.addEventListener("click", () => {
        const root = data.projectRoot ?? data.project?.projectRoot;
        if (root) {
          window.wwritingDesktop.revealPath(root + "/exports");
        }
      });
      toolbar.append(revealBtn);
    }
    body.append(toolbar);

    const list = document.createElement("div");
    list.className = "chrow-list";
    const chapters = data.chapters ?? [];
    if (chapters.length === 0) {
      list.append(drawerEmpty("暂无章节"));
    } else {
      const byChapter = data.cost?.byChapter ?? {};
      const costAvailable = data.summary?.costAvailable === true;
      for (const chapter of chapters) {
        list.append(buildChapterRow(chapter, byChapter[String(chapter.chapter_no)], costAvailable));
      }
    }
    body.append(list);
    ctx.refs.drawerBody.replaceChildren(panel);
  }

  // 章节状态只显示文件事实：已完成（可打开阅读）或待生成。
  function buildChapterRow(chapter, costRow, costAvailable) {
    const done = chapter.status === "completed";
    const row = document.createElement("button");
    row.className = `chrow ${done ? "completed" : "todo"}`;
    row.type = "button";
    row.disabled = !done;
    row.title = chapter.title || (done ? "已定稿章节" : "待生成");
    const n = document.createElement("span");
    n.className = "ch-n mono";
    n.textContent = String(chapter.chapter_no).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "ch-name peek";
    name.textContent = chapter.title || (done ? "已定稿章节" : translateStage(chapter.status ?? "queued"));
    row.append(n, name);
    if (done) {
      const meta = document.createElement("span");
      meta.className = "ch-meta mono";
      if (costAvailable && costRow) {
        meta.textContent = `${formatNumber(chapter.actual_words)} 字 · ${formatYuan(costRow.estimatedCost)}`;
      } else {
        meta.textContent = `${formatNumber(chapter.actual_words)} 字`;
      }
      row.append(meta, icon("chevR", 14, "ch-go"));
      // 第九轮：章节行「历史」按钮（抽屉 §3.3）。
      const historyBtn = document.createElement("button");
      historyBtn.type = "button";
      historyBtn.className = "chrow-history";
      historyBtn.textContent = "历史";
      historyBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        const panel = createVersionPanel({ doc: document });
        row.after(panel);
        panel.open({
          title: `第 ${chapter.chapter_no} 章`,
          kind: "chapter",
          chapterNo: chapter.chapter_no,
          getVersions: async () => getJson(`/api/chapters/versions?chapter_no=${chapter.chapter_no}`),
          getContent: async (version) => getJson(`/api/chapters/versions/content?chapter_no=${chapter.chapter_no}&version=${version}`),
          onRestore: async (version) => {
            const result = await postJson("/api/chapters/rollback", { chapter_no: chapter.chapter_no, version });
            if (result?.ok) { panel.close(); await ctx.loadDashboard?.(); }
          }
        });
      });
      row.append(historyBtn);
      row.addEventListener("click", () => ctx.openReader(chapter.chapter_no));
    } else {
      const state = document.createElement("span");
      state.className = "ch-state todo";
      state.textContent = "待生成";
      row.append(state);
    }
    return row;
  }

  function renderModelPanel(data) {
    const summary = data.summary;
    const profile = data.model_profile ?? {};
    const permissions = data.config?.effective?.tool_permissions ?? data.project.tool_permissions ?? {};
    // Task 8：未配置模型 = 无 model_name（is_mock 语义已废弃）。
    const modelUnconfigured = !profile || !profile.model_name;
    const model = dpanel("模型配置", modelUnconfigured ? "未配置" : (profile.display ?? "未配置"));
    const open = document.createElement("button");
    open.className = "save-btn";
    open.type = "button";
    open.textContent = "打开模型设置";
    open.addEventListener("click", () => ctx.openSettingsModal());
    const summaryLine = document.createElement("p");
    summaryLine.className = "spd-hint";
    summaryLine.textContent = modelUnconfigured
      ? "尚未配置模型。点上方按钮选 DeepSeek / MiMo 或自定义供应商，并粘贴 API Key。"
      : `${profile.display}${profile.endpoint ? ` · ${profile.endpoint}` : ""}；${profile.api_key_saved ? "API Key 已保存在本机。" : "尚未保存 API Key。"}`;
    model.body.append(summaryLine, open);

    const budget = dpanel("预算与权限");
    const kv = document.createElement("dl");
    kv.className = "kv";
    appendKv(kv, "模型调用", `${formatNumber(summary.modelCalls)} / ${summary.maxModelCalls ?? "∞"}`);
    appendKv(kv, "估算成本", summary.costAvailable ? formatYuan(summary.estimatedCost) : "未配置价格");
    appendKv(kv, "缓存", cacheSummaryText(data));
    appendKv(kv, "联网权限", permissions.network_allowed ? "已开启" : "关闭", permissions.network_allowed ? "accent" : "");
    budget.body.append(kv);
    ctx.refs.drawerBody.replaceChildren(model.panel, budget.panel);
  }

  function cacheSummaryText(data) {
    if (!data.cacheSummary) return "缓存待生成";
    return data.cacheSummary.explanation ?? "缓存待生成";
  }

  function appendKv(dl, key, value, valueClass) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.className = valueClass ?? "";
    dd.textContent = value;
    dl.append(dt, dd);
  }

  function renderResearchPanel(data) {
    const sources = data.sources?.latest ?? [];
    const research = dpanel("资料来源", formatNumber(data.sources?.count ?? 0));
    const form = document.createElement("div");
    form.className = "research-form";
    const q = document.createElement("input");
    q.type = "text"; q.placeholder = "搜索关键词"; q.className = "research-input";
    const sBtn = document.createElement("button");
    sBtn.type = "button"; sBtn.className = "small-button"; sBtn.textContent = "搜索";
    sBtn.addEventListener("click", () => runResearch("search", { query: q.value.trim(), limit: 5 }, sBtn));
    const u = document.createElement("input");
    u.type = "url"; u.placeholder = "https://example.com"; u.className = "research-input";
    const fBtn = document.createElement("button");
    fBtn.type = "button"; fBtn.className = "small-button"; fBtn.textContent = "抓取";
    fBtn.addEventListener("click", () => runResearch("fetch", { url: u.value.trim() }, fBtn));
    form.append(q, sBtn, u, fBtn);
    research.body.append(form);
    if (sources.length === 0) {
      research.body.append(drawerEmpty("暂无来源快照。"));
    } else {
      for (const source of sources) {
        const row = document.createElement("div");
        row.className = "evt";
        const et = document.createElement("span");
        et.className = "et";
        et.textContent = translateSourceKind(source.kind);
        const em = document.createElement("span");
        em.className = "em peek";
        em.textContent = source.title ?? source.file;
        const ex = document.createElement("span");
        ex.className = "ex";
        ex.textContent = source.untrusted ? "不可信" : "资料";
        row.append(et, em, ex);
        research.body.append(row);
      }
    }
    ctx.refs.drawerBody.replaceChildren(research.panel);
  }

  function renderCostPanel(data) {
    const summary = data.summary;
    const events = data.events ?? [];
    const { panel, body } = dpanel("成本视图");
    // Pill shows the high-level "has-cost / no-cost" state, mirroring the
    // honest 未配置价格 display from the overview section below.
    if (summary.costAvailable) {
      const pill = document.createElement("span");
      pill.className = "pill mono";
      pill.textContent = formatYuan(summary.estimatedCost);
      panel.querySelector(".dpanel-head").append(pill);
    } else {
      const pill = document.createElement("span");
      pill.className = "pill mono muted";
      pill.textContent = "未配置价格";
      panel.querySelector(".dpanel-head").append(pill);
    }
    body.style.padding = "0";
    const tree = renderCostPanelComponent({
      cost: data.cost ?? null,
      summary,
      events,
      modelConfig: data.config?.effective?.active_model ?? null,
      cacheSummary: data.cacheSummary ?? null
    });
    body.append(tree);
    ctx.refs.drawerBody.replaceChildren(panel);
  }

  // 第九轮：「记忆」分区面板（故事摘要 + 工作日志 + 设定档案只读）。
  async function renderMemoryPanel(data) {
    const blocks = [
      { file: "book_summary", title: "故事摘要", icon: "书" },
      { file: "worklog", title: "工作日志", icon: "记" }
    ];
    const body = document.createElement("div");
    body.className = "dpanel-body memory-body";
    for (const block of blocks) {
      const card = document.createElement("div");
      card.className = "memory-card";
      const head = document.createElement("div");
      head.className = "memory-card-head";
      const title = document.createElement("span");
      title.textContent = block.title;
      head.append(title);
      const history = document.createElement("button");
      history.type = "button";
      history.className = "chrow-history";
      history.textContent = "历史";
      history.addEventListener("click", async (event) => {
        event.stopPropagation();
        const panel = createVersionPanel({ doc: document });
        card.after(panel);
        panel.open({
          title: block.title,
          kind: "memory",
          file: block.file,
          getVersions: async () => getJson(`/api/memory/versions?file=${block.file}`),
          getContent: async (version) => getJson(`/api/memory/versions/content?file=${block.file}&version=${version}`),
          onRestore: async (version) => {
            const result = await postJson("/api/memory/versions/restore", { file: block.file, version });
            if (result?.ok) { panel.close(); renderMemoryPanel(data); }
          }
        });
      });
      head.append(history);
      card.append(head);
      const content = document.createElement("div");
      content.className = "memory-card-content prose";
      const data2 = await getJson(`/api/memory/files/content?file=${block.file}`);
      content.textContent = data2?.content ?? "";
      card.append(content);
      body.append(card);
    }
    const continuityCard = document.createElement("div");
    continuityCard.className = "memory-card";
    const cHead = document.createElement("div");
    cHead.className = "memory-card-head";
    const cTitle = document.createElement("span");
    cTitle.textContent = "设定档案（只读）";
    cHead.append(cTitle);
    continuityCard.append(cHead);
    const cContent = document.createElement("div");
    cContent.className = "memory-card-content prose";
    const cData = await getJson("/api/memory/files/content?file=continuity");
    cContent.textContent = cData?.content ?? "";
    continuityCard.append(cContent);
    body.append(continuityCard);
    ctx.refs.drawerBody.replaceChildren(body);
  }

  // 确定性导出：直接调用书导出 route（不创建 Agent Run、不追加模型 transcript）。
  // btn 由调用方（renderChapterPanel）传入，禁用以面板内的按钮为界，不做全局查询。
  async function exportBook(data, btn) {
    const projectRoot = data.projectRoot ?? data.project?.projectRoot;
    if (!projectRoot) return;
    if (btn) btn.disabled = true;
    try {
      const result = await postJson("/api/projects/export-book", { projectRoot, format: "txt" });
      ctx.showToast(`已导出：${result.path}（${formatNumber(result.characters)} 字）`, "success");
    } catch (error) {
      ctx.showToast(error?.message ?? "导出失败。", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runResearch(action, body, btn) {
    if ((action === "search" && !body.query) || (action === "fetch" && !body.url)) {
      return ctx.showToast(action === "search" ? "请输入搜索关键词。" : "请输入要抓取的网址。", "info");
    }
    btn.disabled = true;
    try {
      await postJson(`/api/research/${action}`, body);
      ctx.showToast(action === "search" ? "搜索完成，结果已保存为来源快照。" : "抓取完成，正文已保存为来源快照。", "success");
      await ctx.loadDashboard();
    } catch (error) {
      ctx.showToast(error?.message ?? "资料检索失败。", "error");
    } finally {
      btn.disabled = false;
    }
  }

  function buildEventRow(event) {
    const row = document.createElement("div");
    row.className = `evt ${event.severity === "error" ? "err" : event.severity === "warning" ? "warn" : ""}`;
    const et = document.createElement("span");
    et.className = "et";
    et.textContent = formatTime(event.timestamp);
    const em = document.createElement("span");
    em.className = "em peek";
    em.textContent = `${translateEventType(event.type ?? "event")} · ${event.message ?? translateStage(event.stage ?? "-")}`;
    const ex = document.createElement("span");
    ex.className = "ex";
    ex.textContent = translateStage(event.stage ?? "-");
    row.append(et, em, ex);
    return row;
  }

  return { renderDrawerBody };
}
