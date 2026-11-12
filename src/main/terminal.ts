// 内置终端（C1）：每个对话一个终端进程（node-pty），界面用 xterm.js 显示。
// 切到别的对话时进程继续跑（比如开着的开发服务器），切回来时把之前的输出重新显示。
// 结束终端用 taskkill /T 结束整个进程树（顺带把终端里启动的子进程也结束掉，不留孤儿进程），
// Git Bash 里脱离进程树的程序另外用 /proc 找出来（见 msysProcesses）。
// node-pty 的 kill() 只结束 shell 本身，不管它启动的程序；而且系统 ConPTY 模式下它会 fork 一个辅助进程，
// 在 Electron 里报 “AttachConsole failed”（M0）。
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import type { IPty } from 'node-pty';
import type { ShellInfo, ShellKind, TermEvent, TermInfo } from '../shared/types';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');

const MAX_BUFFER = 256 * 1024;

let pwshCache: string | null | undefined;
/** PowerShell 7（pwsh）装了就用它，否则用 Windows 自带的 PowerShell */
function findPwsh(): string | null {
  if (pwshCache !== undefined) return pwshCache;
  try {
    pwshCache = execFileSync('where', ['pwsh'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).split(/\r?\n/)[0].trim() || null;
  } catch {
    pwshCache = null;
  }
  return pwshCache;
}

export function listShells(gitBash: string | null): ShellInfo[] {
  const pwsh = findPwsh();
  return [
    { kind: 'powershell', label: pwsh ? 'PowerShell 7' : 'Windows PowerShell', path: pwsh ?? 'powershell.exe', available: true },
    { kind: 'gitbash', label: 'Git Bash', path: gitBash, available: !!gitBash },
    { kind: 'cmd', label: '命令提示符', path: process.env.ComSpec ?? 'cmd.exe', available: true }
  ];
}

/**
 * 终端进程结束后，释放 node-pty 为它开的输入管道和读输出的 worker 线程（每个 worker 是一个独立的 V8，几 MB 内存）。
 * node-pty 1.1.0 进程退出后只关了输出管道，这两样不会自己释放（C1 实测）。不能调 kill()：它会 fork 一个辅助进程，
 * 在 Electron 里报错（M0）。用的是内部字段，所以 package.json 里锁死了 node-pty 的版本，升级时 E2E 第 24 步会检查。
 */
function releasePty(proc: IPty): void {
  const agent = (proc as unknown as { _agent?: { _inSocket?: { destroy(): void }; _conoutSocketWorker?: { dispose(): void } } })._agent;
  try {
    agent?._inSocket?.destroy();
  } catch {
    // 已经关了
  }
  try {
    agent?._conoutSocketWorker?.dispose();
  } catch {
    // 同上
  }
}

export interface TermSize { cols: number; rows: number }

function validSize(size?: TermSize): TermSize {
  const ok = (n: unknown, min: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= 1000;
  return size && ok(size.cols, 2) && ok(size.rows, 1) ? { cols: Math.floor(size.cols), rows: Math.floor(size.rows) } : { cols: 120, rows: 30 };
}

/** pty.spawn() 调用前后的时间。ConPTY 的 conhost.exe 就是在这次调用里同步创建的，所以它的创建时间一定落在这个区间里 */
type SpawnWindow = [number, number];

interface Term {
  id: string;
  key: string;
  shell: ShellKind;
  cwd: string;
  proc: IPty | null;
  /** 当前进程的 spawn 时间窗，用来认出它的 conhost.exe */
  spawned: SpawnWindow | null;
  /** 终端当前的行列数 */
  cols: number;
  rows: number;
  buffer: string;
  exitCode?: number;
  pending: string;
  timer: NodeJS.Timeout | null;
}

export class TerminalManager {
  private terms = new Map<string, Term>();

  constructor(
    private emit: (ev: TermEvent) => void,
    private gitBash: () => string | null,
    private log: (line: string) => void
  ) {}

  private command(id: string, shell: ShellKind): { file: string; args: string[]; env: Record<string, string>; shell: ShellKind } {
    // CLAUDEX_TERM_ID：终端里启动的所有程序都会继承它，结束终端时靠它找出 Git Bash 里“脱离了进程树”的程序
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TERM_PROGRAM: 'Claudex', COLORTERM: 'truecolor', CLAUDEX_TERM_ID: id };
    delete env.ELECTRON_RUN_AS_NODE;
    if (shell === 'gitbash') {
      const bash = this.gitBash();
      // CHERE_INVOKING=1：Git Bash 的登录脚本默认会 cd 到用户目录，有了它才会停在项目目录
      if (bash) return { file: bash, args: ['--login', '-i'], env: { ...env, CHERE_INVOKING: '1', MSYSTEM: 'MINGW64' }, shell };
      shell = 'powershell'; // 没找到 Git Bash，退回 PowerShell
    }
    if (shell === 'cmd') return { file: process.env.ComSpec ?? 'cmd.exe', args: [], env, shell };
    return { file: findPwsh() ?? 'powershell.exe', args: ['-NoLogo'], env, shell: 'powershell' };
  }

  private label(shell: ShellKind): string {
    return listShells(this.gitBash()).find(s => s.kind === shell)?.label ?? shell;
  }

  private start(t: Term): void {
    const { file, args, env, shell } = this.command(t.id, t.shell);
    t.shell = shell;
    const cwd = fs.existsSync(t.cwd) ? t.cwd : os.homedir();
    // 用系统自带的 ConPTY。node-pty 自带的新版 ConPTY（useConptyDll）不漏 conhost，但上一条命令还没结束就接着打字时，
    // Git Bash 里大约每 8 次有 1 次字符错位（C1 实测 5/40，系统版 0/40），所以不用它，conhost 由 reapConsoleHosts 清理
    const t0 = Date.now();
    // 直接按面板的实际大小启动：Git Bash 在等输入时被改大小，会吃掉下一个按键（C1 实测约 1/5），启动后马上改大小正好撞上
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: t.cols, rows: t.rows, cwd, env });
    const spawned: SpawnWindow = [t0, Date.now()];
    t.proc = proc;
    t.spawned = spawned;
    t.exitCode = undefined;
    // 重启后旧进程还可能晚到一点输出（里面可能有终端查询序列），不能混进新终端
    proc.onData(d => { if (t.proc === proc) this.push(t, d); });
    proc.onExit(({ exitCode }) => {
      releasePty(proc);
      this.reapConsoleHost(spawned);
      if (t.proc !== proc) return; // 是我们自己结束的（重启或关闭），不用通知
      this.flush(t);
      t.proc = null;
      t.exitCode = exitCode;
      this.emit({ kind: 'exit', id: t.id, exitCode });
    });
    this.log(`终端启动：${file}（${cwd}）`);
  }

  private reapQueue: SpawnWindow[] = [];
  private reapTimer: NodeJS.Timeout | null = null;

  /**
   * 结束已经退出的终端留下的 conhost.exe。node-pty 1.1.0 在 shell 一退出就丢掉了伪控制台的句柄，
   * 没法再正常关闭它，conhost.exe 会一直留到 Claudex 退出（每个几 MB，C1 实测）。
   * 它是 Claudex 主进程的子进程，创建时间落在对应 pty.spawn() 调用的时间窗里，按这个认出来再结束。
   * 查进程要起 PowerShell（几百毫秒），所以攒一下批量做，也不阻塞主进程。
   */
  private reapConsoleHost(win: SpawnWindow): void {
    this.reapQueue.push(win);
    this.reapTimer ??= setTimeout(() => this.runReap(), 500);
  }

  private runReap(): void {
    const dead = this.reapQueue;
    this.reapQueue = [];
    this.reapTimer = null;
    const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='conhost.exe'" | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      if (err) {
        this.log(`查找终端留下的 conhost 失败：${err.message}`);
        return;
      }
      // 时间窗前后各留 2ms 的取整误差；同时落在还活着的终端的时间窗里的不动，宁可漏掉也不误杀
      const hit = (w: SpawnWindow, at: number) => at >= w[0] - 2 && at <= w[1] + 2;
      const live = [...this.terms.values()].filter(t => t.proc && t.spawned).map(t => t.spawned!);
      for (const line of stdout.split(/\r?\n/)) {
        const [pid, created] = line.trim().split(' ').map(Number);
        if (!pid || !created || !dead.some(w => hit(w, created)) || live.some(w => hit(w, created))) continue;
        try {
          process.kill(pid);
        } catch {
          // 已经没了
        }
      }
    });
  }

  /** 输出攒 10ms 再发给界面，命令刷屏时不会把界面卡住 */
  private push(t: Term, data: string): void {
    t.buffer += data;
    if (t.buffer.length > MAX_BUFFER) {
      // 从换行处截断，免得从一个颜色控制码中间开始，重新显示时出乱码
      const cut = t.buffer.indexOf('\n', t.buffer.length - MAX_BUFFER);
      t.buffer = t.buffer.slice(cut >= 0 ? cut + 1 : t.buffer.length - MAX_BUFFER);
    }
    t.pending += data;
    t.timer ??= setTimeout(() => this.flush(t), 10);
  }

  private flush(t: Term): void {
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    if (!t.pending) return;
    this.emit({ kind: 'data', id: t.id, data: t.pending });
    t.pending = '';
  }

  private info(t: Term): TermInfo {
    return { id: t.id, key: t.key, shell: t.shell, shellLabel: this.label(t.shell), cwd: t.cwd, alive: !!t.proc, exitCode: t.exitCode, buffer: t.buffer, cols: t.cols, rows: t.rows };
  }

  /**
   * Git Bash 里的 msys 程序（比如 sleep），以及 Git Bash 默认用 winpty 包起来启动的 node、python 等，
   * 在 Windows 进程树里和 shell 是断开的，taskkill /T 找不到它们（C1 实测）。
   * 但它们都继承了 CLAUDEX_TERM_ID，用 msys 自己的 /proc 就能找出来。返回 终端 id → Windows 进程号。
   */
  private msysProcesses(): Map<string, number[]> {
    const found = new Map<string, number[]>();
    const bash = this.gitBash();
    if (!bash) return found;
    // 只用 bash 内置命令，不依赖 PATH 里有没有 grep、cat
    const script = 'for p in /proc/[0-9]*; do while IFS= read -r -d "" v; do if [[ $v == CLAUDEX_TERM_ID=* ]]; then read -r w < "$p/winpid" && echo "${v#*=} $w"; break; fi; done < "$p/environ"; done 2>/dev/null; true';
    try {
      const out = execFileSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      for (const line of out.split(/\r?\n/)) {
        const [id, pid] = line.trim().split(' ');
        if (id && Number(pid) > 0) found.set(id, [...(found.get(id) ?? []), Number(pid)]);
      }
    } catch (e) {
      this.log(`查找 Git Bash 子进程失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return found;
  }

  /** 结束这些终端的整个进程树。先把 proc 置空，这样 onExit 不会把“我们自己结束的”当成意外退出 */
  private kill(...ts: Term[]): void {
    const live = ts.filter(t => t.proc);
    if (!live.length) return;
    const extra = live.some(t => t.shell === 'gitbash') ? this.msysProcesses() : new Map<string, number[]>();
    const pids: number[] = [];
    for (const t of live) {
      pids.push(t.proc!.pid, ...(extra.get(t.id) ?? []));
      t.proc = null;
      this.flush(t);
    }
    try {
      execFileSync('taskkill', ['/F', '/T', ...pids.flatMap(p => ['/pid', String(p)])], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    } catch {
      // 有的进程已经不在了，taskkill 会报错，不影响其他的
    }
    // node-pty 的资源在各自的 onExit 里释放
  }

  /** size：界面上面板的行列数，新建终端时按它启动 */
  open(key: string, cwd: string, shell: ShellKind, size?: TermSize): TermInfo {
    const existing = [...this.terms.values()].find(t => t.key === key);
    if (existing) {
      // 先把攒着没发的输出发掉，否则它既在返回的 buffer 里、稍后又会作为新输出再发一次，重放时就重复了
      this.flush(existing);
      return this.info(existing);
    }
    const t: Term = { id: randomUUID(), key, shell, cwd, proc: null, spawned: null, ...validSize(size), buffer: '', pending: '', timer: null };
    this.terms.set(t.id, t);
    this.start(t);
    return this.info(t);
  }

  restart(id: string, shell: ShellKind, size?: TermSize): TermInfo {
    const t = this.terms.get(id);
    if (!t) throw new Error('终端不存在');
    this.kill(t);
    t.shell = shell;
    if (size) Object.assign(t, validSize(size));
    t.buffer = '';
    t.pending = '';
    this.start(t);
    return this.info(t);
  }

  /** 新对话还没发消息时开的终端（挂在“项目”名下），第一条消息发出、对话建好后转给这个对话 */
  rekey(from: string, to: string): void {
    const all = [...this.terms.values()];
    const t = all.find(x => x.key === from);
    if (t && !all.some(x => x.key === to)) t.key = to;
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.proc?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (!t || cols < 2 || rows < 1) return;
    cols = Math.floor(cols);
    rows = Math.floor(rows);
    // 大小没变就不动：每次改大小 Git Bash 都可能吃掉下一个按键
    if (cols === t.cols && rows === t.rows) return;
    t.cols = cols;
    t.rows = rows;
    try {
      t.proc?.resize(cols, rows);
    } catch {
      // 进程刚好退出
    }
  }

  close(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    this.kill(t);
    this.terms.delete(id);
  }

  /** 对话被删除、项目被移除时，结束对应的终端 */
  closeKeys(match: (key: string) => boolean): void {
    for (const t of [...this.terms.values()]) if (match(t.key)) this.close(t.id);
  }

  closeAll(): void {
    this.kill(...this.terms.values());
    this.terms.clear();
  }
}
