// 任务计划工具测试：整表替换的校验与归一——status 缺省 pending、未知 status 拒绝、
// 空摘要拒绝、数量与长度上限、done 计数。纯函数，零依赖。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_STATUSES, PlanToolError, updatePlan } from '../../src/tools/plan.mjs';

test('updatePlan 归一：status 缺省 pending，返回整表与计数', () => {
  const out = updatePlan({ steps: [
    { summary: '通读第二章' },
    { summary: '改写开头', status: 'in_progress' },
    { summary: '检查衔接', status: 'completed' },
  ] });
  assert.deepEqual(out.plan, [
    { summary: '通读第二章', status: 'pending' },
    { summary: '改写开头', status: 'in_progress' },
    { summary: '检查衔接', status: 'completed' },
  ]);
  assert.equal(out.total, 3);
  assert.equal(out.done, 1);
});

test('updatePlan 空表合法（模型显式清空），total 为 0', () => {
  const out = updatePlan({ steps: [] });
  assert.deepEqual(out.plan, []);
  assert.equal(out.total, 0);
  assert.equal(out.done, 0);
});

test('updatePlan 拒绝非数组与缺摘要', () => {
  assert.throws(() => updatePlan({ steps: '先写第三章' }), PlanToolError);
  assert.throws(() => updatePlan({ steps: [{ status: 'pending' }] }), (error) => {
    assert.equal(error instanceof PlanToolError, true);
    assert.equal(error.code, 'TOOL_PLAN_STEP_INVALID');
    return true;
  });
});

test('updatePlan 拒绝未知 status 与超量步骤', () => {
  assert.throws(() => updatePlan({ steps: [{ summary: 'x', status: 'done' }] }), (error) => {
    assert.equal(error.code, 'TOOL_PLAN_STEP_INVALID');
    return true;
  });
  const steps = Array.from({ length: 31 }, () => ({ summary: '步骤' }));
  assert.throws(() => updatePlan({ steps }), (error) => {
    assert.equal(error.code, 'TOOL_PLAN_TOO_MANY_STEPS');
    return true;
  });
});

test('updatePlan 长摘要截到上限，不静默丢步骤', () => {
  const out = updatePlan({ steps: [{ summary: '长'.repeat(500) }] });
  assert.equal(out.plan[0].summary.length, 200);
  assert.equal(out.total, 1);
});

test('PLAN_STATUSES 三态冻结，顺序稳定', () => {
  assert.deepEqual(PLAN_STATUSES, ['pending', 'in_progress', 'completed']);
});
