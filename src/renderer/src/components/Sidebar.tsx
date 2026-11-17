// 左栏：新对话、（后续阶段的入口）、按项目分组的对话列表（主对话 + 团队）、设置和主题。
import { useState } from 'react';
import type { ConversationMeta, EmployeeProfile } from '@shared/types';
import { inWorktree } from '@shared/conv';
import { useStore } from '../store';
import { pendingApprovals } from '../timeline';
import { Icon } from './Icon';
import { needsReview } from './Automation';

function when(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  const date = new Date(ts);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `${Math.floor(d / 3_600_000)} 小时前`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function ConvRow({ c, indent }: { c: ConversationMeta; indent?: boolean }) {
  const view = useStore(s => s.convs[c.id]);
  const activeId = useStore(s => s.activeId);
  const { openConversation, deleteConversation } = useStore.getState();
  const running = view && (view.status === 'running' || view.status === 'starting');
  const waiting = view && pendingApprovals(view.timeline) > 0;
  return (
    <div className={`sess${indent ? ' emp-sess' : ''}${c.id === activeId ? ' active' : ''}`} data-testid="conversation-item" data-id={c.id} onClick={() => void openConversation(c.id)}>
      {inWorktree(c) && <span className="sess-wt" title={`在 worktree 里：${c.worktree!.branch}`}><Icon name="layers" size={13} /></span>}
      {c.pinned && <span className="pin-mark" data-testid="pin-mark" title="已置顶"><Icon name="pin" size={12} /></span>}
      <span className="t">{c.title}</span>
      {waiting ? <i className="dot wait" title="等你审批" /> : running ? <i className="spin" title="正在运行" /> : view?.status === 'error' ? <i className="dot bad" title="出错了" /> : <span className="when">{when(c.updatedAt)}</span>}
      <button className="ibtn sm sess-del" title="删除这个对话（只从列表删除）" onClick={e => {
        e.stopPropagation();
        const ask = inWorktree(c)
          ? `删除对话「${c.title}」和它的 worktree？\n\nworktree 文件夹会被删掉；里面的改动先存到分支 ${c.worktree!.branch} 上，需要时还能找回。\n要保留改动到本地项目，请先点顶栏的“接手到本地”。`
          : `删除对话「${c.title}」？\n只从 Claudex 的列表里删除，Claude Code 的会话记录还在。`;
        if (confirm(ask)) void deleteConversation(c.id);
      }}><Icon name="x" size={13} /></button>
    </div>
  );
}

/** 团队里的一个员工：点开看他的对话（每个活一个对话），可以和他新开一个对话 */
function EmployeeRow({ projectPath, p, convs }: { projectPath: string; p: EmployeeProfile; convs: ConversationMeta[] }) {
  const activeId = useStore(s => s.activeId);
  const busy = useStore(s => convs.filter(c => { const v = s.convs[c.id]; return v && (v.status === 'running' || v.status === 'starting'); }).length);
  const working = useStore(s => Object.values(s.tasks).filter(t => t.employeeId === p.id && t.projectPath === projectPath && t.status === 'running').length);
  const { newEmployeeChat } = useStore.getState();
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? convs.some(c => c.id === activeId);
  const n = Math.max(busy, working);
  return (
    <div className="emp">
      <div className={`emp-head${open ? ' open' : ''}`} data-testid="employee-item" data-employee={p.id} title={`${p.displayName}（${p.id}）：${p.description}`} onClick={() => setManual(!open)}>
        <span className="avatar">{p.displayName.slice(0, 1)}</span>
        <span className="t">{p.displayName}<small>{p.description}</small></span>
        {n > 0 ? <span className="emp-busy" title={`${n} 个活在做`}><i className="spin" />{n > 1 ? n : ''}</span> : <span className="when">{convs.length || ''}</span>}
      </div>
      {open && (
        <div className="emp-convs">
          {convs.map(c => <ConvRow key={c.id} c={c} indent />)}
          <div className="sess emp-sess new-chat" data-testid="employee-new-chat" onClick={() => void newEmployeeChat(projectPath, p.id)}><Icon name="plus" size={13} /><span className="t">和{p.displayName}新开一个对话</span></div>
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const app = useStore(s => s.app);
  const team = useStore(s => s.team);
  const activeId = useStore(s => s.activeId);
  const activeProject = useStore(s => s.activeProject);
  const view = useStore(s => s.view);
  const runningTasks = useStore(s => Object.values(s.tasks).filter(t => t.projectPath === s.activeProject && (t.status === 'running' || t.status === 'waiting')).length);
  const toReview = useStore(s => (s.automation?.runs ?? []).filter(needsReview).length);
  const { startDraft, pickProject, removeProject, setTheme } = useStore.getState();
  if (!app) return null;
  const theme = app.prefs.theme;

  return (
    <aside className="sidebar">
      <div className="side-top drag">
        <span className="logo" /><span className="brand">Claudex</span>
      </div>
      <div className="nav">
        <button className="nav-item" data-testid="new-conversation" onClick={() => startDraft()} disabled={!app.projects.length}>
          <Icon name="new" />新对话<kbd>Ctrl+N</kbd>
        </button>
        <button className={`nav-item${view === 'board' ? ' on' : ''}`} data-testid="board-button" disabled={!app.projects.length}
          title="当前项目的员工和全部任务" onClick={() => useStore.getState().setView(view === 'board' ? 'chat' : 'board')}>
          <Icon name="listcheck" />任务看板{runningTasks > 0 && <span className="nav-badge">{runningTasks}</span>}
        </button>
        <button className={`nav-item${view === 'search' ? ' on' : ''}`} data-testid="search-button" title="搜索全部对话，包括命令行里用过的（Ctrl+K）"
          onClick={() => useStore.getState().setView(view === 'search' ? 'chat' : 'search')}>
          <Icon name="search" />搜索<kbd>Ctrl+K</kbd>
        </button>
        <button className={`nav-item${view === 'automation' ? ' on' : ''}`} data-testid="automation-button"
          title="定时任务和审查队列" onClick={() => useStore.getState().setView(view === 'automation' ? 'chat' : 'automation')}>
          <Icon name="clock" />自动化{toReview > 0 && <span className="nav-badge" data-testid="automation-badge" title="审查队列里等你看的结果">{toReview}</span>}
        </button>
        <button className="nav-item" disabled title="M3 阶段"><Icon name="spark" />Skills<span className="ms">M3</span></button>
        <button className="nav-item" disabled title="M3 阶段"><Icon name="plug" />MCP 服务器<span className="ms">M3</span></button>
      </div>
      <div className="side-label">
        对话
        <button className="ibtn sm" title="添加项目文件夹" data-testid="add-project" onClick={() => void pickProject()}><Icon name="folderPlus" size={15} /></button>
      </div>
      <div className="tree">
        {app.projects.map(p => {
          // 自动化的运行不放在这里，从“自动化”的审查队列打开
          const all = app.conversations.filter(c => c.projectPath === p.path && !c.automation).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
          const mains = all.filter(c => !c.employee);
          const profiles = team[p.path] ?? [];
          // 员工的对话；档案被删掉的员工也列出来（对话还在）
          const ids = [...new Set([...profiles.map(e => e.id), ...all.filter(c => c.employee).map(c => c.employee!.id)])];
          const people: EmployeeProfile[] = ids.map(id => profiles.find(e => e.id === id) ?? { id, displayName: id, description: '（档案已删除）', prompt: '' });
          const isActiveDraft = !activeId && activeProject === p.path;
          return (
            <div className="proj" key={p.path}>
              <div className={`proj-head${isActiveDraft ? ' active' : ''}`} title={p.path} onClick={() => startDraft(p.path)}>
                <Icon name="folder" size={14} /><span className="t">{p.name}</span>
                <span className="proj-acts">
                  <button className="ibtn sm" title="在这个项目里开新对话" onClick={e => { e.stopPropagation(); startDraft(p.path); }}><Icon name="plus" size={14} /></button>
                  <button className="ibtn sm" title="从列表移除这个项目（不删文件）" onClick={e => { e.stopPropagation(); if (confirm(`从列表移除项目「${p.name}」？\n只是不在 Claudex 里显示，不会删除任何文件。`)) void removeProject(p.path); }}><Icon name="trash" size={14} /></button>
                </span>
              </div>
              {mains.map(c => <ConvRow key={c.id} c={c} />)}
              <div className="team-label" data-testid="team-label">
                <Icon name="users" size={13} /><span>团队{people.length ? ` · ${people.length}` : ''}</span>
                <button className="ibtn sm" title="招一个新员工" data-testid="hire-button" onClick={() => useStore.setState({ dialog: { kind: 'employee', projectPath: p.path, profile: null } })}><Icon name="plus" size={13} /></button>
              </div>
              {people.length === 0 && <div className="team-empty">还没有员工。和主对话聊任务时，它会提议招人；也可以点 + 自己招</div>}
              {people.map(e => (
                <EmployeeRow key={e.id} projectPath={p.path} p={e} convs={all.filter(c => c.employee?.id === e.id)} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="side-foot">
        <button className="nav-item" onClick={() => useStore.setState({ dialog: { kind: 'settings' } })}><Icon name="gear" />设置</button>
        <button className="ibtn" title={theme === 'dark' ? '切到浅色' : '切到深色'} onClick={() => void setTheme(theme === 'dark' ? 'light' : 'dark')}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>
    </aside>
  );
}
