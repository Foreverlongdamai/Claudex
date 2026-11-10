// 02 Git Bash：确认 SDK 调起的 Claude Code 用的是 Git Bash，而不是 PATH 里排在前面的 WSL bash。
import { once, reporter, freshDir, BASE } from './lib.mjs';

const r = reporter('02-gitbash');
const dir = freshDir('gitbash');
const calls = [];

const res = await once(
  'Use the Bash tool (not PowerShell) to run exactly this command and nothing else:\n' +
  'echo "BASH=$BASH_VERSION"; uname -s; echo "BASHPATH=$(command -v bash)"\n' +
  'Then reply with the raw output only.',
  {
    ...BASE, cwd: dir, permissionMode: 'default', maxTurns: 4,
    canUseTool: async (name, input) => { calls.push(name); return { behavior: 'allow', updatedInput: input }; }
  }
);
r.cost(res);
const out = res.toolResults.map(t => t.text).join('\n');
r.check('调用了 Bash 工具', res.toolUses.some(t => t.name === 'Bash'), res.toolUses.map(t => t.name));
r.check('Bash 是 Git Bash（MINGW/MSYS）', /MINGW|MSYS/i.test(out), out.slice(0, 300));
r.check('没有用到 WSL 的 bash', !/Linux/.test(out.split('\n').find(l => !l.startsWith('BASH')) || ''), out.slice(0, 300));
r.note('权限回调收到的工具', calls);
r.note('内置工具里有没有 PowerShell', res.init?.tools?.includes('PowerShell'));
if (res.error) r.note('错误输出', { error: res.error, stderr: res.stderr });
r.save();
