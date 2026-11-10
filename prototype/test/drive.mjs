// 原型回归测试：用无头 Chrome 依次点击各交互、检查状态并截图。
// 用法：node prototype/test/drive.mjs "C:\Program Files\Google\Chrome\Application\chrome.exe" "file:///D:/claude_code_lm/prototype/index.html" <截图输出目录>
// 用 Chrome DevTools 协议驱动原型第 2 版：依次点击各交互，检查状态并截图
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , chromePath, pageUrl, outDir] = process.argv;
const port = 9336;
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  '--window-size=1440,900', `--user-data-dir=${join(outDir, 'profile4')}`, 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map(a => a.value).join(' '));
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(expr + ' -> ' + r.result.exceptionDetails.exception?.description);
  return r.result.result.value;
};
const key = async (k, mods = 0) => {
  const code = k === 'Tab' ? 9 : k === 'Escape' ? 27 : k === 'Enter' ? 13 : k === '`' ? 192 : 0;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k === '`' ? 'Backquote' : k, windowsVirtualKeyCode: code, modifiers: mods });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods });
};
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64'));
};
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
const label = () => ev(`document.querySelector('#modeLabel').textContent`);
const bodyHas = c => ev(`document.body.classList.contains('${c}')`);
const shown = sel => ev(`document.querySelector('${sel}').classList.contains('show')`);

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: pageUrl });
await sleep(1200);
await shot('v2-guide.png');

// 1. 说明弹窗
check('说明弹窗默认打开', await shown('#guideOv'));
await ev(`document.querySelector('#guideOv [data-close]').click()`);
check('说明弹窗可关闭', !(await shown('#guideOv')));
check('初始滚动到底部', await ev(`(() => { const t = document.querySelector('#thread'); return t.scrollTop + t.clientHeight >= t.scrollHeight - 2; })()`));
check('顶部改动统计 +5 −2', (await ev(`document.querySelector('#diffStat').textContent`)) === '+5 −2');
check('图标正常渲染', (await ev(`document.querySelector('#btnNew svg').getBoundingClientRect().width`)) === 16);
await shot('v2-main.png');

// 2. 活动记录展开
await ev(`document.querySelectorAll('#colWeb .act-head')[1].click()`);
check('活动记录可展开', await ev(`document.querySelectorAll('#colWeb .act')[1].classList.contains('open')`));

// 3. 模式菜单：5 个模式、分组
await ev(`document.querySelector('#modeBtn').click()`);
check('模式菜单打开', await shown('#modeMenu'));
check('共 5 个模式', (await ev(`document.querySelectorAll('#modeMenu [data-mode]').length`)) === 5);
check('分组：自带 4 个 + 自定义 1 个', (await ev(`[...document.querySelectorAll('#modeMenu .menu-sec')].map(e => e.textContent).join('|')`)) === 'Claude Code 自带|自定义');
await shot('v2-mode-menu.png');

// 4. 自动接受编辑 / 计划模式 直接切换
await ev(`document.querySelector('[data-mode=acceptEdits]').click()`);
check('切到自动接受编辑', (await label()) === '自动接受编辑');
check('菜单选中后关闭', !(await shown('#modeMenu')));
await ev(`document.querySelector('#modeBtn').click(); document.querySelector('[data-mode=plan]').click()`);
check('切到计划模式', (await label()) === '计划模式');

// 5. 环境配置模式：首次选择弹出规则 → 使用
await ev(`document.querySelector('#modeBtn').click(); document.querySelector('[data-mode=envsetup]').click()`);
check('首次选环境配置弹出规则', await shown('#rulesOv'));
check('规则弹窗有“使用这个模式”按钮', !(await ev(`document.querySelector('#rulesUse').hidden`)));
await shot('v2-rules.png');
await ev(`document.querySelector('#rulesUse').click()`);
check('切到环境配置', (await label()) === 'Skills 配置');
check('环境配置：输入框变青色', await bodyHas('mode-envsetup'));
check('顶栏显示环境配置标识', (await ev(`!document.querySelector('#modePill').hidden && document.querySelector('#modePill').textContent`)) === 'Skills 配置模式');

