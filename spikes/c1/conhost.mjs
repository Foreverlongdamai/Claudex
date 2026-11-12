// 用 taskkill 结束 node-pty 的 shell 之后，ConPTY 给它开的 conhost.exe 会不会留下来
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const require = createRequire(path.join('D:/claude_code_lm', 'package.json'));
const pty = require('node-pty');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const conhosts = () => {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.Name -match 'conhost|OpenConsole' }).Count`], { encoding: 'utf8' });
  return Number(out.trim());
};
console.log('start', conhosts());
const procs = [];
for (let i = 0; i < 3; i++) {
  const p = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  p.onData(() => {});
  p.onExit(e => console.log('exit event', p.pid, e.exitCode));
  procs.push(p);
}
await sleep(2000);
console.log('3 shells running', conhosts());
for (const p of procs) { try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
await sleep(2000);
console.log('after taskkill', conhosts());
const q = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
q.onData(() => {});
await sleep(1500);
q.write('exit\r');
await sleep(2000);
console.log('after natural exit', conhosts());
process.exit(0);
