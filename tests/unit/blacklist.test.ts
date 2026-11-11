// 保底黑名单的单元测试：危险命令必须拦住，常见的正常命令不能误伤。
// 运行：npm run test:unit
import { DEFAULT_BLACKLIST, matchBlacklist } from '../../src/main/guard/blacklist.ts';

const blocked: Array<[tool: string, command: string, ruleId: string]> = [
  ['Bash', 'rm -rf /', 'delete-root-or-home'],
  ['Bash', 'rm -rf /*', 'delete-root-or-home'],
  ['Bash', 'rm -rf ~', 'delete-root-or-home'],
  ['Bash', 'rm -rf ~/', 'delete-root-or-home'],
  ['Bash', 'rm -rf "$HOME"', 'delete-root-or-home'],
  ['Bash', 'rm -fr /c/', 'delete-root-or-home'],
  ['Bash', 'rm -rf C:/', 'delete-root-or-home'],
  ['Bash', 'cd /tmp && rm -rf /c/Users/long', 'delete-root-or-home'],
  ['PowerShell', 'Remove-Item -Recurse -Force C:\\', 'delete-root-or-home'],
  ['PowerShell', 'Remove-Item -Recurse -Force C:\\Users\\long', 'delete-root-or-home'],
  ['PowerShell', 'Remove-Item $env:USERPROFILE -Recurse', 'delete-root-or-home'],
  ['Bash', 'rm -rf ~/.claude', 'delete-claude-home'],
  ['Bash', 'rm -rf "$HOME/.claude/"', 'delete-claude-home'],
  ['PowerShell', 'Remove-Item -Recurse C:\\Users\\long\\.claude', 'delete-claude-home'],
  ['Bash', 'git push --force', 'git-force-push'],
  ['Bash', 'git push -f origin main', 'git-force-push'],
  ['Bash', 'git push -uf origin main', 'git-force-push'],
  ['Bash', 'git push origin +main', 'git-force-push'],
  ['PowerShell', 'format C: /q', 'format-disk'],
  ['PowerShell', 'Format-Volume -DriveLetter D', 'format-disk'],
  ['Bash', 'echo y | diskpart', 'format-disk']
];

const allowed: Array<[tool: string, command: string]> = [
  ['Bash', 'rm -rf ./build'],
  ['Bash', 'rm -rf node_modules dist'],
  ['Bash', 'rm -rf ~/projects/demo/tmp'],
  ['Bash', 'rm /tmp/x.txt'],
  ['Bash', 'rm -rf ~/.claude/projects/old-session.jsonl'],
  ['Bash', 'ls ~/.claude'],
  ['PowerShell', 'Remove-Item -Recurse -Force C:\\Users\\long\\proj\\dist'],
  ['Bash', 'git push -u origin main'],
  ['Bash', 'git push --force-with-lease'],
  ['Bash', 'git push --follow-tags'],
  ['Bash', 'npm run format'],
  ['Bash', 'prettier --write . && git status'],
  ['Bash', 'echo "formatting C: drive is dangerous" > note.txt']
];

let failed = 0;
for (const [tool, command, ruleId] of blocked) {
  const hit = matchBlacklist(tool, { command }, DEFAULT_BLACKLIST);
  if (hit?.rule.id !== ruleId) { failed++; console.log(`FAIL  应拦截 [${ruleId}]：${command}  实际：${hit?.rule.id ?? '没拦'}`); }
}
for (const [tool, command] of allowed) {
  const hit = matchBlacklist(tool, { command }, DEFAULT_BLACKLIST);
  if (hit) { failed++; console.log(`FAIL  不该拦截：${command}  被规则 ${hit.rule.id} 拦了`); }
}
// 非 shell 工具不检查；关掉的规则不生效
if (matchBlacklist('Write', { file_path: '/x', content: 'rm -rf /' }, DEFAULT_BLACKLIST)) { failed++; console.log('FAIL  Write 不该被检查'); }
if (matchBlacklist('Bash', { command: 'rm -rf /' }, DEFAULT_BLACKLIST.map(r => ({ ...r, enabled: false })))) { failed++; console.log('FAIL  关掉的规则还在生效'); }

const total = blocked.length + allowed.length + 2;
console.log(`--- 保底黑名单：${total - failed}/${total} 通过`);
process.exit(failed ? 1 : 0);
