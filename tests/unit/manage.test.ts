// M3 管理：Skill 文件检查和模板、Claude Code 设置的表单读写（src/shared/skillFile.ts、claudeSettings.ts）。
// 运行：npm run test:unit
import { checkSkill, parseFrontmatter, skillTemplate } from '../../src/shared/skillFile.ts';
import { applyForm, checkForm, isSecretKey, mask, toForm } from '../../src/shared/claudeSettings.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};

// ---- SKILL.md ----
const good = '---\nname: release-check\ndescription: "发布前检查版本号: 更新日志和构建产物"\nallowed-tools: Read\n---\n\n# 步骤\n1. 看版本号\n';
const fm = parseFrontmatter(good);
check('读 YAML 头：带引号、冒号', fm.ok && fm.fields.name === 'release-check' && fm.fields.description === '发布前检查版本号: 更新日志和构建产物' && fm.body.includes('# 步骤'), fm);
check('多行描述接起来', parseFrontmatter('---\nname: a\ndescription: >\n  第一行\n  第二行\n---\nx').fields.description === '第一行 第二行');
check('Windows 换行', parseFrontmatter(good.replace(/\n/g, '\r\n')).fields.name === 'release-check');
check('格式正确没有问题', checkSkill(good, 'release-check').length === 0, checkSkill(good, 'release-check'));
check('没有 YAML 头', checkSkill('# 只有正文').length === 1 && checkSkill('# 只有正文')[0].includes('YAML 头'));
check('缺 name、description', JSON.stringify(checkSkill('---\nfoo: 1\n---\n正文')).includes('缺少 name') && JSON.stringify(checkSkill('---\nfoo: 1\n---\n正文')).includes('缺少 description'));
check('name 大写不行', checkSkill('---\nname: Release_Check\ndescription: d\n---\n正文').some(p => p.includes('小写字母')));
check('name 和文件夹不一样', checkSkill('---\nname: a-b\ndescription: d\n---\n正文', 'other').some(p => p.includes('文件夹是 other')));
check('description 太长', checkSkill(`---\nname: a\ndescription: ${'很'.repeat(1100)}\n---\n正文`).some(p => p.includes('1024')));
check('正文是空的', checkSkill('---\nname: a\ndescription: d\n---\n\n').some(p => p.includes('正文是空的')));
check('模板本身是合格的', checkSkill(skillTemplate('my-skill', '做某件事'), 'my-skill').length === 0, checkSkill(skillTemplate('my-skill', '做某件事'), 'my-skill'));
check('模板：描述空着时给提示语', parseFrontmatter(skillTemplate('x', '')).fields.description.includes('什么时候用'));

// ---- settings.json ----
const original = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  env: { ANTHROPIC_BASE_URL: 'https://relay.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-secret-123456' },
  permissions: { allow: ['Bash(npm test)'], defaultMode: 'bypassPermissions', additionalDirectories: ['D:\\data'] },
  model: 'opus',
  enabledPlugins: { 'a@b': true },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] }
};
const form = toForm(original);
check('读成表单', form.model === 'opus' && form.env.length === 2 && form.allow[0] === 'Bash(npm test)' && form.defaultMode === 'bypassPermissions' && JSON.parse(form.hooks).Stop.length === 1, form);
check('没改就原样', JSON.stringify(applyForm(original, form, form)) === JSON.stringify(original));
const changed = { ...form, model: 'sonnet', allow: [...form.allow, 'Bash(git status)', '  '], env: [...form.env, { key: 'MY_VAR', value: '1' }] };
const next = applyForm(original, form, changed) as Record<string, any>;
check('改了的写进去', next.model === 'sonnet' && next.permissions.allow.length === 2 && next.env.MY_VAR === '1', next);
check('其他字段和顺序保留', JSON.stringify(Object.keys(next)) === JSON.stringify(Object.keys(original)) && next.enabledPlugins['a@b'] === true && next.permissions.additionalDirectories[0] === 'D:\\data' && next.$schema === original.$schema, next);
check('密钥原样保留（没在表单里改）', next.env.ANTHROPIC_AUTH_TOKEN === 'sk-secret-123456');
const cleared = applyForm(original, form, { ...form, model: '', hooks: '', allow: [], defaultMode: '' }) as Record<string, any>;
check('清空就删掉那一项', !('model' in cleared) && !('hooks' in cleared) && !('allow' in cleared.permissions) && !('defaultMode' in cleared.permissions) && cleared.permissions.additionalDirectories.length === 1, cleared);
const empty = applyForm({}, toForm({}), { ...toForm({}), allow: ['Read'] }) as Record<string, any>;
check('空设置里加权限', JSON.stringify(empty) === '{"permissions":{"allow":["Read"]}}', empty);
check('删光权限就去掉 permissions', !('permissions' in applyForm({ permissions: { allow: ['Read'] } }, toForm({ permissions: { allow: ['Read'] } }), { ...toForm({}), allow: [] })));

check('检查：环境变量名', checkForm({ ...form, env: [{ key: '1BAD', value: '' }] })?.includes('1BAD') === true && checkForm({ ...form, env: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] })?.includes('两次') === true);
check('检查：hooks 要是 JSON 对象', checkForm({ ...form, hooks: '{bad' })?.includes('JSON') === true && checkForm({ ...form, hooks: '[]' }) !== null && checkForm(form) === null);
check('看起来是密钥的变量', isSecretKey('ANTHROPIC_AUTH_TOKEN') && isSecretKey('OPENAI_API_KEY') && isSecretKey('DB_PASSWORD') && !isSecretKey('ANTHROPIC_BASE_URL'));
check('打码', mask('sk-secret-123456') === 'sk-s••••••••••••' && mask('abc') === '••••••' && mask('') === '', mask('sk-secret-123456'));

console.log(`--- Skills 和设置的管理：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
