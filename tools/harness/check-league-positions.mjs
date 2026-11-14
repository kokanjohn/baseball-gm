// r168 §122.35 phase 6 — positions around the league. In season a club somewhere moves a player to a
// new spot every few days (the thinnest spot when it can; a starter to the bullpen too, a reliever
// stretched out); a free agent works out at a new position every week or two. Each is on the wire;
// a lower-rated player is a line in Recent; one who'd start for us there is a Pro Scouting message
// (a trade idea for a club's player, a signing for a free agent), at most one every few days.
//   node tools/harness/check-league-positions.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import * as Pos from '../../engine/Positions.js';
import { fitsUs } from '../../engine/LeaguePositions.js';
import { liveUntil } from './drive.mjs';
import { LEAGUE_POSITIONS as L, PLAYER_GROUP } from '../../data/constants.js';
import { voiceProblems } from './voice-rules.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;

// ── Given outright ─────────────────────────────────────────────
console.log('A position given outright');
const mk = (pos) => { const p = { id: pos + Math.random(), pos, nativePos: pos }; p.positions = Pos.seedPositions(p); return p; };
const ss = mk('SS');
check(`a shortstop given 2B: eligible (${Pos.posLabel(ss)})`, Pos.grantPosition(ss, '2B') && Pos.canPlay(ss, '2B') && Pos.posLabel(ss) === 'SS/2B');
check('…again: nothing changes', !Pos.grantPosition(ss, '2B'));
const sp = mk('SP');
check(`a starter given RP (${Pos.posLabel(sp)}), still listed SP`, Pos.grantPosition(sp, 'RP') && Pos.posLabel(sp) === 'SP/RP' && sp.pos === 'SP');
const rp = mk('RP');
check('a reliever given SP is stretched out', Pos.grantPosition(rp, 'SP') && Pos.stretchOf(rp) === 3);

// ── A month of the season ───────────────────────────────────────
seedRandom(168);
clock.set(Date.UTC(2026, 10, 13, 15));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const S = () => SM.get(), P = (id) => S().players[id];
const first = S().schedule.find(g => !g.isSpring).gameTime;
const lastSpring = Math.max(...S().schedule.filter(g => g.isSpring).map(g => g.gameTime));
const spring = (S().leagueWire || []).filter(e => e.kind === 'position' && e.teamIds.length).length;
await liveUntil(lastSpring - DAY);
const springCpu = (S().leagueWire || []).filter(e => e.kind === 'position' && e.teamIds.length).length;
check(`spring: no club moves (${springCpu}); free agents may work out`, springCpu === spring && springCpu === 0);
const t0 = clock.get();
// (Recent keeps three days: collected as it goes)
const seen = new Map();
for (let t = t0 + 2 * DAY; t <= first + 30 * DAY; t += 2 * DAY) {
  await liveUntil(t);
  for (const e of S().activityFeed || []) if (e.type === 'position') seen.set(e.text + e.timestamp, e);
}
const wire = (S().leagueWire || []).filter(e => e.kind === 'position' && e.atMs >= t0);
const cpu = wire.filter(e => e.teamIds.length), fa = wire.filter(e => !e.teamIds.length);
console.log(`    ${cpu.length} club moves, ${fa.length} free agents in 31 days. e.g.:`);
for (const e of [...cpu.slice(0, 4), ...fa.slice(0, 2)]) console.log(`      ${e.text}`);
check(`a few club moves a week (${cpu.length} in a month)`, cpu.length >= 8 && cpu.length <= 22);
check(`a free agent every week or two (${fa.length})`, fa.length >= 2 && fa.length <= 6);
check('…all of them real: the player plays there now', cpu.every(e => /playing (\w+) too|pitching in relief|stretching/.test(e.text)));
const feed = [...seen.values()];
check(`lines in Recent (${feed.length}), short, no gendered words`, feed.length >= cpu.length / 2 && feed.every(e => !GEN.test(e.text)));
const msgs = (S().inbox || []).filter(c => (c._rosterKey || '').startsWith('lp:'));
console.log(`    Pro Scouting messages: ${msgs.map(c => `"${c.subject}"`).join(', ') || 'none'}`);
const at = msgs.map(c => c.arrivedAtMs ?? c.deliverAtMs).sort((a, b) => a - b);
if (process.env.DBG) console.log('    dbg', at.map(x => ((x - t0) / DAY).toFixed(2)).join(' '));
check('messages at most one every few days', at.every((x, i) => i === 0 || x - at[i - 1] >= L.msgGapMs - 3 * 3600_000));

