// §105 Compose replies come back later — never at once, at varied times, never in quiet hours,
// and field staff answer after the game, not during it.
//   TZ=America/New_York node tools/harness/check-compose-replies.mjs
import { replyTime, inQuietHours } from '../../engine/CardScheduler.js';
import { COMPOSE_REPLY } from '../../data/constants.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? ` — ${info}` : ''}`); };
const at = (h, m = 0) => { const d = new Date(2027, 5, 15); d.setHours(h, m, 0, 0); return d.getTime(); };
const MIN = 60_000;
for (const [who, [lo, hi]] of Object.entries(COMPOSE_REPLY.windows)) {
  const now = at(11, 0);
  const ds = Array.from({ length: 400 }, () => (replyTime({ nowMs: now, minMin: lo, maxMin: hi }) - now) / MIN);
  const inWin = ds.filter(d => d >= lo && d <= hi + 0.01).length;
  const quiet = ds.map(d => now + d * MIN).filter(t => inQuietHours(t)).length;
  const sorted = [...ds].sort((a, b) => a - b), med = sorted[200], spread = sorted[360] - sorted[40];
  check(`${who}: replies ${lo}–${hi} min later (median ${med.toFixed(0)}, 10–90% spread ${spread.toFixed(0)} min), none at once, none in quiet hours`,
        ds.every(d => d >= lo) && quiet === 0 && spread > (hi - lo) * 0.4 && (inWin === ds.length || hi * MIN + now > at(22)));
}
// Late in the evening: the reply waits for the morning.
{
  const now = at(21, 40);
  const ts = Array.from({ length: 200 }, () => replyTime({ nowMs: now, minMin: 45, maxMin: 300 }));
  check('sent at 9:40 PM: nothing arrives in quiet hours; late ones come the next morning', ts.every(t => !inQuietHours(t)) && ts.some(t => t > at(24 + 8)));
}
// Busy with a game from 7:05 to 10:05 PM: field staff answer after it.
{
  const now = at(18, 50), busy = [[at(19, 5), at(22, 5)]];
  const ts = Array.from({ length: 300 }, () => replyTime({ nowMs: now, minMin: 25, maxMin: 150, busy }));
  const during = ts.filter(t => t >= busy[0][0] && t < busy[0][1]).length;
  check(`a message 15 min before first pitch: no reply during the game (${during}); none in quiet hours`, during === 0 && ts.every(t => !inQuietHours(t, '22:00', '08:00') || false));
}
{
  const now = at(13, 0), busy = [[at(13, 5), at(16, 10)]];
  const ts = Array.from({ length: 300 }, () => replyTime({ nowMs: now, minMin: 25, maxMin: 150, busy }));
  const after = ts.filter(t => t >= at(16, 20) && t <= at(17, 0)).length;
  check(`during a day game: the reply comes 10–50 min after the final (${after}/300)`, after === 300);
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
