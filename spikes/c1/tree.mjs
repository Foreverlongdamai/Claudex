// 看看 node-pty 开的 shell 里再启动一个程序时，Windows 进程树是什么样的
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(path.join('D:/claude_code_lm', 'package.json'));
const pty = require('node-pty');
const shell = process.argv[2] || 'gitbash';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-'));
const file = shell === 'gitbash' ? 'D:/git/Git/bin/bash.exe' : 'powershell.exe';
const args = shell === 'gitbash' ? ['--login', '-i'] : ['-NoLogo'];
const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: dir, env: { ...process.env, CHERE_INVOKING: '1' } });
p.onData(() => {});
console.log('pty pid', p.pid);
await new Promise(r => setTimeout(r, 2500));
p.write(`node -e "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(()=>{},1000)"\r`);
const pidFile = path.join(dir, 'child.pid');
for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 200));
const child = Number(fs.readFileSync(pidFile, 'utf8'));
console.log('child pid', child);
const procs = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 1 << 26 }));
const by = new Map(procs.map(x => [x.ProcessId, x]));
let cur = by.get(child);
const chain = [];
while (cur && chain.length < 12) { chain.push(`${cur.Name}(${cur.ProcessId})`); cur = by.get(cur.ParentProcessId); }
console.log('ancestors:', chain.join(' <- '));
const kids = id => procs.filter(x => x.ParentProcessId === id);
const dump = (id, d = 0) => { for (const k of kids(id)) { console.log('  '.repeat(d + 1) + `${k.Name}(${k.ProcessId})`); dump(k.ProcessId, d + 1); } };
console.log('descendants of pty pid:'); dump(p.pid);
try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'pipe' }); } catch (e) { console.log('taskkill err', String(e.stderr)); }
await new Promise(r => setTimeout(r, 1000));
let alive = true; try { process.kill(child, 0); } catch { alive = false; }
console.log('child alive after taskkill /T:', alive);
if (alive) process.kill(child);
process.exit(0);
