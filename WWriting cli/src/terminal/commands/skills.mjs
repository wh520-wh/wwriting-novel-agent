// /skills：技能清单只读列出。纯信息输出，没有任何选择交互（铁律 1/11）；
// 技能怎么装/删 = 往目录里放/删文件夹（ADR-0013，v1 不做导入/删除命令）。
// 来源标签照桌面版：项目 / 全局 / 随应用分发 / 内置。
// 技能目录的标签映射只有一份：agent-loop（提示词层）是权威，/skills 的列法照抄它——
// 这条终端→提示词层的反向 import 收拢在本文件，不外溢到命令层其余部分。
import { SKILL_CATEGORY_TAGS } from '../../agent/agent-loop.mjs';
import { fact } from '../../fact.mjs';

export const skillsCommands = [
  { name: 'skills', description: '查看已发现的技能', run: runSkillsCommand },
];

const SKILL_SOURCE_LABELS = Object.freeze({ project: '项目', global: '全局', bundled: '随应用分发', builtin: '内置' });

async function runSkillsCommand(_args, ctx) {
  const { reply, listSkills } = ctx;
  if (listSkills === null) {
    reply('暂不支持查看技能。', { tone: 'warn' });
    return;
  }
  let catalog;
  try {
    catalog = await listSkills();
  } catch (error) {
    reply('读取失败', { tone: 'error', detail: fact(error) });
    return;
  }
  const active = Array.isArray(catalog?.active) ? catalog.active : [];
  const shadowed = Array.isArray(catalog?.shadowed) ? catalog.shadowed : [];
  const errors = Array.isArray(catalog?.errors) ? catalog.errors : [];
  if (active.length === 0 && shadowed.length === 0 && errors.length === 0) {
    reply('未发现技能。', { detail: '把技能文件夹放进 ~/.wwriting/skills 或项目 skills/ 目录即生效。' });
    return;
  }
  if (active.length > 0) {
    reply(`生效 ${active.length}`);
    for (const skill of active) {
      const tag = SKILL_CATEGORY_TAGS[skill?.category ?? ''];
      const label = tag ? `- [${tag}] ${skill.name}` : `- ${skill.name}`;
      reply(`${label}（${SKILL_SOURCE_LABELS[skill?.source] ?? skill?.source ?? '未知'}）：${typeof skill?.description === 'string' ? skill.description : ''}`);
    }
  }
  if (shadowed.length > 0) {
    reply(`被覆盖 ${shadowed.length}`);
    for (const skill of shadowed) {
      reply(`${skill?.name}（${SKILL_SOURCE_LABELS[skill?.source] ?? skill?.source ?? '未知'}）：被更高优先级同名技能覆盖，不生效。`);
    }
  }
  if (errors.length > 0) {
    reply(`解析失败 ${errors.length}`);
    for (const item of errors) {
      const name = String(item?.dir ?? '').split(/[\\/]/u).pop();
      reply(`${name}：${item?.error ?? '解析失败'}`);
    }
  }
}
