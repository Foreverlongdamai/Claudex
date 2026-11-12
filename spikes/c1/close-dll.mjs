// 用 node-pty 自带的新版 ConPTY（useConptyDll）时，各种结束方式会不会留下 OpenConsole/conhost
// 用法：node close-dll.mjs <gitbash|powershell> <variant> <dll 0|1>
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const require = createRequire(path.join('D:/claude_code_lm', 'package.json'));
const pty = require('node-pty');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [shell = 'gitbash', variant = 'natural-exit', dllArg = '1'] = process.argv.slice(2);
const useConptyDll = dllArg === '1';
const hosts = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Select-Object ProcessId,Name)`], { encoding: 'utf8' }) || '[]').filter(p => /conhost|OpenConsole/i.test(p.Name)).length;
const file = shell === 'gitbash' ? 'D:/git/Git/bin/bash.exe' : 'powershell.exe';
const args = shell === 'gitbash' ? ['--login', '-i'] : ['-NoLogo'];
const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: 'D:/claude_code_lm', env: { ...process.env, CHERE_INVOKING: '1' }, useConptyDll });
let out = '';
p.onData(d => { out += d; });
let exited = false;
p.onExit(() => { exited = true; });
await sleep(3000);
const before = hosts();
const taskkill = () => { try { execFileSync('taskkill', ['/F', '/T', '/pid', String(p.pid)], { stdio: 'ignore' }); } catch {} };
switch (variant) {
  case 'natural-exit': p.write('exit\r'); break;
  case 'taskkill-only': taskkill(); break;
  case 'taskkill-then-kill': taskkill(); p.kill(); break;
  case 'kill-only': p.kill(); break;
}
for (let i = 0; i < 30 && !exited; i++) await sleep(100);
let after = hosts();
for (let i = 0; i < 10 && after >= before; i++) { await sleep(500); after = hosts(); }
const echoed = /\$ |PS /.test(out);
console.log(`dll=${useConptyDll ? 1 : 0} ${shell.padEnd(10)} ${variant.padEnd(20)} host ${before} -> ${after}  exitEvent=${exited} promptSeen=${echoed}`);
process.exit(0);
