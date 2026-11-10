// 09 Electron 主进程里能不能：1) 用 node-pty 开 PowerShell / Git Bash 终端；2) 直接用 Claude Agent SDK。
// 运行：npx electron main.mjs（不开窗口，跑完自动退出，结果写到 ../results/09-electron-pty.json）
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const GIT_BASH = 'D:\\git\\Git\\bin\\bash.exe';
const checks = [];
const notes = {};
const check = (label, ok, detail) => { checks.push({ label, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  (' + JSON.stringify(detail).slice(0, 200) + ')' : ''}`); };
const note = (k, v) => { notes[k] = v; console.log(`NOTE  ${k}: ${JSON.stringify(v)}`); };

process.on('uncaughtException', e => console.log('主进程未捕获异常:', e?.message || e));

/**
 * 在伪终端里跑一个 shell，写入一条命令，等输出里出现期望的文本。
 * 结束时先发 exit 让 shell 自己退出；直接 kill() 在 Electron 里会触发 node-pty 的
 * conpty_console_list_agent 报 “AttachConsole failed”。
 */
function runInPty(pty, file, args, command, expect) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: here, env: process.env });
    let buf = '';
    let found = false;
    let exited = false;
    let exitMs = null;
    p.onExit(() => { exited = true; exitMs = Date.now() - t0; });
    const finish = () => resolve({ ok: found, ms: Date.now() - t0, exitedGracefully: exited, exitMs, tail: buf.slice(-160) });
    const timer = setTimeout(finish, 20000);
    p.onData(d => {
      buf += d;
      if (!found && buf.includes(expect)) {
        found = true;
        p.write('exit\r');
        // 最多等 5 秒让 shell 自己退出
        const wait = setInterval(() => { if (exited) { clearInterval(wait); clearTimeout(timer); finish(); } }, 100);
        setTimeout(() => { clearInterval(wait); clearTimeout(timer); finish(); }, 5000);
      }
    });
    p.write(command + '\r');
  });
}

app.whenReady().then(async () => {
  note('版本', { electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules });

  // 1. node-pty
  try {
    const pty = require('node-pty');
    // 用算式让输出和回显不同：回显是表达式，只有真的执行了才会出现 42
    const ps = await runInPty(pty, 'powershell.exe', ['-NoLogo', '-NoProfile'], 'Write-Output ("PTY-OK-" + (40+2))', 'PTY-OK-42');
    check('node-pty 在 Electron 里开 PowerShell 终端', ps.ok, { ms: ps.ms });
    check('PowerShell 终端能正常退出（不用强杀）', ps.exitedGracefully, { exitMs: ps.exitMs });
    const gb = await runInPty(pty, GIT_BASH, ['--login', '-i'], 'echo "BASH-OK-$((40+2))"', 'BASH-OK-42');
    check('node-pty 在 Electron 里开 Git Bash 终端', gb.ok, { ms: gb.ms, tail: gb.ok ? undefined : gb.tail });
    check('Git Bash 终端能正常退出（不用强杀）', gb.exitedGracefully, { exitMs: gb.exitMs });
  } catch (e) {
    check('node-pty 能在 Electron 里加载', false, String(e?.message || e));
  }

  // 2. SDK 在 Electron 主进程里（只调 supportedModels，不花 token）
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const idle = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
    const q = query({ prompt: idle, options: { cwd: here, permissionMode: 'default', persistSession: false, env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: GIT_BASH } } });
    const models = await q.supportedModels();
    q.close();
    check('Claude Agent SDK 能在 Electron 主进程里用', models.length > 0, models.map(m => m.value));
  } catch (e) {
    check('Claude Agent SDK 能在 Electron 主进程里用', false, String(e?.message || e));
  }

  fs.mkdirSync(path.join(here, '..', 'results'), { recursive: true });
  fs.writeFileSync(path.join(here, '..', 'results', '09-electron-pty.json'), JSON.stringify({ name: '09-electron-pty', at: new Date().toISOString(), checks, notes }, null, 2));
  const failed = checks.filter(c => !c.ok).length;
  console.log(`--- 09-electron-pty: ${checks.length - failed}/${checks.length} 通过`);
  app.quit();
});
