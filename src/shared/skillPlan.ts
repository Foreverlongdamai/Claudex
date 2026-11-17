// Skills 配置模式的推荐清单（M1 收尾）：Claude 用 propose_skill_plan 工具交上来，界面显示成可勾选的卡片，
// 用户勾选后由 Claudex 执行（装 Skill、加 MCP、在本项目关闭、写进 CLAUDE.md），安装动作不经过模型。
// 纯函数，单元测试直接跑。

export interface PlanMcp {
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface PlanItem {
  name: string;
  kind: 'skill' | 'mcp';
  /** GitHub 仓库 owner/name，或者 git 地址、本机路径 */
  repo: string;
  /** Skill 在仓库里的文件夹（SKILL.md 所在的）；在根目录就不填 */
  path?: string;
  description: string;
  stars?: number;
  license?: string;
  /** 多久前更新，比如“3 天前” */
  updated?: string;
  /** 含几个可执行脚本 */
  scripts?: number;
  official?: boolean;
  /** kind 是 mcp 时：怎么启动 */
  mcp?: PlanMcp;
}

export interface SkillPlan {
  summary?: string;
  /** 已安装、本项目要用的 */
  keep: string[];
  /** 新发现、建议安装的 */
  install: PlanItem[];
  /** 与本项目无关、在本项目关闭的 */
  close: string[];
  /** 按筛选标准过滤掉了几个候选 */
  filtered?: number;
  note?: string;
}

/** 默认勾不勾：含脚本、没有许可证的默认不勾（要用户自己看过再勾） */
export function checkedByDefault(item: PlanItem): boolean {
  if (item.kind === 'skill' && (item.scripts ?? 0) > 0) return false;
  if (!item.license || /^(none|无|unknown|未知|noassertion)$/i.test(item.license.trim())) return false;
  return true;
}

/** 给 item 的警告：含脚本、没有许可证 */
export function itemWarnings(item: PlanItem): string[] {
  const w: string[] = [];
  if (item.kind === 'skill' && (item.scripts ?? 0) > 0) w.push(`含 ${item.scripts} 个脚本`);
  if (!item.license || /^(none|无|unknown|未知|noassertion)$/i.test(item.license.trim())) w.push('没有许可证');
  return w;
}

/** 仓库地址：owner/name → GitHub；其他（https://…、git@…、本机路径）原样 */
export function repoUrl(repo: string): string {
  const r = repo.trim().replace(/\.git$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? `https://github.com/${r}.git` : repo.trim();
}

/** 在网页上看这个仓库（GitHub 的才有） */
export function repoPage(item: Pick<PlanItem, 'repo' | 'path'>): string | null {
  const r = item.repo.trim().replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r}${item.path ? `/tree/HEAD/${item.path.replace(/^\/+/, '')}` : ''}`;
  if (/^https:\/\/github\.com\//.test(r)) return r;
  return null;
}

/**
 * 在克隆下来的仓库里找 Skill 所在的文件夹。dirs：仓库里所有含 SKILL.md 的文件夹（相对路径，用 / 分隔，根目录是 ''）
 * 和它们 SKILL.md 里的 name。优先用指定的 path，然后找 name 一样的，再找文件夹名一样的，仓库里只有一个就用它
 */
export function pickSkillDir(dirs: Array<{ dir: string; name?: string }>, name: string, path?: string): string | null {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  if (path !== undefined && path !== null) {
    const p = norm(path);
    const hit = dirs.find(d => norm(d.dir) === p);
    if (hit) return hit.dir;
  }
  const byName = dirs.find(d => d.name === name);
  if (byName) return byName.dir;
  const byFolder = dirs.find(d => norm(d.dir).split('/').pop() === name);
  if (byFolder) return byFolder.dir;
  return dirs.length === 1 ? dirs[0].dir : null;
}

/** 在项目设置里关闭这些 Skills（skillOverrides，值为 "off"），其他字段原样 */
export function withClosedSkills(settings: Record<string, unknown>, close: string[]): Record<string, unknown> {
  if (!close.length) return settings;
  const prev = settings.skillOverrides && typeof settings.skillOverrides === 'object' ? (settings.skillOverrides as Record<string, unknown>) : {};
  return { ...settings, skillOverrides: { ...prev, ...Object.fromEntries(close.map(n => [n, 'off'])) } };
}

export const CLAUDE_MD_START = '<!-- claudex:skills 由 Claudex 的 Skills 配置模式生成，重新应用推荐清单时会更新这一段 -->';
export const CLAUDE_MD_END = '<!-- /claudex:skills -->';

export interface AppliedPlan {
  keep: string[];
  installed: Array<{ name: string; repo: string; scripts: number }>;
  mcp: Array<{ name: string; repo: string }>;
  closed: string[];
}

/** CLAUDE.md 里“本项目用哪些 Skills 和工具”那一段 */
export function claudeMdSection(a: AppliedPlan): string {
  const lines = [CLAUDE_MD_START, '## 本项目用的 Skills 和工具', ''];
  if (a.keep.length) lines.push(`- 要用的 Skills：${a.keep.join('、')}`);
  if (a.installed.length) lines.push(`- 新装的 Skills（在 .claude/skills/ 里）：${a.installed.map(i => `${i.name}（来自 ${i.repo}）`).join('、')}`);
  if (a.mcp.length) lines.push(`- MCP 服务器（.mcp.json）：${a.mcp.map(m => `${m.name}（${m.repo}）`).join('、')}`);
  if (a.closed.length) lines.push(`- 在本项目关闭的 Skills（.claude/settings.json 的 skillOverrides）：${a.closed.length > 20 ? `${a.closed.slice(0, 20).join('、')} 等 ${a.closed.length} 个` : a.closed.join('、')}`);
  if (lines.length === 3) lines.push('- （没有选任何 Skill 或工具）');
  lines.push(CLAUDE_MD_END);
  return lines.join('\n');
}

/** 把那一段写进 CLAUDE.md：已经有就替换，没有就加在最后 */
export function upsertClaudeMd(text: string, section: string): string {
  const i = text.indexOf(CLAUDE_MD_START.slice(0, 20));
  const j = text.indexOf(CLAUDE_MD_END);
  if (i >= 0 && j > i) return text.slice(0, i) + section + text.slice(j + CLAUDE_MD_END.length);
  const base = text.replace(/\s*$/, '');
  return (base ? `${base}\n\n` : '') + section + '\n';
}
