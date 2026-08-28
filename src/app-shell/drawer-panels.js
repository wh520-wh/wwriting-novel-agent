import { icon } from "./icons.js";
import { formatNumber, formatYuan, translateStage, translateSourceKind } from "./utils.js";
import { postJson, getJson } from "./api-client.js";
import { renderCostPanel as renderCostPanelComponent } from "./components/cost-panel.js";
import { createVersionPanel } from "./components/version-panel.js";
import { renderMarkdown, bindExternalLinks } from "./markdown-lite.mjs";

// 抽屉面板（统一 Agent 内核计划 Task 9）：只保留项目领域事实（章节/模型/资料/
// 成本）。删除运行面板与审查面板——运行事实只在 Agent 对话当前轮展示；“导出成书”
// 直接 POST 确定性导出 route，不再经聊天发送。Task 13：技能管理迁入设置弹窗的
// 「Agent 技能」分区，抽屉不再有技能 tab / 列表 / 启停按钮。
export function createDrawerPanels(ctx) {
  // ctx provides: refs, getDrawerTab, setDrawerTab, getDashboard, loadDashboard,
  //   openReader, openSettingsModal, showToast, showActionError, closeDrawer

  // Round10：记忆 Markdown 链接与 agent 对话同一外部链接语义——委托到 drawerBody，
  // 点击交给系统默认浏览器，不在应用窗口内导航。
  bindExternalLinks(ctx.refs.drawerBody);

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
    const row = document.createElement("div");
    row.className = `chrow ${done ? "completed" : "todo"}`;
    row.title = chapter.title || (done ? "已定稿章节" : "待生成");
    if (done) {
      row.setAttribute("role", "button");
      row.tabIndex = 0;
    } else {
      row.setAttribute("aria-disabled", "true");
    }
    const n = document.createElement("span");
    n.className = "ch-n mono";
    n.textContent = String(chapter.chapter_no).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "ch-name";
    name.textContent = chapter.title || (done ? "已定稿章节" : translateStage(chapter.status ?? "queued"));
    row.append(n, name);
    if (done) {
      // Round10：完成状态 = 短 badge（与待生成对称），不挤压标题。
      const state = document.createElement("span");
      state.className = "ch-state completed";
      state.textContent = "已完成";
      row.append(state);
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
      historyBtn.className = "btn btn--sm";
      historyBtn.textContent = "历史";
      let versionPanel = null;
      let versionPanelOpening = null;
      historyBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!versionPanel) {
          versionPanel = createVersionPanel({ doc: document });
          row.after(versionPanel);
        }
        if (versionPanelOpening) return;
        versionPanelOpening = versionPanel.open({
          title: `第 ${chapter.chapter_no} 章`,
          getVersions: async () => getJson(`/api/chapters/versions?chapter_no=${chapter.chapter_no}`),
          getContent: async (version) => getJson(`/api/chapters/versions/content?chapter_no=${chapter.chapter_no}&version=${version}`),
          onRestore: async (version) => {
            const result = await postJson("/api/chapters/rollback", { chapter_no: chapter.chapter_no, version });
            if (result?.ok) { versionPanel.close(); await ctx.loadDashboard?.(); }
          },
          // 第十一轮（审计 C）：Run 进行中禁用恢复（与后端 409 同口径）。
          agentRunning: ctx.isAgentRunning?.() ?? false
        });
        try {
          await versionPanelOpening;
        } finally {
          versionPanelOpening = null;
        }
      });
      row.append(historyBtn);
      row.addEventListener("click", () => ctx.openReader(chapter.chapter_no));
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        ctx.openReader(chapter.chapter_no);
      });
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
    // 第十一轮（审计 M1）：后端在 effective config 附带 resolution_note（悬空/停用
    // 降级、未配置兜底全局默认），此前 UI 零消费--模型被静默替换时作者无感知。
    const resolutionNote =
      typeof data.config?.effective?.resolution_note === "string" && data.config.effective.resolution_note.length > 0
        ? data.config.effective.resolution_note
        : null;
    // Task 8：未配置模型 = 无 model_name（is_mock 语义已废弃）。
    const modelUnconfigured = !profile || !profile.model_name;
    const model = dpanel("模型配置", modelUnconfigured ? "未配置" : (profile.display ?? "未配置"));
    const open = document.createElement("button");
    open.className = "btn btn--primary";
    open.type = "button";
    open.textContent = "打开模型设置";
    open.addEventListener("click", () => ctx.openSettingsModal());
    const summaryLine = document.createElement("p");
    summaryLine.className = "spd-hint";
    summaryLine.textContent = modelUnconfigured
      ? "尚未配置模型。点上方按钮选 DeepSeek / MiMo 或自定义供应商，并粘贴 API Key。"
      : `${profile.display}${profile.endpoint ? ` · ${profile.endpoint}` : ""}；${profile.api_key_saved ? "API Key 已保存在本机。" : "尚未保存 API Key。"}`;
    // 第十三轮（F6）：高级项参数可见（buildModelProfile 已带同源缺省口径）。
    const fmtK = (tokens) => `${Math.round(Number(tokens) / 1000)}k`;
    const nodes = [summaryLine];
    if (!modelUnconfigured && Number(profile.context_window) > 0) {
      const paramsLine = document.createElement("p");
      paramsLine.className = "spd-hint";
      paramsLine.textContent = `上下文 ${fmtK(profile.context_window)} · 最大输出 ${fmtK(profile.max_output_tokens)}`;
      nodes.push(paramsLine);
    }
    if (resolutionNote != null) {
      const noteLine = document.createElement("p");
      noteLine.className = "spd-hint";
      noteLine.textContent = `模型提示：${resolutionNote}`;
      nodes.push(noteLine);
    }
    nodes.push(open);
    model.body.append(...nodes);

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
    const inputTokens = Number(data.cost?.hitRateInputTokens ?? 0);
    if (!(inputTokens > 0)) return "暂无数据";
    const hitTokens = Number(data.cost?.cacheHitTokens ?? 0);
    return `命中 ${Math.round((hitTokens / inputTokens) * 100)}%`;
  }

  function appendKv(dl, key, value, valueClass) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.className = valueClass ?? "";
    dd.textContent = value;
    dl.append(dt, dd);
  }

  // Round10：资料表单两行——每行 = 输入 + 按钮（grid minmax(0,1fr) auto），
  // 按钮不挤压路径输入，长输入可收缩。
  function researchRow(input, button) {
    const row = document.createElement("div");
    row.className = "research-row";
    row.append(input, button);
    return row;
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
    form.append(researchRow(q, sBtn), researchRow(u, fBtn));
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
        em.className = "em";
        em.textContent = source.title ?? source.file;
        const ex = document.createElement("span");
        // Round10：untrusted 来源 = amber badge + 文本（不只靠颜色）。
        ex.className = source.untrusted ? "ex source-badge source-untrusted" : "ex source-badge";
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
    // Round10：主金额只在 cost-panel.js「总览」显示一次，dpanel 标题不再重复金额 pill。
    const { panel, body } = dpanel("成本视图");
    body.style.padding = "0";
    const tree = renderCostPanelComponent({
      cost: data.cost ?? null,
      summary,
      events,
      modelConfig: data.config?.effective?.active_model ?? null
    });
    body.append(tree);
    ctx.refs.drawerBody.replaceChildren(panel);
  }

