// Skills 配置模式的推荐清单（src/shared/skillPlan.ts）。
// 运行：npm run test:unit
import { checkedByDefault, claudeMdSection, CLAUDE_MD_END, itemWarnings, pickSkillDir, repoPage, repoUrl, upsertClaudeMd, withClosedSkills, type PlanItem } from '../../src/shared/skillPlan.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};

const good: PlanItem = { name: 'a', kind: 'skill', repo: 'o/r', description: 'd', license: 'MIT', scripts: 0 };
check('有许可证、没脚本：默认勾上', checkedByDefault(good) && itemWarnings(good).length === 0);
check('含脚本：默认不勾，有警告', !checkedByDefault({ ...good, scripts: 3 }) && itemWarnings({ ...good, scripts: 3 })[0] === '含 3 个脚本');
check('没有许可证：默认不勾', !checkedByDefault({ ...good, license: undefined }) && !checkedByDefault({ ...good, license: 'NOASSERTION' }) && itemWarnings({ ...good, license: '' }).includes('没有许可证'));
check('MCP 不看脚本数', checkedByDefault({ ...good, kind: 'mcp', scripts: 5 }));

check('仓库地址', repoUrl('anthropics/skills') === 'https://github.com/anthropics/skills.git' && repoUrl('D:\\repos\\x') === 'D:\\repos\\x' && repoUrl('https://gitlab.com/a/b.git') === 'https://gitlab.com/a/b.git');
check('网页地址', repoPage({ repo: 'o/r', path: 'skills/x' }) === 'https://github.com/o/r/tree/HEAD/skills/x' && repoPage({ repo: 'D:\\x' }) === null);

const dirs = [{ dir: '', name: 'root-skill' }, { dir: 'skills/greeter', name: 'greeter' }, { dir: 'skills/other', name: 'renamed' }];
check('找 Skill 文件夹：指定的 path', pickSkillDir(dirs, 'x', 'skills/other/') === 'skills/other');
check('找 Skill 文件夹：按 name', pickSkillDir(dirs, 'greeter') === 'skills/greeter' && pickSkillDir(dirs, 'renamed') === 'skills/other');
check('找 Skill 文件夹：按文件夹名', pickSkillDir([{ dir: 'a/my-skill' }], 'my-skill') === 'a/my-skill');
check('找 Skill 文件夹：只有一个就用它；找不到返回 null', pickSkillDir([{ dir: 'x' }], 'zzz') === 'x' && pickSkillDir(dirs, 'zzz') === null);
check('找 Skill 文件夹：path 是根目录', pickSkillDir(dirs, 'x', '') === '');

const s = withClosedSkills({ permissions: { allow: ['Read'] }, skillOverrides: { keep: 'on' } }, ['a', 'b']) as Record<string, any>;
check('关闭写进 skillOverrides，其他保留', s.permissions.allow[0] === 'Read' && s.skillOverrides.keep === 'on' && s.skillOverrides.a === 'off' && s.skillOverrides.b === 'off', s);
check('没有要关的就原样', JSON.stringify(withClosedSkills({ x: 1 }, [])) === '{"x":1}');

const section = claudeMdSection({ keep: ['arxiv'], installed: [{ name: 'greeter', repo: 'o/r', scripts: 0 }], mcp: [{ name: 'wandb', repo: 'wandb/mcp' }], closed: ['a', 'b'] });
check('CLAUDE.md 那一段', section.includes('## 本项目用的 Skills 和工具') && section.includes('greeter（来自 o/r）') && section.includes('wandb（wandb/mcp）') && section.includes('skillOverrides）：a、b') && section.endsWith(CLAUDE_MD_END), section);
const md1 = upsertClaudeMd('# 项目\n\n说明\n', section);
check('没有就加在最后', md1.startsWith('# 项目\n\n说明\n\n<!-- claudex:skills') && md1.endsWith(CLAUDE_MD_END + '\n'), md1);
const section2 = claudeMdSection({ keep: [], installed: [], mcp: [], closed: [] });
const md2 = upsertClaudeMd(md1 + '\n后面的内容\n', section2);
check('已经有就替换，前后内容保留', md2.includes('（没有选任何 Skill 或工具）') && !md2.includes('greeter') && md2.includes('后面的内容') && md2.startsWith('# 项目') && md2.split('claudex:skills 由').length === 2, md2);
check('空文件', upsertClaudeMd('', section2) === section2 + '\n');

console.log(`--- Skills 推荐清单：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
