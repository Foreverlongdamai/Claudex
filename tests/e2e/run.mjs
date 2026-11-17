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
git('config', 'user.name', 'e2e');
git('config', 'user.email', 'e2e@example.invalid');
git('config', 'core.autocrlf', 'false');
git('add', '.');
git('commit', '-m', 'init');
// 改动面板（C2）的推送用：本地的空仓库当远程
const remoteRepo = path.join(work, 'remote.git');
execFileSync('git', ['init', '-q', '--bare', remoteRepo], { stdio: 'ignore' });
git('remote', 'add', 'origin', remoteRepo);
git('push', '-q', '-u', 'origin', 'main');
// 开 PR 用假的 gh（记下参数，返回假的 PR 地址）；撤销的新文件移到这里，不进系统回收站
const ghLog = path.join(work, 'gh.log');
const trashDir = path.join(work, 'trash');

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
  app = await electron.launch({
    args: ['.'], cwd: root,
    env: {
      ...process.env, CLAUDEX_USER_DATA: userData,
      CLAUDEX_GH: path.join(root, 'tests', 'unit', 'fake-gh.mjs'), CLAUDEX_GH_LOG: ghLog, CLAUDEX_TRASH_DIR: trashDir,
      // 自动化：每 2 秒检查一次到点没有；不弹系统通知
      CLAUDEX_AUTOMATION_TICK_MS: '2000', CLAUDEX_NO_NOTIFY: '1'
    }
  });
  win = await app.firstWindow();
  // 界面切换对话的记录（排查“界面自己跳到别的对话”用）
  win.on('console', m => { if (m.text().includes('[claudex-nav]')) fs.appendFileSync(path.join(out, 'renderer-nav.log'), `${new Date().toISOString()} ${m.text()}\n`); });
  await win.waitForSelector('.app, .welcome', { timeout: 30000 });
}
async function shot(name) { await win.screenshot({ path: path.join(out, `${name}.png`) }); }
async function step(name, fn) {
  if (only && !only.has(name.split(' ')[0])) return;
  fs.appendFileSync(path.join(out, 'renderer-nav.log'), `${new Date().toISOString()} --- ${name}\n`);
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

// ---------- 内置终端（C1） ----------
const termText = async () => (await win.locator('.term-panel .xterm-rows').innerText()).replace(/ /g, ' ');
const termOpen = async () => !(await win.locator('.term-panel').evaluate(el => el.hidden));
async function termRun(cmd) {
  // 像人一样等 shell 回到提示符再打字
  await waitFor(async () => /[$>]$/.test((await termText()).trimEnd()), 20000, `输入 ${cmd} 之前等提示符`);
  await win.locator('.term-host').click();
  await win.keyboard.type(cmd);
  await win.keyboard.press('Enter');
}
const waitTerm = (re, label, timeout = 20000) => waitFor(async () => re.test(await termText()), timeout, label);
const PROMPT = /(\$|>)\s*$/m;
/** 如果第一次发消息时弹出 MCP 批准，选“全部不启动” */
async function passMcpGate() {
  await waitFor(async () => (await win.locator('.mcp-row').count()) > 0 || (await win.locator('.msg.user').count()) > 0, 15000, '发出消息');
  if (await win.locator('.mcp-row').count()) {
    await win.getByRole('button', { name: '全部不启动' }).click();
    await win.getByRole('button', { name: '确定并发送' }).click();
  }
}

await step('17 终端：顶栏按钮打开，默认 PowerShell，就在项目目录', async () => {
  await win.locator('[data-testid=terminal-button]').click();
  await waitFor(termOpen, 5000, '终端面板打开');
  if ((await win.locator('[data-testid=terminal-shell]').inputValue()) !== 'powershell') throw new Error('默认不是 PowerShell');
  await waitTerm(/PS .*demo-project>/, 'PowerShell 提示符（在项目目录）');
  await termRun('git status -sb'); // 短格式：前面的步骤改过文件时，长格式的第一行会滚出可见区域
  await waitTerm(/^## main/m, 'git status 输出');
  await termRun('node --version');
  await waitTerm(/^v\d+\.\d+\.\d+/m, 'node 版本');
  await shot('17-terminal');
});

await step('18 Ctrl+` 收起再打开，终端内容还在', async () => {
  await win.locator('.term-host').click();
  await win.keyboard.press('Control+Backquote');
  await waitFor(async () => !(await termOpen()), 5000, '收起');
  await win.keyboard.press('Control+Backquote');
  await waitFor(termOpen, 5000, '再打开');
  if (!/^## main/m.test(await termText())) throw new Error('内容没了');
});

await step('19 切到 Git Bash：重新启动，还在项目目录，设置记住了', async () => {
  await win.locator('[data-testid=terminal-shell]').selectOption('gitbash');
  await waitFor(async () => !/^## main/m.test(await termText()), 10000, '终端重启');
  await waitTerm(/\$\s*$/m, 'bash 提示符');
  await termRun('echo "bash=$BASH_VERSION"; pwd');
  await waitTerm(/bash=\d+\.\d+/, 'BASH_VERSION');
  if (!/\/demo-project\s*$/m.test(await termText())) throw new Error('工作目录不对：' + await termText());
  const shell = await win.evaluate(() => window.claudex.getState().then(s => s.prefs.terminalShell));
  if (shell !== 'gitbash') throw new Error('没记住：' + shell);
  await shot('19-gitbash');
});

await step('20 输入 exit 后提示已退出，按任意键重新启动', async () => {
  await termRun('exit');
  await waitTerm(/进程已退出/, '退出提示');
  await win.keyboard.press('a');
  await waitFor(async () => !/进程已退出/.test(await termText()), 10000, '重新启动');
  await waitTerm(/\$\s*$/m, '新的提示符');
});

await step('21 每个对话有自己的终端，切换时显示各自的输出', async () => {
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push(await win.evaluate(p => window.claudex.newConversation(p).then(m => m.id), project));
  await win.reload(); // 顺带验证：界面刷新后终端进程还在、输出能重放
  await win.waitForSelector('.app');
  const item = id => win.locator(`[data-testid=conversation-item][data-id="${id}"]`);
  await item(ids[0]).click();
  await win.locator('[data-testid=terminal-button]').click();
  await waitTerm(PROMPT, '对话 A 的提示符');
  await termRun('echo marker-AAA');
  await waitTerm(/^marker-AAA/m, 'A 的输出');
  await item(ids[1]).click();
  await waitFor(async () => !/marker-AAA/.test(await termText()), 10000, '切到 B 的终端');
  await waitTerm(PROMPT, '对话 B 的提示符');
  await termRun('echo marker-BBB');
  await waitTerm(/^marker-BBB/m, 'B 的输出');
  await item(ids[0]).click();
  await waitTerm(/^marker-AAA/m, '切回 A，A 的输出还在');
  if (/marker-BBB/.test(await termText())) throw new Error('A 的终端里出现了 B 的输出');
  await shot('21-terminal-per-conversation');
});

await step('22 新对话里先开终端，发第一条消息后终端还是同一个', async () => {
  await win.locator('.thread').click({ position: { x: 20, y: 20 } });
  await win.keyboard.press('Control+n');
  await waitFor(async () => !/marker-AAA/.test(await termText()), 10000, '切到新对话的终端');
  await waitTerm(PROMPT, '提示符');
  await termRun('echo marker-DRAFT');
  await waitTerm(/^marker-DRAFT/m, '草稿终端输出');
  await sendMsg('Reply with exactly the word: ok');
  await passMcpGate();
  await waitTurn();
  if (!/^marker-DRAFT/m.test(await termText())) throw new Error('对话建好后终端变成了新的');
  const conv = await win.evaluate(() => window.claudex.getState().then(s => s.conversations.sort((a, b) => b.createdAt - a.createdAt)[0]));
  const ti = await win.evaluate(([id, p]) => window.claudex.termOpen(id, p, 'powershell'), [conv.id, project]);
  if (!ti.buffer.includes('marker-DRAFT')) throw new Error('主进程里终端没转给新对话');
});

await step('23 结束终端：里面跑的程序也一起结束，再打开是新的终端', async () => {
  // Git Bash 是难点：node 默认经 winpty 启动、sleep 是 msys 程序，两者在 Windows 进程树里都和 shell 断开
  if ((await win.locator('[data-testid=terminal-shell]').inputValue()) !== 'gitbash') throw new Error('这一步要在 Git Bash 里测');
  const pidOf = f => { const p = path.join(project, f); return fs.existsSync(p) && Number(fs.readFileSync(p, 'utf8').trim()); };
  await termRun('sleep 1000 & cat /proc/$!/winpid > sleep.pid');
  await termRun(`node -e "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(()=>{},1000)"`);
  await waitFor(async () => pidOf('child.pid') && pidOf('sleep.pid'), 15000, '子进程启动');
  const pids = [pidOf('child.pid'), pidOf('sleep.pid')];
  await win.locator('[data-testid=terminal-kill]').click();
  await waitFor(async () => !(await termOpen()), 5000, '面板收起');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await waitFor(async () => !pids.some(alive), 10000, `子进程被结束（还活着：${pids.filter(alive).join(',')}）`);
  await win.locator('[data-testid=terminal-button]').click();
  await waitTerm(PROMPT, '新终端的提示符');
  if (/marker-DRAFT/.test(await termText())) throw new Error('还是原来的终端');
});

await step('24 重启、结束、自己退出的终端都不留下控制台进程和 worker 线程', async () => {
  // 每个终端有一个 ConPTY 的控制台进程（OpenConsole.exe，父进程是 Claudex 主进程）和一个读输出的 worker 线程，
  // 终端没了它们也要跟着没。node-pty 1.1.0 默认模式下两样都会漏（C1 实测）
  const mainPid = await app.evaluate(() => process.pid); // app.process() 是 Playwright 套的一层 cmd.exe
  const hosts = () => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${mainPid}" | Where-Object { $_.Name -match 'conhost|OpenConsole' }).Count`], { encoding: 'utf8' }).trim());
  const workers = () => app.evaluate(() => process.getActiveResourcesInfo().filter(r => r === 'MessagePort').length);
  // 控制台进程数要精确相等；worker 用 MessagePort 数来数，Claude 会话自己也会开关 MessagePort，
  // 所以只要求“不多于”（泄漏只会让它变多）。单独测终端时精确相等，见 spikes/c1/electron-workers.mjs
  const expect = async (dh, dw, label) => {
    let h, w;
    try {
      await waitFor(async () => (h = hosts()) === h0 + dh & (w = await workers()) <= w0 + dw, 10000, label);
    } catch (e) {
      throw new Error(`${e.message}（控制台进程 ${h0}→${h}，应为 ${h0 + dh}；worker ${w0}→${w}，应不多于 ${w0 + dw}）`);
    }
  };
  const h0 = hosts(), w0 = await workers();
  if (h0 < 1 || w0 < 1) throw new Error(`没找到终端的控制台进程或 worker（${h0}, ${w0}），测试方法不对`);
  for (let i = 0; i < 3; i++) {
    await win.locator('.term-head [title="重新启动终端"]').click();
    await waitTerm(PROMPT, `第 ${i + 1} 次重启后的提示符`);
  }
  await expect(0, 0, '重启 3 次后数量不变');
  await termRun('exit');
  await waitTerm(/进程已退出/, '退出提示');
  await expect(-1, -1, '自己退出后各少一个');
  await win.keyboard.press('a');
  await waitTerm(PROMPT, '重新启动');
  await expect(0, 0, '重新启动后各回来一个');
  await win.locator('[data-testid=terminal-kill]').click();
  await expect(-1, -1, '结束终端后各少一个');
});

await step('25 终端里 Ctrl+V 粘贴、Ctrl+C 中断正在运行的命令', async () => {
  if (!(await termOpen())) await win.locator('[data-testid=terminal-button]').click();
  await waitTerm(PROMPT, '提示符');
  await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted-$((40+2))'));
  await win.locator('.term-host').click();
  await win.keyboard.press('Control+v');
  await win.keyboard.press('Enter');
  await waitTerm(/^pasted-42/m, '粘贴的命令执行了');
  await termRun('sleep 100');
  await sleep(800);
  await win.keyboard.press('Control+c');
  await termRun('echo after-interrupt');
  await waitTerm(/^after-interrupt/m, 'Ctrl+C 中断了 sleep，后面的命令能执行', 10000);
});

// ---------- 附件：拖进来的文件（Word、PDF、老格式 PPT、录音） ----------
// 文件放在项目目录外、路径里有空格和中文：检验原地引用、读项目外的附件不弹审批、全局规则和 Skills 生效
const attachDir = path.join(work, '附件 资料');
fs.mkdirSync(attachDir, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'tests', 'e2e', 'fixtures'))) {
  if (!f.endsWith('.ps1')) fs.copyFileSync(path.join(root, 'tests', 'e2e', 'fixtures', f), path.join(attachDir, f));
}
const attach = name => path.join(attachDir, name);
const chips = () => win.locator('.composer [data-testid=file-chip]');

await step('26 附件：Word、PDF、老格式 PPT、录音交给 Claude，内容读对、不弹审批', async () => {
  if (await termOpen()) await win.locator('[data-testid=terminal-button]').click();
  await win.locator('.thread').click({ position: { x: 20, y: 20 } });
  await win.keyboard.press('Control+n');
  await win.locator('[data-testid=attach-input]').setInputFiles([attach('周报.docx'), attach('周报.pdf'), attach('汇报.ppt'), attach('录音.wav')]);
  await waitFor(async () => (await chips().count()) === 4, 5000, '4 个附件小卡片');
  const chipText = (await chips().allInnerTexts()).join(' | ');
  if (!/周报\.docx/.test(chipText) || !/录音\.wav/.test(chipText)) throw new Error('小卡片内容不对：' + chipText);
  await shot('26-attachments');
  await sendMsg('逐个读这些附件。每个文件回答一行：文件名 + 里面形如“青松-DOCX-7731”的标记词（没有就写“无”）。最后一行写出录音里说的暗号。');
  await passMcpGate();
  await waitTurn(300000);
  // 整轮都不能弹过审批：还挂着的（approval）和已经处理掉的（ap-done）都算
  const asked = [...await win.locator('[data-testid=approval] .ap-title').allInnerTexts(), ...await win.locator('.ap-done').allInnerTexts()];
  if (asked.length) throw new Error('弹过审批：' + asked.join(' | '));
  if (!(await win.locator('[data-testid=mode-button]').innerText()).includes('默认')) throw new Error('模式变了：' + await win.locator('[data-testid=mode-button]').innerText());
  const reply = await lastAssistant();
  for (const mark of ['青松-DOCX-7731', '白鹭-PPTX-4410', '长江']) if (!reply.includes(mark)) throw new Error(`回复里没有 ${mark}：` + reply);
  const bubble = win.locator('.msg.user').last();
  if ((await bubble.locator('[data-testid=file-chip]').count()) !== 4) throw new Error('消息气泡里应该是 4 个附件小卡片');
  if ((await bubble.innerText()).includes('claudex-attachments')) throw new Error('气泡里露出了附件块原文');
  if (await chips().count()) throw new Error('发送后输入框里的附件没清空');
  await shot('26-attachments-reply');
});

await step('27 拖放：拖到对话区出现提示、松开成为附件；拖到终端粘贴路径；网页上的“文件”提示拿不到路径', async () => {
  // 用一个隐藏的文件框拿到“硬盘上的文件”，再拼成拖放数据（和从资源管理器拖进来一样，带真实路径）
  await win.evaluate(() => {
    const i = Object.assign(document.createElement('input'), { type: 'file', multiple: true, id: 'e2e-drop-src', hidden: true });
    document.body.appendChild(i);
  });
  await win.locator('#e2e-drop-src').setInputFiles([attach('周报.docx'), attach('录音.wav')]);
  const dragData = () => win.evaluateHandle(() => {
    const dt = new DataTransfer();
    for (const f of document.querySelector('#e2e-drop-src').files) dt.items.add(f);
    return dt;
  });
  let dt = await dragData();
  await win.dispatchEvent('.thread', 'dragenter', { dataTransfer: dt });
  await win.dispatchEvent('.thread', 'dragover', { dataTransfer: dt });
  await win.waitForSelector('[data-testid=drop-overlay]', { timeout: 3000 });
  if (!(await win.locator('[data-testid=drop-overlay]').innerText()).includes('附件')) throw new Error('拖放提示不对');
  await shot('27-drop-overlay');
  await win.dispatchEvent('.thread', 'drop', { dataTransfer: dt });
  await waitFor(async () => (await chips().count()) === 2, 5000, '拖进来的 2 个附件');
  if (await win.locator('[data-testid=drop-overlay]').count()) throw new Error('松开后提示没消失');
  // 再拖一次同样的文件：不重复添加
  dt = await dragData();
  await win.dispatchEvent('.thread', 'drop', { dataTransfer: dt });
  await sleep(300);
  if ((await chips().count()) !== 2) throw new Error('重复拖入的文件被加了两次');
  // 点 × 移除
  await chips().first().locator('button').click();
  await waitFor(async () => (await chips().count()) === 1, 3000, '移除一个附件');
  // 不在硬盘上的“文件”（比如网页里拖来的）：拿不到路径，给出提示
  const fake = await win.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['x'], '网页.txt', { type: 'text/plain' })); return d; });
  await win.dispatchEvent('.thread', 'drop', { dataTransfer: fake });
  await waitFor(async () => (await win.locator('.toast').allInnerTexts()).some(t => t.includes('拿不到')), 3000, '拿不到路径的提示');
  // 拖到终端上：把路径（带引号）粘贴进去，不加成附件
  await win.locator('[data-testid=terminal-button]').click();
  await waitTerm(PROMPT, '终端提示符');
  dt = await dragData();
  await win.dispatchEvent('.term-host', 'drop', { dataTransfer: dt });
  await waitTerm(/附件 资料/, '终端里出现粘贴的路径');
  if ((await chips().count()) !== 1) throw new Error('拖到终端的文件不该变成附件');
  await shot('27-drop-terminal');
  await win.locator('.term-host').click();
  await win.keyboard.press('Control+c');
});

