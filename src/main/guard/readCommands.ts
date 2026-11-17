// 读附件的命令自动放行：只由 cd、echo、doc2md、audio-transcribe 组成的命令（可以用 && 或 ; 连起来）。
// 这些命令在 Claude Code 全局设置里已经单独放行了（见 docs/file-reading.md），但 Claude 有时会写成
//   cd "<附件文件夹>" && doc2md "周报.docx"; echo "=====PPT====="; doc2md "汇报.ppt"
// 这样拼起来的命令不匹配单条规则，又因为 cd 到了项目外面，会弹审批（端到端第 26 步实际遇到过）。
// 有重定向（> <）、管道（|）、命令替换（$( ) 和反引号）的一律不放行；纯函数，单元测试直接跑。

const SAFE = /^(cd|set-location|sl|pushd|echo|write-output|write-host|doc2md|audio-transcribe)(\s|$)/i;

/** 按 && || ; 切开（引号里的不算） */
function splitTopLevel(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '>' || c === '<' || c === '|' && cmd[i + 1] !== '|') return null; // 重定向、管道
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) { out.push(cur); cur = ''; i++; continue; }
    if (c === '&') return null; // 后台运行
    if (c === ';' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quote) return null; // 引号没配对
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

export function isSafeReadCommand(command: string): boolean {
  const c = command.trim();
  if (!c || /\$\(|`|\$\{/.test(c)) return false; // 命令替换（双引号里也会展开）
  const segs = splitTopLevel(c);
  return !!segs && segs.length > 0 && segs.every(s => SAFE.test(s));
}
