/**
 * tools/harness/check-day-plan.mjs
 * DEV/TEST ONLY — r297 §122.183 The day plan and around the game, the first set (the design: §122.182).
 *
 *   - The count: drawn from its kind of day's range (home 7–9, road 5–7, off 3–5; Hardcore 10–12), the same day the
 *     same count; heavy days about one in fourteen, 3–5 more. Not in the postseason or the winter.
 *   - Everything counts (the user's choice): a day's messages are those that came and those on their way.
 *   - Played: no drawn message takes a day past its count (a short day sends fewer); the messages around the game come
 *     in their parts, each within its part of the year's budget; the advance scout's report before nearly every series,
 *     on the opener's day, answered by first pitch; none reads alike another of its kind.
 *   - Important only: the new messages are optional, so the staff's.
 *   - Every message of the set is right in parts (partsProblems) and in the voice rules.
 *
 *   node tools/harness/check-day-plan.mjs
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import * as CE from '../../engine/CardEngine.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { dayTarget, dayKey, onDay, planRuns } from '../../engine/DayPlan.js';
import { AROUND_POOL } from '../../data/cards-around.js';
import { partsProblems, wordRuns, alike, READ_ALIKE } from '../../engine/MessageParts.js';
import { voiceProblems } from './voice-rules.mjs';
import { tierOf } from '../../engine/MessageTiers.js';
import { DAY_PLAN, AROUND, PHASE } from '../../data/constants.js';
import { liveUntil } from './drive.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const HOUR = 3_600_000, DAY = 24 * HOUR;

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(297);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });

// ── The written set ──
const probs = AROUND_POOL.flatMap(d => partsProblems(d));
check(`every message of the set is right in parts (${AROUND_POOL.length} messages)`, probs.length === 0, probs.slice(0, 5).join('; '));
const personOf = (sender) => (/^\{(\w+)_name\} \(/.exec(sender || '') ? `{${/^\{(\w+)_name\}/.exec(sender)[1]}_name}` : null);
const voice = [];
for (const d of AROUND_POOL) {
  const versions = (f) => (Array.isArray(d[f]) ? d[f] : [d[f]]).map(v => (typeof v === 'string' ? v : v?.text)).filter(Boolean);
  const parts = Object.fromEntries(Object.entries(d.parts).map(([k, l]) => [k, l.map(v => (typeof v === 'string' ? v : v.text))]));
  // every version of every part, in the body
  for (const [name, list] of Object.entries(parts)) for (const t of list) {
    const body = d.body.replace(/\{@(\w+)\}/g, (_, n) => (n === name ? t : parts[n][0]));
    for (const [rule, f] of voiceProblems({ ...d, body, yesMsg: versions('yesMsg')[0], noMsg: versions('noMsg')[0], preview: versions('preview')[0], yesLabel: versions('yesLabel')[0], noLabel: versions('noLabel')[0] }, personOf)) voice.push(`${d.id} ${rule} ${f}: ${t}`);
  }
}
check('…and in the voice rules', voice.length === 0, voice.slice(0, 4).join('\n      '));
// (and gender-neutral, as every message: sim-season's rule)
const GENDERED = /\b(he|him|his|himself|he's|he'll|he'd|she|her|hers|herself|guy|guys|fella|fellas|man|men|boys)\b/i;
const texts = AROUND_POOL.flatMap(d => [...Object.values(d.parts).flat(), ...['subject', 'preview', 'yesLabel', 'noLabel', 'yesMsg', 'noMsg'].flatMap(f => [].concat(d[f] || []))]).map(v => (typeof v === 'string' ? v : v.text));
check('…and gender-neutral', !texts.some(t => GENDERED.test(t)), texts.filter(t => GENDERED.test(t)).slice(0, 3).join(' | '));
check('…each optional (the staff\'s in Important only), its money under the line', AROUND_POOL.every(d => tierOf({ ...d, cardId: d.id, _budgetCost: 15 }) === 'optional'));

// ── The count ──
const kinds = ['home', 'road', 'off'];
let inRange = true, same = true, heavy = 0, heavyOk = true, n = 0;
for (const k of kinds) for (let i = 0; i < 700; i++) {
  const key = dayKey(d0.getTime() + i * DAY);
  const t = dayTarget(S(), k, key), [lo, hi] = DAY_PLAN.normal[k];
  n++;
  if (t.heavy) { heavy++; if (t.n < lo + DAY_PLAN.heavy.add[0] || t.n > hi + DAY_PLAN.heavy.add[1]) heavyOk = false; }
  else if (t.n < lo || t.n > hi) inRange = false;
  if (dayTarget(S(), k, key).n !== t.n) same = false;
}
check('the count: within its kind of day\'s range (home 7–9, road 5–7, off 3–5), the same day the same count', inRange && same);
check(`…heavy days about one in fourteen, 3–5 more (${heavy} of ${n})`, heavyOk && heavy > n / 22 && heavy < n / 9);
SM.mutate(s => { s.settings.messageMode = 'hardcore'; });
const hc = kinds.every(k => { const t = dayTarget(S(), k, '2401-05-05'); return t.n >= 10 && t.n <= 12 + (t.heavy ? 5 : 0); });
SM.mutate(s => { s.settings.messageMode = 'important'; });
const imp = dayTarget(S(), 'home', '2401-05-05').n;
SM.mutate(s => { s.settings.messageMode = 'normal'; });
check('…Hardcore 10–12 on every kind of day; Important only plays the Normal plan', hc && imp === dayTarget(S(), 'home', '2401-05-05').n);
check('…not in the winter or the postseason', !planRuns({ phase: PHASE.OFFSEASON }) && !planRuns({ phase: PHASE.WORLD_SERIES }) && planRuns({ phase: PHASE.REGULAR_SEASON }));
const key0 = dayKey(clock.get());
const before = onDay(S(), key0);
SM.mutate(s => { s.scheduledCards = [...(s.scheduledCards || []), { instanceId: 'x1', cardId: 'x', deliverAtMs: clock.get() + HOUR }]; s.inbox = [...s.inbox, { instanceId: 'x2', cardId: 'x', arrivedAtMs: clock.get(), resolved: true }]; });
check('…everything counts: what came that day (answered too) and what\'s on its way', onDay(S(), key0) === before + 2);
SM.mutate(s => { s.scheduledCards = s.scheduledCards.filter(c => c.instanceId !== 'x1'); s.inbox = s.inbox.filter(c => c.instanceId !== 'x2'); });

// ── Played: 60 regular-season games ──
const over = [];
CE.cardDebug.onFull = null;
const answered = new Set();
const gm = () => { for (const c of CE.getInbox()) { if (answered.has(c.instanceId)) continue; answered.add(c.instanceId); try { CE.resolve(c.instanceId, Math.random() < 0.6 ? 'yes' : 'no', c.choices?.length ? { pick: c.choices[0].key } : {}); } catch { /* */ } } };
// Each drawn message, at the moment it's put on a day: that day's count with it, against the plan.
const drawnOn = new Map();
const { watchEntry } = await import('../../engine/cards/Entry.js');
watchEntry((via, where, cards) => {
  if (where !== 'schedule') return;
  for (const c of cards) {
    if (!c._pool || !Number.isFinite(c.deliverAtMs) || !planRuns(S())) continue;
    const key = dayKey(c.deliverAtMs);
    drawnOn.set(key, (drawnOn.get(key) || 0) + 1);
  }
});
const reg = S().schedule.filter(g => !g.isSpring);
await liveUntil(reg[59].gameTime + 6 * HOUR, { onStep: gm });
const all = [...S().inbox, ...(S().messageHistory || [])];
const byDay = new Map();
for (const c of all) if (Number.isFinite(c.arrivedAtMs)) byDay.set(dayKey(c.arrivedAtMs), (byDay.get(dayKey(c.arrivedAtMs)) || 0) + 1);
// a drawn message never puts a day past its count: the days with drawn messages hold at most the plan's count of them
for (const [key, nDrawn] of drawnOn) {
  const g = S().schedule.find(x => dayKey(x.gameTime) === key);   // (spring games too)
  const t = dayTarget(S(), g ? (g.isHome ? 'home' : 'road') : 'off', key).n;
  if (nDrawn > t) over.push(`${key}: ${nDrawn} drawn, plan ${t}`);
}
check(`no day drawn past its count (${drawnOn.size} days with drawn messages)`, drawnOn.size > 30 && over.length === 0, over.slice(0, 4).join('; '));

