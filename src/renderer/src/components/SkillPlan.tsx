// Skills 配置模式的推荐清单卡片：已安装要用的（点一下取消）、新发现建议安装的（勾选）、与本项目无关在本项目关闭的。
// 用户点“应用所选”后，由 Claudex 执行（装 Skill、加 MCP、关闭、写进 CLAUDE.md），不经过模型。
import { useState } from 'react';
import type { PermissionRequest } from '@shared/types';
import { checkedByDefault, itemWarnings, repoPage, type PlanItem, type SkillPlan } from '@shared/skillPlan';
import { useStore } from '../store';
import { Icon } from './Icon';

export function SkillPlanCard({ convId, request }: { convId: string; request: PermissionRequest }) {
  const respond = useStore(s => s.respond);
  const project = useStore(s => s.app?.projects.find(p => p.path === s.convs[convId]?.meta.projectPath));
  const plan = request.input as unknown as SkillPlan;
  const keepAll = plan.keep ?? [];
  const installAll = plan.install ?? [];
  const closeAll = plan.close ?? [];
  const [keep, setKeep] = useState(() => new Set(keepAll));
  const [install, setInstall] = useState(() => new Set(installAll.filter(checkedByDefault).map(i => i.name)));
  const [close, setClose] = useState(() => new Set(closeAll));
  const [showClose, setShowClose] = useState(closeAll.length <= 12);
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const pickInstall = (it: PlanItem) => {
    if (!install.has(it.name) && (it.scripts ?? 0) > 0 && !confirm(`「${it.name}」含 ${it.scripts} 个脚本。Claudex 只复制文件、不会运行它们，但 Claude 以后用这个 Skill 时可能会运行。\n建议先点“查看”到仓库里看过脚本内容。确定要装吗？`)) return;
    setInstall(toggle(install, it.name));
  };
  const apply = () => {
    const chosen = { ...plan, keep: keepAll.filter(n => keep.has(n)), install: installAll.filter(i => install.has(i.name)), close: closeAll.filter(n => close.has(n)) };
    void respond(convId, { requestId: request.requestId, behavior: 'allow', updatedInput: chosen as unknown as Record<string, unknown> },
      `应用了推荐清单：安装 ${chosen.install.length} 项、保留 ${chosen.keep.length} 个、关闭 ${chosen.close.length} 个`);
  };
  const skip = () => void respond(convId, { requestId: request.requestId, behavior: 'deny', message: '用户没有应用推荐清单，什么都不要改' }, '都不要：什么都没改');
  return (
    <div className="rec approval" data-testid="skill-plan">
      <div className="rec-head"><Icon name="listcheck" />推荐清单{project ? ` · ${project.name}` : ''}</div>
      {plan.summary && <p className="rec-sum">{plan.summary}</p>}
      {keepAll.length > 0 && <>
        <div className="rec-sec">已安装 · 本项目要用的（点一下取消）</div>
        <div className="chips">
          {keepAll.map(n => <button key={n} className={`tchip${keep.has(n) ? ' on' : ''}`} data-testid="plan-keep" data-skill={n} onClick={() => setKeep(toggle(keep, n))}>{n}</button>)}
        </div>
      </>}
      {installAll.length > 0 && <>
        <div className="rec-sec">新发现 · 建议安装</div>
        {installAll.map(it => {
          const warn = itemWarnings(it);
          const page = repoPage(it);
          return (
            <label className={`cand${install.has(it.name) ? '' : ' off'}`} key={it.name} data-testid="plan-item" data-item={it.name}>
              <input type="checkbox" checked={install.has(it.name)} onChange={() => pickInstall(it)} />
              <div className="cand-main">
                <div className="cand-title"><b>{it.name}</b><span className="kind">{it.kind === 'mcp' ? 'MCP 工具' : 'Skill'}</span><span className="repo">{it.repo}{it.path ? `/${it.path}` : ''}</span></div>
                <div className="cand-desc">{it.description}</div>
                <div className="badges">
                  {it.official && <span className="official">官方</span>}
                  {it.stars !== undefined && <span>★ {it.stars >= 1000 ? `${(it.stars / 1000).toFixed(1)}k` : it.stars}</span>}
                  {it.license && !warn.includes('没有许可证') && <span>{it.license}</span>}
                  {it.kind === 'skill' && !(it.scripts ?? 0) && <span className="good">无脚本</span>}
                  {warn.map(w => <span className="warn" key={w}>{w}</span>)}
                  {it.updated && <span>{it.updated}更新</span>}
                </div>
              </div>
              {page && <button className="link sm" onClick={e => { e.preventDefault(); void window.claudex.openExternal(page); }}>查看</button>}
            </label>
          );
        })}
      </>}
      {closeAll.length > 0 && <>
        <div className="rec-sec">与本项目无关 · 在本项目关闭</div>
        <label className={`cand${close.size ? '' : ' off'}`} data-testid="plan-close">
          <input type="checkbox" checked={close.size > 0} data-testid="plan-close-all" onChange={() => setClose(close.size ? new Set() : new Set(closeAll))} />
          <div className="cand-main">
            <div className="cand-title"><b>关闭 {close.size} 个 Skills</b></div>
            <div className="cand-desc">{closeAll.slice(0, 6).join('、')}{closeAll.length > 6 ? '……' : ''}。只写进本项目的设置，不删除任何文件，其他项目不受影响</div>
          </div>
          <button className="link sm" onClick={e => { e.preventDefault(); setShowClose(!showClose); }}>{showClose ? '收起' : '展开'}</button>
        </label>
        {showClose && <div className="chips">{closeAll.map(n => <button key={n} className={`tchip${close.has(n) ? ' on' : ''}`} data-testid="plan-close-item" data-skill={n} onClick={() => setClose(toggle(close, n))}>{n}</button>)}</div>}
      </>}
      <div className="rec-foot">
        <div className="rec-note">
          {plan.filtered ? `已过滤 ${plan.filtered} 个候选：没有许可证、长期不更新或星数太少。` : ''}
          新 Skill 装到项目的 .claude/skills/，只对这个项目生效；含脚本的不会运行；关闭不会删除任何文件。{plan.note ?? ''}
        </div>
        <div className="ap-actions">
          <button className="btn primary" data-testid="plan-apply" onClick={apply}>应用所选</button>
          <button className="btn ghost" data-testid="plan-skip" onClick={skip}>都不要</button>
        </div>
      </div>
    </div>
  );
}
