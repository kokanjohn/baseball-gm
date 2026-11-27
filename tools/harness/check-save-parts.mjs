/**
 * tools/harness/check-save-parts.mjs
 * DEV/TEST ONLY — r293 §122.175 (foundation step 5): the save in parts (store/SaveParts.js).
 *
 *   - Joining the parts gives back the same state exactly (serialized byte for byte, key order included): a new
 *     club, spring, mid-season during a live game, after 60 games.
 *   - Saved and loaded back: the same state.
 *   - Only what changed is written: a save with nothing changed writes no part; a tick writes only the main state;
 *     a finished box score is written once, ever; box scores nothing refers to any more are deleted.
 *   - A save from before parts loads as it was, is written in parts by its next save, and loads back the same.
 *   - Deleting a save deletes its parts.
 *
 *   node tools/harness/check-save-parts.mjs
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import * as DB from '../../store/DB.js';
import { split, join, PART_NAMES, isFinishedBox, slotPrefix } from '../../store/SaveParts.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { liveUntil } from './drive.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const HOUR = 3_600_000;
const log = globalThis.__idbLog = [];
const kb = (n) => `${Math.round(n / 1024)} KB`;

/** join(split(s)) serializes as s does (a fresh memo: every box score is new). */
function roundTrip(label) {
  const st = S();
  const want = JSON.stringify(st);
  const memo = { boxKeyOf: new WeakMap(), written: new Set() };
  const { main, parts, newBoxes } = split(st, memo);
  const got = JSON.stringify(join(JSON.parse(JSON.stringify(main)), parts, newBoxes, null));
  const mainLen = JSON.stringify(main).length;
  check(`joined, the same state: ${label} (${kb(want.length)}: main ${kb(mainLen)}, ${PART_NAMES.map(n => `${n} ${kb(parts[n].length)}`).join(', ')}, ${newBoxes.size} box scores)`,
    got === want, got.length !== want.length ? `length ${got.length} against ${want.length}` : 'same length, different text');
  check(`…and split didn't change the state (${label})`, JSON.stringify(st) === want);
}
const writes = (from) => log.slice(from).filter(([op]) => op === 'put').map(([, k]) => k);
const kind = (k) => (k.includes('|part|') ? `part:${k.split('|part|')[1]}` : k.includes('|box|') ? 'box' : 'main');

// ── A new club ──
for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(293);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const slotId = SM.getActiveSlotId();
roundTrip('a new club');

// ── Spring, then into the season: a live game ──
const sched = () => S().schedule;
const regular = sched().filter(g => !g.isSpring);
await liveUntil(sched().find(g => g.isSpring).gameTime + 30 * 60_000);
roundTrip('the first spring game, live');
// during the tenth game (our live game keeps its plays outside the state; the state has where it is, livePlayIndex)
await liveUntil(regular[9].gameTime + 40 * 60_000);
const mid = sched().find(x => x.gameTime === regular[9].gameTime);
roundTrip(`during the tenth game (at play ${mid?.livePlayIndex ?? '?'}, ${mid?._committed ? 'over' : 'not over'})`);

// ── Saved and loaded back ──
await SM.save();
const before = JSON.stringify(S());
await SM.load(slotId);   // (flushes, then reads the parts back)
check(`saved and loaded back: the same state (${kb(before.length)})`, JSON.stringify(S()) === before);

// ── Only what changed is written ──
let at = log.length;
await SM.save();
const again = writes(at);
check(`a save with nothing changed writes the main state only (${again.map(kind).join(', ')})`, again.length === 1 && kind(again[0]) === 'main');
at = log.length;
SM.mutate(s => { s._checkTick = (s._checkTick || 0) + 1; });
await SM.save();
const tick = writes(at);
check(`a change to the main state writes it alone (${tick.map(kind).join(', ')})`, tick.length === 1 && kind(tick[0]) === 'main');

