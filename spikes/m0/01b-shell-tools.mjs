// 01b 为什么 SDK 会话里没有 Bash 工具：对比内置 / 已装两个版本，以及显式指定 Git Bash 路径。
// 工具列表只在第一条消息后的 init 里出现，所以每种情况发一个最小请求（Haiku，约 $0.003 一次）。
import { once, reporter, freshDir, BASE, INSTALLED_CLI } from './lib.mjs';

const r = reporter('01b-shell-tools');
const dir = freshDir('shell-tools');
const GIT_BASH = 'D:\\git\\Git\\bin\\bash.exe';

async function shellTools(label, extra) {
  const x = await once('Reply with exactly: ok', { ...BASE, cwd: dir, permissionMode: 'default', maxTurns: 1, ...extra });
  r.cost(x);
  const shells = (x.init?.tools || []).filter(t => /^(bash|powershell)$/i.test(t));
  r.note(`${label}：shell 工具`, { version: x.init?.claude_code_version, shells, error: x.error });
  return shells;
}

const bundled = await shellTools('内置版', {});
const installed = await shellTools('已装版', { pathToClaudeCodeExecutable: INSTALLED_CLI });
const withPath = await shellTools('内置版 + CLAUDE_CODE_GIT_BASH_PATH', { env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: GIT_BASH } });
r.check('至少有一种配置能拿到 Bash 工具', [bundled, installed, withPath].some(s => s.includes('Bash')), { bundled, installed, withPath });
r.save();
