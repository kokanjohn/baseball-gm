// r149 every real moment the app shows is relative ("Today at 8:40 PM",
// "3 days ago", "tomorrow", "in 9 days"), never a calendar date: the real and
// the season's calendars differ, and a date would contradict the Schedule.
//   node tools/harness/check-relative-times.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as W from '../../engine/When.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const ROOT = new URL('../../', import.meta.url).pathname;

console.log('The words');
const now = new Date(2026, 10, 11, 16, 30).getTime(), D = 86_400_000;
check('the past', ['Today at 3:30 PM', 'Yesterday at 3:30 PM', '3 days ago at 3:30 PM', '1 week ago', '2 weeks ago', '1 month ago', '3 months ago', '1 year ago']
  .join('|') === [0, -1, -3, -8, -20, -45, -100, -400].map(d => W.agoFull(now + d * D - 3600_000, now)).join('|'));
check('the future', ['tonight at 7:00 PM', 'tomorrow at 7:00 PM', 'Saturday at 7:00 PM', 'in 9 days', 'in 4 weeks', 'in 3 months']
  .join('|') === [0, 1, 3, 9, 30, 90].map(d => W.untilFull(now + d * D + 2.5 * 3600_000, now)).join('|'));
check('a list: the time today, else the day', W.agoShort(now - 3600_000, now) === '3:30 PM' && W.agoShort(now - 2 * D, now) === '2 days ago');

console.log('No calendar dates in the app');
// A real moment formatted with a month or a day of the month. Allowed: When.js itself, and the
// weather's makeup date (the season's calendar, as on the Schedule).
const ALLOW = [/engine\/When\.js$/, /_wxDay = \(iso\)/];
const DATE = /toLocale(Date)?String\([^)]*\b(month|day)\s*:/;
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!/node_modules|tools|\.git/.test(f)) walk(p); } else if (p.endsWith('.js')) files.push(p); } };
walk(join(ROOT, 'ui')); walk(join(ROOT, 'engine'));
const hits = [];
for (const f of files) {
  if (ALLOW.some(a => a.test(f))) continue;
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (DATE.test(line) && !ALLOW.some(a => a.test(line))) hits.push(`${f.replace(ROOT, '')}:${i + 1}`);
  });
}
check(`${files.length} files: no real moment shown as a calendar date`, hits.length === 0, hits.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
