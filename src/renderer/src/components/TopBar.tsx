// 顶栏：对话标题、项目、模式标识。整条可以拖动窗口；右边留出 Windows 的窗口按钮位置。
import { MODES } from '../modes';
import { useCurrentSettings, useStore } from '../store';
import { Icon } from './Icon';

export function TopBar() {
  const conv = useStore(s => (s.activeId ? s.convs[s.activeId] : null));
  const project = useStore(s => s.app?.projects.find(p => p.path === (conv?.meta.projectPath ?? s.activeProject)));
  const settings = useCurrentSettings();
  const mode = settings?.mode;
  return (
    <div className="topbar drag">
      <span className="tt">{conv ? conv.meta.title : project ? '新对话' : 'Claudex'}</span>
      {project && <span className="tp">{project.name}</span>}
      {mode === 'bypassPermissions' && <span className="mode-pill bypass"><Icon name="unlock" size={13} />完全访问</span>}
      {mode === 'skills' && <span className="mode-pill env"><Icon name="wrench" size={13} />{MODES.skills.label}模式</span>}
    </div>
  );
}
