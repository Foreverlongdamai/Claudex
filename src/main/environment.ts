// 运行环境探测：Git Bash 在哪、有没有走中转、给 Claude Code 子进程的环境变量。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GitBash {
  path: string | null;
  source: 'prefs' | 'auto' | 'none';
}

/**
 * SDK 调起的 Claude Code 自己找不到 Git Bash（M0 发现），只能用 PowerShell，很多 Skills 就跑不了。
 * 所以 App 自己找：用户在设置里指定的 > 从 git 的安装位置推出来 > 几个常见安装位置。
 */
export function detectGitBash(preferred: string | null): GitBash {
  if (preferred && fs.existsSync(preferred)) return { path: preferred, source: 'prefs' };
  const candidates: string[] = [];
  try {
    const out = execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    for (const line of out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      const dir = path.dirname(line);
      // ...\Git\cmd\git.exe、...\Git\bin\git.exe、...\Git\mingw64\bin\git.exe
      candidates.push(path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, 'bash.exe'), path.join(dir, '..', '..', 'bin', 'bash.exe'));
    }
  } catch {
    // PATH 里没有 git
  }
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  candidates.push(path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(pf86, 'Git', 'bin', 'bash.exe'), path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'));
  const found = candidates.map(p => path.normalize(p)).find(p => fs.existsSync(p));
  return found ? { path: found, source: 'auto' } : { path: null, source: 'none' };
}

/** 读 Claude Code 用户设置里的中转地址，只返回主机名（不碰令牌）。直连 Anthropic 时返回 null。 */
export function relayHost(): string | null {
  let url = process.env.ANTHROPIC_BASE_URL;
  if (!url) {
    try {
      url = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'))?.env?.ANTHROPIC_BASE_URL;
    } catch {
      url = undefined;
    }
  }
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return /(^|\.)anthropic\.com$/i.test(host) ? null : host;
  } catch {
    return url;
  }
}

/** 给 Claude Code 子进程的环境变量。注意：SDK 的 env 选项会整个替换子进程环境，所以要带上 process.env。 */
export function sessionEnv(gitBash: string | null, appVersion: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `claudex/${appVersion}` };
  if (gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
  // Electron 会给自己的进程设 ELECTRON_RUN_AS_NODE 之类的变量，别传给子进程
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
