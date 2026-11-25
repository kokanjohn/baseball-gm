/**
 * tools/harness/check-card-ovr.mjs — r270 §122.149 a message's rating effect lands only on the players it names.
 *   - Every card with an `ovr` effect names who it's about: a `_group` of players, or a player token.
 *   - Career day (x5): the body and the reply name three players; saying yes slows exactly those three.
 *   - The rainy spring opener: playing on it costs the named infielder, and no one else.
 *   - A card that names one player (bg12) changes that player only.
 *   - A message about no one (a field repair) changes no player: its cost is morale.
 */
import { pathToFileURL } from 'url';
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { primaryPos } from '../../engine/Positions.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();

// ── static: who every rating effect is about ──
const ROLE = /\{(active_sp|active_bp|active_pitcher|active_hitter|active_catcher|farm_pitcher|farm_hitter|leader_player|act_hi|pl_player|active_farm)_(?:name|pos|who)?(?:_tr)?\}|\{(act_hi|bg12_player)\}/;
const cards = [];
const walk = (x) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === 'object') { if (x.id && (x.body || x.subject)) { cards.push(x); return; } Object.values(x).forEach(walk); } };
for (const f of ['away', 'emergency', 'first-day', 'moments', 'money', 'pool', 'profile', 'winter']) walk(Object.values(await import(pathToFileURL(new URL(`../../data/cards-${f}.js`, import.meta.url).pathname))));
const loose = [...new Set(cards.filter(c => !c._retired && [c.yesEffect, c.noEffect, c.autoResolveTax].some(e => e?.ovr))
  .filter(c => !c._group && !ROLE.test([c.subject, c.preview, c.body].filter(Boolean).join(' '))).map(c => c.id))];
check(`every rating effect is on players the message names (${cards.length} cards read)`, loose.length === 0, loose.join(', '));

// ── live ──
for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(270);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
clock.set(S().schedule[0].gameTime - 60 * 60_000);

const touched = (fn) => SM.speculate(() => {
  const before = Object.fromEntries(Object.entries(S().players).map(([id, p]) => [id, JSON.stringify([p.condition, p.devPlan, p.development, p._devPlans])]));
  const morale = S().userTeam.morale, plans = (S().developmentPlans || []).length;
  fn();
  const ids = Object.entries(S().players).filter(([id, p]) => before[id] !== JSON.stringify([p.condition, p.devPlan, p.development, p._devPlans])).map(([id]) => id);
  for (const x of (S().developmentPlans || []).slice(plans)) if (!ids.includes(x.playerId)) ids.push(x.playerId);   // a gain is a development plan
  return { ids, morale: S().userTeam.morale - morale };
});

const x5 = CE.deliverCardById('x5');
const names = (x5?._groupPlayerIds || []).map(id => S().players[id]?.name);
check(`career day: three players named (${names.join(', ')})`, names.length === 3 && names.every(n => x5.body.includes(n)), x5?.body);
check(`…and the reply names them ("${x5?.yesMsg}")`, names.every(n => (x5?.yesMsg || '').includes(n)));
const r5 = touched(() => CE.resolve(x5.instanceId, 'yes'));
check(`…yes: exactly those three are slowed (${r5.ids.map(id => S().players[id]?.name).join(', ')})`,
  r5.ids.length === 3 && r5.ids.every(id => x5._groupPlayerIds.includes(id)));

const wx = CE.deliverCardById('mo_spo_weather');
const inf = wx?._groupPlayerIds?.[0], infP = S().players[inf];
check(`soft infield: an infielder named in the reply ("${wx?.noMsg}")`, !!infP && ['1B', '2B', '3B', 'SS'].includes(primaryPos(infP)) && wx.noMsg.includes(infP.name), infP?.pos);
const rw = touched(() => CE.resolve(wx.instanceId, 'no'));
check('…played on it: that infielder only', rw.ids.length === 1 && rw.ids[0] === inf, rw.ids.join());

const bg = CE.deliverCardById('bg12');
const rb = touched(() => CE.resolve(bg.instanceId, 'yes'));
check(`one named player (bg12: ${S().players[bg._targetPlayerId]?.name}): only that player`, !!bg._targetPlayerId && rb.ids.length === 1 && rb.ids[0] === bg._targetPlayerId && bg.subject.includes(S().players[bg._targetPlayerId].name), rb.ids.join());

const rv = CE.deliverCardById('rv7_mound');
const rr = touched(() => CE.resolve(rv.instanceId, 'no'));
check(`a message about no one (the mound): no player changes, morale does (${rr.morale})`, rr.ids.length === 0 && rr.morale < 0, rr.ids.join());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