// ── Fits us ─────────────────────────────────────────────────────
console.log('Would start for us');
const u = S().userTeam;
const ourSS = P(u.lineupSlots.find(s => s.slot === 'SS').playerId);
const freeAgents = Object.values(S().players).filter(p => p.group === PLAYER_GROUP.FREE_AGENT && !Pos.isPitcher(p));
const FA = await import('../../engine/FreeAgency.js');
// (one ownership would pay for at that rating: the card only comes when we could actually sign)
let better = null;
for (const c of freeAgents.filter(p => p.ovr >= 45 && p.ovr < ourSS.ovr + L.fitGap)) {
  const was = c.ovr;
  SM.mutate(s => { s.players[c.id].ovr = ourSS.ovr + L.fitGap + 1; });
  const room = FA.roomFor(S(), P(c.id)), d = room.candidates.find(x => !x.starter);
  if (!FA.signBlocker(S(), c.id, room.needsDrop ? d?.player.id : null)) { better = c; break; }
  SM.mutate(s => { s.players[c.id].ovr = was; });
}
SM.mutate(s => { const p = s.players[better.id]; p.positions.elig = (p.positions.elig || []).filter(x => x !== 'SS'); if (p.positions.primary === 'SS') p.positions.primary = '1B'; });
check(`${better.name} (${P(better.id).ovr}) would start at SS over ${ourSS.name} (${ourSS.ovr})`, fitsUs(S(), P(better.id), 'SS')?.start === true && fitsUs(S(), P(better.id), 'SS').over === ourSS.id);
const worse = freeAgents.find(p => p.id !== better.id);
SM.mutate(s => { s.players[worse.id].ovr = Math.min(s.players[worse.id].ovr, ourSS.ovr - 5); });
check(`${worse.name} (${P(worse.id).ovr}) wouldn't`, !fitsUs(S(), P(worse.id), 'SS')?.start);

console.log('A free agent at a spot we need');
SM.mutate(s => { s.leaguePos.lastMsgAt = -Infinity; const p = s.players[better.id]; Pos.grantPosition(p, 'SS'); });
if (process.env.DBG) { const FA = await import('../../engine/FreeAgency.js'); const r = FA.roomFor(S(), P(better.id)); const d = r.candidates.find(c => !c.starter); console.log('    dbg fa', JSON.stringify(fitsUs(S(), P(better.id), 'SS')), r.needsDrop, d?.player.name, FA.signBlocker(S(), better.id, d?.player.id || null), JSON.stringify(FA.termsFor(S(), P(better.id)))); }
CE.leaguePositionNews([{ type: 'LEAGUE_POS', kind: 'fa', playerId: better.id, teamId: null, pos: 'SS', atMs: clock.get(), text: 'x' }], clock.get());
let card = [...(S().inbox || []), ...(S().scheduledCards || [])].find(c => c.cardId === 'fa_pos' && c._targetPlayerId === better.id);
if (card) { CE.releaseDueCards(Math.max(clock.get(), card.deliverAtMs + 1000)); clock.set(Math.max(clock.get(), card.deliverAtMs + 1000)); card = CE.getInbox().find(c => c.instanceId === card.instanceId); }
console.log(`    “${card?.subject}” (${card?.sender}) — ${card?.body}  [${card?.yesLabel} / ${card?.noLabel}]`);
check('Pro Scouting writes: who, why, the terms, who makes room', !!card && card.sender === 'Pro Scouting' && /would start over/.test(card.body) && /The terms/.test(card.body) && card.yesLabel === `Sign ${better.name}`);
check('…gender-neutral, and in Pro Scouting\'s voice', !!card && !GEN.test(card.body) && voiceProblems(card, () => null).filter(([r]) => r !== 'deptSelf').length === 0, JSON.stringify(card && voiceProblems(card, () => null)));
if (card) {
  const drop = card._dropId;
  CE.resolve(card.instanceId, 'yes');
  check(`yes: ${better.name} signs with us${drop ? ` and ${P(drop).name} makes room` : ''}`, P(better.id).teamId === 'user' && (!drop || P(drop).teamId !== 'user' || P(drop).onWaivers));
}

