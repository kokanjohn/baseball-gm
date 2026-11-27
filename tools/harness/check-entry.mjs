/**
 * tools/harness/check-entry.mjs
 * DEV/TEST ONLY — r291 §122.172 (foundation step 3): every message comes in one way (engine/cards/Entry.js).
 *
 *   - In the source: nothing but Entry adds to the inbox or the schedule (state.inbox / state.scheduledCards).
 *   - In play: a new club through spring and 40 games, the GM answering messages, plus a Compose reply and a
 *     debug inject. After every step, every message in the inbox or the schedule came in through Entry, and
 *     every way in was used.
 *
 *   node tools/harness/check-entry.mjs
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import fs from 'node:fs';
import path from 'node:path';
import * as SM from '../../store/StateManager.js';
import * as CE from '../../engine/CardEngine.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { watchEntry, VIA } from '../../engine/cards/Entry.js';
import { ALL_POOLS } from '../../engine/cards/Pools.js';
import { liveUntil } from './drive.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const DAY = 86_400_000;

// ── In the source ──
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const files = ['engine', 'store', 'ui', 'data'].flatMap(function walk(d) {
  return fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.js') ? [`${d}/${e.name}`] : []);
});
// adding: `inbox = [...`, `inbox.push(`, `.unshift(`, `.concat(`, `.splice(i, 0, x)` (the same for scheduledCards)
const ADD = /\b(inbox|scheduledCards)\s*(=\s*\[\s*\.\.\.|\.push\(|\.unshift\(|\.concat\(|\.splice\([^,)]+,\s*0\s*,)/;
const strays = [];
for (const f of files) {
  if (f === 'engine/cards/Entry.js') continue;
  fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (!/^\s*\*/.test(line) && ADD.test(code)) strays.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
}
check(`in the source, only Entry adds to the inbox or the schedule (${files.length} files)`, strays.length === 0, strays.join('\n      '));

// ── In play ──
for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(291);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());

const seen = new Set(), used = {}, strangers = new Map();
watchEntry((via, where, cards) => {
  used[via] = (used[via] || 0) + cards.length;
  for (const c of cards) seen.add(c.instanceId);
});
const look = () => {
  const s = S();
  for (const c of [...(s.inbox || []), ...(s.scheduledCards || [])])
    if (!seen.has(c.instanceId) && !strangers.has(c.instanceId)) strangers.set(c.instanceId, `${c.cardId || c.cardType || '?'} “${String(c.subject || '').slice(0, 50)}”`);
};

await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
look();

// The GM answers about half of what arrives (yes or no; the first choice when there are choices), leaves the rest.
const answered = new Set();
let r = 0.37;
const rand = () => (r = (r * 9301 + 49297) % 233280 / 233280);
const gm = () => {
  look();
  for (const c of CE.getInbox()) {
    if (answered.has(c.instanceId) || c.resolved) continue;
    answered.add(c.instanceId);
    if (rand() < 0.5) continue;
    try { CE.resolve(c.instanceId, rand() < 0.6 ? 'yes' : 'no', c.choices?.length ? { pick: c.choices[0].key } : {}); } catch { /* a card that can't take that answer */ }
    look();
  }
};

const firstReg = S().schedule.find(g => !g.isSpring).gameTime;
await liveUntil(firstReg - DAY, { onStep: gm });
// A Compose reply, and a debug inject.
CE.deliverComposeCard('mgr_lineup', 'manager', { topicLabel: 'check-entry', nowMs: clock.get() });
look();
const anyId = Object.values(ALL_POOLS).flat().map(e => e?.card || e).find(d => d?.id && !d._retired)?.id;
if (anyId) CE.deliverCardById(anyId, {});
look();
const regular = S().schedule.filter(g => !g.isSpring);
await liveUntil(regular[39].gameTime + 6 * 3_600_000, { onStep: gm });
look();

const total = (S().inbox || []).length + (S().scheduledCards || []).length;
check(`in play, every message in the inbox or the schedule came in through Entry (${seen.size} came in; ${total} there now)`,
  strangers.size === 0, [...strangers.values()].slice(0, 8).join('\n      '));
const ways = Object.values(VIA);
const missing = ways.filter(v => !used[v] && v !== VIA.TRADE_SEED && v !== VIA.EXPIRED);
check(`…and the ways in were used (${ways.map(v => `${v} ${used[v] || 0}`).join(', ')})`, missing.length === 0, `never: ${missing.join(', ')}`);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
