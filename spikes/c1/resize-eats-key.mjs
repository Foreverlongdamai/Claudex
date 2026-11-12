// 假设：shell 已经在等输入时改终端大小，Git Bash 会吃掉下一个按键
// 用法：node resize-eats-key.mjs <gitbash|powershell> <resize 0|1> [次数]
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join('D:/claude_code_lm', 'package.json'));
const pty = require('node-pty');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [shell = 'gitbash', resize = '1', n = '10'] = process.argv.slice(2);
const file = shell === 'gitbash' ? 'D:/git/Git/bin/bash.exe' : 'powershell.exe';
const args = shell === 'gitbash' ? ['--login', '-i'] : ['-NoLogo'];
const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: 'D:/claude_code_lm', env: { ...process.env, CHERE_INVOKING: '1' } });
let out = '';
p.onData(d => { out += d; });
await sleep(3000);
let bad = 0;
for (let i = 0; i < Number(n); i++) {
  if (resize === '1') { p.resize(i % 2 ? 120 : 152, i % 2 ? 30 : 12); await sleep(400); }
  out = '';
  for (const ch of `echo hello-${i}\r`) { p.write(ch); await sleep(2); }
  await sleep(800);
  if (/not found|not recognized|CommandNotFound/.test(out)) { bad++; console.log(`round ${i}:`, JSON.stringify(out.slice(0, 120))); }
}
console.log(`${shell} resize=${resize}: ${bad}/${n} lost`);
process.exit(0);
