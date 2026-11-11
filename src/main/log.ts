// 主进程日志：写到 userData/logs/main.log，超过 5 MB 就从头写。不记录任何环境变量和令牌。
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

let file: string | null = null;

export function log(line: string): void {
  try {
    if (!file) {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'main.log');
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.writeFileSync(file, '');
    }
    const safe = line.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
    fs.appendFileSync(file, `${new Date().toISOString()} ${safe}\n`);
  } catch {
    // 写日志失败不影响使用
  }
}
