/**
 * tools/harness/check-first-day.mjs — r211 §122.89 a new team's first day.
 *   - between taking over and the first pitch: the core (as many as there's time for), more with more time,
 *     about one every couple of staff hours, never more than 10, inside staff hours, uneven, never two at once;
 *   - nothing that repeats a seed message;
 *   - three other clubs' GMs over the first spring (not the club already calling), named, each its own club;
 *     the answer moves our standing with that front office (and an unanswered one is a no);
 *   - the scouting director's "send it over" puts the free-agent report on Scouting's clock;
 *   - the trainer's "hold them out" sits the player a game.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { NEW_TEAM_SEED_CARDS } from '../../data/constants.js';
import { FIRST_DAY_CORE, FIRST_DAY_SECONDARY, GM_HELLOS } from '../../data/cards-first-day.js';
import { rapportOf } from '../../engine/TradeEngine.js';
import { inQuietHours } from '../../engine/CardScheduler.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const H = 3_600_000;
const CORE_IDS = new Set(Object.values(FIRST_DAY_CORE).flat().map(c => c.id));
const SECOND_IDS = new Set(FIRST_DAY_SECONDARY.map(c => c.id));
const HELLO_IDS = new Set(GM_HELLOS.map(c => c.id));

async function newTeam(seed, hour, minute = 0) {
  for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
  seedRandom(seed);
  const d = new Date(Date.UTC(2400, 0, 1)); d.setHours(hour, minute, 0, 0);
  clock.set(d.getTime());
  await startNewGame({ archetypeId: 'lab', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
  const now = clock.get(), first = S().schedule[0].gameTime;
  const fd = (S().scheduledCards || []).filter(c => c._firstDay && c.deliverAtMs < first && !c._gmTeamId || (c._firstDay && c._gmTeamId && c.deliverAtMs < first));
  return { now, first, fd: fd.sort((a, b) => a.deliverAtMs - b.deliverAtMs) };
}

const label = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
const subjects = new Set();
for (const [hour, seed] of [[19, 3], [9, 4], [11, 5], [23, 6], [14, 7]]) {
  const { now, first, fd } = await newTeam(seed, hour, hour === 11 ? 15 : 0);
  const hrs = (first - now) / H;
  console.log(`\nTaking over at ${label(hour)}, first pitch in ${hrs.toFixed(1)} hours: ${fd.length} first-day messages`);
  for (const c of fd) console.log(`    +${((c.deliverAtMs - now) / H).toFixed(1)}h  ${c.sender} — ${c.subject}`);
  fd.forEach(c => subjects.add(c.cardId));
  const core = fd.filter(c => CORE_IDS.has(c.cardId));
  const staffHours = (() => { let n = 0; for (let t = now + 4 * 60_000; t < first - 20 * 60_000; t += 60_000) if (!inQuietHours(t)) n++; return n / 60; })();
  check(`the core comes (${core.length}${staffHours >= 3 ? ', all five' : ''}), more with more time (${staffHours.toFixed(1)} staff hours → ${fd.length}), never more than 10`,
        (staffHours >= 3 ? core.length === 5 : core.length >= 2) && fd.length <= 10 && fd.length >= Math.min(10, Math.ceil(staffHours / 1.75)) - 1);
  check('all inside staff hours, before the first pitch, never two within five minutes',
        fd.every(c => !inQuietHours(c.deliverAtMs) && c.deliverAtMs > now && c.deliverAtMs < first - 15 * 60_000)
        && fd.every((c, i) => i === 0 || c.deliverAtMs - fd[i - 1].deliverAtMs >= 5 * 60_000));
  // Every couple of staff hours, with time: the longest quiet stretch inside staff hours.
  if (staffHours >= 6) {
    const pts = [now, ...fd.map(c => c.deliverAtMs), first];
    let worst = 0;
    for (let i = 1; i < pts.length; i++) { let n = 0; for (let t = pts[i - 1]; t < pts[i]; t += 60_000) if (!inQuietHours(t)) n++; worst = Math.max(worst, n / 60); }
    check(`something comes often (the longest wait in staff hours: ${worst.toFixed(1)}h)`, worst <= 4.5);
  }
  const inbox = new Set((S().inbox || []).map(c => c.cardId));
  check('the seed messages are there, and nothing repeats one', NEW_TEAM_SEED_CARDS.every(id => inbox.has(id)) && fd.every(c => !NEW_TEAM_SEED_CARDS.includes(c.cardId)));
  const sched = (S().scheduledCards || []).filter(c => c._firstDay);
  check('no message twice', new Set(sched.map(c => c.cardId)).size === sched.length);
}
check(`two new teams don't open the same way (${subjects.size} different first-day messages over five teams)`, subjects.size >= 10);

// ── Other clubs' GMs ──
console.log('\nOther clubs\' GMs');
{
  const { now } = await newTeam(8, 9);
  const hellos = (S().scheduledCards || []).filter(c => c._gmTeamId).sort((a, b) => a.deliverAtMs - b.deliverAtMs);
  for (const c of hellos) console.log(`    day ${Math.floor((c.deliverAtMs - now) / (24 * H))}  ${c.sender} — ${c.subject}`);
  const callers = (S().inbox || []).map(c => c.sender || '');
  const teams = hellos.map(c => S().leagueTeams.find(t => t.id === c._gmTeamId));
  const names = hellos.map(c => c.sender.split(' (')[0]);
  check(`three, each a different club, each GM named (${names.join(', ')}), none the club already calling`,
        hellos.length === 3 && new Set(teams.map(t => t?.id)).size === 3 && new Set(names).size === 3
        && teams.every(t => t && !callers.some(s => s.includes(t.name))) && hellos.every(c => /^[A-Z][a-z]+ \(.+ GM\)$/.test(c.sender)));
  check('through the first spring, inside staff hours', hellos.every(c => c.deliverAtMs - now < 12 * 24 * H && !inQuietHours(c.deliverAtMs)));
  const [a, b] = hellos;
  clock.set(b.deliverAtMs + 60_000);
  CE.releaseDueCards(clock.get());
  const r0 = [rapportOf(S(), a._gmTeamId), rapportOf(S(), b._gmTeamId)];
  const ca = CE.getInbox().find(c => c.instanceId === a.instanceId), cb = CE.getInbox().find(c => c.instanceId === b.instanceId);
  CE.resolve(ca.instanceId, 'yes');
  CE.resolve(cb.instanceId, 'no');
  const r1 = [rapportOf(S(), a._gmTeamId), rapportOf(S(), b._gmTeamId)];
  const def = (c) => GM_HELLOS.find(x => x.id === c.cardId);
  check(`yes: our standing with that front office moves (${r0[0]} → ${r1[0]}); no: ${r0[1]} → ${r1[1]}`,
        r1[0] - r0[0] === def(ca)._rapport.yes && r1[1] - r0[1] === def(cb)._rapport.no);
}

// ── The scouting director's first look; the trainer's call ──
console.log('\nThe first-day decisions');
{
  await newTeam(9, 9);
  const scout = (S().scheduledCards || []).find(c => /^fd_scout/.test(c.cardId));
  clock.set(scout.deliverAtMs + 60_000);
  CE.releaseDueCards(clock.get());
  CE.resolve(scout.instanceId, 'yes');
  const asked = (S().scheduledCards || []).find(c => c.isCompose && c._composeTopic === 'sc_free_agents');
  check(`"Send it over": the free-agent report is on Scouting's clock (${asked ? ((asked.deliverAtMs - clock.get()) / 60_000).toFixed(0) + ' minutes' : 'nothing'})`,
        !!asked && asked.deliverAtMs > clock.get() + 10 * 60_000);
  const tr = [...(S().scheduledCards || []), ...(S().inbox || [])].find(c => /^fd_trainer/.test(c.cardId));
  clock.set(Math.max(clock.get(), tr.deliverAtMs + 60_000));
  CE.releaseDueCards(clock.get());
  const id = tr._targetPlayerId;
  CE.resolve(tr.instanceId, 'yes');
  const p = S().players[id];
  check(`"Hold them out": ${p.name} sits a game`, p.unavailable?.reason === 'rest' && p.unavailable.gamesLeft === 1, JSON.stringify(p.unavailable || null));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
