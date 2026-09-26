// src/app-shell/model-rows.mjs
// 模型行渲染（round22 D22/R1：从 model-settings-page.js 拆出——R1 字节余量不足以
// 承载本轮 B 链改动；唯一调用方是 model-settings-page 的 renderDetail，拆分只为
// 守住体积红线，公开面保持最小：仅导出 renderModelRows）。
// 状态与网络仍由 model-settings-page.js 管理：本模块经 deps 拿草稿引用、展开态
// Set 与提交/删除/拉取/测试回调，自身不持任何可变状态。
import { bindAutosave } from "./dom-kit.js";

// -- 第十三轮（F1）：高级折叠项--上下文/最大输出两个预设下拉，change 即存。 --
const CONTEXT_PRESETS_K = [128, 256, 400, 512, 1000];
const OUTPUT_PRESETS_K = [128, 64, 32, 16, 8];

function presetSelect({ el, field, presetsK, value, defaultK, onChange }) {
  const currentK = Number.isInteger(value) && value > 0 ? Math.round(value / 1000) : null;
  const optionKs = currentK != null && !presetsK.includes(currentK)
    ? [...presetsK, currentK] // 存量非预设值：追加「当前」项，不静默改写
    : presetsK;
  const select = el("select", { "data-field": field }, optionKs.map((k) => {
    const option = el("option", { value: String(k) });
    option.textContent = presetsK.includes(k) ? `${k}k` : `当前 ${k}k`;
    return option;
  }));
  select.value = String(currentK ?? defaultK);
  select.addEventListener("change", () => {
    // ponytail: 若 defaultK 被移出选项列表，真实 DOM 的 select.value 会回落 ""
    // 导致存 0 token；当前 6 条路径均保证 value ∈ optionKs，无实际触发面。
    onChange(Number(select.value) * 1000);
  });
  return el("label", { class: "model-advanced-field" }, [`${field === "context_window" ? "上下文" : "最大输出"}：`, select]);
}

