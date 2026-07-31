import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskContractError,
  compileWritingTasks,
  validateTaskContract
} from "../src/core/task-contract.mjs";

test("精确章节指令生成严格单章契约", () => {
  assert.deepEqual(compileWritingTasks("写第2章", { currentChapter: 2, targetChapters: 10 }), [{
    instruction: "写第2章",
    contract: {
      version: 1,
      kind: "write_chapter",
      chapter_start: 2,
      chapter_end: 2,
      stop_policy: "immediate",
      resume_policy: "checkpoint",
      skip_policy: "reject"
    }
  }]);
});

test("续写指令生成 resume_chapter 契约（精确/范围/自由指令）", () => {
  const cases = [
    ["续写第3章", { currentChapter: 3, targetChapters: 10 }, "resume_chapter"],
    ["续写到第6章", { currentChapter: 4, targetChapters: 10 }, "resume_chapter"],
    ["续写3章", { currentChapter: 4, targetChapters: 10 }, "resume_chapter"],
    ["续写下一章", { currentChapter: 3, targetChapters: 10 }, "resume_chapter"],
  ];
  for (const [instruction, opts, expectedKind] of cases) {
    const tasks = compileWritingTasks(instruction, opts);
    assert.ok(tasks.length >= 1, instruction);
    assert.equal(tasks[0].contract.kind, expectedKind, instruction);
  }
  // 「写…」指令不受影响，仍为 write_chapter。
  const [writeTask] = compileWritingTasks("写到第6章", { currentChapter: 4, targetChapters: 10 });
  assert.equal(writeTask.contract.kind, "write_chapter");
  const [freeTask] = compileWritingTasks("继续写作，加强雨夜氛围", { currentChapter: 3, targetChapters: 10 });
  assert.equal(freeTask.contract.kind, "write_chapter");
});

test("范围指令拆成多个单章任务", () => {
  for (const instruction of ["写3章", "写三章", "写到第6章"]) {
    const tasks = compileWritingTasks(instruction, {
      currentChapter: 4,
      targetChapters: 10
    });
    assert.deepEqual(
      tasks.map((item) => item.contract.chapter_start),
      [4, 5, 6],
      instruction
    );
    assert.ok(
      tasks.every(
        (item) => item.contract.chapter_start === item.contract.chapter_end
      )
    );
  }
});

test("跳章和隐式重写均被拒绝", () => {
  assert.throws(
    () => compileWritingTasks("写第5章", { currentChapter: 2, targetChapters: 10 }),
    (error) => {
      assert.equal(error instanceof TaskContractError, true);
      assert.equal(error.code, "chapter_gap");
      assert.deepEqual(error.details, {
        currentChapter: 2,
        requestedChapter: 5,
        missing_start: 2,
        missing_end: 4
      });
      return true;
    }
  );
  assert.throws(
    () => compileWritingTasks("写第1章", { currentChapter: 2, targetChapters: 10 }),
    (error) => error instanceof TaskContractError && error.code === "chapter_already_passed"
  );
});

test("普通继续指令只绑定当前章", () => {
  const [task] = compileWritingTasks("继续写作，加强雨夜氛围", {
    currentChapter: 3,
    targetChapters: 10
  });
  assert.equal(task.contract.chapter_start, 3);
  assert.equal(task.contract.chapter_end, 3);
});

test("运行前契约校验拒绝过期任务", () => {
  assert.throws(
    () => validateTaskContract({
      version: 1,
      kind: "write_chapter",
      chapter_start: 2,
      chapter_end: 2,
      stop_policy: "immediate",
      resume_policy: "checkpoint",
      skip_policy: "reject"
    }, { currentChapter: 3, targetChapters: 10 }),
    (error) => error.code === "task_contract_stale"
  );
});