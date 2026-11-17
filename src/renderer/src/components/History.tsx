// 搜索（M2）：Claude Code 的全部会话（Claudex 里的和命令行里的），按标题和对话内容搜索，打开接着聊。
import { useEffect, useRef, useState } from 'react';
import type { HistorySearchHit } from '@shared/types';
import { describeWhen } from '@shared/schedule';
import { useStore } from '../store';
import { Icon } from './Icon';

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** 摘录里把关键词标出来 */
function Mark({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function Hit({ h, q }: { h: HistorySearchHit; q: string }) {
  const s = h.session;
  const project = useStore(st => st.app?.projects.find(p => p.path === s.projectPath)?.name ?? baseName(s.projectPath));
  const { openSession } = useStore.getState();
  const [busy, setBusy] = useState(false);
  const open = async () => { setBusy(true); await openSession(s.sessionId, s.projectPath); setBusy(false); };
  return (
    <div className="hit" data-testid="history-item" data-session={s.sessionId} onDoubleClick={() => void open()}>
      <div className="hit-main">
        <b><Mark text={s.title} q={h.where === 'title' ? q : ''} /></b>
        <span className="hit-meta">
          {project} · {describeWhen(s.lastModified)}
          {s.gitBranch ? ` · ${s.gitBranch}` : ''}
          {s.convId ? (s.employee ? <span className="hit-tag">员工</span> : s.automation ? <span className="hit-tag">自动化</span> : <span className="hit-tag">Claudex</span>) : <span className="hit-tag cli">命令行</span>}
          {h.where === 'content' && <span className="hit-tag">内容里有</span>}
        </span>
        {h.snippet && <span className="hit-snip"><Mark text={h.snippet} q={q} /></span>}
      </div>
      <button className="btn sm" data-testid="history-open" disabled={busy} onClick={() => void open()}>{s.convId ? '打开' : '打开接着聊'}</button>
    </div>
  );
}

export function HistoryView() {
  const activeProject = useStore(s => s.activeProject);
  const hasProjects = useStore(s => !!s.app?.projects.length);
  const { setView } = useStore.getState();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'project' | 'all'>(activeProject ? 'project' : 'all');
  const [hits, setHits] = useState<HistorySearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      setErr(null);
      try {
        const r = await window.claudex.searchHistory(q, scope === 'project' ? activeProject : null);
        if (my === seq.current) setHits(r);
      } catch (e) {
        if (my === seq.current) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (my === seq.current) setBusy(false);
      }
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, scope, activeProject]);
  const project = useStore(s => s.app?.projects.find(p => p.path === s.activeProject));
  return (
    <div className="autoview" data-testid="history-view">
      <div className="av-inner">
        <div className="av-head">
          <h1><Icon name="search" size={18} />搜索对话</h1><span className="sp" />
          <button className="btn sm" onClick={() => setView('chat')}>回到对话</button>
        </div>
        <p className="av-sub">Claude Code 的全部会话：Claudex 里的，和你在命令行里用过的。按标题、你说过的话和 Claude 的回复搜索；打开命令行的会话会把它加进 Claudex，可以接着聊。</p>
        <div className="hist-bar">
          <div className="hist-search"><Icon name="search" size={15} />
            <input autoFocus value={q} placeholder="搜索标题、你说过的话、Claude 的回复…" data-testid="history-input" onChange={e => setQ(e.target.value)} />
            {busy && <i className="spin" />}
          </div>
          <select value={scope} data-testid="history-scope" onChange={e => setScope(e.target.value as 'project' | 'all')} disabled={!hasProjects}>
            <option value="project" disabled={!activeProject}>当前项目{project ? `（${project.name}）` : ''}</option>
            <option value="all">全部项目</option>
          </select>
        </div>
        {err && <p className="field-err">{err}</p>}
        <div className="av-sec">{q ? '搜索结果' : '最近的会话'} <span className="cnt" data-testid="history-count">{hits?.length ?? 0}</span></div>
        {hits && hits.length === 0 && !busy && <div className="q-empty">{q ? '没有找到。' : '这里还没有会话。'}</div>}
        <div className="hits">{(hits ?? []).slice(0, 200).map(h => <Hit key={h.session.sessionId} h={h} q={q} />)}</div>
        {hits && hits.length > 200 && <div className="q-empty">只显示前 200 个，换个更具体的词试试。</div>}
      </div>
    </div>
  );
}
