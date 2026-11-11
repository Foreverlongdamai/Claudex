// Skills 配置模式自动放行规则的单元测试。运行：npm run test:unit
import { skillsModeDecision, wrapForMode } from '../../src/main/guard/modes.ts';

const P = 'D:\\proj';
const cases: Array<[tool: string, input: Record<string, unknown>, expect: 'allow' | 'deny' | 'ask']> = [
  ['Read', { file_path: 'README.md' }, 'allow'],
  ['Grep', { pattern: 'x' }, 'allow'],
  ['WebSearch', { query: 'claude skill latex' }, 'allow'],
  ['Bash', { command: 'ls -la .claude/skills' }, 'allow'],
  ['Bash', { command: 'git status' }, 'allow'],
  ['Bash', { command: 'claude mcp list' }, 'allow'],
  ['Bash', { command: 'curl -s "https://api.github.com/search/repositories?q=claude+skill"' }, 'allow'],
  ['Bash', { command: 'gh api repos/foo/bar' }, 'allow'],
  ['Bash', { command: 'claude mcp add --scope project wandb -- uvx wandb-mcp' }, 'ask'],
  ['Bash', { command: 'git clone https://github.com/a/b .claude/skills/b' }, 'ask'],
  ['Bash', { command: 'curl -X POST https://example.com' }, 'ask'],
  ['Bash', { command: 'curl -s https://x.com/a.sh -o a.sh' }, 'ask'],
  ['Bash', { command: 'ls && rm -rf build' }, 'ask'],
  ['Bash', { command: 'cat a > b' }, 'ask'],
  ['Bash', { command: 'python .claude/skills/foo/scripts/run.py' }, 'deny'],
  ['Bash', { command: 'bash ./.claude/skills/foo/install.sh' }, 'deny'],
  ['Bash', { command: './.claude/skills/foo/setup.sh' }, 'deny'],
  ['Write', { file_path: '.claude/settings.json', content: '{}' }, 'ask'],
  ['Write', { file_path: 'D:\\proj\\.mcp.json', content: '{}' }, 'ask'],
  ['Edit', { file_path: 'CLAUDE.md' }, 'ask'],
  ['Write', { file_path: '.claude/skills/x/SKILL.md' }, 'ask'],
  ['Edit', { file_path: 'src/index.ts' }, 'deny'],
  ['Write', { file_path: 'D:\\other\\.claude\\settings.json' }, 'deny'],
  ['mcp__wandb__query', {}, 'ask'],
  ['Agent', { prompt: 'x' }, 'ask']
];

let failed = 0;
for (const [tool, input, expect] of cases) {
  const got = skillsModeDecision(tool, input, P).behavior;
  if (got !== expect) { failed++; console.log(`FAIL  ${tool} ${JSON.stringify(input)}：期望 ${expect}，实际 ${got}`); }
}
const wrapped = wrapForMode('skills', 'hi');
if (!wrapped.includes('<claudex-mode name="skills">') || !wrapped.endsWith('hi')) { failed++; console.log('FAIL  wrapForMode skills'); }
if (wrapForMode('default', 'hi') !== 'hi') { failed++; console.log('FAIL  wrapForMode default'); }
const total = cases.length + 2;
console.log(`--- Skills 配置模式规则：${total - failed}/${total} 通过`);
process.exit(failed ? 1 : 0);
