// 5 个模式在 SDK 层面怎么实现。前 4 个直接对应 Claude Code 的权限模式；
// “Skills 配置”是自定义模式：底层用 default，加上自动放行规则（canUseTool）和附加在用户消息前的流程说明。
// 对话中途不能改系统提示（SDK 会把系统提示记录下来复用），所以流程说明放进消息里。
// 这个文件不依赖 Electron，方便单独测试。
import path from 'node:path';
import type { ModeId } from '../../shared/types.ts';

export type SdkPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export const SDK_MODE: Record<ModeId, SdkPermissionMode> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  bypassPermissions: 'bypassPermissions',
  skills: 'default'
};

export const MODE_TAG = 'claudex-mode';

const SKILLS_MODE_PROMPT = `你现在处于 Claudex 的「Skills 配置」模式。目标：根据这个项目的需求，挑选合适的 Skills 和工具（MCP 服务器）。不要修改源代码，不要安装项目依赖，这些交给其他模式。

按这个顺序做：
1. 了解项目：读 README、依赖文件、CLAUDE.md，结合用户的描述，归纳项目需要哪几类能力。
2. 盘点已有：列出已安装的 Skills（用户级、项目级、插件自带）和 MCP 服务器，标出和项目相关的。
3. 外部搜索：缺的能力上 GitHub 和 Skills 目录网站找（可以用 WebSearch，或 curl 调 GitHub 搜索接口）。读候选的 SKILL.md 和文件清单，只看不运行。筛选标准：有许可证、一年内有更新、星数不太低，官方出品优先；含可执行脚本的要明确标出来。
4. 用 mcp__claudex__propose_skill_plan 工具交推荐清单（Claudex 会显示成可勾选的卡片），分三组：keep 已安装·本项目要用的；install 新发现·建议安装（写清来源仓库、Skill 在仓库里的文件夹、星数、许可证、多久前更新、含几个脚本、推荐理由；MCP 写清怎么启动）；close 与本项目无关·建议在本项目关闭的。不要再用 Markdown 表格重复一遍。
5. 用户勾选后由 Claudex 执行（装 Skill、加 MCP、关闭、写进 CLAUDE.md），工具会返回执行结果。你自己不要安装、不要改这些文件，简短地告诉用户结果就好。

不要运行下载来的 Skill 里的任何脚本。`;

/** 发给 Claude 的消息：Skills 配置模式下在前面附加流程说明。界面显示时会去掉这一段。 */
export function wrapForMode(mode: ModeId, text: string): string {
  if (mode !== 'skills') return text;
  return `<${MODE_TAG} name="skills">\n${SKILLS_MODE_PROMPT}\n</${MODE_TAG}>\n\n${text}`;
}

// ---------------- Skills 配置模式的自动放行规则 ----------------

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LSP', 'WebSearch', 'WebFetch', 'ToolSearch', 'Skill',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool'
]);

// 只读命令：第一个词（或前两个词）在这个名单里，并且没有重定向、没有串联其他命令
const READ_ONLY_COMMANDS = [
  /^(ls|dir|cat|type|head|tail|wc|pwd|tree|stat|file|which|where)\b/,
  /^(find|grep|rg|fd)\b/,
  /^git\s+(status|log|show|diff|ls-files|remote|branch|rev-parse|describe)\b/,
  /^claude\s+mcp\s+(list|get)\b/,
  /^npm\s+(view|ls|search)\b/,
  /^gh\s+(search|repo\s+view)\b/,
  /^(Get-ChildItem|Get-Content|Get-Item|Test-Path|Select-String|Resolve-Path)\b/i
];
// curl / gh api：只允许不带写操作参数的 GET 请求
const READ_ONLY_HTTP = /^(curl|gh\s+api)\b(?![^\n]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--method\s+(POST|PUT|PATCH|DELETE)|\s-d\b|\s--data|\s-F\b|\s--upload-file|\s-o\b|\s--output))/i;
// 运行 .claude/skills 下的脚本
const RUNS_SKILL_SCRIPT = /(?:\b(?:python3?|node|bash|sh|pwsh|powershell|deno|bun|npx|tsx)\b[^;&|\n]*\.claude[\\/]+skills)|(?:\.claude[\\/]+skills[^\s;&|]*\.(?:sh|py|js|mjs|cjs|ts|ps1|bat|cmd)\b)/i;

export type RuleDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string } | { behavior: 'ask' };

function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  // 重定向、串联、管道、命令替换一律交给用户确认
  if (/[>;&|`]|\$\(/.test(cmd)) return false;
  return READ_ONLY_COMMANDS.some(re => re.test(cmd)) || READ_ONLY_HTTP.test(cmd);
}

/** 项目里允许 Skills 配置模式改的文件：.claude/ 下的设置和 skills、.mcp.json、CLAUDE.md */
function isSkillsConfigFile(filePath: string, projectPath: string): boolean {
  const rel = path.relative(projectPath, path.resolve(projectPath, filePath)).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel.startsWith('.claude/') || rel === '.mcp.json' || rel === 'CLAUDE.md';
}

export function skillsModeDecision(toolName: string, input: Record<string, unknown>, projectPath: string): RuleDecision {
  if (READ_ONLY_TOOLS.has(toolName) || toolName.startsWith('mcp__')) {
    // MCP 工具不在这里自动放行，交给用户
    if (toolName.startsWith('mcp__')) return { behavior: 'ask' };
    return { behavior: 'allow' };
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = String(input.command ?? '');
    if (RUNS_SKILL_SCRIPT.test(command)) {
      return { behavior: 'deny', message: 'Skills 配置模式不运行下载来的 Skill 里的脚本。请把脚本内容给用户看，由用户决定。' };
    }
    return isReadOnlyCommand(command) ? { behavior: 'allow' } : { behavior: 'ask' };
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const filePath = String(input.file_path ?? input.notebook_path ?? '');
    if (isSkillsConfigFile(filePath, projectPath)) return { behavior: 'ask' };
    return { behavior: 'deny', message: 'Skills 配置模式下不改源代码，只改 .claude/、.mcp.json 和 CLAUDE.md。需要改代码请让用户切到其他模式。' };
  }
  return { behavior: 'ask' };
}
