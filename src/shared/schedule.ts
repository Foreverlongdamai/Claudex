// 自动化的“什么时候跑”：每天 / 每个工作日 / 每周某天 / 每小时，按本机时间算下一次运行的时刻。
// 纯函数，不依赖 Node，单元测试直接跑。

export type ScheduleKind = 'daily' | 'weekdays' | 'weekly' | 'hourly';

export interface Schedule {
  kind: ScheduleKind;
  /** HH:mm；每小时的只用分钟 */
  time: string;
  /** 每周的哪一天：0 周日 … 6 周六 */
  weekday?: number;
}

export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "8:05" → [8, 5]；不合法返回 null */
export function parseTime(time: string): [number, number] | null {
  const m = /^\s*(\d{1,2})[:：](\d{2})\s*$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? [h, min] : null;
}

/** 检查设置是否完整，不对时返回原因 */
export function checkSchedule(s: Schedule): string | null {
  if (!['daily', 'weekdays', 'weekly', 'hourly'].includes(s.kind)) return '不认识的运行周期';
  if (!parseTime(s.time)) return '时间要写成 08:00 这样（24 小时制）';
  if (s.kind === 'weekly' && !(Number.isInteger(s.weekday) && s.weekday! >= 0 && s.weekday! <= 6)) return '每周要选星期几';
  return null;
}

/** 严格晚于 after 的下一次运行时刻（毫秒时间戳）；设置不对返回 null */
export function nextRun(s: Schedule, after: number): number | null {
  if (checkSchedule(s)) return null;
  const [h, min] = parseTime(s.time)!;
  if (s.kind === 'hourly') {
    const d = new Date(after);
    d.setMinutes(min, 0, 0);
    while (d.getTime() <= after) d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  const d = new Date(after);
  d.setHours(h, min, 0, 0);
  // 最多往后找 8 天（每周的最远 7 天后）
  for (let i = 0; i < 9; i++) {
    const day = d.getDay();
    const okDay = s.kind === 'daily' || (s.kind === 'weekdays' && day >= 1 && day <= 5) || (s.kind === 'weekly' && day === s.weekday);
    if (okDay && d.getTime() > after) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(h, min, 0, 0);
  }
  return null;
}

/** 给人看的说法：每天 08:00、每个工作日 07:30、每周一 09:00、每小时的第 15 分 */
export function describeSchedule(s: Schedule): string {
  const t = parseTime(s.time);
  const hm = t ? `${String(t[0]).padStart(2, '0')}:${String(t[1]).padStart(2, '0')}` : s.time;
  switch (s.kind) {
    case 'daily': return `每天 ${hm}`;
    case 'weekdays': return `每个工作日 ${hm}`;
    case 'weekly': return `每${WEEKDAY_NAMES[s.weekday ?? 1]} ${hm}`;
    case 'hourly': return `每小时的第 ${t ? t[1] : '?'} 分`;
  }
}

/** 时刻的简短说法：今天 08:00、明天 08:00、11-20 08:00 */
export function describeWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === -1) return `昨天 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}
