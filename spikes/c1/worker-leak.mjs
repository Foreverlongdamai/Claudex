// useConptyDll 时，终端结束后 node-pty 读输出的 worker 线程会不会留下（留下的话 node 不会自己退出）
// 用法：node worker-leak.mjs <natural-exit|taskkill>
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const require = createRequire(path.join('D:/claude_code_lm', 'package.json'));
const pty = require('node-pty');
const how = process.argv[2] || 'natural-exit';
const p = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: 'D:/claude_code_lm', env: process.env, useConptyDll: true });
p.onData(() => {});
const t0 = Date.now();
p.onExit(e => console.log(`exit event after ${Date.now() - t0}ms code=${e.exitCode}`));
setTimeout(() => {
  if (how === 'natural-exit') p.write('exit\r');
  else try { execFileSync('taskkill', ['/F', '/T', '/pid', String(p.pid)], { stdio: 'ignore' }); } catch {}
}, 2500);
process.on('exit', () => console.log(`node exited by itself after ${Date.now() - t0}ms`));
// 兜底：20 秒还没退出就说明有东西挂着
setTimeout(() => { console.log('STILL ALIVE after 20s:', process.getActiveResourcesInfo().join(',')); process.exit(1); }, 20000).unref();
