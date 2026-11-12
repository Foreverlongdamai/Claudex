// 内置终端面板（C1）：对话区底部，跟着当前对话切换。一个 xterm 实例，切对话时重放对应终端之前的输出。
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { ShellInfo, ShellKind, TermInfo } from '@shared/types';
import { useStore } from '../store';
import { Icon } from './Icon';

const api = window.claudex;
const HEIGHT_KEY = 'claudex.terminalHeight';

const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: { background: '#161616', foreground: '#e6e6e6', cursor: '#e6e6e6', cursorAccent: '#161616', selectionBackground: 'rgba(255,255,255,.22)' },
  light: {
    background: '#f7f7f7', foreground: '#1a1a1a', cursor: '#1a1a1a', cursorAccent: '#f7f7f7', selectionBackground: 'rgba(0,0,0,.15)',
    black: '#1a1a1a', red: '#c4262f', green: '#13784a', yellow: '#8a5a00', blue: '#0b5cad', magenta: '#8a3ab9', cyan: '#0e7490', white: '#6b6b6b',
    brightBlack: '#5d5d5d', brightRed: '#d63a42', brightGreen: '#1d8f5a', brightYellow: '#9a6700', brightBlue: '#1f6fd1', brightMagenta: '#9d4fcc', brightCyan: '#13879f', brightWhite: '#8e8e8e'
  }
};

const exitMessage = (code?: number) => `\r\n\x1b[90m[进程已退出${code !== undefined ? `（代码 ${code}）` : ''}。按任意键重新启动]\x1b[0m\r\n`;

function savedHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return v >= 120 ? v : 260;
  } catch {
    return 260;
  }
}