// ---------- C2：改动面板（Git 审查和提交） ----------
const gitOut = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const remoteHead = ref => execFileSync('git', ['rev-parse', ref], { cwd: remoteRepo, encoding: 'utf8' }).trim();
const utilsFile = path.join(project, 'src', 'utils.js');
const readUtils = () => fs.readFileSync(utilsFile, 'utf8');
const reviewFiles = () => win.locator('[data-testid=review-file]').evaluateAll(els => els.map(e => e.getAttribute('data-path')));
const fileCard = p => win.locator(`[data-testid=review-file][data-path="${p}"]`);
async function scope(id) { await win.locator(`.rev-seg [data-scope=${id}]`).click(); }
async function waitFiles(expected, label) {
  let last;
  await waitFor(async () => JSON.stringify(last = await reviewFiles()) === JSON.stringify(expected), 15000, `${label}：应该是 ${JSON.stringify(expected)}，实际 ${JSON.stringify(last)}`);
}
const lastOk = () => win.locator('[data-testid=notice-ok]').last();
async function waitOk(text, timeout = 60000) {
  await waitFor(async () => (await lastOk().innerText()).includes(text), timeout, `提示“${text}”`);
}
const stat = async () => (await win.locator('[data-testid=diff-stat]').count()) ? (await win.locator('[data-testid=diff-stat]').innerText()).replace(/\s/g, '') : null;

