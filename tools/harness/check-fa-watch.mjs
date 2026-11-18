// r204 §122.82 The free-agent report is a decision: sign any of the players it names, or have the director
// watch one (up to three at once). The message stays open for the rest; Done closes it, and it closes itself
// when nothing's left to decide or its looks come back (a week). A club moving to sign a watched player puts
// in a claim instead: the director's message comes, with half a day to sign first; Let Go (or no answer) and
// the club signs.
//   node tools/harness/check-fa-watch.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, gmWatchFreeAgent, gmSignFreeAgent, advanceClock } from '../../engine/GameEngine.js';
import { deliverComposeCard, releaseDueCards, getInbox, resolve, syncRosterCards, expireDueRosterCards } from '../../engine/CardEngine.js';
import { watching, isWatched, reportRows, reportSummary, claimInstead, held } from '../../engine/FaWatch.js';
import { cpuFreeAgentLook, rankPickups } from '../../engine/TransactionEngine.js';
import { roomFor } from '../../engine/FreeAgency.js';
import { FA_WATCH } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const S = () => SM.get();
const H = 3600_000, D = 86_400_000;

seedRandom(77);
await startNewGame({ archetypeId: 'lab', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
// Plenty of money, so a signing is never blocked by payroll here.
SM.mutate(s => { s.userTeam.finances.funds = 1e9; s.userTeam.finances.payrollTarget = 1e9; s.userTeam.finances.ownerTarget = 1e9; });

/** Ask for a report; → the reply card (with players). */
function report(atMs = clock.get()) {
  SM.mutate(s => { s.composeLog = []; });
  const c = deliverComposeCard('sc_free_agents', 'scouting', { topicLabel: 'Free agents worth a look', nowMs: atMs });
  releaseDueCards(c.deliverAtMs);
  clock.set(c.deliverAtMs);
  return getInbox().find(x => x.instanceId === c.instanceId);
}
const drop = (id) => { const r = roomFor(S(), S().players[id]); return r.needsDrop ? r.candidates[0].player.id : null; };

console.log('\nThe report');
let card = report();
check(`a report with players (${card?._faRows?.length})`, card?._faRows?.length >= 1, card?.body);
check('…a decision: Done, open until its looks come back (a week)', card.yesLabel === 'Done' && !card.noLabel
  && card.expiresAtMs === card.deliverAtMs + 7 * D, `${card.yesLabel} ${(card.expiresAtMs - card.deliverAtMs) / D}`);
check('…and the director says up to three can be watched', /up to three free agents at a time/.test(card.body));
check('every player starts open', reportRows(S(), card, clock.get()).every(r => r.status === 'open'));

console.log('\nWatch, and sign');
const [a, b] = card._faRows;
check('Watch: watching', gmWatchFreeAgent(a).ok && isWatched(S(), a, clock.get()));
check('…the row says so, and the message stays open', reportRows(S(), getInbox().find(x => x.instanceId === card.instanceId), clock.get())[0].status === 'watching'
  && (card._faRows.length === 1 || !getInbox().find(x => x.instanceId === card.instanceId).resolved));
if (b) {
  const r = gmSignFreeAgent(b, drop(b));
  check(`Sign: ours (${r.reason || 'ok'})`, r.ok && S().players[b].teamId === 'user');
  check('…the row says signed', reportRows(S(), card, clock.get()).find(x => x.id === b)?.status === 'signed');
}
{
  const live = getInbox().find(x => x.instanceId === card.instanceId);
  const open = reportRows(S(), live, clock.get()).filter(r => r.status === 'open');
  if (open.length) {
    resolve(card.instanceId, 'yes');
    const done = getInbox().find(x => x.instanceId === card.instanceId) || S().inbox.find(x => x.instanceId === card.instanceId);
    check(`Done: closed, with what came of each (“${done._summary}”)`, done.resolved && /Watching/.test(done._summary) && /Passed on/.test(done._summary)
      && (!b || /Signed/.test(done._summary)));
  } else {
    const done = S().inbox.find(x => x.instanceId === card.instanceId);
    check(`nothing left to decide: it closed itself (“${done._summary}”)`, done.resolved && /Watching/.test(done._summary));
  }
}

console.log('\nUp to three at once');
{
  const pool = (S().freeAgentPool || []).filter(id => !isWatched(S(), id, clock.get()));
  for (const id of pool) { if (watching(S(), clock.get()).length >= FA_WATCH.max) break; gmWatchFreeAgent(id); }
  check(`watching ${watching(S(), clock.get()).length}`, watching(S(), clock.get()).length === FA_WATCH.max);
  const more = pool.find(id => !isWatched(S(), id, clock.get()));
  const r = gmWatchFreeAgent(more);
  check(`a fourth: refused (“${r.reason}”)`, !r.ok && /3 already/.test(r.reason));
}

console.log('\nA report that closes itself');
SM.speculate(() => {
  const c2 = report(clock.get() + 2 * D);
  if (!c2?._faRows?.length) { check('a second report', false); return; }
  // Its looks come back: it closes, the rest passed on.
  expireDueRosterCards(c2.expiresAtMs);
  const done = S().inbox.find(x => x.instanceId === c2.instanceId);
  check(`its looks come back: closed (“${done?._summary}”)`, done?.resolved && done.choice === 'auto' && /Passed on|Watching|Signed/.test(done._summary || ''));
});

SM.speculate(() => {
  const c3 = report(clock.get() + 3 * D);
  if (!c3?._faRows?.length) { check('a third report', false); return; }
  for (const id of c3._faRows) gmSignFreeAgent(id, drop(id));
  const done = S().inbox.find(x => x.instanceId === c3.instanceId);
  check(`every player signed: nothing left to decide, it closed itself (“${done?._summary}”)`, done?.resolved && done.choice === 'yes' && /^Signed /.test(done._summary || ''));
});

console.log('\nA club moves on a player we watch');
const watched = watching(S(), clock.get())[0];
const club = S().leagueTeams.find(t => t.id !== 'user');
/** The club's move, now: the message comes with half a day to answer. */
function move(id = watched) {
  const t = clock.get();
  SM.mutate(d => { claimInstead(d, d.players[id], club.id, t); });
  syncRosterCards([], t);
  releaseDueCards(t + 1);
  return getInbox().find(x => x.cardId === 'watch_alert' && x._targetPlayerId === id && !x.resolved);
}
SM.speculate(() => {
  const alert = move();
  const p = S().players[watched];
  check(`the director's message: “${alert?.subject}”`, !!alert && alert.yesLabel.startsWith(`Sign ${p.name}`) && alert.noLabel === 'Let Go'
    && alert.expiresAtMs - clock.get() === FA_WATCH.warnMs, alert?.body);
  check('…other clubs leave the player alone meanwhile', held(p) && !rankPickups(S(), S().leagueTeams[1].id, { side: null }, { atMs: clock.get() }).some(x => x.id === watched));
  resolve(alert.instanceId, 'no');
  check(`Let Go: the club signs (${S().players[watched].teamId})`, S().players[watched].teamId === club.id && !S().players[watched]._watchClaim && !isWatched(S(), watched, clock.get()));
});
SM.speculate(() => {
  const alert = move();
  resolve(alert.instanceId, 'yes', { pick: alert._choices?.[0]?.key ?? null });
  check(`Sign: ours, the move over (${S().players[watched].teamId})`, S().players[watched].teamId === 'user' && !S().players[watched]._watchClaim);
});
SM.speculate(() => {
  const alert = move();
  expireDueRosterCards(alert.expiresAtMs);
  check('no answer: the club signs at the deadline', S().players[watched].teamId === club.id);
});
SM.speculate(() => {
  const alert = move();
  gmSignFreeAgent(watched, drop(watched));
  syncRosterCards([], clock.get());
  check('signed from the Free Agents screen first: the message goes away', S().players[watched].teamId === 'user'
    && !getInbox().some(x => x.instanceId === alert.instanceId && !x.resolved));
});

console.log('\nThe clubs\' own looks');
SM.speculate(() => {
  // Make the watched player an obvious upgrade for every club: the first to look moves on it.
  SM.mutate(d => { d.players[watched].ovr = 95; d.players[watched]._buzzAt = 0; for (const t of d.leagueTeams) { t.finances = { ...(t.finances || {}), payrollTarget: 1e9 }; } });
  SM.mutate(d => cpuFreeAgentLook(d, clock.get()));
  const p = S().players[watched];
  check(`an upgrade look moves on the watched player, and waits (${p._watchClaim?.teamId})`, !!p._watchClaim && p.group === 'freeAgent'
    && p._watchClaim.atMs - p._watchClaim.madeAtMs === FA_WATCH.warnMs);
  const before = p._watchClaim.teamId;
  SM.mutate(d => cpuFreeAgentLook(d, clock.get() + H));
  check('…the next look leaves it alone (claimed)', S().players[watched]._watchClaim?.teamId === before && S().players[watched].group === 'freeAgent');
  check('a club filling a hole doesn\'t wait on a watched player', !rankPickups(S(), before, { side: null }, { atMs: clock.get() }).some(x => isWatched(S(), x.id, clock.get())));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
