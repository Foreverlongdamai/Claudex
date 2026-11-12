// Git Bash 里直接运行原生程序（不经过 winpty）、msys 程序、.cmd 脚本再起的程序时，taskkill /T 能不能结束它们
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(path.join('D:/claude_code_lm', 'package.json'));
const pty = require('node-pty');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-'));
const CR = String.fromCharCode(13);
const NODE_CHILD = name => `node.exe -e "require('fs').writeFileSync('${name}.pid', String(process.pid)); setInterval(()=>{},1000)"`;
fs.writeFileSync(path.join(dir, 'c.cmd'), '@' + NODE_CHILD('c') + CR + '\n');
const p = pty.spawn('D:/git/Git/bin/bash.exe', ['--login', '-i'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: dir, env: { ...process.env, CHERE_INVOKING: '1' } });
p.onData(() => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
p.write(NODE_CHILD('a') + ' &' + CR);
p.write('sleep 1000 & cat /proc/$!/winpid > s.pid' + CR);
p.write('cmd.exe //c c.cmd &' + CR);
const ready = f => fs.existsSync(path.join(dir, f)) && fs.readFileSync(path.join(dir, f), 'utf8').trim();
for (let i = 0; i < 75 && !['a.pid', 's.pid', 'c.pid'].every(ready); i++) await sleep(200);
const pids = Object.fromEntries(['a', 's', 'c'].filter(k => ready(k + '.pid')).map(k => [k, Number(fs.readFileSync(path.join(dir, k + '.pid'), 'utf8').trim())]));
console.log('pty pid', p.pid, pids);
const procs = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 1 << 26 }));
const by = new Map(procs.map(x => [x.ProcessId, x]));
for (const [k, pid] of Object.entries(pids)) {
  let cur = by.get(pid); const chain = [];
  while (cur && chain.length < 8) { chain.push(`${cur.Name}(${cur.ProcessId})`); cur = by.get(cur.ParentProcessId); }
  console.log(k, 'ancestors:', chain.join(' <- '));
}
try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'pipe' }); } catch (e) { console.log('taskkill err', String(e.stderr)); }
await sleep(1000);
for (const [k, pid] of Object.entries(pids)) {
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  console.log(k, 'alive after taskkill /T:', alive);
  if (alive) try { process.kill(pid); } catch {}
}
process.exit(0);
