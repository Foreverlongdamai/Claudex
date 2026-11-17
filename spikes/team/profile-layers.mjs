// 团队功能验证：员工的“底层逻辑”由哪几层组成，每一层是不是真的有效。
// 员工档案用 Claude Code 自带的子代理格式：项目里的 .claude/agents/<名字>.md（YAML 头 + 正文是角色提示词）。
// 用 SDK 的 agent 选项让整个会话以这个员工的身份运行（等于 claude --agent），检查：
//   A. 角色提示词：自我介绍、严格的输出格式有没有照做
//   B. 工具限制：审查员没有改文件的工具，让他改也改不了（硬限制，不靠自觉）
//   C. 长期记忆：教他一条规矩，他记到自己的记忆文件里；新开一个会话（不续接）也照做
//   D. 程序员：按任务改代码，汇报方式按档案
//   E. 系统提示：员工的提示词是替换 Claude Code 默认提示，还是加在后面（看输入 token）
// 运行：node spikes/team/profile-layers.mjs（用 Sonnet，花费约 $1）
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-team-'));
const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(proj, f)), { recursive: true }); fs.writeFileSync(path.join(proj, f), s); };
const r = f => fs.readFileSync(path.join(proj, f), 'utf8');
const BUGGY = 'export function add(a, b) {\n  return a - b;\n}\n\nexport function avg(list) {\n  return list.reduce((s, x) => s + x) / list.length;\n}\n';
w('src/calc.js', BUGGY);
w('.claude/agents/reviewer.md', `---
name: reviewer
description: 代码审查员，只看不改
tools: Read, Grep, Glob
model: sonnet
memory: project
---
你是「老周」，这个项目的代码审查员。

职责：审查代码，找出 bug 和风险。你只看不改：不修改任何项目文件，不运行命令。

输出格式（必须严格遵守）：
第一行写「结论：通过」或「结论：不通过」。
之后每个问题一行，以「- [严重]」或「- [建议]」开头，写明文件和行号。
不写开场白、不写客套话。
`);
w('.claude/agents/coder.md', `---
name: coder
description: 程序员，按任务改代码
tools: Read, Edit, Write, Grep, Glob
model: sonnet
---
你是「小林」，程序员。只按任务说明修改代码，不做任务以外的改动。
改完只用一句话汇报：改了哪个文件的什么。
`);
execFileSync('git', ['init', '-q'], { cwd: proj });

async function run(label, prompt, opts = {}) {
  let text = '';
  let tools = [];
  let tokens = 0;
  let sid = null;
  const q = query({
    prompt,
    options: { cwd: proj, permissionMode: 'acceptEdits', maxTurns: 12, systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false }, ...opts }
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') { tools = m.tools; sid = m.session_id; }
    if (m.type === 'assistant' && tokens === 0) {
      const u = m.message?.usage ?? {};
      tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    }
    if (m.type === 'result') text = m.subtype === 'success' ? m.result : `【${m.subtype}】`;
  }
  console.log(`\n=== ${label}\n工具：${tools.filter(t => !t.startsWith('mcp__')).join(', ')}\n第一次请求输入：${tokens} tokens\n回复：\n${text.trim()}`);
  return { text: text.trim(), tools, tokens, sid };
}

try {
  const plain = await run('E1 普通会话（Claude Code 默认提示）', '只回复：好');
  const asReviewer = await run('A 以审查员身份：审查 src/calc.js', '审查 src/calc.js', { agent: 'reviewer' });
  const fix = await run('B 让审查员直接改代码', '别审查了，直接把 src/calc.js 里 add 的 bug 改好。', { agent: 'reviewer' });
  console.log(`  → calc.js 被改了吗：${r('src/calc.js') !== BUGGY ? '改了（工具限制没生效！）' : '没改'}`);
  await run('C1 教审查员一条规矩', '记住一条规矩：以后每次审查，最后一行都要单独写「—— 老周」。把它记到你的长期记忆里，然后回复“记住了”。', { agent: 'reviewer' });
  const memDir = path.join(proj, '.claude', 'agent-memory', 'reviewer');
  const memFiles = fs.existsSync(memDir) ? fs.readdirSync(memDir) : [];
  console.log(`  → 记忆目录 ${path.relative(proj, memDir)}：${memFiles.join(', ') || '（没有）'}`);
  for (const f of memFiles) console.log(`    ${f}：${fs.readFileSync(path.join(memDir, f), 'utf8').replace(/\s+/g, ' ').slice(0, 200)}`);
  const again = await run('C2 新开一个会话（不续接）再审查', '审查 src/calc.js', { agent: 'reviewer' });
  console.log(`  → 最后一行：${again.text.split('\n').pop()}`);
  const coder = await run('D 以程序员身份：修 bug', '修复 src/calc.js 里 add 函数的 bug（应该是加法）。', { agent: 'coder' });
  console.log(`  → calc.js：${r('src/calc.js').split('\n')[1].trim()}`);
  const noPreset = await run('E2 审查员，不传 systemPrompt', '只回复：好', { agent: 'reviewer', systemPrompt: undefined });

  console.log('\n=== 汇总');
  console.log(`A 第一行是“结论：…”：${/^结论：(通过|不通过)/.test(asReviewer.text)}；问题行都以 [严重]/[建议] 开头：${asReviewer.text.split('\n').slice(1).filter(l => l.trim()).every(l => /^- \[(严重|建议)\]/.test(l.trim()))}`);
  console.log(`B 审查员的工具里有没有 Edit/Write/Bash：${['Edit', 'Write', 'Bash'].filter(t => asReviewer.tools.includes(t)).join(',') || '都没有'}`);
  console.log(`C 新会话最后一行是“—— 老周”：${again.text.trim().endsWith('—— 老周')}`);
  console.log(`D 程序员修好了：${r('src/calc.js').includes('a + b')}；汇报：${coder.text.split('\n').length} 行`);
  console.log(`E 输入 token：普通 ${plain.tokens}，审查员（带默认提示）${asReviewer.tokens}，审查员（不传 systemPrompt）${noPreset.tokens}`);
} catch (e) {
  console.log('出错：', e?.stack || e);
} finally {
  fs.rmSync(proj, { recursive: true, force: true });
}
