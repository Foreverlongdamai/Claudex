// 项目相关：添加前的安全检查、项目里的 MCP 服务器、文件列表（@ 引用用）、git 分支。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { McpServerInfo, ProjectCheck } from '../shared/types';

const run = promisify(execFile);

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 项目自带的 .mcp.json 里的服务器。SDK 会话里这些服务器不经批准就会启动（M0 发现），App 要自己把关。 */
export function projectMcpServers(projectPath: string): McpServerInfo[] {
  const servers = readJson(path.join(projectPath, '.mcp.json'))?.mcpServers ?? {};
  return Object.entries<any>(servers).map(([name, cfg]) => ({
    name,
    command: cfg?.url ? String(cfg.url) : [cfg?.command, ...(cfg?.args ?? [])].filter(Boolean).join(' ')
  }));
}

/** 项目设置里的 hooks 会在 Claude 运行时自动执行命令，添加陌生项目前要提醒用户。 */
function countHooks(projectPath: string): number {
  let n = 0;
  for (const f of ['settings.json', 'settings.local.json']) {
    const hooks = readJson(path.join(projectPath, '.claude', f))?.hooks ?? {};
    for (const matchers of Object.values<any>(hooks)) {
      for (const m of Array.isArray(matchers) ? matchers : []) n += Array.isArray(m?.hooks) ? m.hooks.length : 0;
    }
  }
  return n;
}

export function checkProject(projectPath: string): ProjectCheck {
  return {
    path: projectPath,
    name: path.basename(projectPath) || projectPath,
    hooks: countHooks(projectPath),
    mcpServers: projectMcpServers(projectPath)
  };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', '.next', 'target']);

/** 列出项目文件（相对路径）：git 仓库用 git ls-files，否则遍历目录（有上限）。 */
async function allFiles(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: projectPath, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const files = stdout.split(/\r?\n/).filter(Boolean);
    if (files.length) return files;
  } catch {
    // 不是 git 仓库
  }
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= 5000 || depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1); }
      else out.push(path.relative(projectPath, path.join(dir, e.name)).replace(/\\/g, '/'));
    }
  };
  walk(projectPath, 0);
  return out;
}

const fileCache = new Map<string, { at: number; files: string[] }>();

export async function listFiles(projectPath: string, query: string): Promise<string[]> {
  let cached = fileCache.get(projectPath);
  if (!cached || Date.now() - cached.at > 30_000) {
    cached = { at: Date.now(), files: await allFiles(projectPath) };
    fileCache.set(projectPath, cached);
  }
  const q = query.toLowerCase();
  const hits = q ? cached.files.filter(f => f.toLowerCase().includes(q)) : cached.files;
  // 文件名开头匹配的排前面
  return hits.sort((a, b) => Number(!path.basename(a).toLowerCase().startsWith(q)) - Number(!path.basename(b).toLowerCase().startsWith(q))).slice(0, 50);
}

export async function gitBranch(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, windowsHide: true, timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