await step('28 改动面板：顶栏显示改动统计，“未暂存”里看到修改和新文件', async () => {
  if (await win.locator('.term-panel').count()) await win.locator('[data-testid=terminal-button]').click();
  // 先把前面步骤留下的改动提交掉，从干净的状态开始
  gitOut('add', '-A');
  try { gitOut('commit', '-q', '-m', 'e2e: 前面步骤留下的改动'); } catch { /* 没有改动 */ }
  await waitFor(async () => (await stat()) === null, 15000, '顶栏没有改动统计');
  fs.appendFileSync(path.join(project, 'README.md'), '新的一行\n');
  fs.writeFileSync(path.join(project, 'notes.txt'), '第一行\n第二行\n');
  let s;
  await waitFor(async () => (s = await stat()) === '+3−0', 15000, `顶栏的改动统计 +3 −0（实际 ${s}）`);
  await win.locator('[data-testid=review-button]').click();
  await win.waitForSelector('[data-testid=review-panel]');
  await scope('unstaged');
  await waitFiles(['README.md', 'notes.txt'], '未暂存的文件');
  if (!(await fileCard('notes.txt').innerText()).includes('新文件')) throw new Error('新文件没有标出来');
  if ((await fileCard('README.md').locator('.dl.add').count()) !== 1) throw new Error('README.md 应该有 1 行新增');
  if (!(await win.locator('[data-testid=commit-info]').innerText()).includes('全部 2 个文件')) throw new Error('提交框的说明不对');
  await shot('28-review-unstaged');
});

await step('29 暂存、取消暂存、撤销（撤销要点两次，新文件移到回收站）', async () => {
  await fileCard('README.md').locator('[data-testid=stage-file]').click();
  await waitFiles(['notes.txt'], '暂存后，未暂存里只剩 notes.txt');
  await scope('staged');
  await waitFiles(['README.md'], '已暂存');
  if (gitOut('diff', '--cached', '--name-only') !== 'README.md') throw new Error('git 里没暂存上');
  if (!(await win.locator('[data-testid=commit-info]').innerText()).includes('已暂存的 1 个文件')) throw new Error('提交框没显示“已暂存的 1 个文件”');
  await fileCard('README.md').locator('[data-testid=unstage-file]').click();
  await win.waitForSelector('[data-testid=review-empty]');
  await scope('unstaged');
  await waitFiles(['README.md', 'notes.txt'], '取消暂存后');
  const revert = fileCard('notes.txt').locator('[data-testid=revert-file]');
  await revert.click();
  if ((await revert.innerText()) !== '确定撤销？') throw new Error('点一次应该先问“确定撤销？”');
  if (!fileExists('notes.txt')) throw new Error('点一次就撤销了');
  await revert.click();
  await waitFiles(['README.md'], '撤销新文件后');
  if (fileExists('notes.txt')) throw new Error('新文件还在');
  if (!fs.readdirSync(trashDir).some(f => f.endsWith('notes.txt'))) throw new Error('新文件没有移到回收站');
  const r2 = fileCard('README.md').locator('[data-testid=revert-file]');
  await r2.click();
  await r2.click();
  await win.waitForSelector('[data-testid=review-empty]');
  if (fs.readFileSync(path.join(project, 'README.md'), 'utf8').includes('新的一行')) throw new Error('README.md 没恢复');
  await waitFor(async () => (await stat()) === null, 10000, '顶栏的统计消失');
});

await step('30 行内评论：发给 Claude，Claude 照着改；“上一轮”只算这一轮改的文件', async () => {
  fs.writeFileSync(utilsFile, 'export function greet(name) {\n  return "hello " + name;\n}\n');
  gitOut('add', '-A');
  try { gitOut('commit', '-q', '-m', 'e2e: 重置 utils.js'); } catch { /* 本来就一样 */ }
  fs.writeFileSync(utilsFile, 'export const VERSION = 1;\n\nexport function greet(name) {\n  return "hello " + name;\n}\n');
  fs.writeFileSync(path.join(project, 'scratch.txt'), '我自己的草稿\n');
  await setMode('acceptEdits');
  await waitFiles(['scratch.txt', 'src/utils.js'], '未暂存');
  const line = fileCard('src/utils.js').locator('[data-testid=diff-line]', { hasText: 'return "hello " + name;' });
  await line.hover();
  await line.locator('[data-testid=comment-button]').click();
  await win.locator('[data-testid=comment-input]').fill('把这一行改成模板字符串：return `hello ${name}`;\n只用 Edit 工具改这一处，不要运行任何命令，改完回复 DONE。');
  await shot('30-comment-box');
  await win.locator('[data-testid=comment-send]').click();
  await waitFor(async () => (await win.locator('.msg.user').last().innerText()).includes('【代码评论】src/utils.js 第 4 行'), 10000, '评论作为消息发出去');
  if ((await win.locator('.cnote').count()) < 1) throw new Error('评论下面没显示“已发给 Claude”');
  await waitTurn();
  if (!readUtils().includes('`hello ${name}`')) throw new Error('Claude 没照评论改：' + readUtils());
  await scope('turn');
  await waitFiles(['src/utils.js'], '上一轮只有 utils.js（scratch.txt 是自己改的，不算）');
  if (!(await win.locator('[data-testid=review-desc]').innerText()).includes('上一轮')) throw new Error('上一轮的说明不对');
  if ((await fileCard('src/utils.js').locator('.dl.add').count()) !== 1) throw new Error('上一轮里应该只有 1 行新增（VERSION 那行是之前就有的）');
  await shot('30-review-turn');
});

await step('31 撤销这一轮：恢复成这一轮开始前的样子，自己的改动不受影响', async () => {
  const btn = win.locator('[data-testid=revert-turn]');
  await btn.click();
  await btn.click();
  await waitFor(async () => !readUtils().includes('`hello'), 10000, 'utils.js 恢复');
  const content = readUtils();
  if (!content.includes('VERSION') || !content.includes('"hello " + name')) throw new Error('没有恢复成这一轮开始前的样子：' + content);
  if (!fileExists('scratch.txt')) throw new Error('自己的改动被撤销了');
  await win.waitForSelector('[data-testid=review-empty]');
  if (!(await win.locator('[data-testid=review-empty]').innerText()).includes('都撤销了')) throw new Error('撤销后上一轮应该显示“都撤销了”');
});

await step('32 提交：写了说明就用这个说明；留空让 Claude 来写', async () => {
  await scope('unstaged');
  await waitFiles(['scratch.txt', 'src/utils.js'], '未暂存');
  await win.locator('[data-testid=commit-message]').fill('e2e: 手写的提交说明');
  await win.locator('[data-testid=commit-button]').click();
  await waitOk('已提交：e2e: 手写的提交说明', 30000);
  if (gitOut('log', '-1', '--format=%s') !== 'e2e: 手写的提交说明') throw new Error('git 里的提交说明不对');
  await win.waitForSelector('[data-testid=review-empty]');
  if ((await win.locator('[data-testid=commit-message]').inputValue()) !== '') throw new Error('提交后说明没清空');
  fs.writeFileSync(path.join(project, 'todo.md'), '# 待办\n\n- 给 greet 加单元测试\n');
  await waitFiles(['todo.md'], '新文件');
  await win.locator('[data-testid=commit-button]').click();
  await waitFor(async () => (await win.locator('[data-testid=commit-info]').innerText()).includes('Claude 正在写提交说明'), 5000, '“Claude 正在写提交说明”');
  await waitOk('提交说明是 Claude 写的', 120000);
  const msg = gitOut('log', '-1', '--format=%B');
  if (!msg || msg.includes('```') || /co-authored-by/i.test(msg) || msg === 'e2e: 手写的提交说明') throw new Error('Claude 写的提交说明不对：' + msg);
  console.log(`      Claude 写的提交说明：${msg.split('\n')[0]}`);
  await shot('32-commit-generated');
});

