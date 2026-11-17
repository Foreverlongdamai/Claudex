// 整体布局和全局快捷键。
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Composer } from './components/Composer';
import { Dialogs } from './components/Dialogs';
import { ReviewPanel } from './components/ReviewPanel';
import { TaskBoard } from './components/Board';
import { AutomationView } from './components/Automation';
import { HistoryView } from './components/History';
import { Sidebar } from './components/Sidebar';
import { TerminalPanel } from './components/TerminalPanel';
import { Thread } from './components/Thread';
import { TopBar } from './components/TopBar';
import { Welcome } from './components/Welcome';
import { DROP_EVENT, TERM_DROP_EVENT, droppedFiles } from './drop';
import { MODE_ORDER } from './modes';
import { useStore } from './store';

export function App() {
  const ready = useStore(s => s.ready);
  const hasProjects = useStore(s => (s.app?.projects.length ?? 0) > 0);
  const toasts = useStore(s => s.toasts);
  const view = useStore(s => s.view);

  useEffect(() => {
    void useStore.getState().init();
  }, []);

  // 把文件拖进窗口时，Electron 默认会直接打开那个文件（整个界面被替换掉），先全部拦住；对话区再单独处理
  useEffect(() => {
    const block = (e: globalThis.DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => { window.removeEventListener('dragover', block); window.removeEventListener('drop', block); };
  }, []);

  // 拖文件到对话区：松开后交给输入框作为附件；拖到终端上则把路径粘贴进终端
  const [dropTarget, setDropTarget] = useState<'chat' | 'terminal' | null>(null);
  const dragDepth = useRef(0);
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const overTerminal = (e: DragEvent) => !!(e.target as HTMLElement | null)?.closest?.('.term-panel');
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => { if (hasFiles(e)) { dragDepth.current++; setDropTarget(overTerminal(e) ? 'terminal' : 'chat'); } },
    onDragLeave: (e: DragEvent) => { if (hasFiles(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDropTarget(null); } },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const t = overTerminal(e) ? 'terminal' : 'chat';
      if (t !== dropTarget) setDropTarget(t);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDropTarget(null);
      window.dispatchEvent(new CustomEvent(overTerminal(e) ? TERM_DROP_EVENT : DROP_EVENT, { detail: droppedFiles(e.dataTransfer) }));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.isComposing) return;
      if (e.ctrlKey && e.code === 'Backquote') {
        e.preventDefault();
        if (!s.dialog && s.app?.projects.length) s.toggleTerminal();
        return;
      }
      // 焦点在终端里时，按键都交给终端里的程序
      if ((e.target as HTMLElement | null)?.closest?.('.term-panel')) return;
      if (e.key === 'Escape') {
        if (s.dialog) { s.closeDialog(); return; }
        const conv = s.activeId ? s.convs[s.activeId] : null;
        if (conv && (conv.status === 'running' || conv.status === 'starting')) void s.interrupt();
        return;
      }
      if (s.dialog) return;
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        const cur = s.activeId ? s.convs[s.activeId]?.meta.mode : s.draft?.mode;
        if (!cur) return;
        s.requestMode(MODE_ORDER[(MODE_ORDER.indexOf(cur) + 1) % MODE_ORDER.length]);
        return;
      }
      if (e.ctrlKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (s.app?.projects.length) s.setView(s.view === 'search' ? 'chat' : 'search');
        return;
      }
      if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        if (s.app?.projects.length) s.startDraft();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) return <div className="loading"><i className="spin" />正在启动…</div>;
  return (
    <div className="app">
      <Sidebar />
      <div className="mainwrap">
        <TopBar />
        {view === 'automation' ? <div className="content"><AutomationView /></div> : view === 'search' ? <div className="content"><HistoryView /></div> : view === 'board' && hasProjects ? <div className="content"><TaskBoard /></div> : (
        <div className="content">
        <main className="chat" {...(hasProjects ? dropHandlers : {})}>
          {hasProjects ? <><Thread /><Composer /><TerminalPanel /></> : <Welcome />}
          {dropTarget && (
            <div className={`drop-overlay${dropTarget === 'terminal' ? ' terminal' : ''}`} data-testid="drop-overlay">
              <div className="drop-card">
                {dropTarget === 'terminal'
                  ? <><b>松开把文件路径粘贴到终端</b><span>拖到上面的对话区则作为附件发给 Claude</span></>
                  : <><b>松开添加为附件</b><span>Word、PDF、Excel、PPT、录音、视频都行；图片直接发给 Claude 看，其他文件只带路径，不复制</span></>}
              </div>
            </div>
          )}
        </main>
        {hasProjects && <ReviewPanel />}
        </div>
        )}
      </div>
      <Dialogs />
      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast">{t.text}</div>)}</div>
    </div>
  );
}