at = log.length;
const finishedBefore = sched().filter(isFinishedBox).length;
await liveUntil(regular[11].gameTime + 6 * HOUR);
await SM.save();
const day = writes(at), dayBoxes = day.filter(k => kind(k) === 'box');
check(`after two more games: the schedules part and the new box scores only (${dayBoxes.length} box scores; ${[...new Set(day.map(kind))].join(', ')})`,
  dayBoxes.length > 0 && day.some(k => kind(k) === 'part:schedules') && sched().filter(isFinishedBox).length > finishedBefore);

await liveUntil(regular[59].gameTime + 6 * HOUR);
await SM.save();
roundTrip('after 60 games');
const perKey = {};
for (const k of writes(0)) if (kind(k) === 'box') perKey[k] = (perKey[k] || 0) + 1;
const twice = Object.entries(perKey).filter(([, n]) => n > 1);
check(`every finished box score written once (${Object.keys(perKey).length} written)`, twice.length === 0, twice.slice(0, 3).map(([k, n]) => `${k} ×${n}`).join(', '));
const stored = await DB.loadParts(slotPrefix(slotId));
const storedBoxes = [...stored.keys()].filter(k => kind(k) === 'box').length;
const allFinished = sched().filter(isFinishedBox).length + Object.values(S().leagueSchedule?.dayMap || {}).flat().filter(isFinishedBox).length;
check(`the save holds one box score per finished game (${storedBoxes}; ${allFinished} games)`, storedBoxes <= allFinished && storedBoxes >= allFinished - 2);

// box scores nothing refers to are deleted (as at a new season, when the schedules start again)
at = log.length;
const keep = structuredClone({ schedule: S().schedule, leagueSchedule: S().leagueSchedule });
SM.mutate(s => { s.schedule = s.schedule.map(g => (isFinishedBox(g) ? { ...g, boxScore: null } : g)); });
await SM.save();
const dels = log.slice(at).filter(([op, k]) => op === 'del' && kind(k) === 'box').length;
const ours = keep.schedule.filter(isFinishedBox).length;
check(`box scores nothing refers to are deleted (${dels} deleted; our ${ours} games' box scores dropped)`, dels > 0 && dels <= ours);
SM.mutate(s => { s.schedule = keep.schedule; });
await SM.save();
const back = JSON.stringify(S());
await SM.load(slotId);
check('…and written again when they come back; loads the same', JSON.stringify(S()) === back);

// ── A save from before parts ──
const whole = structuredClone(S());
const oldId = 'old-format-slot';
await DB.saveSlot({ slotId: oldId, teamName: 'Old', archetype: 'ember', seasonNum: whole.seasonNum, lastPlayed: 1, state: whole });
await SM.load(oldId);
check('a save from before parts loads as it was', JSON.stringify(S()) === JSON.stringify(whole));
await SM.save();
const env = await DB.loadSlot(oldId);
const oldParts = await DB.loadParts(slotPrefix(oldId));
check(`…its next save writes it in parts (format ${env.format}; ${oldParts.size} parts; main ${kb(JSON.stringify(env.state).length)})`,
  env.format === 2 && env.state.schedule === null && oldParts.size > PART_NAMES.length);
const conv = JSON.stringify(S());
await SM.load(slotId);
await SM.load(oldId);
check('…and loads back the same', JSON.stringify(S()) === conv);

// ── Deleting a save deletes its parts ──
await SM.deleteSlot(oldId);
check('deleting a save deletes its parts', (await DB.loadParts(slotPrefix(oldId))).size === 0 && !(await DB.loadSlot(oldId)));
check('…and leaves the other save\'s', (await DB.loadParts(slotPrefix(slotId))).size > 0);

// ── The slot list reads the main state only ──
const slots = await SM.listSlots();
const mine = slots.find(x => x.slotId === slotId);
check(`the slot list: the record and the tier are in the main state (${mine?.state?.userTeam?.wins}–${mine?.state?.userTeam?.losses}, tier ${mine?.state?.prestigeTier})`,
  mine && Number.isFinite(mine.state?.userTeam?.wins) && mine.state.schedule === null);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
