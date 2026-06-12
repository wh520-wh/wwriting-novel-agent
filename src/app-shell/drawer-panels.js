import { icon } from "./icons.js";
import { formatNumber, formatMoney, formatTime, translateStage, translateReviewStatus, translateSkillType, translateSourceKind, translateEventType } from "./utils.js";
import { postJson } from "./api-client.js";
import { renderCostPanel as renderCostPanelComponent } from "./components/cost-panel.js";

export function createDrawerPanels(ctx) {
  // ctx provides: refs, getDrawerTab, setDrawerTab, getDashboard, loadDashboard,
  //   openReader, openSettingsModal, showToast, showActionError

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
    else if (drawerTab === "cost") renderCostPanel(dashboard);
    else if (drawerTab === "reviewer") renderReviewerPanel(dashboard);
    else renderRunPanel(dashboard);
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

    // 导出工具条
    const toolbar = document.createElement("div");
    toolbar.className = "export-toolbar";
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "tbtn export-btn";
    exportBtn.textContent = "导出成书";
    exportBtn.addEventListener("click", () => {
      ctx.closeDrawer?.();
      ctx.sendChatMessageWithUX?.("导出全书为 md");
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
      list.append(drawerEmpty("尚无章节，发送指令后开始生成。"));
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

  function buildChapterRow(chapter, costRow, costAvailable) {
    const done = chapter.status === "completed";
    const running = !done && chapter.status && !["queued", "planned"].includes(chapter.status);
    const row = document.createElement("button");
    row.className = `chrow ${done ? "completed" : running ? "running" : "todo"}`;
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
    } else if (running) {
      const state = document.createElement("span");
      state.className = "ch-state run";
      const spin = document.createElement("span");
      spin.className = "spin";
      state.append(spin, document.createTextNode("生成中"));
      row.append(state);
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
    appendKv(kv, "审查器", translateReviewStatus(data.review?.status), "green");
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

  function renderRunPanel(data) {
    const summary = data.summary;
    const progress = dpanel("进度", `${summary.progressPercent ?? 0}%`);
    const kv = document.createElement("dl");
    kv.className = "kv";
    appendKv(kv, "完成章节", `${summary.completedChapters} / ${summary.targetChapters}`);
    appendKv(kv, "累计字数", formatNumber(summary.totalWords));
    appendKv(kv, "当前阶段", translateStage(summary.currentStage ?? "-"));
    appendKv(kv, "最近检查点", summary.latestCheckpoint ?? "-");
    progress.body.append(kv);

    const events = dpanel("运行事件");
    events.body.style.padding = "4px 0";
    const list = data.events ?? [];
    if (list.length === 0) {
      events.body.append(drawerEmpty("暂无事件。"));
    } else {
      for (const event of [...list].slice(-40).reverse()) {
        events.body.append(buildEventRow(event));
      }
    }

    const skillItems = data.skills?.items ?? [];
    const enabledCount = skillItems.filter((s) => s.enabled_in_project).length;
    const skills = dpanel("技能", `${enabledCount} 启用`);
    if (skillItems.length === 0) {
      skills.body.append(drawerEmpty("未发现技能。"));
    } else {
      for (const skill of skillItems) skills.body.append(buildSkillRow(skill));
    }

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
    ctx.refs.drawerBody.replaceChildren(progress.panel, events.panel, skills.panel, research.panel);
  }

  function renderSkillsPanel(data) {
    const skillItems = data.skills?.items ?? [];
    const enabledCount = skillItems.filter((s) => s.enabled_in_project).length;
    const skills = dpanel("技能", `${enabledCount} 启用`);
    if (skillItems.length === 0) {
      skills.body.append(drawerEmpty("未发现技能。"));
    } else {
      for (const skill of skillItems) skills.body.append(buildSkillRow(skill));
    }
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
      events
    });
    body.append(tree);
    ctx.refs.drawerBody.replaceChildren(panel);
  }

  function renderReviewerPanel(data) {
    const review = data.review ?? {};
    const panel = dpanel("审查报告");
    if (!review.generated_at) {
      panel.body.append(drawerEmpty("暂无审查报告。运行 /review 命令后生成。"));
    } else {
      const kv = document.createElement("dl");
      kv.className = "kv";
      appendKv(kv, "状态", translateReviewStatus(review.status));
      appendKv(kv, "生成时间", formatTime(review.generated_at));
      panel.body.append(kv);
      if (review.summary) {
        const p = document.createElement("p");
        p.className = "agent-say";
        p.textContent = review.summary;
        panel.body.append(p);
      }
    }
    ctx.refs.drawerBody.replaceChildren(panel.panel);
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
    const et = document.createElement("span");
    et.className = "et";
    et.textContent = skill.name;
    const em = document.createElement("span");
    em.className = "em";
    em.textContent = `${translateSkillType(skill.type)} · 优先级 ${skill.priority}`;
    const action = document.createElement("button");
    action.className = "small-button";
    action.type = "button";
    action.textContent = skill.enabled_in_project ? "禁用" : "启用";
    action.addEventListener("click", async () => {
      action.disabled = true;
      try {
        await postJson(skill.enabled_in_project ? "/api/skills/disable" : "/api/skills/enable", { name: skill.name });
        ctx.showToast(`技能已${skill.enabled_in_project ? "禁用" : "启用"}：${skill.name}`, "success");
        await ctx.loadDashboard();
      } catch (error) {
        ctx.showActionError(error);
        action.disabled = false;
      }
    });
    row.append(et, em, action);
    return row;
  }

  return { renderDrawerBody };
}
