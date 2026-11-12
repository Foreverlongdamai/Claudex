// 预输入（上一条命令还没跑完就接着打字）在两种 ConPTY 下会不会乱序
// 用法：node typeahead.mjs <dll 0|1> [次数]
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join('D:/claude_code_lm', 'package.json'));
const pty = require('node-pty');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const useConptyDll = process.argv[2] === '1';
const rounds = Number(process.argv[3] || 10);
const p = pty.spawn('D:/git/Git/bin/bash.exe', ['--login', '-i'], { name: 'xterm-256color', cols: 200, rows: 30, cwd: 'D:/claude_code_lm', env: { ...process.env, CHERE_INVOKING: '1' }, useConptyDll });
let out = '';
p.onData(d => {
  out += d;
  // 像 xterm 一样回答 ConPTY 的查询
  if (d.includes('\x1b[c')) p.write('\x1b[?1;2c');
});
await sleep(3000);
let bad = 0;
for (let i = 0; i < rounds; i++) {
  const marker = `typeahead-${i}-abcdefghijklmnopqrstuvwxyz`;
  out = '';
  p.write('sleep 0.2\r');
  await sleep(20);
  // 模拟 Playwright 逐字输入：每个字符单独写
  for (const ch of `echo "${marker}", 'x,y' {},1000\r`) { p.write(ch); await sleep(2); }
  await sleep(1500);
  const ok = out.includes(`${marker}, x,y {},1000`);
  if (!ok) { bad++; console.log(`round ${i} garbled:`, JSON.stringify(out.split('\n').filter(l => /typeahead|not found/.test(l)).join(' | ')).slice(0, 300)); }
}
console.log(`dll=${useConptyDll ? 1 : 0}: ${bad}/${rounds} garbled`);
p.kill();
process.exit(0);
