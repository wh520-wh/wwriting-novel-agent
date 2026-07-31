export class TaskContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TaskContractError";
    this.code = code;
    this.details = details;
  }
}

export function makeChapterContract(chapterNo, kind = "write_chapter") {
  return {
    version: 1,
    kind,
    chapter_start: chapterNo,
    chapter_end: chapterNo,
    stop_policy: "immediate",
    resume_policy: "checkpoint",
    skip_policy: "reject"
  };
}

export function compileWritingTasks(instruction, { currentChapter, targetChapters }) {
  const text = String(instruction ?? "").trim();
  const current = positiveInteger(currentChapter, "currentChapter");
  const target = positiveInteger(targetChapters, "targetChapters");
  if (!text) throw new TaskContractError("empty_instruction", "请输入写作指令。");

  const precise = /^(写|续写)第(\d+)章(?:[，,\s].*)?$/u.exec(text);
  if (precise) {
    const chapter = Number(precise[2]);
    assertRequestedChapter(chapter, current, target);
    return [{ instruction: text, contract: makeChapterContract(chapter, kindForVerb(precise[1])) }];
  }

  const toChapter = /^(?:写|续写|写完|一直写)到第(\d+)章$/u.exec(text);
  if (toChapter) {
    const end = Number(toChapter[1]);
    assertRangeEnd(end, current, target);
    return chapterTasks(current, end, preciseVerb(text));
  }

  const count = /^(写|续写)(\d+|[一二三四五六七八九十])章$/u.exec(text);
  if (count) {
    const countValue = parseChapterCount(count[2]);
    const end = current + countValue - 1;
    assertRangeEnd(end, current, target);
    return chapterTasks(current, end, count[1]);
  }

  // 「续写…」开头的自由指令（如「续写下一章」）也视为续写任务，其余走常规写作。
  return [{ instruction: text, contract: makeChapterContract(current, kindForVerb(text)) }];
}

export function makeResumeContract(chapterNo) {
  return makeChapterContract(positiveInteger(chapterNo, "chapterNo"), "resume_chapter");
}

export function validateTaskContract(contract, { currentChapter, targetChapters }) {
  if (!contract || contract.version !== 1) {
    throw new TaskContractError("invalid_task_contract", "任务缺少可执行契约。");
  }
  const current = positiveInteger(currentChapter, "currentChapter");
  const target = positiveInteger(targetChapters, "targetChapters");
  const start = positiveInteger(contract.chapter_start, "chapter_start");
  const end = positiveInteger(contract.chapter_end, "chapter_end");
  if (start !== end) {
    throw new TaskContractError("multi_chapter_contract_rejected", "执行器只接受单章任务。");
  }
  if (start !== current) {
    throw new TaskContractError("task_contract_stale", `当前待写第 ${current} 章，任务目标为第 ${start} 章。`, {
      currentChapter: current,
      requestedChapter: start
    });
  }
  if (start > target) {
    throw new TaskContractError("chapter_out_of_project", `第 ${start} 章超过项目目标 ${target} 章。`);
  }
  return contract;
}

function assertRequestedChapter(chapter, current, target) {
  if (chapter > target) {
    throw new TaskContractError("chapter_out_of_project", `第 ${chapter} 章超过项目目标 ${target} 章。`);
  }
  if (chapter > current) {
    throw new TaskContractError("chapter_gap", `请先完成第 ${current} 至 ${chapter - 1} 章。`, {
      currentChapter: current,
      requestedChapter: chapter,
      missing_start: current,
      missing_end: chapter - 1
    });
  }
  if (chapter < current) {
    throw new TaskContractError("chapter_already_passed", `第 ${chapter} 章已经越过，请使用明确的重写操作。`);
  }
}

function assertRangeEnd(end, current, target) {
  if (!Number.isInteger(end) || end < current) {
    throw new TaskContractError("invalid_chapter_range", "章节范围不能早于当前待写章节。");
  }
  if (end > target) {
    throw new TaskContractError("chapter_out_of_project", `范围终点第 ${end} 章超过项目目标 ${target} 章。`);
  }
}

function chapterTasks(start, end, verb) {
  const kind = kindForVerb(verb);
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const chapter = start + offset;
    return {
      instruction: `${verb}第${chapter}章`,
      contract: makeChapterContract(chapter, kind)
    };
  });
}

function kindForVerb(verb) {
  // 「续写」开头的指令是续写任务（resume_chapter → 任务卡显示「续写」），
  // 其余为常规写作（write_chapter → 「写作」）。
  return String(verb ?? "").startsWith("续写") ? "resume_chapter" : "write_chapter";
}

function preciseVerb(text) {
  return text.startsWith("续写") ? "续写" : "写";
}

function parseChapterCount(token) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (map[token] !== undefined) return map[token];
  return Number(token);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TaskContractError("invalid_task_contract", `${name} 必须是正整数。`);
  }
  return number;
}