const ag = all.filter(c => /^ag_/.test(c.cardId || '') && !c._note);   // (whole messages: a note keeps only what stories need)
if (process.env.DEBUG) { for (const c of ag) console.log(c.instanceId.slice(0,6), c.cardId, !!c._parts, c._from, c._note ? 'note' : '', c.expiresAtMs, `${c.subject} | ${c.body}`.slice(0, 140)); }
const kindsSeen = new Set(all.filter(c => /^ag_/.test(c.cardId || '')).map(c => c.cardId.replace(/^ag_(\w+?)_.*$/, '$1').replace(/^ag_/, '')));
check(`the set came in play: ${all.filter(c => /^ag_/.test(c.cardId || '')).length} messages (${[...new Set(ag.map(c => c.cardId))].join(', ')})`, all.filter(c => /^ag_/.test(c.cardId || '')).length >= 30 && ['scout', 'form', 'media'].every(k => kindsSeen.has(k)));
check('…each written in parts, from its sender, every fact filled in', ag.every(c => c._parts && c._from && !/\{[a-z_]+\}/.test(`${c.subject} ${c.body} ${c.yesLabel} ${c.noLabel}`)));
const n2 = S().around?.n || {};
check(`…each kind within its part of the year's budget (${JSON.stringify(n2)})`, Object.entries(n2).every(([k, v]) => Object.entries(v).every(([seg, x]) => x <= (AROUND.budget[k]?.[seg] ?? 0))));

