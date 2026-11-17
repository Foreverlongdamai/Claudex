// 验证：员工的会话（agent 主线程）里，会话级别的 skills 选项能不能只放行档案里选中的几个 Skill。
// Skill 本身还放在全局和项目里；员工档案只记“能用哪几个”。
// 运行：node spikes/team/skills-filter.mjs（用 Haiku）
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-skills-'));
// 一个项目级的 Skill
fs.mkdirSync(path.join(proj, '.claude', 'skills', 'proj-greeting'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'skills', 'proj-greeting', 'SKILL.md'), '---\nname: proj-greeting\ndescription: 用固定格式打招呼\n---\n打招呼时说：你好，我是项目 Skill。\n');
const agents = { writer: { description: '写作', prompt: '你是写作员工。', tools: ['Read', 'Skill'] } };

async function run(label, extra, prompt = '只回复：好') {
  let skills = [];
  let all = [];
  let text = '';
  const q = query({ prompt, options: { cwd: proj, model: 'haiku', maxTurns: 3, permissionMode: 'default', agents, agent: 'writer', ...extra } });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      skills = m.skills ?? [];
      try { all = (await q.reloadSkills()).skills.map(s => s.name); } catch (e) { all = [`reloadSkills 出错：${e.message}`]; }
    }
    if (m.type === 'result') text = m.subtype === 'success' ? m.result : m.subtype;
  }
  console.log(`\n=== ${label}\ninit 里的 skills（${skills.length} 个）：${skills.slice(0, 12).join(', ')}${skills.length > 12 ? ' …' : ''}\nreloadSkills（${all.length} 个）：${all.slice(0, 12).join(', ')}${all.length > 12 ? ' …' : ''}\n回复：${text.trim().slice(0, 200)}`);
  return { skills, all };
}

try {
  const a = await run('不设 skills（全部）', {});
  const b = await run('skills: [proj-greeting, office-docx]', { skills: ['proj-greeting', 'office-docx'] });
  const c = await run('skills: [proj-greeting]，让他用 office-docx', { skills: ['proj-greeting'] }, '用 Skill 工具调用 office-docx 这个 skill（只调用，不用做别的），然后告诉我调用成功了没有。');
  console.log('\n=== 汇总');
  console.log(`全部：${a.skills.length} 个，包含项目 Skill：${a.skills.includes('proj-greeting')}`);
  console.log(`只选两个：${JSON.stringify(b.skills)}`);
  console.log(`没选 office-docx 却要用：${c.skills.includes('office-docx') ? '列表里有（没过滤）' : '列表里没有'}`);
} finally {
  fs.rmSync(proj, { recursive: true, force: true });
}
