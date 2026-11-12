// MessagePort 数量能不能代表 node-pty 的 worker 数：开一个、自然退出并释放、再开一个，看每一步的数量
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join('D:/claude_code_lm', 'package.json'));
const pty = require('node-pty');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ports = () => process.getActiveResourcesInfo().filter(r => r === 'MessagePort').length;
const release = p => { try { p._agent._inSocket.destroy(); } catch {} try { p._agent._conoutSocketWorker.dispose(); } catch {} };
const spawn = () => { const p = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: 'D:/claude_code_lm', env: process.env }); p.onData(() => {}); p.onExit(() => release(p)); return p; };
console.log('start', ports());
const a = spawn(); await sleep(2500); console.log('A running', ports());
a.write('exit\r'); await sleep(3500); console.log('A exited + released', ports());
const b = spawn(); await sleep(500); console.log('B 0.5s', ports()); await sleep(2500); console.log('B 3s', ports());
const c = spawn(); await sleep(3000); console.log('C 3s (B still running)', ports());
b.write('exit\r'); c.write('exit\r'); await sleep(3500); console.log('B, C exited + released', ports());
process.exit(0);
