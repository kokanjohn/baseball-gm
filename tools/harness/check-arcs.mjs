/**
 * tools/harness/check-arcs.mjs — r221 §122.100 story arcs.
 *   - each arc's steps in order, each written from the answer before and what really happened since;
 *   - the veteran: one more year (an extension) or out on top (they retire at the offseason);
 *   - the prospect: a real lineup change, and the regular back if it doesn't work;
 *   - the neighbors: the council's fee if we let them decide; the coach: the job taken, the chair empties;
 *   - the feud: a flare-up, and a real game on the bench;
 *   - one step a day, the next day 11:00–12:30; an arc ends when its people are gone; at most two running; a new
 *     one only from a real situation; voice, neutral, no raw tokens.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import * as Offseason from '../../engine/OffseasonEngine.js';
import { ARCS, pickArc } from '../../engine/Arcs.js';
import { senderLabel } from '../../engine/Senders.js';
import { voiceProblems } from './voice-rules.mjs';
import { PHASE, SPRING_TRAINING_GAME_COUNT, PLAYER_GROUP } from '../../data/constants.js';
import { eligibleSlotsFor } from '../../engine/RosterEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const HOUR = 3_600_000, DAY = 24 * HOUR;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const personOf = (s) => (String(s).match(/^(.+?) \(/) || [])[1] || null;
const readsRight = (c) => voiceProblems(c, personOf).length === 0 && !GEN.test(`${c.body} ${c.preview} ${c.yesMsg || ''} ${c.noMsg || ''}`) && !/\{[a-z0-9_]+\}|undefined|NaN|null/.test(`${c.subject} ${c.body} ${c.preview}`);
const all = [];
const say = (c) => { all.push(c); console.log(`    ${new Date(c.deliverAtMs).toString().slice(0, 21)}  ${senderLabel(c, S())} — ${c.subject}\n      ${c.body}\n      [${c.yesLabel}${c.noLabel ? ` / ${c.noLabel}` : ''}]`); };

seedRandom(111);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const sched = S().schedule;
const reg = sched.map((g, i) => i).filter(i => !sched[i].isSpring && !sched[i].isPlayoff);
/** The season after `n` regular-season games; the clock at the last one's final. */
const after = (n) => {
  const i = reg[n];
  SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; s.currentGameIndex = i; s.schedule.forEach((g, k) => { g._committed = k < i; }); });
  const end = sched[i - 1].gameTime + 3 * HOUR; clock.set(end); return end;
};
const fresh = () => SM.mutate(s => { s.inbox = []; s.scheduledCards = []; s.arcs = { active: [], done: {} }; });
const start = (key, who) => SM.mutate(s => { s.arcs.active.push({ id: `t-${key}`, key, s: s.seasonNum || 1, who, step: 0, picks: {}, at: {}, nextAt: 0 }); });
/** Advance after game n: the step it brings (released into the inbox), or null. */
const advance = (n) => { const end = after(n); const got = CE.advanceArcs(end, buildCardContext())[0] || null; if (got) { clock.set(got.deliverAtMs); CE.releaseDueCards(got.deliverAtMs); say(got); } return got && CE.getInbox().find(c => c.instanceId === got.instanceId); };
const answer = (c, choice) => CE.resolve(c.instanceId, choice);
const bench = () => { const on = new Set(S().userTeam.lineupSlots.map(x => x.playerId)); return S().userTeam.rosterIds.map(id => S().players[id]).filter(p => !on.has(p.id) && !['SP', 'RP'].includes(p.pos) && p.teamId === 'user'); };

console.log('The veteran');
{
  for (const final of ['no', 'yes']) {
    SM.speculate(() => {
      fresh();
      const p = S().players[S().userTeam.lineupSlots[0].playerId];
      SM.mutate(s => { s.players[p.id].contractExpiry = (s.seasonNum || 1) + 1; s.players[p.id].contractYears = 1; });
      start('veteran', { p: p.id });
      const a = advance(30);
      check('the manager: their last season (a decision)', a?.cardId === 'arc_veteran' && /last season/.test(a.body) && a.noLabel);
      const h = new Date(a.deliverAtMs).getHours() + new Date(a.deliverAtMs).getMinutes() / 60;
      check('the next day, 11:00–12:30', h >= 11 && h <= 12.5);
      answer(a, 'yes');
      check('a step a day at most', advance(31) == null);
      const b = advance(60);
      check('a farewell tour: PR on how it\'s going', b && /farewell tour/.test(b.body));
      answer(b, 'yes');
      check('the last question waits for the season\'s end', advance(90) == null);
      const c = advance(122);
      check('one more year, or out on top', c && /One more year/.test(c.subject) && c.yesLabel === 'Offer One More Year');
      answer(c, final);
      if (final === 'no') {
        check('out on top: marked to retire', S().players[p.id]._retiringAfter === (S().seasonNum || 1));
        SM.mutate(s => { Offseason.beginOffseason(s, clock.get()); });
        check('…and they retire when the offseason begins', S().players[p.id].group === PLAYER_GROUP.RETIRED);
      } else check('one more year: an extension', !!S().players[p.id].pendingContract && S().players[p.id].pendingContract.years >= 1);
    });
  }
}

