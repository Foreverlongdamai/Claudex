// M3 管理（Skills、MCP 服务器、Claude Code 设置）在主进程和界面之间传的数据。
import type { SettingsForm, SettingsScope } from './claudeSettings';

export type { SettingsForm, SettingsScope } from './claudeSettings';

/** 一个 Skill（SKILL.md 所在的文件夹） */
export interface SkillEntry {
  name: string;
  description: string;
  /** user：~/.claude/skills；project：项目的 .claude/skills；plugin：插件自带（只读） */
  source: 'user' | 'project' | 'plugin';
  /** 插件名（source 是 plugin 时） */
  plugin?: string;
  /** SKILL.md 的完整路径 */
  path: string;
  readOnly: boolean;
  /** 格式问题的个数（0 表示没问题） */
  problems: number;
}

export interface SkillDoc {
  entry: SkillEntry;
  content: string;
  problems: string[];
}

export type McpTransport = 'stdio' | 'http' | 'sse';

/** 新建 / 修改 MCP 服务器的表单 */
export interface McpServerInput {
  name: string;
  scope: 'user' | 'project' | 'local';
  type: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerView {
  name: string;
  /** user / project / local / plugin / claudeai / managed …… */
  scope: string;
  type: string;
  /** stdio：命令和参数；http / sse：地址 */
  target: string;
  /** connected 已连接；failed 连接失败；needs-auth 要登录；pending 还在连；disabled 停用（项目里没批准的） */
  status: string;
  error?: string;
  tools: string[];
  /** 能在 Claudex 里改（用户级、项目级、本地级） */
  editable: boolean;
  /** 项目 .mcp.json 里的、用户还没批准的（Claudex 不会启动它） */
  unapproved?: boolean;
  /** 修改时预先填好的表单 */
  input?: McpServerInput;
}

export interface SettingsView {
  scope: SettingsScope;
  path: string;
  exists: boolean;
  form: SettingsForm;
  /** 文件不是合法的 JSON：不能用表单改 */
  error?: string;
}