export function TerminalPanel() {
  const open = useStore(s => s.terminalOpen);
  const key = useStore(s => s.activeId ?? (s.activeProject ? `project:${s.activeProject}` : null));
  const cwd = useStore(s => (s.activeId ? s.convs[s.activeId]?.meta.projectPath : s.activeProject) ?? null);
  const shellPref = useStore(s => s.app?.prefs.terminalShell ?? 'powershell');
  const theme = useStore(s => s.app?.prefs.theme ?? 'dark');
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const current = useRef<TermInfo | null>(null);
  const exited = useRef(false);
  /** 正在重放历史输出。历史里有终端查询（比如 ConPTY 启动时问“你是什么终端”），xterm 会自动回答，
   *  重放时这些回答不能发给 shell，否则会被当成用户输入（C1 实测：bash 里冒出 “1;2c”） */
  const replaying = useRef(false);
  const [info, setInfo] = useState<TermInfo | null>(null);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [height, setHeight] = useState(savedHeight);

  /**
   * 按面板大小重新排版。终端进程那边尽量少改大小：Git Bash 在等输入时被改大小，会吃掉下一个按键
   * （C1 实测约 1/5，PowerShell 没这个问题）。所以行列数真的变了才发，拖动面板时等停下来再发。
   */
  const resizeTimer = useRef<number | null>(null);
  const syncSize = () => {
    const t = term.current, f = fit.current;
    if (!t || !f || !host.current?.offsetParent) return;
    try { f.fit(); } catch { /* 面板刚隐藏 */ }
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = window.setTimeout(() => {
      resizeTimer.current = null;
      const c = current.current;
      if (!c || (c.cols === t.cols && c.rows === t.rows)) return;
      c.cols = t.cols;
      c.rows = t.rows;
      api.termResize(c.id, t.cols, t.rows);
    }, 150);
  };

  /** 面板现在放得下的行列数：新建、重启终端时直接按它启动，免得启动后马上改大小 */
  const panelSize = () => {
    const t = term.current!;
    if (host.current?.offsetParent) {
      try { fit.current?.fit(); } catch { /* 同上 */ }
    }
    return { cols: t.cols, rows: t.rows };
  };

  /** 显示某个终端（重放它之前的输出）。focus：要不要把键盘焦点给终端（切换对话时焦点留在输入框） */
  const show = (ti: TermInfo, focus = true) => {
    current.current = ti;
    exited.current = !ti.alive;
    setInfo(ti);
    const t = term.current!;
    t.reset();
    if (ti.buffer) {
      replaying.current = true;
      t.write(ti.buffer, () => { replaying.current = false; });
    }
    if (!ti.alive) t.write(exitMessage(ti.exitCode));
    if (focus) t.focus();
    requestAnimationFrame(syncSize);
  };

  const restart = async (shell: ShellKind) => {
    const c = current.current;
    if (c) show(await api.termRestart(c.id, shell, panelSize()));
  };

  // 第一次打开面板时创建 xterm
  useEffect(() => {
    if (!open || term.current || !host.current) return;
    const t = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace',
      fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: THEMES[theme]
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon((_e, uri) => void api.openExternal(uri)));
    t.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true;
      // Ctrl+`：交给 App 开关面板
      if (e.ctrlKey && e.code === 'Backquote') return false;
      if (!e.ctrlKey || e.altKey) return true;
      const k = e.key.toLowerCase();
      // 粘贴：Ctrl+V / Ctrl+Shift+V 交给浏览器的粘贴事件，xterm 会按终端的规矩处理（不然 xterm 会把 Ctrl+V 当成 ^V 发给 shell）
      if (k === 'v') return false;
      // 复制：Ctrl+Shift+C，或者选中了文字时的 Ctrl+C；没选中时 Ctrl+C 照常发给程序（中断）
      if (k === 'c' && (e.shiftKey || t.hasSelection())) {
        if (t.hasSelection()) {
          void navigator.clipboard.writeText(t.getSelection());
          t.clearSelection();
        }
        return false;
      }
      return true;
    });
    // ConPTY 启动时会打开“焦点汇报”（CSI ? 1004 h），之后终端每次获得/失去焦点，xterm 都会往输入里塞 ESC[I / ESC[O，
    // Git Bash 会把它们当成按键（C1 实测：提示符被莫名重画，有时还吞掉下一个按键）。我们用不到焦点汇报，不让 xterm 打开它
    t.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => params.length === 1 && params[0] === 1004);
    t.open(host.current);
    t.onData(d => {
      const c = current.current;
      if (!c) return;
      if (replaying.current) return;
      if (exited.current) { void restart(c.shell); return; }
      api.termWrite(c.id, d);
    });
    term.current = t;
    fit.current = f;
    void api.listShells().then(setShells);
  }, [open]);

  // 终端输出
  useEffect(() => api.onTerm(ev => {
    const c = current.current;
    if (!c || ev.id !== c.id) return;
    if (ev.kind === 'data') term.current?.write(ev.data);
    else {
      exited.current = true;
      term.current?.write(exitMessage(ev.exitCode));
      setInfo(i => (i ? { ...i, alive: false, exitCode: ev.exitCode } : i));
    }
  }), []);

  // 打开面板、或者切换了对话：接上对应的终端（没有就新建）。
  // 刚打开面板时焦点给终端；只是切换对话时焦点留在输入框（输入框自己会抢焦点，这里不跟它抢）
  const wasOpen = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    const justClosed = !open && wasOpen.current;
    wasOpen.current = open;
    const focused = document.activeElement;
    if (justClosed && (!focused || focused === document.body || host.current?.contains(focused))) {
      document.querySelector<HTMLTextAreaElement>('[data-testid=composer-input]')?.focus();
    }
    if (!open || !key || !cwd || !term.current) return;
    if (current.current?.key === key) {
      if (justOpened) term.current.focus();
      requestAnimationFrame(syncSize);
      return;
    }
    let cancelled = false;
    void api.termOpen(key, cwd, shellPref, panelSize()).then(ti => {
      if (cancelled) return;
      // 同一个终端换了归属（草稿变成了正式对话），画面不用重放
      if (ti.id === current.current?.id) { current.current = ti; setInfo(ti); return; }
      show(ti, justOpened);
    });
    return () => { cancelled = true; };
  }, [open, key, cwd]);

  useEffect(() => { if (term.current) term.current.options.theme = THEMES[theme]; }, [theme]);

  useEffect(() => {
    if (!host.current) return;
    const ro = new ResizeObserver(() => syncSize());
    ro.observe(host.current);
    return () => ro.disconnect();
  }, []);

  // 拖动面板上沿调整高度
  const startDrag = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let h = startH;
    const move = (ev: MouseEvent) => {
      h = Math.max(120, Math.min(window.innerHeight - 220, startH + startY - ev.clientY));
      setHeight(h);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      try { localStorage.setItem(HEIGHT_KEY, String(Math.round(h))); } catch { /* 存不了就算了 */ }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const kill = async () => {
    const c = current.current;
    if (!c) return;
    await api.termKill(c.id);
    current.current = null;
    setInfo(null);
    term.current?.reset();
    useStore.getState().toggleTerminal(false);
  };

  return (
    <div className="term-panel" hidden={!open} style={{ height }} data-testid="terminal-panel">
      <div className="term-drag" onMouseDown={startDrag} title="拖动调整高度" />
      <div className="term-head">
        <Icon name="term" size={14} />
        <select data-testid="terminal-shell" value={info?.shell ?? shellPref} title="切换 shell（会重新启动终端）"
          onChange={e => {
            const sh = e.target.value as ShellKind;
            void useStore.getState().setPrefs({ terminalShell: sh });
            void restart(sh);
          }}>
          {shells.map(s => <option key={s.kind} value={s.kind} disabled={!s.available}>{s.label}{s.available ? '' : '（没找到）'}</option>)}
        </select>
        <span className="term-cwd" title={info?.cwd}>{info?.cwd}</span>
        <span className="sp" />
        <button className="ibtn sm" title="重新启动终端" onClick={() => info && void restart(info.shell)}><Icon name="refresh" size={14} /></button>
        <button className="ibtn sm" title="结束终端（连同里面运行的程序）" data-testid="terminal-kill" onClick={() => void kill()}><Icon name="trash" size={14} /></button>
        <button className="ibtn sm" title="收起（终端继续在后台运行）  Ctrl+`" onClick={() => useStore.getState().toggleTerminal(false)}><Icon name="down" size={14} /></button>
      </div>
      <div className="term-host" ref={host} onMouseUp={() => term.current?.focus()} />
    </div>
  );
}
