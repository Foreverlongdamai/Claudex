// 顶栏：对话标题、项目、模式标识。整条可以拖动窗口；右边留出 Windows 的窗口按钮位置。
import { MODES } from '../modes';
import { useCurrentSettings, useStore } from '../store';
import { Icon } from './Icon';

export function TopBar() {
  const conv = useStore(s => (s.activeId ? s.convs[s.activeId] : null));
  const project = useStore(s => s.app?.projects.find(p => p.path === (conv?.meta.projectPath ?? s.activeProject)));
  const settings = useCurrentSettings();
  const mode = settings?.mode;
  const terminalOpen = useStore(s => s.terminalOpen);
  const reviewOpen = useStore(s => s.reviewOpen);
  const git = useStore(s => (project ? s.git[project.path] : undefined));
  const hasProject = !!project;
  const changed = git?.repo ? git.files.length : 0;
  return (
    <div className="topbar drag">
      <span className="tt">{conv ? conv.meta.title : project ? '新对话' : 'Claudex'}</span>
      {project && <span className="tp">{project.name}</span>}
      {mode === 'bypassPermissions' && <span className="mode-pill bypass"><Icon name="unlock" size={13} />完全访问</span>}
      {mode === 'skills' && <span className="mode-pill env"><Icon name="wrench" size={13} />{MODES.skills.label}模式</span>}
      <span className="sp" />
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
