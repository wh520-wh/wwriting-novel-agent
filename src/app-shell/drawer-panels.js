import { icon } from "./icons.js";
import { formatNumber, formatMoney, formatTime, translateStage, translateSkillType, translateSourceKind, translateEventType } from "./utils.js";
import { postJson } from "./api-client.js";
import { renderCostPanel as renderCostPanelComponent } from "./components/cost-panel.js";

// 抽屉面板（统一 Agent 内核计划 Task 9）：只保留项目领域事实（章节/模型/技能/
// 资料/成本）。删除运行面板与审查面板——运行事实只在 Agent 对话当前轮展示；
// “导出成书”直接 POST 确定性导出 route，不再经聊天发送。
export function createDrawerPanels(ctx) {
  // ctx provides: refs, getDrawerTab, setDrawerTab, getDashboard, loadDashboard,
  //   openReader, openSettingsModal, showToast, showActionError, closeDrawer

  function renderDrawerBody() {
    const dashboard = ctx.getDashboard();
    const drawerTab = ctx.getDrawerTab();
    if (!dashboard || !dashboard.hasProject) {
      ctx.refs.drawerBody.replaceChildren(drawerEmpty("打开或新建一部小说后显示。"));
      return;
    }
    if (drawerTab === "chapters") renderChapterPanel(dashboard);
    else if (drawerTab === "model") renderModelPanel(dashboard);
    else if (drawerTab === "skills") renderSkillsPanel(dashboard);
    else if (drawerTab === "research") renderResearchPanel(dashboard);
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
    exportBtn.className = "tbtn export-btn";
    exportBtn.textContent = "导出成书";
    exportBtn.addEventListener("click", () => {
      void exportBook(data, exportBtn);
    });
    toolbar.append(exportBtn);
    if (window.wwritingDesktop?.revealPath) {
      const revealBtn = document.createElement("button");
      revealBtn.type = "button";
      revealBtn.className = "tbtn export-reveal-btn";
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
        meta.textContent = `${formatNumber(chapter.actual_words)} 字 · ${formatMoney(costRow.estimatedCost)}`;
      } else {
        meta.textContent = `${formatNumber(chapter.actual_words)} 字`;
      }
      row.append(meta, icon("chevR", 14, "ch-go"));
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
    const model = dpanel("模型配置", profile.is_mock ? "未配置" : (profile.display ?? "未配置"));
    const open = document.createElement("button");
    open.className = "save-btn";
    open.type = "button";
    open.textContent = "打开模型设置";
    open.addEventListener("click", () => ctx.openSettingsModal());
    const summaryLine = document.createElement("p");
    summaryLine.className = "spd-hint";
    summaryLine.textContent = profile.is_mock
      ? "尚未配置模型。点上方按钮选 DeepSeek / MiMo 或自定义供应商，并粘贴 API Key。"
      : `${profile.display}${profile.endpoint ? ` · ${profile.endpoint}` : ""}；${profile.api_key_saved ? "API Key 已保存在本机。" : "尚未保存 API Key。"}`;
    model.body.append(summaryLine, open);

    const budget = dpanel("预算与权限");
    const kv = document.createElement("dl");
    kv.className = "kv";
    appendKv(kv, "模型调用", `${formatNumber(summary.modelCalls)} / ${summary.maxModelCalls ?? "∞"}`);
    appendKv(kv, "估算成本", summary.costAvailable ? formatMoney(summary.estimatedCost) : "未配置价格");
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

  function renderSkillsPanel(data) {
    const skills = buildSkillsPanel(data);
    ctx.refs.drawerBody.replaceChildren(skills.panel);
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
      pill.textContent = formatMoney(summary.estimatedCost);
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

  function buildSkillRow(skill) {
    const row = document.createElement("div");
    row.className = "evt";
    const desc = document.createElement("span");
    desc.className = "et";
    desc.textContent = skill.description ?? skill.name;
    desc.title = skill.description ?? skill.name;
    const meta = document.createElement("span");
    meta.className = "em";
    meta.textContent = `${translateSkillType(skill.type)} · ${skill.name}`;
    const action = document.createElement("button");
    action.className = "small-button";
    action.type = "button";
    action.textContent = skill.enabled_in_project ? "禁用" : "启用";
    action.addEventListener("click", async () => {
      action.disabled = true;
      try {
        await postJson(skill.enabled_in_project ? "/api/skills/disable" : "/api/skills/enable", { name: skill.name });
        ctx.showToast(`技能已${skill.enabled_in_project ? "禁用" : "启用"}：${skill.description ?? skill.name}`, "success");
        await ctx.loadDashboard();
      } catch (error) {
        ctx.showActionError(error);
        action.disabled = false;
      }
    });
    row.append(desc, meta, action);
    return row;
  }

  function buildSkillsPanel(data) {
    const skillItems = data.skills?.items ?? [];
    const enabledCount = skillItems.filter((s) => s.enabled_in_project).length;
    const skills = dpanel("技能", `${enabledCount} 启用`);

    const intro = document.createElement("div");
    intro.className = "skill-intro";
    intro.textContent = "写作技能包：开启后，写作时自动注入规则，审稿时按清单检查质量。";

    const pendingSkills = skillItems.filter((s) => !s.enabled_in_project);
    const enableAllBtn = document.createElement("button");
    enableAllBtn.type = "button";
    enableAllBtn.className = "small-button promote";
    enableAllBtn.textContent = "全部启用";
    enableAllBtn.disabled = pendingSkills.length === 0;
    enableAllBtn.addEventListener("click", async () => {
      enableAllBtn.disabled = true;
      let ok = 0;
      let failed = 0;
      for (const skill of pendingSkills) {
        try {
          await postJson("/api/skills/enable", { name: skill.name });
          ok += 1;
        } catch (error) {
          failed += 1;
          console.error("enable skill failed:", skill.name, error);
        }
      }
      if (failed > 0) {
        ctx.showToast(`技能启用：成功 ${ok} 个，失败 ${failed} 个`, "error");
      } else {
        ctx.showToast(`已启用 ${ok} 个技能，写作时会自动生效`, "success");
      }
      await ctx.loadDashboard();
    });

    const toolbar = document.createElement("div");
    toolbar.className = "skill-toolbar";
    toolbar.append(intro, enableAllBtn);
    skills.body.append(toolbar);

    if (skillItems.length === 0) {
      skills.body.append(drawerEmpty("未发现技能。"));
    } else {
      for (const skill of skillItems) skills.body.append(buildSkillRow(skill));
    }
    return skills;
  }

  return { renderDrawerBody };
}
