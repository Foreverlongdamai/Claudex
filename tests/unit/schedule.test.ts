// 自动化的运行时刻（src/shared/schedule.ts）。用本机时间构造日期，和时区无关。
// 运行：npm run test:unit
import { checkSchedule, describeSchedule, describeWhen, nextRun, parseTime } from '../../src/shared/schedule.ts';

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
};
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const show = (t: number | null) => (t === null ? null : new Date(t).toString());

// 2026-11-16 是周一，11-21 周六，11-22 周日
check('parseTime', JSON.stringify(parseTime('8:05')) === '[8,5]' && JSON.stringify(parseTime('23：59')) === '[23,59]' && parseTime('24:00') === null && parseTime('8点') === null);
check('checkSchedule：时间不对', checkSchedule({ kind: 'daily', time: '25:00' }) !== null);
check('checkSchedule：每周要选星期几', checkSchedule({ kind: 'weekly', time: '09:00' }) !== null && checkSchedule({ kind: 'weekly', time: '09:00', weekday: 1 }) === null);

// 每天
check('每天：今天还没到点', nextRun({ kind: 'daily', time: '08:00' }, at(2026, 11, 16, 7, 59)) === at(2026, 11, 16, 8, 0));
check('每天：正好到点算下一天（严格晚于）', nextRun({ kind: 'daily', time: '08:00' }, at(2026, 11, 16, 8, 0)) === at(2026, 11, 17, 8, 0));
check('每天：过了点就是明天', nextRun({ kind: 'daily', time: '08:00' }, at(2026, 11, 16, 9, 0)) === at(2026, 11, 17, 8, 0));
check('每天：跨月', nextRun({ kind: 'daily', time: '00:30' }, at(2026, 11, 30, 23, 0)) === at(2026, 12, 1, 0, 30));
check('每天：跨年', nextRun({ kind: 'daily', time: '08:00' }, at(2026, 12, 31, 9, 0)) === at(2027, 1, 1, 8, 0));

// 每个工作日
check('工作日：周五晚上 → 下周一', nextRun({ kind: 'weekdays', time: '07:30' }, at(2026, 11, 20, 20, 0)) === at(2026, 11, 23, 7, 30), show(nextRun({ kind: 'weekdays', time: '07:30' }, at(2026, 11, 20, 20, 0))));
check('工作日：周六 → 下周一', nextRun({ kind: 'weekdays', time: '07:30' }, at(2026, 11, 21, 6, 0)) === at(2026, 11, 23, 7, 30));
check('工作日：周二早上 → 当天', nextRun({ kind: 'weekdays', time: '07:30' }, at(2026, 11, 17, 6, 0)) === at(2026, 11, 17, 7, 30));

// 每周
check('每周一：周一过了点 → 下周一', nextRun({ kind: 'weekly', time: '09:00', weekday: 1 }, at(2026, 11, 16, 10, 0)) === at(2026, 11, 23, 9, 0));
check('每周一：周一没到点 → 当天', nextRun({ kind: 'weekly', time: '09:00', weekday: 1 }, at(2026, 11, 16, 8, 0)) === at(2026, 11, 16, 9, 0));
check('每周日：周三 → 本周日', nextRun({ kind: 'weekly', time: '21:00', weekday: 0 }, at(2026, 11, 18, 8, 0)) === at(2026, 11, 22, 21, 0));

// 每小时
check('每小时第 15 分：10:05 → 10:15', nextRun({ kind: 'hourly', time: '00:15' }, at(2026, 11, 16, 10, 5)) === at(2026, 11, 16, 10, 15));
check('每小时第 15 分：10:15 → 11:15', nextRun({ kind: 'hourly', time: '00:15' }, at(2026, 11, 16, 10, 15)) === at(2026, 11, 16, 11, 15));
check('每小时第 0 分：23:30 → 第二天 00:00', nextRun({ kind: 'hourly', time: '00:00' }, at(2026, 11, 16, 23, 30)) === at(2026, 11, 17, 0, 0));
check('每小时只看分钟（小时部分忽略）', nextRun({ kind: 'hourly', time: '08:15' }, at(2026, 11, 16, 10, 5)) === at(2026, 11, 16, 10, 15));

check('设置不对时 nextRun 返回 null', nextRun({ kind: 'weekly', time: '09:00' }, at(2026, 11, 16)) === null);

// 说法
check('describeSchedule', describeSchedule({ kind: 'daily', time: '8:00' }) === '每天 08:00' && describeSchedule({ kind: 'weekdays', time: '07:30' }) === '每个工作日 07:30'
  && describeSchedule({ kind: 'weekly', time: '09:00', weekday: 1 }) === '每周一 09:00' && describeSchedule({ kind: 'hourly', time: '00:15' }) === '每小时的第 15 分',
  [describeSchedule({ kind: 'daily', time: '8:00' }), describeSchedule({ kind: 'weekly', time: '09:00', weekday: 1 }), describeSchedule({ kind: 'hourly', time: '00:15' })]);
const now = at(2026, 11, 17, 12, 0);
check('describeWhen', describeWhen(at(2026, 11, 17, 8, 0), now) === '今天 08:00' && describeWhen(at(2026, 11, 18, 8, 0), now) === '明天 08:00'
  && describeWhen(at(2026, 11, 16, 8, 0), now) === '昨天 08:00' && describeWhen(at(2026, 11, 20, 8, 5), now) === '11-20 08:05');

console.log(`--- 自动化的运行时刻：${total - failed}/${total} 通过`);
if (failed) process.exit(1);
