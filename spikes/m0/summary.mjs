// 汇总 results/ 下所有验证结果：每个脚本通过几项、花了多少。
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS } from './lib.mjs';

let total = 0, pass = 0, all = 0;
for (const f of fs.readdirSync(RESULTS).filter(f => f.endsWith('.json')).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8'));
  const p = j.checks.filter(c => c.ok).length;
  const cost = j.notes['合计花费 USD（按官方价估算）'] || 0;
  total += cost; pass += p; all += j.checks.length;
  const fails = j.checks.filter(c => !c.ok).map(c => c.label);
  console.log(`${j.name.padEnd(26)} ${p}/${j.checks.length}  $${cost.toFixed(4)}${fails.length ? '  未通过：' + fails.join('；') : ''}`);
}
console.log(`合计 ${pass}/${all} 项通过，总花费约 $${total.toFixed(3)}（按官方价估算，实际以中转计费为准）`);
