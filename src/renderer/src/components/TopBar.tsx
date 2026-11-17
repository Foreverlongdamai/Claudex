// 顶栏：对话标题、项目、模式标识、worktree（C3）、终端和改动面板按钮。整条可以拖动窗口；右边留出 Windows 的窗口按钮位置。
import { inWorktree } from '@shared/conv';
import { MODES } from '../modes';
import { useActiveCwd, useCurrentSettings, useStore } from '../store';
import { Icon } from './Icon';

export function TopBar() {
  const conv = useStore(s => (s.activeId ? s.convs[s.activeId] : null));
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
  return (
    <div className="topbar drag">
      <span className="tt">{conv ? conv.meta.title : project ? '新对话' : 'Claudex'}</span>
      {project && <span className="tp">{project.name}</span>}
      {wt && <span className="wt-chip" title={`这个对话在独立的 worktree 里改代码，不影响本地项目文件夹：\n${wt.path}`} data-testid="wt-chip"><Icon name="layers" size={13} />{wt.branch}</span>}
      {mode === 'bypassPermissions' && <span className="mode-pill bypass"><Icon name="unlock" size={13} />完全访问</span>}
      {mode === 'skills' && <span className="mode-pill env"><Icon name="wrench" size={13} />{MODES.skills.label}模式</span>}
      <span className="sp" />
      {wt && (
        <button className="tbtn" data-testid="handoff-button" disabled={running || !!busy}
          title={running ? 'Claude 正在回复，等这一轮结束再接手' : '把这个 worktree 里的改动搬到本地项目文件夹，然后删掉 worktree'}
          onClick={() => useStore.setState({ dialog: { kind: 'handoff', convId: conv!.meta.id } })}>
          <Icon name="download" size={14} />接手到本地
        </button>
      )}
      {hasProject && (
        <button className={`tbtn${terminalOpen ? ' on' : ''}`} data-testid="terminal-button" title="内置终端（Ctrl+`）" onClick={() => useStore.getState().toggleTerminal()}>
          <Icon name="term" size={14} />终端
        </button>
      )}
      {hasProject && (
        <button className={`tbtn${reviewOpen ? ' on' : ''}`} data-testid="review-button" title={changed ? `${changed} 个文件有改动，点开审查和提交` : '改动面板：审查和提交'}
          onClick={() => useStore.getState().toggleReview()}>
          <Icon name="panel" size={14} />
          {changed ? <span className="tstat" data-testid="diff-stat"><span className="add">+{git!.add}</span><span className="del">−{git!.del}</span></span> : '改动'}
        </button>
      )}
    </div>
  );
}