await step('33 推送：“整个分支”看没推送的提交；没有改动时直接推送；提交并推送', async () => {
  await scope('branch');
  await waitFor(async () => (await reviewFiles()).includes('todo.md'), 10000, '整个分支里有还没推送的 todo.md');
  if (!(await win.locator('[data-testid=review-desc]').innerText()).includes('origin/main')) throw new Error('整个分支的说明里应该有 origin/main');
  await waitFor(async () => (await win.locator('[data-testid=commit-info]').innerText()).includes('个提交还没推送'), 10000, '“还没推送”的提示');
  if ((await win.locator('[data-testid=commit-button]').innerText()) !== '推送') throw new Error('没有改动时主按钮应该是“推送”');
  await win.locator('[data-testid=commit-button]').click();
  await waitOk('已推送到 origin/main');
  if (remoteHead('main') !== gitOut('rev-parse', 'HEAD')) throw new Error('远程没更新');
  await win.waitForSelector('[data-testid=review-empty]');
  fs.appendFileSync(path.join(project, 'todo.md'), '- 写文档\n');
  await scope('unstaged');
  await waitFiles(['todo.md'], '改动');
  await win.locator('[data-testid=commit-message]').fill('e2e: 提交并推送');
  await win.locator('[data-testid=commit-more]').click();
  await win.locator('.commit-menu [data-commit=push]').click();
  await waitOk('已提交并推送：e2e: 提交并推送');
  if (remoteHead('main') !== gitOut('rev-parse', 'HEAD')) throw new Error('提交并推送后远程没更新');
});

await step('34 开 PR：在 main 上先起新分支，推送后用 gh 开 PR，提示里能打开链接', async () => {
  fs.appendFileSync(path.join(project, 'todo.md'), '- 开 PR\n');
  await waitFiles(['todo.md'], '改动');
  await win.locator('[data-testid=commit-message]').fill('e2e: 开 PR');
  await win.locator('[data-testid=commit-more]').click();
  await win.locator('.commit-menu [data-commit=pr]').click();
  await win.waitForSelector('[data-testid=pr-branch-input]');
  await win.locator('[data-testid=pr-branch-input]').fill('main');
  await win.locator('[data-testid=pr-branch-confirm]').click();
  await win.waitForSelector('.field-err');
  await win.locator('[data-testid=pr-branch-input]').fill('e2e/pr-test');
  await shot('34-pr-branch');
  await win.locator('[data-testid=pr-branch-confirm]').click();
  await waitOk('已开 PR：e2e: 开 PR');
  const notice = await lastOk().innerText();
  if (!notice.includes('https://github.com/example/demo/pull/7')) throw new Error('提示里没有 PR 地址：' + notice);
  if ((await lastOk().locator('button', { hasText: '打开 PR' }).count()) !== 1) throw new Error('没有“打开 PR”按钮');
  const call = JSON.parse(fs.readFileSync(ghLog, 'utf8').trim().split('\n').pop());
  if (call.args.join(' ') !== 'pr create --fill --base main --head e2e/pr-test') throw new Error('gh 的参数不对：' + call.args.join(' '));
  if (gitOut('rev-parse', '--abbrev-ref', 'HEAD') !== 'e2e/pr-test') throw new Error('没切到新分支');
  if (remoteHead('e2e/pr-test') !== gitOut('rev-parse', 'HEAD')) throw new Error('新分支没推送');
  await waitFor(async () => (await win.locator('.uchip', { hasText: 'e2e/pr-test' }).count()) === 1, 10000, '输入框下面显示新分支');
  await shot('34-pr-done');
});

await step('35 不是 Git 仓库的项目：面板里一键初始化', async () => {
  const plain = path.join(work, 'plain-project');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'data.csv'), 'a,b\n1,2\n');
  await win.evaluate(p => window.claudex.addProject(p), plain);
  await win.reload();
  await win.waitForSelector('.app');
  await win.locator('.proj-head', { hasText: 'plain-project' }).click();
  await win.locator('[data-testid=review-button]').click();
  await win.waitForSelector('[data-testid=not-repo]');
  await shot('35-not-repo');
  await win.locator('[data-testid=git-init]').click();
  await waitFiles(['data.csv'], '初始化后，未暂存里有 data.csv');
  if (!fs.existsSync(path.join(plain, '.git'))) throw new Error('没有初始化');
});

// ---------- C3：worktree 并行对话 ----------
const wtParent = path.join(work, '.claudex-worktrees', 'demo-project');
const convMeta = async id => (await win.evaluate(() => window.claudex.getState())).conversations.find(c => c.id === id);
const activeConvId = () => win.locator('[data-testid=conversation-item].active').getAttribute('data-id');
async function pickPlace(place) {
  await win.locator('[data-testid=place-button]').click();
  await win.locator(`.menu [data-place=${place}]`).click();
  await waitFor(async () => (await win.locator('[data-testid=place-button]').innerText()).includes(place === 'worktree' ? '新 worktree' : '本地'), 3000, '位置选择');
}
let wtA, wtB;

await step('36 新 worktree 对话：Claude 在 worktree 里改文件，本地项目文件夹不受影响', async () => {
  gitOut('switch', '-q', 'main');
  await win.locator('.proj-head', { hasText: 'demo-project' }).click();
  await pickPlace('worktree');
  await shot('36-place-menu');
  await setMode('acceptEdits');
  await sendMsg('Use the Write tool to create wt-note.txt containing exactly: from worktree\nDo not use Bash. Reply DONE.');
  await win.waitForSelector('[data-testid=wt-chip]', { timeout: 30000 });
  await waitTurn();
  wtA = await activeConvId();
  const meta = await convMeta(wtA);
  if (!meta?.worktree || path.dirname(meta.worktree.path) !== wtParent) throw new Error('worktree 不在项目旁边的统一文件夹里：' + JSON.stringify(meta?.worktree));
  if (!fs.existsSync(path.join(meta.worktree.path, 'wt-note.txt'))) throw new Error('worktree 里没有 Claude 写的文件');
  if (fileExists('wt-note.txt')) throw new Error('本地项目文件夹被改了');
  if (!(await win.locator('[data-testid=wt-chip]').innerText()).includes(meta.worktree.branch)) throw new Error('顶栏没显示 worktree 分支');
  await waitFor(async () => (await win.locator('[data-testid=branch-chip]').innerText()).includes(meta.worktree.branch), 10000, '输入框下面显示 worktree 的分支');
  if ((await win.locator(`[data-testid=conversation-item][data-id="${wtA}"] .sess-wt`).count()) !== 1) throw new Error('侧栏没标出 worktree 对话');
  await scope('unstaged');
  await waitFiles(['wt-note.txt'], '改动面板看的是 worktree 里的改动');
  await shot('36-worktree-conv');
});

await step('37 两个 worktree 对话同时跑，互不干扰', async () => {
  await win.locator('[data-testid=new-conversation]').click();
  if (!(await win.locator('[data-testid=place-button]').innerText()).includes('本地')) throw new Error('新对话应该默认本地');
  await pickPlace('worktree');
  await setMode('acceptEdits');
  await sendMsg('Use the Write tool to create b.txt containing exactly: from B\nDo not use Bash. Reply DONE.');
  await win.waitForSelector('[data-testid=wt-chip]', { timeout: 30000 });
  wtB = await activeConvId();
  // B 还在跑的时候切到 A 再发一条
  await win.locator(`[data-testid=conversation-item][data-id="${wtA}"]`).click();
  await sendMsg('Use the Write tool to create a2.txt containing exactly: from A again\nDo not use Bash. Reply DONE.');
  const [a, b] = [(await convMeta(wtA)).worktree.path, (await convMeta(wtB)).worktree.path];
  if (a === b) throw new Error('两个对话用了同一个 worktree');
  await waitFor(async () => fs.existsSync(path.join(a, 'a2.txt')) && fs.existsSync(path.join(b, 'b.txt')) && (await win.locator('.sess .spin').count()) === 0, 180000, '两个对话都做完');
  if (fs.existsSync(path.join(a, 'b.txt')) || fs.existsSync(path.join(b, 'a2.txt')) || fs.existsSync(path.join(b, 'wt-note.txt'))) throw new Error('两个 worktree 串了');
  if (fileExists('a2.txt') || fileExists('b.txt')) throw new Error('本地项目文件夹被改了');
});