console.log('\nThe prospect');
{
  SM.speculate(() => {
    fresh();
    const p = bench().find(x => !['SP', 'RP'].includes(x.pos));
    const slot = S().userTeam.lineupSlots.find(x => eligibleSlotsFor(p).includes(x.slot));
    const s0 = slot.playerId;
    start('prospect', { p: p.id, starter: s0 });
    answer(advance(30), 'yes');
    const b = advance(38);
    check('the manager: a week in the lineup (a decision)', b && b.noLabel && b.body.includes(S().players[s0].name));
    answer(b, 'yes');
    check('…a real lineup change', S().userTeam.lineupSlots.some(x => x.playerId === p.id) && !S().userTeam.lineupSlots.some(x => x.playerId === s0));
    SM.mutate(s => { s.players[p.id]._impGameLog = Array.from({ length: 8 }, (_, k) => ({ gameIndex: k, atMs: clock.get() + (k + 1) * HOUR, stats: { ab: 4, h: 0, hr: 0 } })); });
    const c = advance(48);
    check('it didn\'t work: put the regular back?', c && c.noLabel && c.yesLabel.startsWith('Put'));
    answer(c, 'yes');
    check('…the regular back in the lineup', S().userTeam.lineupSlots.some(x => x.playerId === s0));
  });
}

console.log('\nThe neighbors');
{
  SM.speculate(() => {
    fresh();
    start('neighbors', {});
    answer(advance(30), 'no');
    const b = advance(50);
    check('it went to the council: a decision', b && /council/.test(b.subject) && b.noLabel);
    answer(b, 'no');
    const c = advance(65);
    const atmo = S().userTeam.atmosphere ?? 50;
    answer(c, 'yes');
    check(`let the council decide: the parking fee, and the crowd feels it (${atmo} → ${S().userTeam.atmosphere})`, c && /parking fee/.test(c.subject) && S().userTeam.atmosphere === Math.max(0, atmo - 3));
    check('the arc is over', advance(80) == null && !S().arcs.active.length);
  });
}

console.log('\nThe coach');
{
  let left = null;
  for (let k = 0; k < 12 && !left; k++) SM.speculate(() => {
    fresh();
    const role = 'pitchingCoach', c = S().userTeam.coachingStaff[role];
    start('coach', { role, club: S().leagueTeams[0].id, name: c.name });
    answer(advance(70 + k), 'yes');
    const b = advance(90 + k);
    if (b && /offered me the job/.test(b.body)) left = { ok: S().userTeam.coachingStaff[role]._leaving?.clubId === S().leagueTeams[0].id && S().userTeam.coachingStaff[role]._leaving.season === S().seasonNum };
  });
  check('the job taken: the coach will leave after the season', left?.ok === true);
}

console.log('\nThe feud');
{
  let flared = null;
  for (let k = 0; k < 12 && !flared; k++) SM.speculate(() => {
    fresh();
    const [a, b] = S().userTeam.lineupSlots.map(x => x.playerId);
    start('feud', { a, b });
    answer(advance(40 + k), 'no');
    const c = advance(50 + k);
    if (c?.noLabel) { answer(c, 'yes'); flared = { b, sat: S().players[b].unavailable?.reason === 'rest' }; }
  });
  check('left alone, it flared: the one who started it sits a game (for real)', flared?.sat === true);
}

console.log('\nThe rules');
{
  SM.speculate(() => {
    fresh();
    const p = S().players[S().userTeam.lineupSlots[0].playerId];
    start('veteran', { p: p.id });
    advance(30);
    SM.mutate(s => { s.players[p.id].teamId = s.leagueTeams[0].id; });
    advance(70);
    check('its player traded away: the arc ends', !S().arcs.active.length);
  });
  SM.speculate(() => {
    fresh(); after(40);
    SM.mutate(s => { s.userTeam.streak = 0; });
    const got = ARCS.filter(d => d.trigger(S(), clock.get(), () => 0.3)).map(d => d.key);
    check(`a new arc only from a real situation (now: ${got.join(', ') || 'none'}; no feud without a losing streak)`, !got.includes('feud'));
    SM.mutate(s => { s.userTeam.streak = -5; });
    check('…a losing streak: a feud can start', !!ARCS.find(d => d.key === 'feud').trigger(S(), clock.get(), () => 0.3));
    const [fa, fb] = S().userTeam.lineupSlots.map(x => x.playerId);
    SM.mutate(s => { s.arcs.active = [{ id: 'a', key: 'neighbors', s: s.seasonNum, who: {}, step: 1, picks: { 0: 'yes' }, at: {}, nextAt: Infinity },
                                      { id: 'b', key: 'feud', s: s.seasonNum, who: { a: fa, b: fb }, step: 1, picks: { 0: 'yes' }, at: {}, nextAt: Infinity }]; });
    let started = 0;
    for (let k = 0; k < 40; k++) { const st0 = S().arcs.active.length; CE.advanceArcs(clock.get() + k * 60_000, buildCardContext()); if (S().arcs.active.length > st0) started++; }
    check('two running: no third', started === 0);
  });
}

check(`every step reads right (${all.length})`, all.every(readsRight), all.filter(c => !readsRight(c)).map(c => `${c.subject}: ${c.body}`).join('\n      '));
console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