// 记忆分区内容读取失败不静默残旧：失败信息渲染进对应卡片（重开抽屉/切回分区即重试）。
async function fetchMemoryContent(file) {
  try {
    return (await getJson(`/api/memory/files/content?file=${file}`))?.content;
  } catch (error) {
    return `读取失败：${error?.message ?? "请稍后重试"}`;
  }
}

// 记忆卡正文渲染：只展示、不改磁盘内容；去除文档第一个 H1（与卡头重复），
// 剥离后为空则显示紧凑空态文案。
  function renderMemoryContent(target, content, emptyText) {
    const lines = String(content ?? "").replace(/^\uFEFF/u, "").split(/\r?\n/u);
    if (/^#\s+\S/u.test(lines[0] ?? "")) lines.shift();
    const body = lines.join("\n").trim();

    if (body === "") {
      target.classList.add("memory-card-content--empty");
      target.textContent = emptyText;
      return;
    }

    target.classList.remove("memory-card-content--empty");
    target.innerHTML = renderMarkdown(body);
  }

  // 第九轮：「记忆」分区面板（故事摘要 + 工作日志 + 设定档案只读）。
  // Round10：记忆区是独立文档块（memory-card 非 dpanel），正文用现有安全
  // Markdown 渲染器（.agent-markdown 子集），不创建第二个 parser、不执行原始 HTML。
  async function renderMemoryPanel(data) {
    const blocks = [
      { file: "book_summary", title: "故事摘要", emptyText: "暂无故事摘要" },
      { file: "worklog", title: "工作日志", emptyText: "暂无工作日志" }
    ];
    const body = document.createElement("div");
    body.className = "memory-body";
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
      history.className = "btn btn--sm";
      history.textContent = "历史";
      let versionPanel = null;
      let versionPanelOpening = null;
      history.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!versionPanel) {
          versionPanel = createVersionPanel({ doc: document });
          card.after(versionPanel);
        }
        if (versionPanelOpening) return;
        versionPanelOpening = versionPanel.open({
          title: block.title,
          getVersions: async () => getJson(`/api/memory/versions?file=${block.file}`),
          getContent: async (version) => getJson(`/api/memory/versions/content?file=${block.file}&version=${version}`),
          onRestore: async (version) => {
            const result = await postJson("/api/memory/versions/restore", { file: block.file, version });
            if (result?.ok) { versionPanel.close(); renderMemoryPanel(data); }
          },
          // 第十一轮（审计 C）：Run 进行中禁用恢复（与后端 409 同口径）。
          agentRunning: ctx.isAgentRunning?.() ?? false
        });
        try {
          await versionPanelOpening;
        } finally {
          versionPanelOpening = null;
        }
      });
      head.append(history);
      card.append(head);
      const content = document.createElement("div");
      content.className = "memory-card-content agent-markdown";
      renderMemoryContent(content, await fetchMemoryContent(block.file), block.emptyText);
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
    cContent.className = "memory-card-content agent-markdown";
    renderMemoryContent(cContent, await fetchMemoryContent("continuity"), "暂无设定档案");
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

  return { renderDrawerBody };
}
