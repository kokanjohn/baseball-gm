// §118 step 2 Injuries during the game.
//   node tools/harness/check-game-injuries.mjs [seed=1]
// 1. The sim (400 games): a player hurt on a play never appears again; a
//    hitter's replacement takes the spot in the order (and the base, if the
//    hitter reached); a hurt pitcher is followed at once by a pitching change;
//    the replacement is in the box; the text is gender-neutral.
// 2. A real day: the look-ahead foresees one of our players hurt in our next
//    game; played with the app open, the same player is hurt on the same play,
//    is being evaluated from that play's moment (not the final out), and the
//    trainer's first message arrives during the game, naming the inning.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import { dice } from '../../engine/Dice.js';
import { baseballYear } from '../../engine/PlayerFactory.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock, tick, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards, getInbox } from '../../engine/CardEngine.js';
import { generatePlays, leagueNorms, accumulateBox } from '../../engine/SimEngine.js';
import { lookAhead } from '../../engine/LookAhead.js';
import { GAME_STATUS } from '../../data/constants.js';

const SEED = parseInt(process.argv[2] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|guys?|men|man)\b/i;

seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
clock.set(SM.get().schedule[0].gameTime - 20 * 3600_000);
advanceClock(clock.get()); releaseDueCards();

// ── 1. The sim ────────────────────────────────────────────────
console.log('\nThe sim: 400 games');
{
  const st = SM.get(), players = st.players, user = st.userTeam;
  const norms = leagueNorms([user, ...st.leagueTeams], players);
  const T0 = st.schedule[0].gameTime;
  let hurt = 0, hitters = 0, pitchers = 0, onBase = 0;
  const bad = [];
  for (let i = 0; i < 400; i++) {
    const opp = st.leagueTeams[i % st.leagueTeams.length];
    const g = { isHome: i % 2 === 0, gameTime: T0 + i * 86_400_000, weather: null, fieldCondition: null };
    const r = generatePlays(g, user, opp, players, { phase: st.phase, isSpring: false, norms, rand: dice('check-game-injuries', SEED, i), injuryYear: baseballYear(st) });
    const ps = r.plays;
    ps.forEach((p, k) => {
      if (p.type !== 'injury') return;
      hurt++;
      const id = p._injury.playerId;
      if (GEN.test(p.description)) bad.push(`gendered: ${p.description}`);
      // Never again in this game.
      // Never bats, pitches or stands on a base again. Stats after leaving: only a pitcher's
      // runs from runners left on base (charged to the pitcher who put them on) and the
      // end-of-game decisions (a pitcher who left can still get the win or the loss).
      const allowed = (q) => p._injury.role !== 'hitter' && (q.type === 'game_end'
        || (q._statDeltas?.[id] || []).every(d => ['er', 'r', 'runs_allowed'].includes(d.stat)));
      const later = ps.slice(k + 1).filter(q => q.batterId === id || q.pitcherId === id
        || Object.values(q._basesAfter || {}).includes(id)
        || (Object.keys(q._statDeltas || {}).includes(id) && !allowed(q)));
      if (later.length) bad.push(`${players[id]?.name} appears after leaving (${later[0].type}: ${JSON.stringify(later[0]._statDeltas?.[id] || '')}${later[0].batterId === id ? ' bats' : ''}${later[0].pitcherId === id ? ' pitches' : ''})`);
      if (p._injury.role === 'hitter') {
        hitters++;
        const sub = p._injury.subId;
        if (!sub) bad.push('a hurt hitter with no replacement');
        const wasOn = Object.values(ps[k - 1]?._basesAfter || {}).includes(id) && (ps[k - 1]?.outsAfter ?? 3) < 3;
        if (wasOn) { onBase++; if (!Object.values(p._basesAfter || {}).includes(sub)) bad.push('the replacement is not on the base'); }
        const box = accumulateBox(ps, players, { userIsHome: g.isHome, homeIds: g.isHome ? user.rosterIds : opp.rosterIds });
        const inBox = [...box.home.hitters, ...box.away.hitters].some(h => h.id === sub);
        if (!inBox) bad.push(`replacement ${players[sub]?.name} missing from the box`);
      } else {
        pitchers++;
        if (ps[k + 1]?.type !== 'pitching_change') bad.push(`a hurt pitcher not followed by a pitching change (${ps[k + 1]?.type})`);
      }
    });
  }
  console.log(`    ${hurt} injuries in 400 games (${hitters} hitters, ${onBase} of them on base; ${pitchers} pitchers)`);
  check('injuries happen on plays, in both lineups and on the mound', hitters > 5 && pitchers > 5, `${hitters} / ${pitchers}`);
  check('a hurt player never appears again; the replacement takes the spot (and the base); a hurt pitcher is relieved at once; gender-neutral',
        bad.length === 0, bad.slice(0, 4).join(' | '));
}

