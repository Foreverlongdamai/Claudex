// Skill 文件（SKILL.md）的检查和模板（M3）。纯函数，单元测试直接跑。
// 格式：开头是 YAML 头（--- 包起来），至少有 name 和 description；正文是 Claude 用这个 Skill 时照着做的说明。

export interface Frontmatter {
  ok: boolean;
  fields: Record<string, string>;
  body: string;
}

/** 读 YAML 头里的 key: value（只认一层；值可以带引号；多行值的后续行接在上一个值后面） */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(src);
  if (!m) return { ok: false, fields: {}, body: src };
  const fields: Record<string, string> = {};
  let last: string | null = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      last = kv[1];
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
      fields[last] = v === '|' || v === '>' ? '' : v;
    } else if (last && /^\s+\S/.test(line)) {
      fields[last] = `${fields[last]} ${line.trim()}`.trim();
    }
  }
  return { ok: true, fields, body: m[2] };
}

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 检查 SKILL.md：返回问题列表（空表示没问题）。folder：Skill 所在文件夹的名字 */
export function checkSkill(text: string, folder?: string): string[] {
  const fm = parseFrontmatter(text);
  if (!fm.ok) return ['开头要有 YAML 头：第一行 ---，写 name 和 description，再一行 --- 结束'];
  const problems: string[] = [];
  const name = fm.fields.name ?? '';
  const desc = fm.fields.description ?? '';
  if (!name) problems.push('缺少 name');
  else {
    if (!SKILL_NAME.test(name)) problems.push('name 只能用小写字母、数字和 -（比如 release-check）');
    if (name.length > 64) problems.push('name 最多 64 个字符');
    if (folder && name !== folder) problems.push(`name 要和文件夹名一样（文件夹是 ${folder}）`);
  }
  if (!desc) problems.push('缺少 description：写清楚这个 Skill 做什么、什么时候用（Claude 靠它决定要不要用）');
  else if (desc.length > 1024) problems.push(`description 最多 1024 个字符（现在 ${desc.length} 个）`);
  if (!fm.body.trim()) problems.push('正文是空的：写上 Claude 用这个 Skill 时要照着做的步骤');
  return problems;
}

/** 新建 Skill 的模板 */
export function skillTemplate(name: string, description: string): string {
  return `---
name: ${name}
description: ${description.replace(/\s*\n\s*/g, ' ').trim() || '这个 Skill 做什么、什么时候用（用户说了哪些话时用它）'}
---

# ${name}

## 什么时候用

- 用户说……的时候

## 步骤

1. 第一步
2. 第二步
3. 最后把结果整理成……的格式汇报
`;
}
