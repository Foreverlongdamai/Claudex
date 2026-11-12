// 整体布局和全局快捷键。
import { useEffect } from 'react';
import { Composer } from './components/Composer';
import { Dialogs } from './components/Dialogs';
import { Sidebar } from './components/Sidebar';
import { TerminalPanel } from './components/TerminalPanel';
import { Thread } from './components/Thread';
import { TopBar } from './components/TopBar';
import { Welcome } from './components/Welcome';
import { MODE_ORDER } from './modes';
import { useStore } from './store';

export function App() {
  const ready = useStore(s => s.ready);
  const hasProjects = useStore(s => (s.app?.projects.length ?? 0) > 0);
  const toasts = useStore(s => s.toasts);

  useEffect(() => {
    void useStore.getState().init();
  }, []);

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
        <main className="chat">
          {hasProjects ? <><Thread /><Composer /><TerminalPanel /></> : <Welcome />}
        </main>
      </div>
      <Dialogs />
      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast">{t.text}</div>)}</div>
    </div>
  );
}
