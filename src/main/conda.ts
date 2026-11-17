// 项目环境（conda）：每个项目指定一个 conda 环境，项目里所有对话（本地、worktree，以后的老板和员工）和终端都用它。
// 做法和 conda activate 一样：把环境的几个目录放到 PATH 最前面，设好 CONDA_PREFIX 等变量。
// 还没指定时，在系统提示里告诉 Claude：先找现有的环境，没有就为项目新建一个，再用 set_project_env 工具登记。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CondaEnv, CondaInfo } from '../shared/types';

const run = promisify(execFile);

export interface CondaInstall {
  exe: string;
  root: string;
}

/** conda 装在哪：CONDA_EXE > PATH 里的 conda > 几个常见位置 */
export async function findConda(): Promise<CondaInstall | null> {
  const roots: string[] = [];
  if (process.env.CONDA_EXE) roots.push(path.dirname(path.dirname(process.env.CONDA_EXE)));
  try {
    const { stdout } = await run('where', ['conda'], { windowsHide: true, timeout: 5000 });
    for (const line of stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      // ...\Scripts\conda.exe、...\condabin\conda.bat、...\Library\bin\conda.bat
      const dir = path.dirname(line);
      roots.push(path.basename(dir).toLowerCase() === 'bin' ? path.dirname(path.dirname(dir)) : path.dirname(dir));
    }
  } catch {
    // PATH 里没有 conda
  }
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  for (const name of ['anaconda3', 'miniconda3', 'Anaconda', 'Miniconda', 'Anaconda3', 'Miniconda3', 'miniforge3']) {
    roots.push(path.join(home, name), path.join(local, name), path.join('C:\\ProgramData', name), path.join('C:\\', name), path.join('D:\\', name));
  }
  for (const root of roots) {
    const exe = path.join(root, 'Scripts', 'conda.exe');
    if (fs.existsSync(exe)) return { exe, root: path.resolve(root) };
  }
  return null;
}

let cache: { at: number; info: CondaInfo; install: CondaInstall | null } | null = null;

/** conda 和它的环境列表（缓存 1 分钟；force 时重新查，比如 Claude 刚新建了环境） */
export async function condaInfo(force = false): Promise<CondaInfo & { install: CondaInstall | null }> {
  if (!force && cache && Date.now() - cache.at < 60_000) return { ...cache.info, install: cache.install };
  const install = await findConda();
  let envs: CondaEnv[] = [];
  if (install) {
    try {
      const { stdout } = await run(install.exe, ['env', 'list', '--json'], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      const prefixes: string[] = JSON.parse(stdout).envs ?? [];
      envs = prefixes.map(p => ({ prefix: path.resolve(p), name: envName(p, install.root) }));
    } catch {
      envs = [];
    }
  }
  const info: CondaInfo = { available: !!install, root: install?.root ?? null, envs };
  cache = { at: Date.now(), info, install };
  return { ...info, install };
}

function envName(prefix: string, root: string): string {
  const p = path.resolve(prefix);
  if (p.toLowerCase() === path.resolve(root).toLowerCase()) return 'base';
  return path.basename(p);
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** 按名字或路径找环境 */
export function findEnv(info: CondaInfo, nameOrPrefix: string): CondaEnv | undefined {
  const q = nameOrPrefix.trim();
  return info.envs.find(e => e.name === q) ?? info.envs.find(e => (path.isAbsolute(q) ? samePath(e.prefix, q) : false));
}

/** 和 conda activate 一样：环境的目录放到 PATH 最前面，设好 CONDA_* 变量。env 是要传给子进程的环境变量（会被改） */
export function activate<T extends Record<string, string | undefined>>(env: T, condaEnv: CondaEnv, install: CondaInstall | null): T {
  const p = condaEnv.prefix;
  const dirs = [p, path.join(p, 'Library', 'mingw-w64', 'bin'), path.join(p, 'Library', 'usr', 'bin'), path.join(p, 'Library', 'bin'), path.join(p, 'Scripts'), path.join(p, 'bin')];
  // Windows 上环境变量名不分大小写，复制出来的对象里可能叫 Path，不能再加一个 PATH
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  const rest = (env[key] ?? '').split(';').filter(d => d && !dirs.some(x => samePath(x, d)));
  (env as Record<string, string | undefined>)[key] = [...dirs, ...rest].join(';');
  Object.assign(env, {
    CONDA_PREFIX: p,
    CONDA_DEFAULT_ENV: condaEnv.name,
    CONDA_SHLVL: '1',
    CONDA_PROMPT_MODIFIER: `(${condaEnv.name}) `,
    // 终端的登录脚本里如果有 conda init，别让它把 base 激活回来
    CONDA_AUTO_ACTIVATE_BASE: 'false',
    ...(install ? { CONDA_EXE: install.exe, CONDA_PYTHON_EXE: path.join(install.root, 'python.exe') } : {})
  });
  return env;
}

/** 系统提示里关于项目环境的说明；没装 conda 时返回 null */
export function envPrompt(projectName: string, condaEnv: CondaEnv | undefined, info: CondaInfo): string | null {
  if (!info.available) return null;
  if (condaEnv) {
    return [
      '# 本项目的 Python 环境（Claudex）',
      `这个项目指定使用 conda 环境「${condaEnv.name}」（${condaEnv.prefix}），它已经放在 PATH 最前面：直接运行 python、pip 用的就是这个环境。`,
      '- 不要 conda activate 别的环境，也不要另建 venv / virtualenv。',
      `- 需要装包就装进这个环境（pip install …，或 conda install -p "${condaEnv.prefix}" …）。`,
      '- 这个项目里所有的对话（包括在 worktree 里的）都用这一个环境。',
      '- 如果用户要换环境，选好或建好以后调用 mcp__claudex__set_project_env 重新登记。'
    ].join('\n');
  }
  const slug = projectName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project';
  return [
    '# 本项目的 Python 环境（Claudex）',
    '这个项目还没有指定 Python 环境。本机装了 conda。只有在需要运行 Python 时才处理这件事：',
    '1. 先运行 `conda env list` 看现有的 conda 环境里有没有能用的（有项目需要的包、Python 版本合适）。',
    `2. 没有合适的，就在 conda 里为这个项目新建一个，例如 \`conda create -n ${slug} python=3.11 -y\`，再装项目需要的包。`,
    '3. 选好或建好以后，调用 mcp__claudex__set_project_env 工具把它登记为本项目的环境；之后这个项目里所有的对话（包括 worktree 里的）都会自动用它。',
    '不要用 venv / virtualenv，也不要把包装进 base 环境。'
  ].join('\n');
}
