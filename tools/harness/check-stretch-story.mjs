/**
 * tools/harness/check-stretch-story.mjs — r216 §122.95 the stretch run and October as a story.
 *   - the stretch moments (25/18/12/6/1 games left), in staff hours; the seeding as it stands in the words;
 *   - pushed: the physician on who's wearing down (a day off sits them); rested: news that it paid off;
 *   - the last week: the seed set → rest the regulars; still moving → the owner's bonus pool;
 *   - each series: game 1's morning (the scouts' read; at home the gate, on the road the families' trip); the morning
 *     after (won: celebrate; lost: the owner and a word to the fans; the title: the parade);
 *   - voice, no raw tokens.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { storyMoments, seeding, nextStepAt } from '../../engine/StretchStory.js';
import { buildBracket } from '../../engine/PlayoffEngine.js';
import { senderLabel } from '../../engine/Senders.js';
import { voiceProblems } from './voice-rules.mjs';
import { PHASE, REGULAR_SEASON_GAME_COUNT } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const say = (c) => console.log(`    ${senderLabel(c, S())} — ${c.subject}\n      ${c.body}\n      [${c.yesLabel}${c.noLabel ? ` / ${c.noLabel}` : ''}]`);
const voiceOk = (c) => voiceProblems(c, (s) => (String(s).match(/^(.+?) \(/) || [])[1] || (Object.values(S().userTeam.coachingStaff).some(x => x?.name === s) || s === S().userTeam.ownerName ? s : null))
  .filter(([r]) => r !== 'deptSelf').length === 0 && !GEN.test(`${c.body} ${c.preview}`) && !/\{[a-z_]+\}|undefined|NaN/.test(`${c.subject} ${c.body}`);
const all = [];

seedRandom(51);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const div = S().userTeam.divisionId || 'A';
const setRace = (rows) => SM.mutate(s => {
  // rows: [[id, wins, losses]] for our division, in any order
  const list = rows.map(([id, w, l]) => ({ id, name: id === 'user' ? s.userTeam.name : s.leagueTeams.find(t => t.id === id).name, wins: w, losses: l, divisionId: div }));
  s.standings = { ...(s.standings || {}), [div === 'B' ? 'divB' : 'divA']: list };
  const u = rows.find(r => r[0] === 'user'); s.userTeam.wins = u[1]; s.userTeam.losses = u[2];
});
const mates = S().leagueTeams.filter(t => t.divisionId === div).map(t => t.id);
SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; });
// We've played 107 regular-season games: 25 left.
SM.mutate(s => { let n = 0; for (const g of s.schedule) if (!g.isSpring && !g.isPlayoff && n < REGULAR_SEASON_GAME_COUNT - 25) { g._committed = true; n++; } });
setRace([[mates[0], 62, 45], ['user', 60, 47], [mates[1], 58, 49], [mates[2], 50, 57], [mates[3], 44, 63]]);

const M = storyMoments(S());
const step = (key) => {
  const m = M.find(x => x.key === key) || storyMoments(S()).find(x => x.key === key);
  clock.set(m.atMs);
  const got = CE.deliverStretchStep(m.atMs, buildCardContext());
  clock.set(m.atMs + 2 * 3_600_000); CE.releaseDueCards(clock.get());
  const cs = got.map(c => CE.getInbox().find(x => x.instanceId === c.instanceId) || c);
  cs.forEach(say); all.push(...cs);
  return cs;
};

console.log('The stretch');
{
  for (const m of M) console.log(`    ${m.key.padEnd(9)} ${new Date(m.atMs).toString().slice(0, 21)}`);
  check(`five moments, 25 games left to the last day (${M.map(m => m.key).join(', ')})`, M.map(m => m.key).join() === 'race,tickets,toll,lastweek,lastday');
  check('staff hours', M.every(m => { const h = new Date(m.atMs).getHours(); return h >= 9 && h < 13; }));
  check('the clock\'s next', nextStepAt(S(), M[0].atMs)?.key === 'race' && nextStepAt(S(), M[0].atMs - 60_000) == null);
  const s = seeding(S());
  check(`seeding: we're 2nd, 2 games behind for the top seed, 2 ahead of 3rd`, s.seed === 2 && s.gapUp === 2 && s.gapDown === 2 && !s.locked);
  const [race] = step('race');
  check('the race: our seed and our neighbours in the words; push, or keep the rest days', /We're seed 2 — 2 games behind .+ for the top seed, 2 games ahead of/.test(race.body) && race.yesLabel === 'Push the Regulars');
  CE.resolve(race.instanceId, 'yes');
  check('…pushing (remembered)', S().stretch.push === true);
  const [tix] = step('tickets');
  check('tickets: the race is tight, prices up for money', /The race is selling tickets/.test(tix.subject) && tix._revenueK > 0);
  const [toll] = step('toll');
  check('pushed: the physician names who\'s wearing down', !!toll && toll._targetPlayerId && /wearing down/.test(toll.subject));
  CE.resolve(toll.instanceId, 'yes');
  check('…a day off sits them a game', S().players[toll._targetPlayerId].unavailable?.reason === 'rest');
  const [lw] = step('lastweek');
  check('still moving: the owner\'s bonus pool', /bonus/.test(lw.subject) && lw._budgetCost > 0);
  const [ld] = step('lastday');
  check('the last day: what\'s at stake (news)', !!ld && !ld.noLabel);
}

console.log('\nThe seed set; rested');
SM.speculate(() => {
  SM.mutate(s => { s.stretch = { season: s.seasonNum, done: {} }; s.inbox = s.inbox.filter(c => !c._stretchStory); });
  setRace([[mates[0], 75, 50], ['user', 66, 59], [mates[1], 55, 70], [mates[2], 50, 75], [mates[3], 44, 81]]);
  SM.mutate(s => { let n = 0; for (const g of s.schedule) if (!g.isSpring && !g.isPlayoff) { g._committed = n < REGULAR_SEASON_GAME_COUNT - 6; n++; } });
  const [toll] = step('toll');
  check('rested: the physician says it paid off', /paying off/.test(toll.subject) && !toll.noLabel);
  const [lw] = step('lastweek');
  check('the seed set: rest the regulars?', /Seed 2 is ours/.test(lw.subject));
});

console.log('\nOctober');
{
  const ours = S().leagueTeams.find(t => t.id === mates[0]);
  const sd = (id, w, l, seed) => ({ id, name: id === 'user' ? S().userTeam.name : S().leagueTeams.find(t => t.id === id).name, wins: w, losses: l, seed, divisionId: div });
  const seeds = [sd(mates[0], 80, 52, 1), sd('user', 76, 56, 2), sd(mates[1], 70, 62, 3), sd(mates[2], 60, 72, 4), sd(mates[3], 50, 82, 5)];
  const other = S().leagueTeams.filter(t => t.divisionId !== div).map((t, i) => sd(t.id, 70 - i, 62 + i, i + 1));
  const br = buildBracket(div === 'B' ? other : seeds, div === 'B' ? seeds : other);
  const key = div === 'B' ? 'divB' : 'divA';
  const fr = br[key].FIRST_ROUND.series[1];   // us (2) vs 3: we host
  const t0 = (() => { const d = new Date(S().schedule.filter(g => !g.isSpring).slice(-1)[0].gameTime + 3 * 86_400_000); d.setHours(0, 5, 0, 0); return d.getTime(); })();
  SM.mutate(s => {
    s.phase = PHASE.FIRST_ROUND; s.playoffBracket = br; s.stretch = { season: s.seasonNum, done: { race: 1, tickets: 1, toll: 1, lastweek: 1, lastday: 1 } };
    for (let i = 0; i < 3; i++) s.schedule.push({ index: s.schedule.length, isPlayoff: true, seriesId: fr.id, playoffRound: 'FIRST_ROUND', isHome: true, opponent: ours.name, opponentId: mates[1], gameTime: t0 + i * 86_400_000 + 13 * 3_600_000 });
  });
  const prev = storyMoments(S()).find(m => m.key === `preview:${fr.id}`);
  check('game 1\'s morning', !!prev && prev.atMs < t0 + 13 * 3_600_000 && new Date(prev.atMs).getHours() >= 8);
  const pv = step(`preview:${fr.id}`);
  check('the scouts\' read on the opponent, and at home the gate', pv.length === 2 && /The first round: the /.test(pv[0].subject) && pv[1].cardId === 'stretch_preview_gate');
  // We win it in two.
  SM.mutate(s => { const x = s.playoffBracket[key].FIRST_ROUND.series[1]; x.status = 'final'; x.winner = 'A'; x.winsA = 2;
    s.schedule.filter(g => g.seriesId === x.id).slice(0, 2).forEach(g => { g._committed = true; }); });
  const [won] = step(`after:${fr.id}`);
  check('won: celebrate, or one more round', !!won && /We won the first round/.test(won.subject) && won._budgetCost > 0);
  // The world series: lost, then (on a copy) won.
  const ws = br.WORLD_SERIES.series[0];
  SM.mutate(s => { const w = s.playoffBracket.WORLD_SERIES.series[0]; w.teamA = seeds[1]; w.teamB = other[0]; w.status = 'final'; w.winner = 'B';
    for (let i = 0; i < 4; i++) s.schedule.push({ index: s.schedule.length, isPlayoff: true, seriesId: ws.id, playoffRound: 'WORLD_SERIES', isHome: i % 2 === 0, opponent: other[0].name, opponentId: other[0].id, gameTime: t0 + (10 + i) * 86_400_000, _committed: true }); });
  SM.speculate(() => {
    const out = step(`after:${ws.id}`);
    check('lost the World Series: the owner (news), and a word to the fans', out.length === 2 && !out[0].noLabel && /close/.test(out[0].body) && out[1].yesLabel === 'Thank the Fans');
  });
  SM.mutate(s => { s.playoffBracket.WORLD_SERIES.series[0].winner = 'A'; });
  const [par] = step(`after:${ws.id}`);
  check('won it all: the parade', !!par && par.cardId === 'stretch_parade');
}

check(`every message in its sender's voice, no raw tokens (${all.length})`, all.every(voiceOk), all.filter(c => !voiceOk(c)).map(c => `${c.cardId}: ${c.body}`).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