// 6. 完全访问：确认 → 自动放行审批
await ev(`document.querySelector('#modeBtn').click(); document.querySelector('[data-mode=bypass]').click()`);
check('选完全访问弹出确认', await shown('#faOv'));
await ev(`document.querySelector('#faConfirm').click()`);
check('切到完全访问', (await label()) === '完全访问');
check('完全访问：界面变红', await bodyHas('mode-bypass'));
check('切换时清掉环境配置样式', !(await bodyHas('mode-envsetup')));
await sleep(600);
check('待审批被自动允许', await ev(`!document.querySelector('#approval') && document.querySelector('#colWeb .ap-done').textContent.includes('自动允许')`));
await sleep(1700);
check('测试记录显示通过', (await ev(`[...document.querySelectorAll('#colWeb .act .meta')].pop().textContent`)).includes('12 个通过'));
await sleep(9000);
check('最终回复输出完毕', (await ev(`[...document.querySelectorAll('#colWeb .msg.assistant .text')].pop().textContent`)).includes('Asia/Tokyo'));
check('计划计数 3/4', (await ev(`document.querySelector('#planCnt').textContent`)) === '3/4');
await shot('v2-bypass.png');

// 7. Shift+Tab 循环：完全访问 → 环境配置（已看过规则，直接切）→ 默认
await ev(`document.querySelector('#input').focus()`);
await key('Tab', 8);
check('Shift+Tab：完全访问 → 环境配置', (await label()) === 'Skills 配置');
await key('Tab', 8);
check('Shift+Tab：环境配置 → 默认', (await label()) === '默认：询问');
check('回到默认后样式还原', !(await bodyHas('mode-bypass')) && !(await bodyHas('mode-envsetup')));
check('顶栏标识隐藏', await ev(`document.querySelector('#modePill').hidden`));

// 8. 模型选择器
await ev(`document.querySelector('#modelBtn').click(); document.querySelector('[data-model=sonnet]').click()`);
check('Sonnet 下快速置灰', await ev(`document.querySelector('[data-fast="1"]').disabled`));
await shot('v2-model.png');
await ev(`document.querySelector('[data-model=opus]').click()`);
check('模型标签', (await ev(`document.querySelector('#modelLabel').textContent`)) === 'Opus 5.5 · 高 · ⚡');
await ev(`document.body.click()`);
await ev(`document.querySelector('#usageBtn').click()`);
check('用量弹窗打开', await shown('#usagePop'));
await ev(`document.body.click()`);

