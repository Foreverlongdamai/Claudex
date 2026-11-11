// Claudex 端到端测试：真正启动 App，像人一样点界面、发消息，经中转 API 调用真实的 Claude。
// 用独立的数据目录和临时项目，不碰用户真实的 Claudex 数据。
// 运行：npm run test:e2e（会先构建）。截图在 tests/e2e/.out/。
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = path.join(root, 'tests', 'e2e', '.tmp');
const out = path.join(root, 'tests', 'e2e', '.out');
const userData = path.join(work, 'userdata');
const project = path.join(work, 'demo-project');
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;

// ---------- 准备一个临时项目：git 仓库 + 两个文件 + 一个没批准过的 MCP 服务器 ----------
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(project, 'README.md'), '# demo-project\n\nClaudex 端到端测试用的小项目。\n');
fs.writeFileSync(path.join(project, 'src', 'utils.js'), 'export function greet(name) {\n  return "hello " + name;\n}\n');
fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'e2e-untrusted': { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] } } }, null, 2));
const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
git('init', '-b', 'main');
git('add', '.');
git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-m', 'init');

// ---------- 小工具 ----------
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 120000, label = '条件') {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* 页面还没准备好 */ }
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
    await sleep(300);
  }
}
let app, win;
async function launch() {
  app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, CLAUDEX_USER_DATA: userData } });
  win = await app.firstWindow();
  await win.waitForSelector('.app, .welcome', { timeout: 30000 });
}
async function shot(name) { await win.screenshot({ path: path.join(out, `${name}.png`) }); }
async function step(name, fn) {
  if (only && !only.has(name.split(' ')[0])) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message || e) });
    console.log(`FAIL  ${name}  ${String(e?.message || e).split('\n')[0]}`);
    await shot(`FAIL-${name.split(' ')[0]}`).catch(() => {});
  }
}
const input = () => win.locator('[data-testid=composer-input]');
async function sendMsg(text) {
  await input().fill(text);
  await input().press('Enter');
}
/** 等这一轮结束：停止按钮消失、发送按钮回来 */
async function waitTurn(timeout = 180000) {
  await waitFor(async () => (await win.locator('[data-testid=stop-button]').count()) === 0 && (await win.locator('[data-testid=send-button]').count()) === 1, timeout, '这一轮结束');
}
const lastAssistant = async () => (await win.locator('.msg.assistant').last().innerText()).trim();
const fileExists = f => fs.existsSync(path.join(project, f));
async function setMode(mode) {
  await win.locator('[data-testid=mode-button]').click();
  await win.locator(`.menu [data-mode=${mode}]`).click();
}
const bash = cmd => `Use the Bash tool to run exactly this command, with no changes: ${cmd}\nDo not use any other tool. If it is blocked or denied, do not retry or try alternatives; just reply BLOCKED. Otherwise reply DONE.`;

// ---------- 测试 ----------
await launch();

await step('01 第一次启动显示欢迎页和环境检查', async () => {
  await win.waitForSelector('.welcome');
  await waitFor(async () => (await win.locator('.env-line.ok').count()) >= 2, 60000, 'Claude Code 连接和 Git Bash 检查');
  const text = await win.locator('.checks').innerText();
  if (!/Git Bash：.*bash\.exe/.test(text)) throw new Error('没显示 Git Bash 路径：' + text);
  await shot('01-welcome');
});

await step('02 添加项目时能查出项目自带的 MCP 服务器', async () => {
  const check = await win.evaluate(p => window.claudex.checkProject(p), project);
  if (check.mcpServers.length !== 1 || check.mcpServers[0].name !== 'e2e-untrusted') throw new Error(JSON.stringify(check));
  await win.evaluate(p => window.claudex.addProject(p), project);
  await win.reload();
  await win.waitForSelector('.hero');
  const hero = await win.locator('.hero-t').innerText();
  if (!hero.includes('demo-project')) throw new Error(hero);
});

await step('03 第一次发消息前先问要不要启动项目里的 MCP 服务器', async () => {
  await sendMsg('Reply with exactly the word: pong');
  await win.waitForSelector('.mcp-row', { timeout: 15000 });
  await shot('03-mcp-gate');
  await win.getByRole('button', { name: '全部不启动' }).click();
  await win.getByRole('button', { name: '确定并发送' }).click();
  const approvals = await win.evaluate(p => window.claudex.getState().then(s => s.mcpApprovals), project);
  if (!Object.values(approvals).some(a => a['e2e-untrusted'] === false)) throw new Error('没记住“不启动”：' + JSON.stringify(approvals));
});

