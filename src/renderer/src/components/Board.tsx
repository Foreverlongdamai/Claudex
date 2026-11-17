// 任务看板：当前项目的员工（在忙什么）和全部任务（进行中 / 已完成 / 没做完），包括员工之间的转交和请同事帮忙。
import { useEffect, useState } from 'react';
import type { TeamTask } from '@shared/types';
import { useStore } from '../store';
import { Icon } from './Icon';
import { TASK_STATE } from './Team';

/** 一段时间：12 秒、3 分钟、1 小时 5 分 */
function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

function TaskCardOnBoard({ t }: { t: TeamTask }) {
  const fromTitle = useStore(s => s.app?.conversations.find(c => c.id === t.fromConvId)?.title);
  const { openConversation, stopTask } = useStore.getState();
  const active = t.status === 'running' || t.status === 'waiting';
  return (
    <div className={`bcard ${t.status}`} data-testid="board-task" data-task={t.id} data-status={t.status}>
      <div className="bc-head">
        <b>#{t.id}</b><span className="bc-title" title={t.title}>{t.title}</span>
        <span className={`bc-state ${t.status}`}>{active && <i className="spin" />}{TASK_STATE[t.status]}</span>
      </div>
      <div className="bc-who"><span className="avatar sm">{t.employeeName.slice(0, 1)}</span><span className="bc-name">{t.employeeName}</span>
        <span className="bc-from">· {t.fromKind === 'employee' ? `${t.fromName} 请他帮忙` : `来自「${fromTitle ?? t.fromName ?? '主对话'}」`}</span>
      </div>
      <div className="bc-links">
        {t.handedFrom && <span className="bc-tag">转交自 #{t.handedFrom}</span>}
        {t.handedTo && <span className="bc-tag">转交给 #{t.handedTo}</span>}
        {t.parentId && <span className="bc-tag">是 #{t.parentId} 的一部分</span>}
        {!!t.waitingFor?.length && <span className="bc-tag wait">在等 {t.waitingFor.map(x => `#${x}`).join('、')}</span>}
        <span className="bc-time">{active ? `已经 ${dur(Date.now() - t.createdAt)}` : t.endedAt ? `用时 ${dur(t.endedAt - t.createdAt)}` : ''}</span>
      </div>
      {t.result && !active && <div className="bc-result" title={t.result}>{t.result.replace(/\s+/g, ' ').slice(0, 160)}</div>}
      <div className="bc-acts">
        <button className="link sm" data-testid="board-open" onClick={() => void openConversation(t.convId)}>打开他的对话</button>
        <button className="link sm" onClick={() => void openConversation(t.fromConvId)}>打开派活的对话</button>
        {active && <button className="link sm danger" data-testid="board-stop" onClick={() => { if (confirm(`停止任务 #${t.id}「${t.title}」？`)) void stopTask(t.id); }}>停止</button>}
      </div>
    </div>
  );
}

export function TaskBoard() {
  const projectPath = useStore(s => s.activeProject);
  const project = useStore(s => s.app?.projects.find(p => p.path === s.activeProject));
  const team = useStore(s => (s.activeProject ? s.team[s.activeProject] ?? [] : []));
  const allTasks = useStore(s => s.tasks);
  const { loadTeam, newEmployeeChat, setView } = useStore.getState();
  const [, tick] = useState(0);
  useEffect(() => { if (projectPath) void loadTeam(projectPath); }, [projectPath, loadTeam]);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 15_000); return () => clearInterval(t); }, []); // 刷新“已经多久”
  if (!projectPath || !project) return <div className="board"><div className="board-empty">先在左边选一个项目</div></div>;
  const tasks = Object.values(allTasks).filter(t => t.projectPath === projectPath).sort((a, b) => Number(b.id) - Number(a.id));
  const cols: Array<{ key: string; label: string; list: TeamTask[] }> = [
    { key: 'active', label: '进行中', list: tasks.filter(t => t.status === 'running' || t.status === 'waiting') },
    { key: 'done', label: '已完成', list: tasks.filter(t => t.status === 'done' || t.status === 'handed') },
    { key: 'failed', label: '没做完', list: tasks.filter(t => t.status === 'failed') }
  ];
  return (
    <div className="board" data-testid="task-board">
      <div className="board-head">
        <h1><Icon name="listcheck" size={18} />任务看板<span className="tp">{project.name}</span></h1>
        <span className="sp" />
        <button className="btn sm" onClick={() => setView('chat')}>回到对话</button>
      </div>
      <div className="board-team">
        {team.length === 0 && <div className="board-empty">还没有员工。和主对话聊任务时它会提议招人，也可以在左栏“团队”的 + 自己招。</div>}
        {team.map(e => {
          const busy = tasks.filter(t => t.employeeId === e.id && (t.status === 'running' || t.status === 'waiting')).length;
          const done = tasks.filter(t => t.employeeId === e.id && t.status === 'done').length;
          return (
            <div className="bemp" key={e.id} data-testid="board-employee" data-employee={e.id}>
              <span className="avatar">{e.displayName.slice(0, 1)}</span>
              <div className="bemp-main">
                <b>{e.displayName}<small>{e.id}</small></b>
                <span title={e.description}>{e.description}</span>
                <span className={`bemp-state${busy ? ' busy' : ''}`}>{busy ? `在做 ${busy} 个活` : '空闲'}{done ? ` · 已完成 ${done} 个` : ''}</span>
              </div>
              <div className="bemp-acts">
                <button className="link sm" onClick={() => useStore.setState({ dialog: { kind: 'employee', projectPath, profile: e } })}>档案</button>
                <button className="link sm" onClick={() => void newEmployeeChat(projectPath, e.id)}>和他聊</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="board-cols">
        {cols.map(c => (
          <div className={`bcol ${c.key}`} key={c.key} data-testid={`board-col-${c.key}`}>
            <div className="bcol-head">{c.label}<span className="cnt">{c.list.length}</span></div>
            <div className="bcol-body">
              {c.list.length === 0 && <div className="board-empty sm">没有</div>}
              {c.list.map(t => <TaskCardOnBoard key={t.id} t={t} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