// 9. 斜杠菜单与 /env
await ev(`(() => { const i = document.querySelector('#input'); i.value = '/skills-s'; i.focus(); i.setSelectionRange(9,9); i.dispatchEvent(new Event('input')); })()`);
check('斜杠菜单 /skills-s → /skills-setup', (await ev(`[...document.querySelectorAll('#popup .pk')].map(e => e.textContent).join(',')`)) === '/skills-setup');
await ev(`document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
check('回车选中 /skills-setup', (await ev(`document.querySelector('#input').value`)) === '/skills-setup ');
await ev(`document.querySelector('#sendBtn').click()`);
check('/skills-setup 切到 Skills 配置', (await label()) === 'Skills 配置');
await sleep(300);
check('生成中按钮变成停止', (await ev(`document.querySelector('#sendUse').getAttribute('href')`)) === '#i-stop');
await key('Escape');
check('Esc 停止生成', (await ev(`[...document.querySelectorAll('#colWeb .msg.assistant .text')].pop().textContent`)).includes('已停止'));

// 10. 切到环境配置示例对话（为项目挑选 Skills 和工具）
await ev(`document.querySelector('.sess[data-thread=env]').click()`);
check('切到“为项目挑选 Skills 和工具”对话', !(await ev(`document.querySelector('#colEnv').hidden`)) && (await ev(`document.querySelector('#colWeb').hidden`)));
check('标题更新', (await ev(`document.querySelector('#hdrTitle').textContent`)) === '为项目挑选 Skills 和工具');
check('该对话的模式是环境配置', (await label()) === 'Skills 配置');
check('应用前改动面板为空', (await ev(`document.querySelectorAll('#revBody .rfile').length`)) === 0 && (await ev(`document.querySelector('#diffStat').textContent`)) === '+0 −0');
const applyText = () => ev(`document.querySelector('#recApply').textContent`);
check('推荐清单初始计数', (await applyText()) === '应用所选（安装 3 · 保留 9 · 关闭 117）', await applyText());
await ev(`document.querySelector('#thread').scrollTop = 0`);
await shot('v3-env-top.png');
await ev(`document.querySelector('#recCard').scrollIntoView({ block: 'start' })`);
await shot('v3-rec.png');
await ev(`document.querySelector('#recKeep .tchip').click()`);
check('取消一个已安装 Skill → 保留 8、关闭 118', (await applyText()) === '应用所选（安装 3 · 保留 8 · 关闭 118）', await applyText());
await ev(`document.querySelector('#recKeep .tchip').click()`);
await ev(`document.querySelector('input[data-warn]').closest('.cand').querySelector('.cand-main').click()`);
check('勾选含脚本的 Skill → 安装 4', (await applyText()) === '应用所选（安装 4 · 保留 9 · 关闭 117）', await applyText());
check('勾选含脚本的 Skill 弹出审查提示', (await ev(`[...document.querySelectorAll('.toast')].pop().textContent`)).includes('35 个脚本'));
await ev(`document.querySelector('input[data-warn]').click()`);
check('直接点复选框也能取消 → 安装 3', (await applyText()) === '应用所选（安装 3 · 保留 9 · 关闭 117）', await applyText());
await ev(`document.querySelector('#recCard .link').click()`);
check('“查看”链接不改变勾选', (await applyText()) === '应用所选（安装 3 · 保留 9 · 关闭 117）');
await ev(`document.querySelector('#colEnv [data-open-rules]').click()`);
check('对话内“查看规则”打开规则弹窗', await shown('#rulesOv'));
check('从链接打开时不显示“使用这个模式”', await ev(`document.querySelector('#rulesUse').hidden`));
await shot('v3-rules.png');
await key('Escape');
await ev(`document.querySelector('#recApply').click()`);
check('应用后显示确认记录', (await ev(`document.querySelector('#colEnv .ap-done').textContent`)).includes('安装 3 项、保留 9 个、关闭 117 个'));
await sleep(10000);
check('生成 5 条操作记录', (await ev(`[...document.querySelectorAll('#colEnv .act .verb')].slice(-5).map(v => v.textContent).join('|')`)) === '已安装 Skill|已运行|已安装 Skill|已编辑|已编辑', await ev(`[...document.querySelectorAll('#colEnv .act .verb')].slice(-5).map(v => v.textContent).join('|')`));
check('改动面板 5 处改动', (await ev(`document.querySelectorAll('#revBody .rfile').length`)) === 5);
check('顶部改动统计 +214 −0', (await ev(`document.querySelector('#diffStat').textContent`)) === '+214 −0', await ev(`document.querySelector('#diffStat').textContent`));
check('最终回复提到 WANDB_API_KEY', (await ev(`[...document.querySelectorAll('#colEnv .msg.assistant .text')].pop().textContent`)).includes('WANDB_API_KEY'));
check('出现配置报告卡片：11 个专用 Skills', (await ev(`(document.querySelector('#colEnv .report') || {}).textContent || ''`)).includes('11 个'));
check('应用后清单不能再改', await ev(`document.querySelector('#recCard').classList.contains('done')`));
await shot('v3-env-done.png');

// 11. 切回 web 对话，模式恢复为该对话自己的
await ev(`document.querySelector('.sess[data-thread=web]').click()`);
check('切回后恢复该对话的模式', (await label()) === 'Skills 配置', await label());

// 12. 改动面板开关
await ev(`document.querySelector('#btnReview').click()`);
check('改动面板可关闭', await ev(`document.querySelector('#content').classList.contains('no-review')`));
await ev(`document.querySelector('#btnReview').click()`);

// ===== 第 4 版：Codex 功能 =====
const revFiles = () => ev(`document.querySelectorAll('#revBody .rfile').length`);
const scope = s => ev(`document.querySelector('#revScope [data-scope=${s}]').click()`);
// A. 改动面板按范围看、暂存
check('默认范围“上一轮”显示 1 个文件', (await revFiles()) === 1);
await scope('staged');
check('“已暂存”为空', (await revFiles()) === 0 && (await ev(`document.querySelector('#revBody .empty').textContent`)) === '这个范围里没有文件。');
await scope('unstaged');
check('“未暂存”有 1 个文件', (await revFiles()) === 1);
await ev(`document.querySelector('#revBody [data-act=stage]').click()`);
check('暂存后“未暂存”为空', (await revFiles()) === 0);
await scope('staged');
check('暂存后“已暂存”有 1 个文件', (await revFiles()) === 1);
check('提交说明显示已暂存数', (await ev(`document.querySelector('#commitInfo').textContent`)) === '提交到 main（已暂存的 1 个文件）', await ev(`document.querySelector('#commitInfo').textContent`));
await scope('turn');
// B. 行内评论
await ev(`document.querySelectorAll('#revBody .dl')[3].querySelector('.cbtn').click()`);
check('点 + 出现评论框', (await ev(`document.querySelectorAll('#revBody .cbox').length`)) === 1);
await ev(`document.querySelector('#revBody .cbox textarea').value = '这里用 Intl 的默认值就行'`);
await ev(`document.querySelector('#revBody [data-c=send]').click()`);
check('评论显示在那一行下面', (await ev(`document.querySelector('#revBody .cnote').textContent`)).includes('这里用 Intl 的默认值就行'));
check('评论作为消息发给 Claude', (await ev(`[...document.querySelectorAll('#colWeb .msg.user .bubble')].pop().textContent`)).startsWith('【评论】src/utils.ts 第 13 行'), await ev(`[...document.querySelectorAll('#colWeb .msg.user .bubble')].pop().textContent`));
await key('Escape');
await shot('v4-review.png');
// C. 提交并推送
await ev(`document.querySelector('#commitMsg').value = 'feat: 时区参数'`);
await ev(`document.querySelector('#commitMore').click()`);
check('提交方式菜单打开', await shown('#commitMenu'));
await ev(`document.querySelector('[data-commit=push]').click()`);
check('提交记录出现在对话里', (await ev(`[...document.querySelectorAll('#colWeb .ap-done')].pop().textContent`)).includes('已提交并推送到 origin/main：feat: 时区参数'));
check('提交后改动清空', (await ev(`document.querySelector('#diffStat').textContent`)) === '+0 −0' && (await ev(`document.querySelector('#commitBtn').disabled`)));
// D. 终端
await ev(`document.querySelector('#btnTerm').click()`);
check('终端打开', !(await ev(`document.querySelector('#term').hidden`)));
check('终端在项目目录', (await ev(`document.querySelector('#termTitle').textContent`)) === 'pwsh · D:\\demo\\web-app');
await ev(`(() => { const i = document.querySelector('#termInput'); i.value = 'git log -1'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
check('终端能输入命令', (await ev(`document.querySelector('#termOut').textContent`)).includes('git log -1'));
await shot('v4-term.png');
// E. 切到 worktree 对话：终端跟着切到 worktree 目录
await ev(`document.querySelector('.sess[data-thread=wt]').click()`);
check('worktree 对话显示分支标识', !(await ev(`document.querySelector('#wtChip').hidden`)) && (await ev(`document.querySelector('#wtName').textContent`)) === 'lumen/fix-login-k3');
check('显示“接手到本地”', !(await ev(`document.querySelector('#btnHandoff').hidden`)));
check('位置显示 Worktree', (await ev(`document.querySelector('#placeLabel').textContent`)) === 'Worktree');
check('终端切到 worktree 目录', (await ev(`document.querySelector('#termTitle').textContent`)).endsWith('worktrees\\fix-login-k3'));
check('worktree 对话的模式', (await label()) === '自动接受编辑');
await shot('v4-worktree.png');
await ev(`document.querySelector('#placeBtn').click(); document.querySelector('[data-place=local]').click()`);
check('已开始的对话不能换位置', (await ev(`[...document.querySelectorAll('.toast')].pop().textContent`)).includes('不能换位置') && (await ev(`document.querySelector('#placeLabel').textContent`)) === 'Worktree');
await key('`', 2);
check('Ctrl+` 关闭终端', await ev(`document.querySelector('#term').hidden`));
// F. 新对话：选 worktree 后发消息
await ev(`document.querySelector('#btnNew').click()`);
check('新对话显示欢迎页', (await ev(`!!document.querySelector('.col:not([hidden]) .hero')`)));
check('新对话默认询问模式', (await label()) === '默认：询问');
check('新对话默认本地', (await ev(`document.querySelector('#placeLabel').textContent`)) === '本地');
await ev(`document.querySelector('#placeBtn').click(); document.querySelector('[data-place=worktree]').click()`);
check('新对话可以选 worktree', (await ev(`document.querySelector('#placeLabel').textContent`)) === 'Worktree');
await shot('v4-new.png');
await ev(`(() => { const i = document.querySelector('#input'); i.value = '给项目加一个暗色主题'; i.dispatchEvent(new Event('input')); document.querySelector('#sendBtn').click(); })()`);
check('发消息时自动创建 worktree', (await ev(`document.querySelector('.col:not([hidden]) .act .verb').textContent`)) === '已创建 worktree');
check('worktree 分支名', /^lumen\/task-/.test(await ev(`document.querySelector('#wtName').textContent`)));
check('左栏标题变成第一句话', (await ev(`document.querySelector('.sess.active .t').textContent`)) === '给项目加一个暗色主题');
await key('Escape');
await ev(`document.querySelector('#btnNew').click()`);
check('再点新对话又开一个', (await ev(`document.querySelectorAll('.sess[data-thread^=n]').length`)) === 2);
// G. 自动化
await ev(`document.querySelector('#btnAuto').click()`);
check('打开自动化页面', !(await ev(`document.querySelector('#autoView').hidden`)) && (await ev(`document.querySelector('#content').hidden`)));
check('顶栏标题“自动化”', (await ev(`document.querySelector('#hdrTitle').textContent`)) === '自动化');
await shot('v4-auto.png');
await ev(`document.querySelector('#queue [data-q-done]').click()`);
check('标为已读后队列减 1', (await ev(`document.querySelector('#queueCnt').textContent`)) === '1' && (await ev(`document.querySelector('#autoBadge').textContent`)) === '1');
await ev(`document.querySelector('#btnNewAuto').click()`);
check('新建自动化弹窗', await shown('#autoOv'));
await ev(`document.querySelector('#autoSave').click()`);
check('没填完不能保存', await shown('#autoOv'));
await ev(`document.querySelector('#autoName').value = '周报'; document.querySelector('#autoPrompt').value = '每周五汇总本周的提交和实验，写一份周报'; document.querySelector('#autoWhen').value = '每周一'`);
await shot('v4-auto-new.png');
await ev(`document.querySelector('#autoSave').click()`);
check('保存后表格多一行', (await ev(`document.querySelectorAll('#autoTbl tr').length`)) === 5 && !(await shown('#autoOv')));
await ev(`document.querySelector('#autoTbl .mini-sw').click()`);
check('开关可以暂停', !(await ev(`document.querySelector('#autoTbl .mini-sw').classList.contains('on')`)));
await ev(`document.querySelector('.sess[data-thread=web]').click()`);
check('点对话回到聊天界面', (await ev(`document.querySelector('#autoView').hidden`)) && !(await ev(`document.querySelector('#content').hidden`)) && !(await ev(`document.querySelector('#topActions').hidden`)));

// 13. 管理弹窗 + 设置里的规则入口（叠层）
await ev(`document.querySelector('[data-manage=settings]').click()`);
check('设置打开', await ev(`document.querySelector('#m-settings').classList.contains('active')`));
await shot('v2-settings.png');
await ev(`document.querySelector('#m-settings [data-open-rules]').click()`);
check('设置里打开规则，叠在上层', await shown('#rulesOv') && await shown('#manageOv'));
await key('Escape');
check('Esc 先关最上层', !(await shown('#rulesOv')) && await shown('#manageOv'));
await key('Escape');

// 14. 浅色主题截图
await ev(`document.querySelector('#btnTheme').click()`);
await sleep(200);
await shot('v2-light.png');
await ev(`document.querySelector('.sess[data-thread=env]').click()`);
await shot('v2-light-env.png');

// 15. 拒绝流程（重新加载）
await send('Page.navigate', { url: 'about:blank' });
await sleep(300);
await send('Page.navigate', { url: pageUrl + '#noguide' });
await sleep(1000);
await ev(`document.querySelector('[data-ap=deny]').click()`);
await ev(`document.querySelector('#denyReason').value = '我还要改一下'`);
await ev(`document.querySelector('[data-ap=denySend]').click()`);
check('拒绝后显示原因', (await ev(`document.querySelector('.ap-done.deny').textContent`)).includes('我还要改一下'));
// 取消完全访问确认，模式不变
await ev(`document.querySelector('#modeBtn').click(); document.querySelector('[data-mode=bypass]').click()`);
await ev(`document.querySelector('#faOv [data-close]').click()`);
check('取消确认后模式不变', (await label()) === '默认：询问');

check('无 JS 运行错误', errors.length === 0, errors.join(' | '));
console.log(results.join('\n'));
console.log(`--- ${results.filter(r => r.startsWith('PASS')).length}/${results.length} 通过`);
ws.close();
chrome.kill();
process.exit(0);
