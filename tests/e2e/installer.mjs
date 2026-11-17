// 安装包测试（M4）：静默安装 → 启动装好的 Claudex → 欢迎页、发一条消息（Claude Code 程序能从安装目录启动）、
// 内置终端（node-pty 能用）、托盘图标 → 退出 → 静默卸载。用独立的数据目录，不碰用户真实的 Claudex 数据。
// 运行：npm run dist 之后 npm run test:installer
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(root, 'dist');
const work = path.join(root, 'tests', 'e2e', '.tmp', 'installer');
const out = path.join(root, 'tests', 'e2e', '.out');
const installDir = path.join(work, 'app');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* 还没准备好 */ }
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
    await sleep(300);
  }
}
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}  ${String(e?.message || e).split('\n')[0]}`);
    if (win) await win.screenshot({ path: path.join(out, `FAIL-installer-${name.split(' ')[0]}.png`) }).catch(() => {});
  }
}

const setup = fs.existsSync(dist) && fs.readdirSync(dist).find(f => /^Claudex-Setup-.*\.exe$/.test(f));
if (!setup) { console.log('没找到安装包：先运行 npm run dist'); process.exit(1); }
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const proj = path.join(work, 'hello-project');
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# hello-project\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });

let app, win;

await step('I1 静默安装', async () => {
  execFileSync(path.join(dist, setup), ['/S', `/D=${installDir}`], { stdio: 'ignore', timeout: 300000 });
  await waitFor(() => fs.existsSync(path.join(installDir, 'Claudex.exe')), 60000, '装好 Claudex.exe');
  const unpacked = path.join(installDir, 'resources', 'app.asar.unpacked', 'node_modules');
  if (!fs.existsSync(path.join(unpacked, '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'))) throw new Error('Claude Code 程序没放在 app.asar.unpacked 里');
  if (!fs.existsSync(path.join(unpacked, 'node-pty'))) throw new Error('node-pty 没放在 app.asar.unpacked 里');
});

await step('I2 启动装好的 Claudex：欢迎页', async () => {
  app = await electron.launch({
    executablePath: path.join(installDir, 'Claudex.exe'), args: [],
    env: { ...process.env, CLAUDEX_USER_DATA: path.join(work, 'userdata'), CLAUDEX_NO_NOTIFY: '1' }
  });
  win = await app.firstWindow();
  await win.waitForSelector('.welcome', { timeout: 30000 });
  if (!(await app.evaluate(({ app }) => app.isPackaged))) throw new Error('不是打包后的程序');
  await win.screenshot({ path: path.join(out, 'installer-welcome.png') });
});

await step('I3 发一条消息：Claude Code 程序从安装目录启动', async () => {
  await win.evaluate(p => window.claudex.addProject(p), proj);
  await win.reload();
  await win.waitForSelector('.app');
  await win.locator('.proj-head', { hasText: 'hello-project' }).click();
  await win.locator('[data-testid=composer-input]').fill('Reply with exactly: PACKAGED-OK');
  await win.locator('[data-testid=composer-input]').press('Enter');
  await waitFor(async () => (await win.locator('.msg.assistant').count()) > 0 && (await win.locator('[data-testid=send-button]').count()) === 1, 180000, '回复');
  const reply = await win.locator('.msg.assistant').last().innerText();
  if (!reply.includes('PACKAGED-OK')) throw new Error('回复不对：' + reply);
  await win.screenshot({ path: path.join(out, 'installer-reply.png') });
});

await step('I4 内置终端（node-pty）', async () => {
  await win.locator('[data-testid=terminal-button]').click();
  const text = async () => (await win.locator('.term-panel .xterm-rows').innerText()).replace(/ /g, ' ');
  await waitFor(async () => /PS .*hello-project>/.test(await text()), 30000, 'PowerShell 提示符');
  await win.locator('.term-host').click();
  await win.keyboard.type('echo term-ok');
  await win.keyboard.press('Enter');
  await waitFor(async () => /^term-ok/m.test(await text()), 20000, '终端输出');
});

await step('I5 托盘：关窗口缩到托盘，再打开', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitFor(async () => !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())), 5000, '藏到托盘');
  await app.evaluate(() => globalThis.claudexTray.open());
  await waitFor(async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 5000, '从托盘打开');
});

if (app) await app.close().catch(() => {});

await step('I6 静默卸载', async () => {
  const uninstaller = fs.readdirSync(installDir).find(f => /^Uninstall .*\.exe$/i.test(f));
  if (!uninstaller) throw new Error('没有卸载程序');
  execFileSync(path.join(installDir, uninstaller), ['/S'], { stdio: 'ignore', timeout: 120000 });
  await waitFor(() => !fs.existsSync(path.join(installDir, 'Claudex.exe')), 60000, '卸载掉 Claudex.exe');
});

const failed = results.filter(r => !r.ok);
console.log(`--- 安装包测试：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
