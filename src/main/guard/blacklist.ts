// 保底黑名单：任何模式下（包括完全访问）都拦截的高危命令。
// 通过 SDK 的 PreToolUse hook 生效，M0 验证过完全访问下 hook 照样执行。
// 这个文件不依赖 Electron，方便单独测试（tests/unit/blacklist.test.ts）。
import type { BlacklistRule } from '../../shared/types.ts';

// 删除命令：bash 的 rm / rmdir，PowerShell 的 Remove-Item / ri / rmdir
const DELETE_VERB = String.raw`(?:^|[;&|(\s])(?:rm|rmdir|Remove-Item|ri)\b[^;&|\n]*?\s["']?`;
// 命令结束的位置：空白、行尾、命令分隔符
const END = String.raw`[\\/]?\*?["']?(?=\s|$|[;&|)])`;
// 用户目录的各种写法
const HOME = String.raw`(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%|[a-zA-Z]:[\\/]Users[\\/][^\\/\s"';&|]+|\/[a-zA-Z]\/Users\/[^\/\s"';&|]+)`;
// 盘根：/、/c、C:、C:\
const ROOT = String.raw`(?:\/|\/[a-zA-Z]|[a-zA-Z]:)`;

export const DEFAULT_BLACKLIST: BlacklistRule[] = [
  {
    id: 'delete-root-or-home',
    label: '删除盘根或用户目录',
    tools: ['Bash', 'PowerShell'],
    pattern: DELETE_VERB + String.raw`(?:${ROOT}|${HOME})` + END,
    flags: 'i',
    enabled: true
  },
  {
    id: 'delete-claude-home',
    label: '删除 ~/.claude',
    tools: ['Bash', 'PowerShell'],
    pattern: DELETE_VERB + HOME + String.raw`[\\/]\.claude` + END,
    flags: 'i',
    enabled: true
  },
  {
    id: 'git-force-push',
    label: '强制推送（git push --force）',
    tools: ['Bash', 'PowerShell'],
    // --force（不含更安全的 --force-with-lease）、-f 及含 f 的短参数组合、+refspec
    pattern: String.raw`\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(?:\s--force(?!-with-lease)\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+[^\s]+)`,
    enabled: true
  },
  {
    id: 'format-disk',
    label: '格式化磁盘',
    tools: ['Bash', 'PowerShell'],
    pattern: String.raw`(?:^|[;&|(\s])(?:format(?:\.com)?\s+[a-zA-Z]:|Format-Volume\b|Clear-Disk\b|diskpart\b|mkfs(?:\.\w+)?\b)`,
    flags: 'i',
    enabled: true
  }
];

export interface BlacklistHit {
  rule: BlacklistRule;
  detail: string;
}

/** 检查一次工具调用是否命中黑名单。目前只检查 shell 命令。 */
export function matchBlacklist(toolName: string, input: unknown, rules: BlacklistRule[]): BlacklistHit | null {
  const command = typeof (input as { command?: unknown })?.command === 'string' ? (input as { command: string }).command : null;
  if (command === null) return null;
  for (const rule of rules) {
    if (!rule.enabled || !rule.tools.includes(toolName)) continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, rule.flags);
    } catch {
      continue; // 用户改坏的规则直接跳过，不影响其他规则
    }
    if (re.test(command)) return { rule, detail: command };
  }
  return null;
}