// ── 2. A real day: foreseen, then played with the app open ───
console.log('\nOur game: foreseen, then played with the app open');
let found = null;
for (let d = 0; d < 80 && !found; d++) {
  const st = SM.get();
  const g0 = st.schedule[st.currentGameIndex];
  if (!g0) break;
  const L = lookAhead(clock.get());
  const ours = (L?.plays || []).find(p => p._injury && st.players[p._injury.playerId]?.teamId === 'user');
  if (ours) { found = { L, play: ours, idx: g0.index, g0 }; break; }
  // Not this one: play it (app closed: the next-morning catch-up) and move on.
  clock.set(g0.gameTime + 15 * 3600_000); tick(); releaseDueCards();
  for (let guard = 0; guard < 50; guard++) {
    const g = SM.get().schedule[g0.index];
    if (!g || g._committed) break;
    if (g.status === GAME_STATUS.FINAL || g.status === GAME_STATUS.POSTPONED || g.cancelled) { await commitGame(g0.index); break; }
    clock.advance(30 * 60_000); tick(); releaseDueCards();
  }
}
check('the look-ahead foresees one of our players hurt within the next games', !!found);
if (found) {
  const { play, idx, g0 } = found;
  const id = play._injury.playerId;
  const P = () => SM.get().players[id];
  console.log(`    foreseen: ${new Date(play._timestamp).toISOString().slice(11, 16)} UTC, inning ${play.inning} — “${play.description}”`);
  // App open: 1-minute steps from an hour before first pitch, through the game.
  let hurtAt = null, act1 = null, sawEvaluating = false;
  for (let t = Math.max(clock.get(), g0.gameTime - 3600_000); ; t += 60_000) {
    clock.set(t); tick(); releaseDueCards();
    const g = SM.get().schedule[idx];
    if (P()?.injury?.status === 'evaluating' && !hurtAt) { hurtAt = t; sawEvaluating = g?.status === GAME_STATUS.LIVE; }
    const c = getInbox().find(x => x.cardId === 'injury_act1' && x._targetPlayerId === id);
    if (c && !act1) act1 = { card: c, at: t, live: g?.status === GAME_STATUS.LIVE };
    if (!g || g.status === GAME_STATUS.FINAL || g._committed || t > g0.gameTime + 6 * 3600_000) break;
  }
  const real = (SM.get().schedule[idx].plays || []).find(p => p._injury?.playerId === id);
  check('the real game hurts the same player on the same play', !!real && real._timestamp === play._timestamp && real.description === play.description);
  check('being evaluated from that play\'s moment, while the game is still on (not at the final out)',
        sawEvaluating && hurtAt >= play._timestamp && hurtAt < play._timestamp + 2 * 60_000 && P().injury.injuredAt === play._timestamp,
        `hurt seen at +${Math.round((hurtAt - play._timestamp) / 1000)}s`);
  check('the trainer\'s first message arrives during the game, minutes after the play',
        !!act1 && act1.live && act1.at - play._timestamp <= 25 * 60_000, act1 ? `+${Math.round((act1.at - play._timestamp) / 60_000)} min` : 'none');
  if (act1) console.log(`    Head Trainer: “${act1.card.subject}” — ${act1.card.body.slice(0, 140)}…`);
  check('…and it names the inning', act1 && act1.card.body.includes(`in the ${play.inning}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