console.log('A club\'s player at a spot we need');
// (a player Pro Scouting can put a package together for: the first who'd start over our second baseman)
const { scoutPackage } = await import('../../engine/LeagueTrades.js');
const our2B = P(S().userTeam.lineupSlots.find(s => s.slot === '2B').playerId);
let club = null, theirs = null;
for (const t of S().leagueTeams) {
  for (const p of t.rosterIds.map(P).filter(p => p && !Pos.isPitcher(p) && !Pos.canPlay(p, '2B') && p.ovr >= our2B.ovr + L.fitGap)) {
    if (scoutPackage(S(), t.id, p.id, clock.get())) { club = t; theirs = p; break; }
  }
  if (theirs) break;
}
check(`(found one: ${theirs?.name}, ${theirs?.ovr}, over ${our2B.name}, ${our2B.ovr})`, !!theirs);
SM.mutate(s => { Pos.grantPosition(s.players[theirs.id], '2B'); s.leaguePos.lastMsgAt = -Infinity; });
if (process.env.DBG) { const { scoutPackage } = await import('../../engine/LeagueTrades.js'); const { tradeWindow } = await import('../../engine/TradeEngine.js'); console.log('    dbg', JSON.stringify(fitsUs(S(), P(theirs.id), '2B')), tradeWindow(S()).open, !!scoutPackage(S(), club.id, theirs.id, clock.get()), S().phase); }
CE.leaguePositionNews([{ type: 'LEAGUE_POS', kind: 'cpu', playerId: theirs.id, teamId: club.id, pos: '2B', atMs: clock.get(), text: 'line' }], clock.get());
let idea = [...(S().inbox || []), ...(S().scheduledCards || [])].find(c => c._rosterKey === `lp:${theirs.id}:2B`);
if (idea) { CE.releaseDueCards(Math.max(clock.get(), idea.deliverAtMs + 1000)); idea = CE.getInbox().find(c => c.instanceId === idea.instanceId) || idea; }
console.log(`    “${idea?.subject}” (${idea?.sender}) — ${idea?.body?.slice(0, 260)}…  [${idea?.yesLabel} / ${idea?.noLabel}]`);
check('a trade idea from Pro Scouting, with a package', !!idea && idea.cardId === 'lt_offer' && /would start over/.test(idea.body) && !GEN.test(idea.body));
// a second within the gap: Recent instead

const other = club.rosterIds.map(P).filter(p => !Pos.isPitcher(p) && p.id !== theirs.id && !Pos.canPlay(p, '3B'))[0];
SM.mutate(s => { const p = s.players[other.id]; p.ovr = 99; Pos.grantPosition(p, '3B'); });
CE.leaguePositionNews([{ type: 'LEAGUE_POS', kind: 'cpu', playerId: other.id, teamId: club.id, pos: '3B', atMs: clock.get(), text: `${club.abbr} have ${other.name} playing 3B too` }], clock.get());
check('another the same day: a line in Recent, not a second message', (S().activityFeed || []).some(e => e.text === `${club.abbr} have ${other.name} playing 3B too`) && ![...(S().inbox || []), ...(S().scheduledCards || [])].some(c => c._rosterKey === `lp:${other.id}:3B`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
