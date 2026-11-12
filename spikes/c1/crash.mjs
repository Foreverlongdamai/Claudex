// 两个终端同时退出时的段错误：是我们的释放代码引起的，还是 node-pty 本身的问题
// 用法：node crash.mjs <release: none|insocket|worker|both> <together 0|1> <dll 0|1>
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join('D:/claude_code_lm', 'package.json'));
const pty = require('node-pty');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [mode = 'both', together = '1', dll = '0'] = process.argv.slice(2);
const release = p => {
  if (mode === 'insocket' || mode === 'both') try { p._agent._inSocket.destroy(); } catch {}
  if (mode === 'worker' || mode === 'both') try { p._agent._conoutSocketWorker.dispose(); } catch {}
};
const spawn = () => {
  const p = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: 'D:/claude_code_lm', env: process.env, useConptyDll: dll === '1' });
  p.onData(() => {});
  p.onExit(() => release(p));
  return p;
};
const ps = [spawn(), spawn(), spawn()];
await sleep(3000);
if (together === '1') for (const p of ps) p.write('exit\r');
else for (const p of ps) { p.write('exit\r'); await sleep(1500); }
await sleep(4000);
console.log(`release=${mode} together=${together} dll=${dll}: survived`);
process.exit(0);
