// 负责人的说明改了以后，很短的问题（“1+1 等于几？只回答数字。”）偶尔答非所问：对比改前、改后的说明各问几次。
// 运行：node spikes/team/trivial-question.mjs [次数]
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectGitBash } from '../../src/main/environment.ts';

const N = Number(process.argv[2] ?? 6);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-trivial-'));
fs.writeFileSync(path.join(cwd, 'README.md'), '# demo\n');
const bash = detectGitBash(null).path;
const team = '- tester（小测）：按任务运行命令、检查环境\n- translator（小李子）：中英日翻译\n- reviewer（老周）：代码审查';
const common = [
  '- 员工是这个项目的资产，项目里所有主对话共用。mcp__claudex__list_employees 看有哪些员工、在忙什么。',
  '- 派活用 mcp__claudex__assign_task：写清楚目标、范围、验收标准和需要的背景。派完马上返回，不用等。',
  '', '现在的团队（以 list_employees 为准）：', team
];
const OLD = ['# 你的团队（Claudex）', '你是这个项目的负责人（CEO）：和用户沟通需求、拆分任务，把能分工、能并行的活派给团队里的员工，再把员工交回的结果核对、整理好告诉用户。小事可以自己顺手做，但能分工、能并行的活优先派给员工。', ...common].join('\n');
const NEW = ['# 你的团队（Claudex）', '你是这个项目的负责人（CEO）：和用户沟通需求、拆分任务，把活派给团队里的员工，再把员工交回的结果核对、整理好告诉用户。用户的每个请求都先想一想该谁做：',
  '- 团队里有负责这类活的员工：派给他，哪怕活很小。员工有自己的长期记忆和用户教过的规矩（比如格式、署名、习惯），你自己做就绕过了这些。',
  '- 能分工、能并行的活：拆开，同时派给合适的员工。',
  '- 没有负责这类活的员工：一次性的小事（回答问题、看一眼文件、查个东西）你自己做；以后还会反复出现的同类活，向用户提议招一个专职员工。',
  '- 和用户沟通需求、核对员工交回的结果、向用户汇报，是你自己的事。', ...common].join('\n');

async function ask(append) {
  let text = '';
  const q = query({
    prompt: '1+1 等于几？只回答数字。',
    options: {
      cwd, model: 'opus', effort: 'xhigh', permissionMode: 'default', persistSession: false, maxTurns: 2,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      env: { ...process.env, ...(bash ? { CLAUDE_CODE_GIT_BASH_PATH: bash } : {}) }
    }
  });
  for await (const m of q) if (m.type === 'result') text = String(m.result ?? m.subtype);
  return text.trim();
}

for (const [label, append] of [['改前', OLD], ['改后', NEW]]) {
  const answers = [];
  for (let i = 0; i < N; i++) answers.push(await ask(append));
  const ok = answers.filter(a => /^\**2\**[。.]?$/.test(a)).length;
  console.log(`${label}：${ok}/${N} 只答了 2；全部回答：${answers.map(a => JSON.stringify(a.slice(0, 40))).join('，')}`);
}
fs.rmSync(cwd, { recursive: true, force: true });