await step('04 回复逐字显示，结束后显示在对话列表里', async () => {
  await win.waitForSelector('.msg.user');
  await waitTurn();
  const reply = await lastAssistant();
  if (!/pong/i.test(reply)) throw new Error('回复不对：' + reply);
  const title = await win.locator('[data-testid=conversation-item] .t').first().innerText();
  if (!title.includes('Reply with exactly')) throw new Error('对话标题不对：' + title);
  await waitFor(async () => /\d+%/.test(await win.locator('.ring').innerText()), 15000, '上下文用量');
  await shot('04-first-reply');
});

await step('05 默认模式：运行命令前弹审批框，允许后执行', async () => {
  await sendMsg(bash('echo e2e-ok > e2e.txt'));
  await win.waitForSelector('[data-testid=approval]', { timeout: 120000 });
  const card = await win.locator('[data-testid=approval]').innerText();
  if (!card.includes('echo e2e-ok > e2e.txt')) throw new Error('审批框里没有命令：' + card);
  await shot('05-approval');
  await win.getByRole('button', { name: '允许一次' }).click();
  await waitTurn();
  if (!fileExists('e2e.txt')) throw new Error('命令没执行');
  if (!(await win.locator('.ap-done').last().innerText()).includes('你允许了一次')) throw new Error('没显示审批结果');
  if ((await win.locator('.act-head .verb', { hasText: '已运行' }).count()) < 1) throw new Error('没有“已运行”记录');
});

await step('06 拒绝审批：命令不执行，记录标成“已拒绝”', async () => {
  await sendMsg(bash('echo nope > nope.txt'));
  await win.waitForSelector('[data-testid=approval]', { timeout: 120000 });
  await win.getByRole('button', { name: '拒绝…' }).click();
  await win.locator('.deny-box input').fill('这是测试，先别跑');
  await win.locator('.deny-box button').click();
  await waitTurn();
  if (fileExists('nope.txt')) throw new Error('拒绝了还是执行了');
  if ((await win.locator('.tag.deny').count()) < 1) throw new Error('没有“已拒绝”标记');
});

await step('07 改文件：审批框和活动记录里都有红绿对比', async () => {
  await sendMsg('Use the Edit tool to change the word "hello" to "hi" in src/utils.js. Do not use Bash. Reply DONE.');
  await win.waitForSelector('[data-testid=approval] .diff', { timeout: 120000 });
  await shot('07-edit-approval');
  await win.getByRole('button', { name: '允许一次' }).click();
  await waitTurn();
  const content = fs.readFileSync(path.join(project, 'src', 'utils.js'), 'utf8');
  if (!content.includes('"hi "')) throw new Error('文件没改：' + content);
  await waitFor(async () => (await win.locator('.act .diff .dl.add').count()) > 0 && (await win.locator('.act .diff .dl.del').count()) > 0, 10000, '活动记录里的红绿对比');
  await shot('07-edit-diff');
});

await step('08 切到“自动接受编辑”：写文件不再问', async () => {
  await setMode('acceptEdits');
  await waitFor(async () => (await win.locator('[data-testid=mode-button]').innerText()).includes('自动接受编辑'), 5000, '模式按钮');
  const before = await win.locator('[data-testid=approval]').count();
  await sendMsg('Use the Write tool to create notes.md containing exactly: # notes\nDo not use Bash. Reply DONE.');
  await waitTurn();
  if (!fileExists('notes.md')) throw new Error('文件没写');
  if ((await win.locator('[data-testid=approval]').count()) !== before) throw new Error('还弹了审批框');
});

await step('09 切到完全访问：先确认，界面变红，命令直接执行', async () => {
  await setMode('bypassPermissions');
  await win.waitForSelector('[data-testid=confirm-bypass]');
  await shot('09-bypass-confirm');
  await win.locator('[data-testid=confirm-bypass]').click();
  await win.waitForSelector('.mode-pill.bypass');
  await sendMsg(bash('echo bypass-ok > bypass.txt'));
  await waitTurn();
  if (!fileExists('bypass.txt')) throw new Error('命令没执行');
  await shot('09-bypass');
});

await step('10 完全访问下保底黑名单仍然拦截', async () => {
  // 加一条测试规则，免得真的去跑危险命令
  await win.evaluate(() => window.claudex.getState().then(s => window.claudex.setPrefs({
    blacklist: [...s.prefs.blacklist, { id: 'e2e', label: 'E2E 测试规则', tools: ['Bash', 'PowerShell'], pattern: 'E2E_BLOCK_MARKER', enabled: true }]
  })));
  await sendMsg(bash('echo E2E_BLOCK_MARKER > blocked.txt'));
  await waitTurn();
  if (fileExists('blocked.txt')) throw new Error('黑名单命令执行了');
  const notice = await win.locator('.notice.blocked').last().innerText();
  if (!notice.includes('E2E 测试规则')) throw new Error('没有拦截提示：' + notice);
  await shot('10-blocked');
});

