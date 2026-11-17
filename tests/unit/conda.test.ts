// 项目环境（src/main/conda.ts）：找 conda、像 conda activate 一样拼环境变量、系统提示里的说明。
// 运行：npm run test:unit（本机没装 conda 时，和 conda 本身有关的检查跳过）
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { activate, condaInfo, envPrompt, findEnv } from '../../src/main/conda.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};

// ---- 拼环境变量（不依赖本机装没装 conda） ----
const env = { Path: 'C:\\Windows;D:\\Anaconda\\envs\\x\\Scripts;C:\\tools', OTHER: '1' } as Record<string, string | undefined>;
const x = { name: 'x', prefix: 'D:\\Anaconda\\envs\\x' };
activate(env, x, { exe: 'D:\\Anaconda\\Scripts\\conda.exe', root: 'D:\\Anaconda' });
const parts = env.Path!.split(';');
check('沿用原来的 Path 键，不另加 PATH（Windows 上会重复）', !('PATH' in env) && typeof env.Path === 'string');
check('环境目录放在最前面，顺序和 conda activate 一样', parts.slice(0, 6).join(';') === [
  'D:\\Anaconda\\envs\\x', 'D:\\Anaconda\\envs\\x\\Library\\mingw-w64\\bin', 'D:\\Anaconda\\envs\\x\\Library\\usr\\bin',
  'D:\\Anaconda\\envs\\x\\Library\\bin', 'D:\\Anaconda\\envs\\x\\Scripts', 'D:\\Anaconda\\envs\\x\\bin'
].join(';'), parts);
check('原来 PATH 里重复的环境目录去掉，其他保留', parts.filter(p => p.toLowerCase() === 'd:\\anaconda\\envs\\x\\scripts').length === 1 && parts.includes('C:\\Windows') && parts.includes('C:\\tools'), parts);
check('CONDA_* 变量', env.CONDA_PREFIX === x.prefix && env.CONDA_DEFAULT_ENV === 'x' && env.CONDA_SHLVL === '1' && env.CONDA_EXE === 'D:\\Anaconda\\Scripts\\conda.exe' && env.CONDA_AUTO_ACTIVATE_BASE === 'false', env);
check('其他变量不动', env.OTHER === '1');

// ---- 系统提示 ----
const info = { available: true, root: 'D:\\Anaconda', envs: [x, { name: 'base', prefix: 'D:\\Anaconda' }] };
const withEnv = envPrompt('demo', x, info)!;
check('指定了环境：说明用哪个环境、不要另建', withEnv.includes('「x」') && withEnv.includes(x.prefix) && withEnv.includes('不要') && withEnv.includes('worktree'), withEnv);
const noEnv = envPrompt('My Project!', undefined, info)!;
check('没指定：先找现有的，没有就新建，再登记', noEnv.includes('conda env list') && noEnv.includes('conda create -n my-project') && noEnv.includes('mcp__claudex__set_project_env'), noEnv);
check('没装 conda：不加说明', envPrompt('demo', undefined, { available: false, root: null, envs: [] }) === null);
check('按名字找环境', findEnv(info, 'x')?.prefix === x.prefix && findEnv(info, 'base')?.prefix === 'D:\\Anaconda');
check('按路径找环境（大小写、斜杠不同也行）', findEnv(info, 'd:/anaconda/envs/X')?.name === 'x');
check('找不到返回 undefined', findEnv(info, 'nope') === undefined);

// ---- 本机的 conda ----
const real = await condaInfo(true);
if (!real.available) {
  console.log('      （本机没装 conda，跳过实际环境的检查）');
} else {
  check('找到 conda 和它的环境', !!real.install && real.envs.length > 0 && real.envs.some(e => e.name === 'base'), real);
  const other = real.envs.find(e => e.name !== 'base') ?? real.envs[0];
  const e2 = activate({ ...process.env } as Record<string, string | undefined>, other, real.install);
  const out = execFileSync('python', ['-c', 'import sys; print(sys.prefix)'], { env: e2 as NodeJS.ProcessEnv, encoding: 'utf8' }).trim();
  check(`拼好的环境变量里运行 python，用的就是 ${other.name}`, path.resolve(out).toLowerCase() === path.resolve(other.prefix).toLowerCase(), { out, want: other.prefix });
}

console.log(`--- 项目环境（conda）：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
