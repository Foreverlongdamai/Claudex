// 04 权限：审批回调、对话中途切模式、完全访问下保底黑名单（PreToolUse hook）是否还生效。
import fs from 'node:fs';
import path from 'node:path';
import { session, reporter, freshDir, BASE } from './lib.mjs';

const r = reporter('04-permissions');
const dir = freshDir('permissions');
const exists = f => fs.existsSync(path.join(dir, f));
let step = '';
const calls = [];      // canUseTool 被调用的记录
const hookCalls = [];  // PreToolUse hook 被调用的记录
const BLOCK = 'LUMEN_BLOCK_TEST';

const s = session({
  ...BASE, cwd: dir,
  permissionMode: 'default',
  allowDangerouslySkipPermissions: true, // 允许中途切到完全访问，但启动时不进入
  canUseTool: async (name, input, opts) => {
    calls.push({ step, name, command: input.command, hasSuggestions: !!opts.suggestions?.length, title: opts.title, displayName: opts.displayName });
    if (name === 'ExitPlanMode') return { behavior: 'deny', message: '测试：保持计划模式，不要退出' };
    if (String(input.command || '').includes('step-b')) return { behavior: 'deny', message: '用户拒绝：这是一个测试' };
    return { behavior: 'allow', updatedInput: input };
  },
  hooks: {
    PreToolUse: [{
      matcher: 'Bash|PowerShell',
      hooks: [async (input) => {
        const cmd = String(input.tool_input?.command || '');
        hookCalls.push({ step, cmd });
        if (cmd.includes(BLOCK)) {
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '保底黑名单拦截（测试）' } };
        }
        return {};
      }]
    }]
  }
});
const bash = cmd => `Use the Bash tool to run exactly this command, with no changes: ${cmd}\nDo not use any other tool. If it is blocked or denied, do not try any alternative; just reply BLOCKED. Otherwise reply OK.`;
const callsIn = st => calls.filter(c => c.step === st);

try {
  step = 'A';
  const a = await s.turn(bash('echo step-a > a.txt'));
  r.cost(a);
  r.check('默认模式：运行命令前调用了审批回调', callsIn('A').some(c => c.name === 'Bash'), callsIn('A'));
  r.check('默认模式：允许后命令执行了', exists('a.txt'));
  r.note('审批回调收到的信息示例', callsIn('A')[0]);

  step = 'B';
  const b = await s.turn(bash('echo step-b > b.txt'));
  r.cost(b);
  r.check('默认模式：拒绝后命令没有执行', !exists('b.txt'));
  r.check('结果里记录了被拒绝的调用', (b.result.permission_denials || []).length >= 1, b.result.permission_denials?.length);

  step = 'C';
  await s.q.setPermissionMode('acceptEdits');
  const c = await s.turn('Use the Write tool to create the file c.txt with the content: c\nDo not use Bash. Reply OK when done.');
  r.cost(c);
  r.check('切到自动接受编辑：写文件不再问', exists('c.txt') && !callsIn('C').some(x => x.name === 'Write'), callsIn('C'));

  step = 'D';
  await s.q.setPermissionMode('plan');
  const d = await s.turn(bash('echo step-d > d.txt'));
  r.cost(d);
  r.check('切到计划模式：不执行命令', !exists('d.txt'), { calls: callsIn('D').map(x => x.name), reply: d.text.slice(0, 120) });

  step = 'E';
  await s.q.setPermissionMode('bypassPermissions');
  const e = await s.turn(bash('echo step-e > e.txt'));
  r.cost(e);
  r.check('切到完全访问：不再调用审批回调，命令直接执行', exists('e.txt') && callsIn('E').length === 0, callsIn('E'));

  step = 'F';
  const f = await s.turn(bash(`echo ${BLOCK} > f.txt`));
  r.cost(f);
  r.check('完全访问下 PreToolUse hook 仍然被调用', hookCalls.some(h => h.step === 'F' && h.cmd.includes(BLOCK)), hookCalls.filter(h => h.step === 'F'));
  r.check('完全访问下黑名单命令被拦截，没有执行', !exists('f.txt'), f.text.slice(0, 120));

  step = 'G';
  await s.q.setPermissionMode('default');
  const g = await s.turn(bash('echo step-g > g.txt'));
  r.cost(g);
  r.check('切回默认：又开始调用审批回调', callsIn('G').some(x => x.name === 'Bash') && exists('g.txt'), callsIn('G'));
  r.note('每一步 hook 被调用的次数', Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(k => [k, hookCalls.filter(h => h.step === k).length])));
} catch (err) {
  r.check(`步骤 ${step} 出错`, false, String(err?.message || err));
} finally {
  await s.close();
}

// 不开 allowDangerouslySkipPermissions 时，哪些模式能切过去（只发控制请求，不花 token）
const s2 = session({ ...BASE, cwd: dir, permissionMode: 'default' });
try {
  await s2.q.initializationResult();
  const modes = {};
  for (const m of ['acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions', 'default']) {
    try { await s2.q.setPermissionMode(m); modes[m] = '可以'; } catch (e) { modes[m] = '被拒绝：' + String(e?.message || e).slice(0, 120); }
  }
  r.note('没开 allowDangerouslySkipPermissions 时各模式能否切换', modes);
  r.check('没开安全开关时不能切到完全访问', modes.bypassPermissions !== '可以', modes.bypassPermissions);
} finally {
  await s2.close();
}
r.save();