await step('11 停止：生成到一半点停止', async () => {
  await setMode('default');
  await sendMsg('Write the numbers from 1 to 400, one per line, as plain text. No tools.');
  await waitFor(async () => (await win.locator('.msg.assistant .caret').count()) > 0, 120000, '开始逐字输出');
  await sleep(1500);
  await win.locator('[data-testid=stop-button]').click();
  await waitTurn(30000);
  const text = await lastAssistant();
  if (/\b400\b/.test(text)) throw new Error('没停下来，写完了');
});

await step('12 计划模式：计划卡片，批准后切回默认模式', async () => {
  await setMode('plan');
  await sendMsg('Plan how to add a function answer() that returns 42 to src/utils.js. Keep the plan to 3 short steps, then present it with ExitPlanMode. Do not edit anything yet.');
  await win.waitForSelector('.plan-card', { timeout: 180000 });
  await shot('12-plan');
  await win.getByRole('button', { name: '批准，开始执行' }).click();
  await waitFor(async () => (await win.locator('[data-testid=mode-button]').innerText()).includes('默认'), 15000, '切回默认模式');
  // 批准后 Claude 会开始改文件，在默认模式下要审批；这里直接拒绝，结束这一轮
  await waitFor(async () => (await win.locator('[data-testid=approval]').count()) > 0 || (await win.locator('[data-testid=stop-button]').count()) === 0, 180000, '下一步');
  if (await win.locator('[data-testid=approval]').count()) {
    await win.getByRole('button', { name: '拒绝…' }).click();
    await win.locator('.deny-box button').click();
  }
  await waitTurn();
});

await step('13 Claude 提问：选项卡片，回答后 Claude 能收到', async () => {
  await sendMsg('Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with just my answer.');
  await win.waitForSelector('.question-card', { timeout: 180000 });
  await shot('13-question');
  await win.locator('.q-opt', { hasText: 'Blue' }).click();
  await win.getByRole('button', { name: '提交回答' }).click();
  await waitTurn();
  const reply = await lastAssistant();
  if (!/blue/i.test(reply)) throw new Error('Claude 没收到回答：' + reply);
});

await step('14 模型选择器：列出模型，切换后按钮更新', async () => {
  await win.locator('[data-testid=model-button]').click();
  await win.waitForSelector('.pop .opt');
  const names = await win.locator('.pop .opt .opt-main').allInnerTexts();
  if (names.length < 3) throw new Error('模型太少：' + names.join(','));
  const fast = win.locator('.pop .seg button', { hasText: '快速' });
  if (!(await fast.isDisabled())) throw new Error('走中转时快速模式应该是灰的');
  await shot('14-model-picker');
  await win.locator('.pop .opt', { hasText: 'Sonnet' }).click();
  await win.locator('.pop .seg button', { hasText: '中' }).click();
  // 点对话区关掉菜单（别点左栏，会切到别的项目）
  await win.locator('.thread').click({ position: { x: 20, y: 20 } });
  const label = await win.locator('[data-testid=model-button]').innerText();
  if (!/Sonnet.*中/.test(label)) throw new Error('按钮没更新：' + label);
  await sendMsg('Reply with exactly: switched');
  await waitTurn();
  if (!/switched/i.test(await lastAssistant())) throw new Error('切换模型后回复不对');
});

await step('15 重启后对话还在，打开能看到历史并接着聊', async () => {
  await app.close();
  await launch();
  await win.waitForSelector('[data-testid=conversation-item]');
  await win.locator('[data-testid=conversation-item]').first().click();
  await waitFor(async () => (await win.locator('.msg.user').count()) >= 5, 20000, '历史消息');
  await shot('15-history');
  await sendMsg('Earlier in this conversation you created a file whose name starts with "e2e". What is its exact file name? Reply with just the file name.');
  await waitTurn();
  const reply = await lastAssistant();
  if (!reply.includes('e2e.txt')) throw new Error('续接后不记得：' + reply);
});

await step('16 浅色主题', async () => {
  await win.locator('.side-foot .ibtn').click();
  await waitFor(async () => (await win.evaluate(() => document.documentElement.dataset.theme)) === 'light', 5000, '切到浅色');
  await shot('16-light');
  await win.locator('.side-foot .ibtn').click();
});

await app.close();
const failed = results.filter(r => !r.ok);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`--- 端到端测试：${results.length - failed.length}/${results.length} 通过，截图在 tests/e2e/.out/`);
process.exit(failed.length ? 1 : 0);
