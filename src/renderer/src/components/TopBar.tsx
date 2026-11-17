// 顶栏：对话标题、项目、模式标识、worktree（C3）、终端和改动面板按钮。整条可以拖动窗口；右边留出 Windows 的窗口按钮位置。
import { useState } from 'react';
import { inWorktree } from '@shared/conv';
import { MODES } from '../modes';
import { useActiveCwd, useCurrentSettings, useStore } from '../store';
import { Icon } from './Icon';
import { useOutsideClose } from './Composer';

/** 对话的“更多”：改名、置顶、分叉、导出、删除（M2） */
function MoreMenu({ convId }: { convId: string }) {
  const meta = useStore(s => s.convs[convId]?.meta);
  const busy = useStore(s => { const c = s.convs[convId]; return c?.status === 'running' || c?.status === 'starting'; });
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  if (!meta) return null;
  const { forkConversation, pinConversation, exportConversation, deleteConversation } = useStore.getState();
  const run = (fn: () => void) => { setOpen(false); fn(); };
  const empty = !meta.sessionId;
  return (
    <div className="dd" ref={ref}>
      <button className={`tbtn icon${open ? ' on' : ''}`} data-testid="more-button" title="更多：改名、置顶、分叉、导出" onClick={() => setOpen(o => !o)}><Icon name="dots" size={15} /></button>
      {open && (
        <div className="menu down right more-menu">
          <button className="mitem" data-testid="more-rename" onClick={() => run(() => useStore.setState({ dialog: { kind: 'rename', convId, title: meta.title } }))}>
            <Icon name="pen" /><span className="mi"><b>改名</b><span>命令行 /resume 里也是这个名字</span></span>
          </button>
          <button className="mitem" data-testid="more-pin" onClick={() => run(() => void pinConversation(convId, !meta.pinned))}>
            <Icon name="pin" /><span className="mi"><b>{meta.pinned ? '取消置顶' : '置顶'}</b><span>{meta.pinned ? '回到按时间排' : '在左栏排在最前面'}</span></span>
          </button>
          <button className="mitem" data-testid="more-fork" disabled={empty || busy} title={busy ? '等这一轮结束再分叉' : ''} onClick={() => run(() => void forkConversation(convId))}>
            <Icon name="branch" /><span className="mi"><b>分叉</b><span>复制一份接着聊，试别的方向；原来的对话不动</span></span>
          </button>
          <div className="menu-sep" />
          <button className="mitem" data-testid="more-export-md" disabled={empty} onClick={() => run(() => void exportConversation(convId, 'md'))}>
            <Icon name="download" /><span className="mi"><b>导出 Markdown</b><span>对话文字和用过的工具</span></span>
          </button>
          <button className="mitem" data-testid="more-export-html" disabled={empty} onClick={() => run(() => void exportConversation(convId, 'html'))}>
            <Icon name="globe" /><span className="mi"><b>导出 HTML</b><span>浏览器里直接看，方便发给别人</span></span>
          </button>
          <div className="menu-sep" />
          <button className="mitem danger" data-testid="more-delete" onClick={() => run(() => { if (confirm(`删除对话「${meta.title}」？\n只从 Claudex 的列表里删除，Claude Code 的会话记录还在（搜索里还能找到）。`)) void deleteConversation(convId); })}>
            <Icon name="trash" /><span className="mi"><b>删除</b><span>只从 Claudex 的列表里删除</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const view = useStore(s => s.view);
  const conv = useStore(s => (s.activeId && s.view === 'chat' ? s.convs[s.activeId] : null));
  const project = useStore(s => s.app?.projects.find(p => p.path === (conv?.meta.projectPath ?? s.activeProject)));
  const settings = useCurrentSettings();
  const mode = settings?.mode;
  const terminalOpen = useStore(s => s.terminalOpen);
  const reviewOpen = useStore(s => s.reviewOpen);
  const busy = useStore(s => s.gitBusy);
  const cwd = useActiveCwd();
  const git = useStore(s => (cwd ? s.git[cwd] : undefined));
  const hasProject = !!project;
  const changed = git?.repo ? git.files.length : 0;
  const wt = conv && inWorktree(conv.meta) ? conv.meta.worktree! : null;
  const running = conv?.status === 'running' || conv?.status === 'starting';
  const employee = useStore(s => (conv?.meta.employee ? (s.team[conv.meta.projectPath] ?? []).find(e => e.id === conv.meta.employee!.id) : undefined));
  const empId = conv?.meta.employee?.id;
  return (
    <div className="topbar drag">
      <span className="tt">{view === 'board' ? '任务看板' : view === 'automation' ? '自动化' : view === 'search' ? '搜索对话' : conv ? conv.meta.title : project ? '新对话' : 'Claudex'}</span>
      {project && view !== 'automation' && view !== 'search' && <span className="tp">{project.name}</span>}
      {conv?.meta.automation && (
        <button className="emp-chip auto-chip" data-testid="automation-chip" title="这是自动化的一次运行，点这里回到自动化和审查队列"
          onClick={() => useStore.getState().setView('automation')}>
          <Icon name="clock" size={13} />自动化 · {conv.meta.automation.name}
        </button>
      )}
      {empId && (
        <button className="emp-chip" data-testid="employee-chip" title={employee ? `员工档案：${employee.description}` : '档案已删除'}
          onClick={() => employee && useStore.setState({ dialog: { kind: 'employee', projectPath: conv!.meta.projectPath, profile: employee } })}>
          <Icon name="users" size={13} />员工 · {employee?.displayName ?? empId}{employee && <span className="emp-chip-act">档案</span>}
        </button>
      )}
      {wt && <span className="wt-chip" title={`这个对话在独立的 worktree 里改代码，不影响本地项目文件夹：\n${wt.path}`} data-testid="wt-chip"><Icon name="layers" size={13} />{wt.branch}</span>}
      {view === 'chat' && mode === 'bypassPermissions' && <span className="mode-pill bypass"><Icon name="unlock" size={13} />完全访问</span>}
      {view === 'chat' && mode === 'skills' && <span className="mode-pill env"><Icon name="wrench" size={13} />{MODES.skills.label}模式</span>}
      <span className="sp" />
      {wt && (
        <button className="tbtn" data-testid="handoff-button" disabled={running || !!busy}
          title={running ? 'Claude 正在回复，等这一轮结束再接手' : '把这个 worktree 里的改动搬到本地项目文件夹，然后删掉 worktree'}
          onClick={() => useStore.setState({ dialog: { kind: 'handoff', convId: conv!.meta.id } })}>
          <Icon name="download" size={14} />接手到本地
        </button>
      )}
      {hasProject && view === 'chat' && (
        <button className={`tbtn${terminalOpen ? ' on' : ''}`} data-testid="terminal-button" title="内置终端（Ctrl+`）" onClick={() => useStore.getState().toggleTerminal()}>
          <Icon name="term" size={14} />终端
        </button>
      )}
      {hasProject && view === 'chat' && (
        <button className={`tbtn${reviewOpen ? ' on' : ''}`} data-testid="review-button" title={changed ? `${changed} 个文件有改动，点开审查和提交` : '改动面板：审查和提交'}
          onClick={() => useStore.getState().toggleReview()}>
          <Icon name="panel" size={14} />
          {changed ? <span className="tstat" data-testid="diff-stat"><span className="add">+{git!.add}</span><span className="del">−{git!.del}</span></span> : '改动'}
        </button>
      )}
      {conv && <MoreMenu convId={conv.meta.id} />}
    </div>
  );
}
