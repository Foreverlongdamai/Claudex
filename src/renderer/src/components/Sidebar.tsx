// 左栏：新对话、（后续阶段的入口）、按项目分组的对话列表、设置和主题。
import { useStore } from '../store';
import { pendingApprovals } from '../timeline';
import { Icon } from './Icon';

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

export function Sidebar() {
  const app = useStore(s => s.app);
  const convs = useStore(s => s.convs);
  const activeId = useStore(s => s.activeId);
  const activeProject = useStore(s => s.activeProject);
  const { startDraft, openConversation, pickProject, removeProject, deleteConversation, setTheme } = useStore.getState();
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
        <button className="nav-item" disabled title="M2 阶段"><Icon name="search" />搜索<span className="ms">M2</span></button>
        <button className="nav-item" disabled title="C4 阶段"><Icon name="clock" />自动化<span className="ms">C4</span></button>
        <button className="nav-item" disabled title="M3 阶段"><Icon name="spark" />Skills<span className="ms">M3</span></button>
        <button className="nav-item" disabled title="M3 阶段"><Icon name="plug" />MCP 服务器<span className="ms">M3</span></button>
      </div>
      <div className="side-label">
        对话
        <button className="ibtn sm" title="添加项目文件夹" data-testid="add-project" onClick={() => void pickProject()}><Icon name="folderPlus" size={15} /></button>
      </div>
      <div className="tree">
        {app.projects.map(p => {
          const list = app.conversations.filter(c => c.projectPath === p.path).sort((a, b) => b.updatedAt - a.updatedAt);
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
              {list.map(c => {
                const view = convs[c.id];
                const running = view && (view.status === 'running' || view.status === 'starting');
                const waiting = view && pendingApprovals(view.timeline) > 0;
                return (
                  <div key={c.id} className={`sess${c.id === activeId ? ' active' : ''}`} data-testid="conversation-item" data-id={c.id} onClick={() => void openConversation(c.id)}>
                    <span className="t">{c.title}</span>
                    {waiting ? <i className="dot wait" title="等你审批" /> : running ? <i className="spin" title="正在运行" /> : view?.status === 'error' ? <i className="dot bad" title="出错了" /> : <span className="when">{when(c.updatedAt)}</span>}
                    <button className="ibtn sm sess-del" title="删除这个对话（只从列表删除）" onClick={e => { e.stopPropagation(); if (confirm(`删除对话「${c.title}」？\n只从 Claudex 的列表里删除，Claude Code 的会话记录还在。`)) void deleteConversation(c.id); }}><Icon name="x" size={13} /></button>
                  </div>
                );
              })}
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