// The advance scout: nearly every series, on the opener's day, answered by first pitch.
const played = reg.slice(0, 60);
const openers = played.filter((g, i) => i > 0 && (g.opponentId !== played[i - 1].opponentId || !!g.isHome !== !!played[i - 1].isHome) && i >= 6);
const scouts = ag.filter(c => c.cardId === 'ag_scout');
const scoutsAll = all.filter(c => c.cardId === 'ag_scout');
const onOpener = openers.filter(g => scoutsAll.some(c => dayKey(c.arrivedAtMs) === dayKey(g.gameTime) && c.arrivedAtMs < g.gameTime));
check(`the scout's report before nearly every series (${onOpener.length} of ${openers.length} openers after the first week)`, onOpener.length >= openers.length * 0.8);
check('…each answered by first pitch (its deadline the opener\'s first pitch)', scouts.every(c => Number.isFinite(c.expiresAtMs) && played.some(g => g.gameTime === c.expiresAtMs)));

// None reads alike another of its kind this season.
let worst = 0;
for (const id of new Set(ag.map(c => c.cardId))) {
  const runs = ag.filter(c => c.cardId === id).map(c => wordRuns(`${c.subject} ${c.body}`));
  for (let i = 0; i < runs.length; i++) for (let j = 0; j < i; j++) worst = Math.max(worst, alike(runs[i], runs[j]));
}
check(`…and none reads alike another (the most alike ${Math.round(worst * 100)}%, the line ${Math.round(READ_ALIKE * 100)}%)`, worst < READ_ALIKE);

// ── Important only: the set is the staff's ──
SM.mutate(s => { s.settings.messageMode = 'important'; });
const seen = new Set(all.map(c => c.instanceId));
await liveUntil(reg[79].gameTime + 6 * HOUR, { onStep: gm });
const agImp = [...S().inbox, ...(S().messageHistory || [])].filter(c => !seen.has(c.instanceId) && /^ag_/.test(c.cardId || ''));
check(`Important only: every message of the set the staff's (${agImp.length})`, agImp.length > 0 && agImp.every(c => c._staffHandle));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
