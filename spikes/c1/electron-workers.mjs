// 在 Electron 主进程里反复“自然退出 → 重启”，每一步打印活动资源（MessagePort 数代表 worker 数）
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
const root = 'D:/claude_code_lm';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, CLAUDEX_USER_DATA: path.join(root, 'tests/e2e/.tmp/userdata-probe') } });
const win = await app.firstWindow();
await win.waitForSelector('.app, .welcome', { timeout: 30000 });
const res = async () => {
  const list = await app.evaluate(() => process.getActiveResourcesInfo());
  const count = {};
  for (const r of list) count[r] = (count[r] ?? 0) + 1;
  return JSON.stringify(count);
};
const shell = process.argv[2] || 'gitbash';
console.log('start      ', await res());
let ti = await win.evaluate(([p, s]) => window.claudex.termOpen('probe', p, s, { cols: 100, rows: 20 }), [root, shell]);
await sleep(3000);
console.log('open       ', await res());
for (let i = 0; i < 4; i++) {
  await win.evaluate(id => window.claudex.termWrite(id, 'exit\r'), ti.id);
  await sleep(4000);
  console.log(`exit ${i}     `, await res());
  ti = await win.evaluate(([id, s]) => window.claudex.termRestart(id, s, { cols: 100, rows: 20 }), [ti.id, shell]);
  await sleep(3000);
  console.log(`restart ${i}  `, await res());
}
await app.close();