await step('38 接手到本地：改动变成本地未提交的改动，worktree 删掉，对话在本地接着聊', async () => {
  await win.locator(`[data-testid=conversation-item][data-id="${wtA}"]`).click();
  await waitTurn();
  const before = await convMeta(wtA);
  await win.locator('[data-testid=handoff-button]').click();
  await win.waitForSelector('[data-testid=handoff-confirm]');
  await shot('38-handoff-confirm');
  await win.locator('[data-testid=handoff-confirm]').click();
  await waitOk('已接手到本地', 60000);
  if (fs.readFileSync(path.join(project, 'wt-note.txt'), 'utf8').trim() !== 'from worktree' || !fileExists('a2.txt')) throw new Error('改动没搬到本地');
  if (gitOut('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort().join('|') !== '?? a2.txt|?? wt-note.txt') throw new Error('本地应该只多了两个未提交的新文件：' + gitOut('status', '--porcelain'));
  if (fs.existsSync(before.worktree.path)) throw new Error('worktree 没删掉');
  if (!gitOut('show', '--name-only', '--format=', before.worktree.branch).includes('wt-note.txt')) throw new Error('分支上没存着改动');
  if (await win.locator('[data-testid=wt-chip]').count()) throw new Error('顶栏还显示 worktree');
  if (!(await win.locator('[data-testid=place-chip], .uchip', { hasText: '已接手' }).count())) throw new Error('输入框下面没显示“已接手”');
  await waitFiles(['a2.txt', 'wt-note.txt'], '改动面板里看到搬过来的改动');
  await shot('38-handed-off');
  await sendMsg('Read wt-note.txt in the current directory and reply with its exact content only.');
  await waitTurn();
  if (!(await lastAssistant()).includes('from worktree')) throw new Error('接手后接着聊不对：' + (await lastAssistant()));
});

await step('39 删除 worktree 对话：改动先存到分支上，再删掉 worktree', async () => {
  const meta = await convMeta(wtB);
  win.once('dialog', d => void d.accept());
  const row = win.locator(`[data-testid=conversation-item][data-id="${wtB}"]`);
  await row.hover();
  await row.locator('.sess-del').click();
  await waitFor(async () => (await win.locator(`[data-testid=conversation-item][data-id="${wtB}"]`).count()) === 0, 30000, '对话从列表里消失');
  if (fs.existsSync(meta.worktree.path)) throw new Error('worktree 没删掉');
  if (gitOut('show', `${meta.worktree.branch}:b.txt`) !== 'from B') throw new Error('分支上没存着 b.txt');
  if (fs.existsSync(wtParent)) throw new Error('worktree 都删光了，空文件夹应该一起删掉');
});

await step('40 还没有提交的仓库不能开 worktree，并说明原因', async () => {
  await win.locator('.proj-head', { hasText: 'plain-project' }).click();
  await win.locator('[data-testid=place-button]').click();
  const opt = win.locator('.menu [data-place=worktree]');
  await waitFor(async () => (await opt.isDisabled()) && (await opt.innerText()).includes('提交'), 5000, 'worktree 选项不能选，并说明原因');
  await win.keyboard.press('Escape');
});

// ---------- 项目环境（conda） ----------
/** 发完消息后一直点“允许一次”，直到这一轮结束 */
async function runApproving(timeout = 240000) {
  await waitFor(async () => (await win.locator('[data-testid=stop-button]').count()) === 1, 10000, '开始回复').catch(() => {});
  const t0 = Date.now();
  for (;;) {
    const allow = win.locator('[data-testid=approval] button', { hasText: '允许一次' });
    if (await allow.count()) await allow.first().click().catch(() => {});
    if ((await win.locator('[data-testid=stop-button]').count()) === 0 && (await win.locator('[data-testid=send-button]').count()) === 1) return;
    if (Date.now() - t0 > timeout) throw new Error('等待超时：这一轮结束');
    await sleep(400);
  }
}
const samePrefix = (text, prefix) => text.replace(/\//g, '\\').toLowerCase().includes(prefix.toLowerCase());
const PY = 'python -c "import sys; print(sys.prefix)"';
const condaState = async () => win.evaluate(() => window.claudex.condaInfo(true));

await step('41 项目环境：在输入框下面选 conda 环境，Claude 和终端里的 python 都是这个环境', async () => {
  const info = await condaState();
  if (!info.available) { console.log('      （本机没装 conda，跳过）'); return; }
  const target = info.envs.find(e => e.name !== 'base') ?? info.envs[0];
  await win.locator('.proj-head', { hasText: 'demo-project' }).click();
  await win.locator('[data-testid=env-button]').click();
  await win.waitForSelector('.env-menu');
  await shot('41-env-menu');
  await win.locator(`.env-menu [data-env="${target.name}"]`).click();
  await waitFor(async () => (await win.locator('[data-testid=env-button]').innerText()).includes(target.name), 5000, '输入框下面显示选好的环境');
  await sendMsg(`Use the Bash tool to run exactly this command: ${PY}\nThen reply with exactly the printed path and nothing else.`);
  await runApproving();
  if (!samePrefix(await lastAssistant(), target.prefix)) throw new Error(`Claude 用的不是 ${target.name}：${await lastAssistant()}`);
  await win.locator('[data-testid=terminal-button]').click();
  await waitTerm(PROMPT, '终端提示符');
  await termRun(PY);
  await waitFor(async () => samePrefix(await termText(), target.prefix), 20000, `终端里的 python 是 ${target.name}`);
  await shot('41-env-terminal');
  await win.locator('[data-testid=terminal-button]').click();
});

await step('42 没指定环境时：Claude 挑一个现有的环境登记成项目环境，之后的消息自动用它', async () => {
  const info = await condaState();
  const target = info.envs.find(e => e.name === 'test') ?? info.envs.find(e => e.name !== 'base');
  if (!info.available || !target) { console.log('      （本机没有可用的 conda 环境，跳过）'); return; }
  await win.locator('.proj-head', { hasText: 'plain-project' }).click();
  if ((await win.locator('[data-testid=env-button]').innerText()).trim() !== 'Python 环境') throw new Error('plain-project 不该有指定的环境');
  await sendMsg(`This project needs Python. Follow the project Python environment instructions in your system prompt, but do NOT create a new environment: use the existing conda environment named "${target.name}" and register it as this project's environment with the set_project_env tool. Do not run any other commands. Reply DONE when it is registered.`);
  await runApproving();
  await waitOk(`Claude 把 conda 环境「${target.name}」登记`, 10000);
  await waitFor(async () => (await win.locator('[data-testid=env-button]').innerText()).includes(target.name), 5000, '输入框下面显示登记的环境');
  const st = await win.evaluate(() => window.claudex.getState());
  if (st.projects.find(p => p.name === 'plain-project')?.condaEnv?.name !== target.name) throw new Error('项目设置里没记下环境');
  await shot('42-env-registered');
  // 下一条消息：进程按新环境重启，python 就是登记的环境
  await sendMsg(`Use the Bash tool to run exactly this command: ${PY}\nThen reply with exactly the printed path and nothing else.`);
  await runApproving();
  if (!samePrefix(await lastAssistant(), target.prefix)) throw new Error(`登记后用的不是 ${target.name}：${await lastAssistant()}`);
});

// ---------- 团队（老板-员工） ----------
const teamProj = path.join(work, 'team-project');
const teamTasks = () => win.evaluate(p => window.claudex.listTasks(p), teamProj);
const agentFile = id => path.join(teamProj, '.claude', 'agents', `${id}.md`);
const resultCards = () => win.locator('[data-testid=task-result]');
/** 等某个任务到某个状态（不靠数结果卡片，别的任务的结果也可能先回来） */
async function waitTask(pick, statuses, timeout = 300000, label = '任务') {
  let t;
  await waitFor(async () => (t = pick(await teamTasks())) && statuses.includes(t.status), timeout, `${label}：${statuses.join('/')}（现在 ${t?.status}）`);
  return t;
}
/** 左栏展开某个员工（已经展开就不点，点了会收起来） */
async function expandEmployee(id) {
  const emp = win.locator('.emp', { has: win.locator(`[data-testid=employee-item][data-employee=${id}]`) });
  if (!(await emp.locator('[data-testid=employee-new-chat]').count())) await emp.locator('[data-testid=employee-item]').click();
  return emp;
}
/** 等员工交回的结果出现在主对话里，并且老板处理完 */
async function waitResults(n, timeout = 240000) {
  await waitFor(async () => (await resultCards().count()) >= n, timeout, `主对话里出现第 ${n} 个员工交回的结果`);
  await waitTurn(timeout);
}
let boss1;

await step('43 招人：主对话提议招人时弹出档案卡片，可以改了再录用，档案写进项目', async () => {
  fs.mkdirSync(teamProj, { recursive: true });
  fs.writeFileSync(path.join(teamProj, 'README.md'), '# team-project\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: teamProj });
  await win.evaluate(p => window.claudex.addProject(p), teamProj);
  await win.reload();
  await win.waitForSelector('.app');
  await win.locator('.proj-head', { hasText: 'team-project' }).click();
  await sendMsg('我们需要一个翻译员工。请直接用 hire_employee 招一个：编号 translator，名字“小李”，负责中英互译；模型 haiku。角色提示词写清楚：只输出译文，不加解释。录用后回复 DONE。');
  await win.waitForSelector('[data-testid=profile-approval]', { timeout: 180000 });
  await shot('43-hire-card');
  await win.locator('[data-testid=profile-approval] [data-testid=pf-name]').fill('小李子');
  await win.locator('[data-testid=profile-approve]').click();
  await waitTurn();
  boss1 = await activeConvId();
  if (!fs.existsSync(agentFile('translator'))) throw new Error('档案没写到 .claude/agents/translator.md');
  const text = fs.readFileSync(agentFile('translator'), 'utf8');
  if (!text.includes('displayName: 小李子') || !text.includes('model: haiku')) throw new Error('档案内容不对（卡片里改的名字、模型）：' + text);
  if (/tools:|permissionMode:/.test(text)) throw new Error('档案里不该有工具、权限的限制：' + text);
  await waitFor(async () => (await win.locator('[data-testid=employee-item][data-employee=translator]').count()) === 1, 5000, '侧栏的团队里出现小李子');
});

await step('44 派活：老板派完马上回来，员工在自己的新对话里做，做完结果自动送回主对话', async () => {
  await sendMsg('用 assign_task 把一个活派给 translator，标题“翻译通知”：把“今晚八点上线新版本”翻译成英文。派完马上回复我“已派出”，不要等结果。');
  await waitTurn();
  if (!(await lastAssistant()).includes('已派出')) throw new Error('老板没有马上回来：' + await lastAssistant());
  if ((await win.locator('[data-testid=assign-row]').count()) < 1) throw new Error('主对话里没有派活记录');
  await waitResults(1);
  const card = await resultCards().first().innerText();
  if (!/tonight|8/i.test(card)) throw new Error('交回的结果不对：' + card);
  await waitFor(async () => (await win.locator('[data-testid=assign-row] .tstate').first().innerText()).includes('已交回'), 10000, '派活记录显示“已交回”');
  await shot('44-result-back');
  const tasks = await teamTasks();
  const t = tasks.find(x => x.title === '翻译通知');
  if (!t || t.status !== 'done' || t.fromConvId !== boss1) throw new Error('任务记录不对：' + JSON.stringify(tasks));
  // 从结果卡片打开员工做这个活的对话：任务卡片 + 他的回复
  await resultCards().first().locator('button', { hasText: '打开' }).click();
  await waitFor(async () => (await activeConvId()) === t.convId, 5000, '打开员工做这个活的对话');
  await win.waitForSelector('[data-testid=task-card]');
  if (!(await win.locator('[data-testid=employee-chip]').innerText()).includes('小李子')) throw new Error('员工对话的顶栏没显示员工');
  await shot('44-employee-conv');
});

await step('45 并行：同一个员工同时接两个活，开两个对话一起做', async () => {
  await win.locator(`[data-testid=conversation-item][data-id="${boss1}"]`).click();
  await sendMsg('同时派两个活给 translator，都不要等：1）标题“翻译A”，把“你好”翻成英文；2）标题“翻译B”，把“谢谢”翻成英文。两个都派出去后回复“已派出”。');
  await waitTurn();
  await waitResults(3);
  const tasks = await teamTasks();
  const a = tasks.find(x => x.title === '翻译A');
  const b = tasks.find(x => x.title === '翻译B');
  if (!a || !b || a.status !== 'done' || b.status !== 'done') throw new Error('两个活没做完：' + JSON.stringify(tasks));
  if (a.convId === b.convId) throw new Error('两个活应该各开一个对话');
  if (!(a.createdAt < b.endedAt && b.createdAt < a.endedAt)) throw new Error('两个活没有同时在做：' + JSON.stringify({ a, b }));
});

await step('46 员工完全访问：运行写文件的命令直接做，不用审批、也不弹给用户', async () => {
  // 在侧栏手动招一个员工（档案表单）
  await win.locator('.proj', { hasText: 'team-project' }).locator('[data-testid=hire-button]').click();
  await win.locator('.modal [data-testid=pf-name]').fill('小测');
  await win.locator('.modal [data-testid=pf-id]').fill('tester');
  await win.locator('.modal [data-testid=pf-desc]').fill('按任务运行命令、检查环境');
  await win.locator('.modal [data-testid=pf-prompt]').fill('你是测试员“小测”。按任务运行命令，把命令的输出原样写进汇报。');
  if (await win.locator('.modal [data-testid=pf-mode], .modal [data-testid=pf-tools]').count()) throw new Error('档案表单里不该再有权限、工具的设置');
  await shot('46-hire-form');
  await win.locator('[data-testid=employee-save]').click();
  await waitFor(() => fs.existsSync(agentFile('tester')), 5000, '档案写好');
  await win.locator(`[data-testid=conversation-item][data-id="${boss1}"]`).click();
  // 写文件的命令：员工完全访问，直接运行，不经过任何审批
  await sendMsg('用 assign_task 派给 tester，标题“写探针文件”：用 Bash 运行 node -e "require(\'fs\').writeFileSync(\'probe.txt\', \'ok\')"，在项目根目录生成 probe.txt，然后汇报。派完回复“已派出”。');
  await waitTurn();
  const t = await waitTask(ts => ts.filter(x => x.employeeId === 'tester').pop(), ['done', 'failed'], 300000, '测试员的任务');
  if (t.status !== 'done') throw new Error('任务结果不对：' + JSON.stringify(t));
  await waitResults(4);
  if (!fs.existsSync(path.join(teamProj, 'probe.txt'))) throw new Error('命令没执行：' + t.result);
  if (/tools:|permissionMode:/.test(fs.readFileSync(agentFile('tester'), 'utf8'))) throw new Error('档案里不该有工具、权限的设置');
  await resultCards().last().locator('button', { hasText: '打开' }).click();
  await waitFor(async () => (await activeConvId()) === t.convId, 5000, '打开员工做这个活的对话');
  const st = await win.evaluate(() => window.claudex.getState());
  if (st.conversations.find(c => c.id === t.convId)?.mode !== 'bypassPermissions') throw new Error('员工的对话应该是完全访问');
  await win.waitForSelector('[data-testid=task-card]');
  if (await win.locator('.approval').count()) throw new Error('员工的操作不该弹审批');
  await shot('46-full-access');
});

await step('47 直接和员工聊：教他一条规矩，他记进长期记忆', async () => {
  const emp = win.locator('.emp', { has: win.locator('[data-testid=employee-item][data-employee=translator]') });
  if (!(await emp.locator('[data-testid=employee-new-chat]').count())) await emp.locator('[data-testid=employee-item]').click();
  await emp.locator('[data-testid=employee-new-chat]').click();
  await waitFor(async () => (await win.locator('[data-testid=employee-chip]').innerText()).includes('小李子'), 5000, '打开的是小李子的对话');
  await win.waitForSelector('[data-testid=employee-chip]');
  await sendMsg('记住一条规矩：以后每次翻译，最后单独一行写“—— 小李子”。把它记进你的长期记忆，然后回复“记住了”。');
  await runApproving();
  const memDir = path.join(teamProj, '.claude', 'agent-memory', 'translator');
  const mem = fs.existsSync(memDir) ? fs.readdirSync(memDir).map(f => fs.readFileSync(path.join(memDir, f), 'utf8')).join('\n') : '';
  if (!mem.includes('小李子')) throw new Error('长期记忆里没有这条规矩：' + mem);
});

let boss2;
await step('48 另一个主对话也能看团队、改员工档案（先弹卡片确认）', async () => {
  await win.locator('.proj-head', { hasText: 'team-project' }).click();
  await sendMsg('用 update_employee 把 translator 的“负责什么”（description）改成“中英日翻译”，其他不变。改好回复 DONE。');
  await win.waitForSelector('[data-testid=profile-approval]', { timeout: 180000 });
  await shot('48-update-card');
  await win.locator('[data-testid=profile-approve]').click();
  await waitTurn();
  boss2 = await activeConvId();
  if (boss2 === boss1) throw new Error('应该是另一个主对话');
  if (!fs.readFileSync(agentFile('translator'), 'utf8').includes('description: 中英日翻译')) throw new Error('档案没改');
  await waitFor(async () => (await win.locator('[data-testid=employee-item][data-employee=translator]').innerText()).includes('中英日翻译'), 5000, '侧栏显示新的描述');
  await sendMsg('用 list_employees 看一下有哪些员工，只回复他们的编号，用逗号隔开。');
  await waitTurn();
  const reply = await lastAssistant();
  if (!reply.includes('translator') || !reply.includes('tester')) throw new Error('看不到全部员工：' + reply);
});

await step('49 新的活里员工照着教过的规矩做（长期记忆跨对话生效）', async () => {
  await sendMsg('用 assign_task 派给 translator，标题“翻译谢谢”：把“非常感谢”翻成英文。派完回复“已派出”。');
  await waitTurn();
  await waitResults(1);
  const t = (await teamTasks()).find(x => x.title === '翻译谢谢');
  if (!t || t.fromConvId !== boss2) throw new Error('任务记录不对：' + JSON.stringify(t));
  if (!(t.result ?? '').trim().endsWith('—— 小李子')) throw new Error('没照着规矩写落款：' + t.result);
  await shot('49-second-boss');
});

// ---------- 团队：Skills、看板、员工之间交接 ----------
const profileText = id => fs.readFileSync(agentFile(id), 'utf8');

await step('50 员工档案里选能用的 Skills（从全局和项目现有的里挑），员工的对话全是完全访问', async () => {
  const st = await win.evaluate(() => window.claudex.getState());
  const empConvs = st.conversations.filter(c => c.employee);
  if (!empConvs.length || empConvs.some(c => c.mode !== 'bypassPermissions')) throw new Error('员工的对话应该都是完全访问：' + JSON.stringify(empConvs.map(c => [c.title, c.mode])));
  const emp = await expandEmployee('translator');
  await emp.locator('[data-testid=conversation-item]').first().click();
  await win.locator('[data-testid=employee-chip]').click();
  await win.waitForSelector('.modal [data-testid=skills-picker]');
  await win.locator('.modal [data-testid=skills-mode]').selectOption('some');
  await win.locator('.modal [data-testid=skills-search]').fill('office-docx');
  await win.waitForSelector('.modal .sp-item[data-skill=office-docx]', { timeout: 60000 });
  await win.locator('.modal .sp-item[data-skill=office-docx] input').check();
  await shot('50-skills-picker');
  await win.locator('[data-testid=employee-save]').click();
  await waitFor(() => /skills: \[office-docx\]/.test(profileText('translator')), 5000, '档案里记下能用的 Skills');
});

await step('51 直接和员工聊：他自己把 office-pdf 加进能用的 Skills（不用确认，直接生效、留记录）', async () => {
  await (await expandEmployee('translator')).locator('[data-testid=employee-new-chat]').click();
  await waitFor(async () => (await win.locator('[data-testid=employee-chip]').innerText()).includes('小李子'), 5000, '打开的是小李子的对话');
  await sendMsg('把 office-pdf 也加到你能用的 Skills 里（保留原来的 office-docx）。用 update_my_skills 改，然后回复 DONE。');
  await waitTurn();
  if (await win.locator('.approval').count()) throw new Error('改自己的 Skills 不该再弹确认');
  const text = profileText('translator');
  if (!/skills: \[.*office-docx.*\]/.test(text) || !/skills: \[.*office-pdf.*\]/.test(text)) throw new Error('档案里的 Skills 不对：' + text);
  await waitOk('把自己能用的 Skills 改成了', 5000);
  await shot('51-skills-updated');
});

await step('52 任务看板：看到员工和全部任务，能打开员工做活的对话', async () => {
  await win.locator('.proj-head', { hasText: 'team-project' }).click();
  await win.locator('[data-testid=board-button]').click();
  await win.waitForSelector('[data-testid=task-board]');
  await waitFor(async () => (await win.locator('[data-testid=board-employee]').count()) === 2, 5000, '看板上有两个员工');
  const done = await win.locator('[data-testid=board-col-done] [data-testid=board-task]').count();
  if (done < 5) throw new Error('已完成的任务应该至少 5 个，实际 ' + done);
  await shot('52-board');
  const card = win.locator('[data-testid=board-col-done] [data-testid=board-task]').first();
  const id = await card.getAttribute('data-task');
  await card.locator('[data-testid=board-open]').click();
  await win.waitForSelector('[data-testid=task-card]');
  if (!(await win.locator('[data-testid=task-card]').first().innerText()).includes(`#${id}`)) throw new Error('打开的不是这个任务的对话');
});

let boss3;
await step('53 转交：翻译把活转交给测试员写文件，最后的结果交回主对话（带交接链）', async () => {
  await win.locator('.proj-head', { hasText: 'team-project' }).click();
  await sendMsg('用 assign_task 派给 translator，标题“翻译并存档”，任务说明这样写：把“早上好”翻译成英文；你只负责翻译，自己不要写文件，翻译完必须用 handoff_task 转交给 tester，交接说明里写上译文，让他把译文写进项目根目录的 greeting.txt。派完回复“已派出”，不要等结果。');
  await waitTurn();
  boss3 = await activeConvId();
  const first = await waitTask(ts => ts.filter(x => x.employeeId === 'translator' && x.fromConvId === boss3).pop(), ['handed', 'done', 'failed'], 300000, '翻译的任务');
  if (first.status !== 'handed' || !first.handedTo) throw new Error('没有转交：' + JSON.stringify(first));
  const second = await waitTask(ts => ts.find(x => x.id === first.handedTo), ['done', 'failed'], 300000, '接手的任务');
  if (second.employeeId !== 'tester' || second.status !== 'done' || second.fromConvId !== boss3 || second.handedFrom !== first.id) throw new Error('接手的任务不对：' + JSON.stringify(second));
  await waitResults(1, 300000);
  const file = path.join(teamProj, 'greeting.txt');
  if (!fs.existsSync(file) || !/good morning/i.test(fs.readFileSync(file, 'utf8'))) throw new Error('greeting.txt 不对');
  const card = await resultCards().last().innerText();
  if (!card.includes('小测') || !card.includes('交接')) throw new Error('结果卡片里没有交接链：' + card);
  await waitFor(async () => (await win.locator('[data-testid=assign-row]').last().innerText()).includes('转交给 小测'), 5000, '派活记录显示转交');
  await shot('53-handoff');
});

await step('54 请同事帮忙：测试员请翻译做一部分，等结果回来接着做完，再交回主对话', async () => {
  await sendMsg('用 assign_task 派给 tester，标题“晚上好存档”，任务说明这样写：先用 ask_colleague 请 translator 把“晚上好”翻译成英文；在他的结果回来之前不要自己翻译，先结束这一轮；结果回来后，把译文写进项目根目录的 evening.txt，再汇报。派完回复“已派出”，不要等结果。');
  await waitTurn();
  const started = Date.now() - 120000;
  const main = await waitTask(ts => ts.filter(x => x.employeeId === 'tester' && x.fromConvId === boss3 && x.createdAt > started && !x.handedFrom).pop(), ['done', 'failed'], 400000, '测试员的任务');
  const sub = (await teamTasks()).find(x => x.parentId === main.id);
  if (main.status !== 'done' || !sub) throw new Error('任务不对：' + JSON.stringify({ main, sub }));
  if (sub.employeeId !== 'translator' || sub.fromKind !== 'employee' || sub.status !== 'done') throw new Error('帮忙的任务不对：' + JSON.stringify(sub));
  if (sub.endedAt > main.endedAt) throw new Error('应该先拿到同事的结果，再交回');
  const file = path.join(teamProj, 'evening.txt');
  if (!fs.existsSync(file) || !/good evening/i.test(fs.readFileSync(file, 'utf8'))) throw new Error('evening.txt 不对');
});

await step('55 任务看板上停止一个正在做的任务，派活的主对话收到“没做完”', async () => {
  await sendMsg('用 assign_task 派给 tester，标题“慢任务”：用 Bash 运行 node -e "setTimeout(()=>{}, 120000)"，等它结束后汇报。派完回复“已派出”，不要等结果。');
  await waitTurn();
  const before = await resultCards().count();
  const t = await waitTask(ts => ts.filter(x => x.employeeId === 'tester').pop(), ['running'], 60000, '慢任务开始');
  await win.locator('[data-testid=board-button]').click();
  await win.waitForSelector(`[data-testid=board-task][data-task="${t.id}"][data-status=running]`);
  await sleep(8000); // 让员工真的跑起来
  win.once('dialog', d => void d.accept());
  await win.locator(`[data-testid=board-task][data-task="${t.id}"] [data-testid=board-stop]`).click();
  await waitFor(async () => (await teamTasks()).find(x => x.id === t.id)?.status === 'failed', 60000, '任务记为没做完');
  await win.waitForSelector(`[data-testid=board-col-failed] [data-testid=board-task][data-task="${t.id}"]`);
  await shot('55-board-stopped');
  await win.locator('[data-testid=board-button]').click();
  await win.locator(`[data-testid=conversation-item][data-id="${boss3}"]`).click();
  await waitFor(async () => (await resultCards().count()) > before, 60000, '主对话收到结果');
  const card = await resultCards().last().innerText();
  if (!card.includes('没做完') || !card.includes('用户停止了这个任务')) throw new Error('主对话没收到“没做完 / 用户停止了”：' + card);
});

// ---------- 自动化（C4） ----------
const autoState = () => win.evaluate(() => window.claudex.listAutomations());
/** 等某次运行到某个状态 */
async function waitRun(pick, statuses, timeout = 240000, label = '运行') {
  let r;
  await waitFor(async () => (r = pick((await autoState()).runs)) && statuses.includes(r.status), timeout, `${label}：${statuses.join('/')}（现在 ${r?.status}）`);
  return r;
}
async function openAutomation() {
  if (!(await win.locator('[data-testid=automation-view]').count())) await win.locator('[data-testid=automation-button]').click();
  await win.waitForSelector('[data-testid=automation-view]');
}
let auto1;

await step('56 自动化：新建（每天 08:00、新 worktree），保存并试跑一次，跑完进审查队列，打开看结果', async () => {
  await openAutomation();
  await shot('56-empty');
  await win.locator('[data-testid=automation-new]').click();
  await win.locator('[data-testid=af-name]').fill('每日问候');
  await win.locator('[data-testid=af-project]').selectOption({ label: 'demo-project' });
  await win.locator('[data-testid=af-prompt]').fill('Create a file named auto-hello.txt containing exactly: hello from automation. Then reply with exactly: AUTO-OK');
  await win.locator('[data-testid=af-time]').fill('08:00');
  await shot('56-form');
  await win.locator('[data-testid=af-save-run]').click();
  await win.waitForSelector('[data-testid=automation-row]');
  const a = (await autoState()).automations.find(x => x.name === '每日问候');
  if (!a || a.place !== 'worktree' || a.mode !== 'bypassPermissions' || !a.enabled || !a.nextRunAt) throw new Error('自动化没存对：' + JSON.stringify(a));
  if (new Date(a.nextRunAt).getHours() !== 8 || new Date(a.nextRunAt).getMinutes() !== 0 || a.nextRunAt <= Date.now()) throw new Error('下次运行的时刻不对：' + new Date(a.nextRunAt));
  auto1 = a.id;
  const r = await waitRun(rs => rs.find(x => x.automationId === a.id), ['done', 'failed'], 300000, '试跑');
  if (r.status !== 'done' || r.trigger !== 'manual' || !/AUTO-OK/.test(r.summary ?? '')) throw new Error('试跑的结果不对：' + JSON.stringify(r));
  if (fileExists('auto-hello.txt')) throw new Error('在 worktree 里跑的自动化不该改本地文件');
  const meta = await convMeta(r.convId);
  if (!meta?.worktree || !fs.existsSync(path.join(meta.worktree.cwd, 'auto-hello.txt'))) throw new Error('worktree 里没有 Claude 写的文件：' + JSON.stringify(meta?.worktree));
  if (await win.locator(`[data-testid=conversation-item][data-id="${r.convId}"]`).count()) throw new Error('自动化的对话不该出现在左栏的对话列表里');
  await waitFor(async () => (await win.locator(`[data-testid=queue-item][data-run="${r.id}"][data-status=done]`).count()) === 1, 5000, '审查队列里有这次运行');
  await waitFor(async () => (await win.locator('[data-testid=automation-badge]').innerText()).trim() === '1', 5000, '左栏“自动化”上显示 1');
  await shot('56-queue');
  await win.locator(`[data-testid=queue-item][data-run="${r.id}"] [data-testid=queue-open]`).click();
  await waitFor(async () => (await win.locator('[data-testid=automation-chip]').count()) === 1, 10000, '打开这次运行的对话，顶栏标着自动化');
  await waitFor(async () => (await lastAssistant()).includes('AUTO-OK'), 20000, '对话里有 Claude 的回复');
  await waitFor(async () => (await autoState()).runs.find(x => x.id === r.id)?.read === true, 5000, '打开后标为已读');
  await waitFor(async () => (await win.locator('[data-testid=automation-badge]').count()) === 0, 5000, '左栏的数字没了');
  await shot('56-run-conv');
});

await step('57 自动化按时运行：每小时的某一分钟到点自动跑；停用后不再有下次', async () => {
  await openAutomation();
  const now = new Date();
  const target = new Date(now.getTime() + (now.getSeconds() > 45 ? 120000 : 60000));
  await win.locator('[data-testid=automation-new]').click();
  await win.locator('[data-testid=af-name]').fill('整点报时');
  await win.locator('[data-testid=af-project]').selectOption({ label: 'demo-project' });
  await win.locator('[data-testid=af-prompt]').fill('Reply with exactly: TICK-OK');
  await win.locator('[data-testid=af-kind]').selectOption('hourly');
  await win.locator('[data-testid=af-minute]').fill(String(target.getMinutes()));
  await win.locator('[data-testid=af-place]').selectOption('local');
  await win.locator('[data-testid=af-save]').click();
  await waitFor(async () => (await win.locator('[data-testid=automation-row]').count()) === 2, 5000, '表里有两个自动化');
  const a = (await autoState()).automations.find(x => x.name === '整点报时');
  if (!a?.nextRunAt || new Date(a.nextRunAt).getMinutes() !== target.getMinutes()) throw new Error('下次运行的时刻不对：' + JSON.stringify(a));
  if ((await autoState()).runs.some(x => x.automationId === a.id)) throw new Error('只保存不该马上跑');
  const r = await waitRun(rs => rs.find(x => x.automationId === a.id), ['done', 'failed'], 300000, '到点运行');
  if (r.status !== 'done' || r.trigger !== 'schedule' || !/TICK-OK/.test(r.summary ?? '')) throw new Error('按时运行的结果不对：' + JSON.stringify(r));
  if (r.startedAt < a.nextRunAt) throw new Error('没到点就跑了');
  const after = (await autoState()).automations.find(x => x.id === a.id);
  if (!after.nextRunAt || after.nextRunAt - a.nextRunAt !== 3600000) throw new Error('下一次应该是一小时后：' + JSON.stringify(after));
  await win.locator(`[data-testid=automation-row][data-automation="${a.id}"] [data-testid=automation-enabled]`).click();
  await waitFor(async () => { const x = (await autoState()).automations.find(y => y.id === a.id); return !x.enabled && !x.nextRunAt; }, 5000, '停用后没有下次运行');
  await shot('57-scheduled');
});

await step('58 没人看着时需要审批：这次运行暂停，进审查队列，去处理后接着跑完', async () => {
  await openAutomation();
  await win.evaluate(p => window.claudex.saveAutomation({
    name: '写探针', projectPath: p, place: 'local', mode: 'default', enabled: true, schedule: { kind: 'daily', time: '03:00' },
    prompt: 'Use the Bash tool to run exactly this command: node -e "require(\'fs\').writeFileSync(\'auto-probe.txt\', \'ok\')"\nThen reply with exactly: PROBE-OK'
  }), project);
  const a = (await autoState()).automations.find(x => x.name === '写探针');
  await win.locator(`[data-testid=automation-row][data-automation="${a.id}"] [data-testid=automation-run]`).click();
  const r = await waitRun(rs => rs.find(x => x.automationId === a.id), ['waiting', 'done', 'failed'], 180000, '等审批');
  if (r.status !== 'waiting') throw new Error('应该暂停等审批：' + JSON.stringify(r));
  await waitFor(async () => (await win.locator(`[data-testid=queue-item][data-run="${r.id}"] [data-testid=queue-open]`).innerText()).includes('去处理'), 5000, '队列里显示“去处理”');
  await shot('58-waiting');
  await win.locator(`[data-testid=queue-item][data-run="${r.id}"] [data-testid=queue-open]`).click();
  const allow = win.locator('[data-testid=approval] button', { hasText: '允许一次' });
  await allow.first().waitFor({ timeout: 20000 });
  await allow.first().click();
  const done = await waitRun(rs => rs.find(x => x.id === r.id), ['done', 'failed'], 180000, '审批后跑完');
  if (done.status !== 'done' || !/PROBE-OK/.test(done.summary ?? '')) throw new Error('审批后没跑完：' + JSON.stringify(done));
  if (!fileExists('auto-probe.txt')) throw new Error('命令没执行');
  fs.rmSync(path.join(project, 'auto-probe.txt'), { force: true });
});

await step('59 关掉窗口缩到托盘，后台照样运行；从托盘打开回来', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitFor(async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1 && !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())), 5000, '窗口藏到托盘');
  const before = (await autoState()).runs.length;
  await win.evaluate(id => window.claudex.runAutomation(id), auto1);
  const r = await waitRun(rs => rs.length > before ? rs[rs.length - 1] : null, ['done', 'failed'], 300000, '窗口藏起来时运行');
  if (r.status !== 'done') throw new Error('后台运行没跑完：' + JSON.stringify(r));
  await app.evaluate(() => globalThis.claudexTray.automation());
  await waitFor(async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 5000, '从托盘打开窗口');
  await win.waitForSelector('[data-testid=automation-view]');
  await shot('59-from-tray');
});

await step('60 App 关着时错过的运行：下次打开补跑一次', async () => {
  await app.close();
  const file = path.join(userData, 'claudex-automations.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.automations.find(x => x.id === auto1).nextRunAt = Date.now() - 3 * 3600000;
  fs.writeFileSync(file, JSON.stringify(data));
  await launch();
  const r = await waitRun(rs => rs.find(x => x.automationId === auto1 && x.trigger === 'catchup'), ['done', 'failed'], 300000, '补跑');
  if (r.status !== 'done') throw new Error('补跑没跑完：' + JSON.stringify(r));
  const a = (await autoState()).automations.find(x => x.id === auto1);
  if (!a.nextRunAt || a.nextRunAt <= Date.now()) throw new Error('补跑后下一次的时刻不对');
  if ((await autoState()).runs.filter(x => x.automationId === auto1 && x.trigger === 'catchup').length !== 1) throw new Error('只该补跑一次');
});

await app.close();
const failed = results.filter(r => !r.ok);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`--- 端到端测试：${results.length - failed.length}/${results.length} 通过，截图在 tests/e2e/.out/`);
process.exit(failed.length ? 1 : 0);