// 模型区渲染（从 renderDetail 拆出：Task 15 的拉取/测试连接接线落在这里）。
// 结构：标题行「模型列表 + 拉取模型」→ 可折叠候选容器（默认收起，pullModels
// 成功自动展开，逐条「添加」）→ 各模型行（改名 / 启停 / 测试连接 / 设默认 / 删除）。
// D10（round22）：空态（无模型）只给「添加模型」一个动作；「添加模型」打开可
// 搜索目录候选 + 手填 ID 输入，只有明确选择/提交非空 ID 时才 POST（addModel(id)）。
export function renderModelRows(container, provider, deps) {
  const {
    el, icon, documentRef,
    draftRefs, advancedOpenModels,
    isDefaultModel, commitModelPatch, saveModelPatch, setDefaultModel,
    removeModelWithConfirm, testConnection, pullModels, addModel,
    catalogCandidates = () => []
  } = deps;

  const isEmpty = (provider.models ?? []).length === 0;
  if (isEmpty) {
    // D10：新供应商空态——仅「添加模型」按钮（不写解释段落、不铺拉取入口）。
    container.append(buildAddModelControl());
    return;
  }

  container.append(el("h4", { text: "模型列表" }));
  const pullButton = el("button", { type: "button", class: "pull-models", text: "拉取模型" });
  pullButton.addEventListener("click", () => { pullModels(provider.id); });
  container.append(pullButton);

  const candidateHolder = el("div", { class: "candidate-list", "data-candidate-list": "true" });
  candidateHolder.hidden = true;
  const candidateToggle = el("button", { type: "button", class: "candidate-toggle", text: "拉取候选 ▸", "aria-expanded": "false" });
  candidateToggle.addEventListener("click", () => {
    candidateHolder.hidden = !candidateHolder.hidden;
    candidateToggle.textContent = candidateHolder.hidden ? "拉取候选 ▸" : "拉取候选 ▾";
    candidateToggle.setAttribute("aria-expanded", String(!candidateHolder.hidden));
  });
  container.append(candidateToggle, candidateHolder);

  for (const model of provider.models) {
    const isDefault = isDefaultModel(provider.id, model.id);
    // 模型名：失焦（change）保存；空值行内中文错误不静默丢弃（Task 20 #5）。
    const nameInput = el("input", { value: model.model_name, "data-field": "model_name" });
    draftRefs.modelInputs.set(model.id, nameInput);
    bindAutosave(nameInput, {
      refs: draftRefs,
      fieldKey: `model_name:${model.id}`,
      validate: (value) => (value ? null : "模型名称不能为空"),
      commit: (value) => commitModelPatch(provider.id, model.id, { model_name: value }),
      // Task 22（#11）：添加模型的提示文案承诺「名称框改名后回车保存」，
      // 绑定 Enter 与失焦保存同一提交路径。
      onEnter: true
    });
    const nameError = el("span", { class: "spd-field-error", "data-field-error": `model_name:${model.id}` });
    draftRefs.errorRefs.set(`model_name:${model.id}`, nameError);
    // 启停开关：文案即动作，点击保存相反状态，refresh 后文案随新状态翻转。
    const toggle = el("button", {
      type: "button",
      class: "model-status-toggle",
      text: model.enabled === false ? "启用" : "停用"
    });
    toggle.addEventListener("click", () => {
      saveModelPatch(provider.id, model.id, { enabled: !model.enabled });
    });
    // 设为默认：POST .../default；默认模型行显示「默认」角标。
    // 停用即不能用：停用模型按钮置灰并提示（后端同款拒绝，前后端一致）。
    const setDefaultButton = el("button", {
      type: "button",
      class: "model-set-default",
      text: "设为默认",
      ...(model.enabled === false ? { disabled: true, title: "已停用的模型不能设为默认。" } : {})
    });
    setDefaultButton.addEventListener("click", () => {
      setDefaultModel(provider.id, model.id);
    });
    // 删除：二次确认后 POST .../remove；Round10：图标 + 文字，走现有 icon 体系。
    const deleteButton = el("button", { type: "button", class: "model-delete", text: "删除" });
    deleteButton.replaceChildren(icon("trash", 14, null, documentRef), documentRef.createTextNode("删除"));
    deleteButton.addEventListener("click", () => {
      removeModelWithConfirm(provider.id, model.id);
    });
    // 测试连接：结果通栏渲染到条目下方（绿勾 / 红字错误文案）。
    const resultSlot = el("div", { class: "model-connection-result", "data-model-connection-result": model.id });
    resultSlot.setAttribute("role", "status");
    const testButton = el("button", { type: "button", class: "model-test-connection", text: "测试连接" });
    testButton.addEventListener("click", () => {
      testConnection(provider, model, resultSlot);
    });
    // Task 5：展开态 Set 改复合键——model id 是供应商局部的（model-provider-store.mjs
    // 契约），两供应商可有同 id 模型；跨供应商引用必须 `${provider.id}/${model.id}`，
    // 否则 A 展开后切到 B，B 的同 id 模型会「继承」展开态。
    const advancedKey = `${provider.id}/${model.id}`;
    const advancedOpen = advancedOpenModels.has(advancedKey);
    // data-model-advanced 保持 model.id（DOM 定位用，非状态键）。
    const advancedHolder = el("div", { class: "model-advanced", "data-model-advanced": model.id });
    advancedHolder.hidden = !advancedOpen;
    // aria-expanded：初始随展开态；点击切换时同步（与折叠箭头同源）。
    const advancedToggle = el("button", { type: "button", class: "model-advanced-toggle", text: advancedOpen ? "高级 ▾" : "高级 ▸", "aria-expanded": String(advancedOpen) });
    advancedToggle.addEventListener("click", () => {
      const opening = advancedHolder.hidden;
      advancedHolder.hidden = !opening;
      advancedToggle.textContent = opening ? "高级 ▾" : "高级 ▸";
      advancedToggle.setAttribute("aria-expanded", String(!opening));
      if (opening) advancedOpenModels.add(advancedKey);
      else advancedOpenModels.delete(advancedKey);
    });
    advancedHolder.append(
      presetSelect({
        el, field: "context_window", presetsK: CONTEXT_PRESETS_K, value: model.context_window, defaultK: 256,
        onChange: (tokens) => { saveModelPatch(provider.id, model.id, { context_window: tokens }); }
      }),
      presetSelect({
        el, field: "max_output_tokens", presetsK: OUTPUT_PRESETS_K, value: model.max_output_tokens, defaultK: 64,
        onChange: (tokens) => { saveModelPatch(provider.id, model.id, { max_output_tokens: tokens }); }
      })
    );
    // Round10：每行三层稳定结构——主行（名称 + 状态）、操作行（可换行）、
    // 通栏结果行（role=status，长错误 anywhere 换行）。主行恒为两个 grid 子项：
    // 名称组（输入 + 行内错误）与状态组（已启用/停用 + 可选「默认」角标），
    // 与两列 grid 一一对应，空错误不把状态推到新行。handler 全部保留。
    container.append(el("div", { class: "model-row", "data-model-id": model.id }, [
      el("div", { class: "model-row-main" }, [
        el("div", { class: "model-row-name" }, [nameInput, nameError]),
        el("span", { class: "model-row-state" }, [
          model.enabled === false ? "已停用" : "已启用",
          ...(isDefault ? [el("span", { class: "default-badge", text: "默认" })] : [])
        ])
      ]),
      el("div", { class: "model-row-actions" }, [
        testButton,
        toggle,
        setDefaultButton,
        deleteButton,
        advancedToggle
      ]),
      advancedHolder,
      resultSlot
    ]));
  }
  // 「+ 添加模型」（D10）：打开可搜索候选池 + 手填 ID 输入；点选候选或提交
  // 非空手填 ID 才调 addModel(provider.id, id) POST。
  container.append(buildAddModelControl());

  // 添加模型控件：按钮 + 折叠面板（候选搜索 + 手填输入）。候选来自目录中与本
  // 厂商同协议的条目（deps.catalogCandidates），已入列的候选被上游过滤。
  function buildAddModelControl() {
    const wrap = el("div", { class: "add-model-control", "data-add-model-control": "true" });
    const addButton = el("button", { type: "button", class: "add-model", text: "+ 添加模型" });
    const panel = el("div", { class: "add-model-panel" });
    panel.hidden = true;
    addButton.addEventListener("click", () => { panel.hidden = !panel.hidden; });

    const search = el("input", { class: "add-model-search", "data-field": "add-model-search", placeholder: "搜索目录候选，或直接在下方手填模型 ID" });
    const hits = el("div", { class: "add-model-hits", "data-add-model-hits": "true" });
    const manualInput = el("input", { class: "add-model-manual", "data-field": "add-model-manual", placeholder: "手填模型 ID，如 deepseek-v4-pro" });
    const submit = el("button", { type: "button", class: "add-model-submit", text: "添加模型" });

    const renderHits = () => {
      const query = search.value.trim().toLowerCase();
      const list = catalogCandidates().filter((id) => !query || String(id).toLowerCase().includes(query));
      hits.replaceChildren();
      hits.hidden = list.length === 0;
      for (const id of list) {
        const row = el("button", { type: "button", class: "add-model-candidate", "data-candidate-model": id }, [
          el("span", { text: id }),
          el("span", { class: "add-model-candidate-add", text: "添加" })
        ]);
        row.addEventListener("click", async () => {
          // 明确选择候选 = 立即入列
          const ok = await addModel(provider.id, id);
          if (ok) panel.hidden = true;
        });
        hits.append(row);
      }
    };
    search.addEventListener("input", renderHits);
    submit.addEventListener("click", async () => {
      const id = manualInput.value.trim();
      if (!id) return; // 空手填不 POST
      const ok = await addModel(provider.id, id);
      if (ok) {
        manualInput.value = "";
        panel.hidden = true;
      }
    });

    panel.append(search, hits, manualInput, submit);
    wrap.append(addButton, panel);
    return wrap;
  }
}
