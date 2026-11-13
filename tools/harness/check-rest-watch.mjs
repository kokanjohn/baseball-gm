// r160 §122.32 The staff's rest messages. Our lineup is the GM's: the manager never sits one of ours
// on the manager's own say. When a regular wears down, one of the staff writes — about a catcher the
// manager or the pitching coach, about a tired bat the hitting coach, about one worn down the team
// physician — a decision: sit the player the next game (the backup is named), or not. Never a pile-up:
// one open at a time, two days between any two, the same player not again for six days (unless now
// worn down). The manager steps in only when a message about someone worn down goes unanswered.
//   node tools/harness/check-rest-watch.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, gmMove } from '../../engine/GameEngine.js';
import { liveUntil } from './drive.mjs';
import * as CE from '../../engine/CardEngine.js';
import * as Dev from '../../engine/DevelopmentEngine.js';
import { WEAR, REST_WATCH } from '../../data/constants.js';
import { moveOptions } from '../../engine/RosterEngine.js';
import { voiceProblems } from './voice-rules.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const S = () => SM.get();
const P = (id) => S().players[id];
const restCards = () => [...(S().inbox || []), ...(S().scheduledCards || [])].filter(c => c.cardId === 'rest_ask');
const slotOf = (id) => S().userTeam.lineupSlots.find(s => s.playerId === id)?.slot;
const staff = () => S().userTeam.coachingStaff || {};
const personOf = (sender) => [staff().manager, staff().pitchingCoach, staff().hittingCoach].find(x => x?.name && sender === x.name)?.name || null;

seedRandom(47);
clock.set(Number(process.env.T0) || Date.UTC(2026, 10, 13, 15, 0));   // (a fixed start: the same season every run)
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });

// ── A stretch of the season, the GM answering nothing ──────────
console.log('Five weeks, nobody answering: what the staff sends, and how often');
const t0 = clock.get();
const seen = new Map();   // instanceId → the card as delivered
const restedBy = [];       // our players sat with no card behind it
let lastWhy = '';
const onStep = () => {
  if (process.env.DBG) {
    const sl = S().userTeam.lineupSlots.find(x => x.slot === 'C'), p = P(sl.playerId);
    const why = `${p?.name} ${p?.wear} open:${restCards().filter(c => !c.resolved).length} lr:${(S().inbox || []).filter(c => c.cardId === 'lineup_return' && !c.resolved).length} last:${S().restWatch?.lastAt ? ((clock.get() - S().restWatch.lastAt) / DAY).toFixed(1) : '-'} avail:${p && !p.unavailable && !p.isInjured} sub:${!!Dev.fillInFor(S(), S().userTeam, p)}`;
    if ((p?.wear || 0) >= 9 && why.replace(/[\d.]+/g, '') !== lastWhy) { console.log('      ', new Date(clock.get()).toISOString().slice(5, 16), why); lastWhy = why.replace(/[\d.]+/g, ''); }
  }
  for (const c of S().inbox || []) if (c.cardId === 'rest_ask' && !seen.has(c.instanceId)) seen.set(c.instanceId, { ...c, _slot: slotOf(c._targetPlayerId), _wear: Dev.wearOf(P(c._targetPlayerId)) });
  for (const sl of S().userTeam.lineupSlots) {
    const p = sl.playerId && P(sl.playerId);
    if (p?.unavailable?.reason === 'rest' && !restCards().some(c => c._targetPlayerId === p.id && c.choice === 'auto')) restedBy.push(p.name);
  }
};
await liveUntil(t0 + 35 * DAY, { onStep });
if (process.env.DBG) {
  const played = S().schedule.filter(g => g._committed && g.gameTime >= t0);
  console.log('    games played', played.length, 'phase', S().phase, 'wear', S().userTeam.lineupSlots.map(sl => `${sl.slot}:${P(sl.playerId)?.wear}/${P(sl.playerId)?.straight}`).join(' '));
}
const got = [...seen.values()].sort((a, b) => a.deliverAtMs - b.deliverAtMs);
for (const c of got) console.log(`    ${new Date(c.deliverAtMs).toISOString().slice(5, 16)}  ${c._slot}  “${c.subject}” (${c.sender}) — ${c.body}  [${c.yesLabel} / ${c.noLabel}]`);
check(`the staff wrote about rest (${got.length} messages in five weeks — enough to notice, not a flood)`, got.length >= 2 && got.length <= 14);
check('…at least one about the catcher, from the manager or the pitching coach',
      got.some(c => c._slot === 'C' && [staff().manager?.name, staff().pitchingCoach?.name].includes(c.sender)));
const gaps = got.slice(1).map((c, i) => c.deliverAtMs - got[i].deliverAtMs);
check(`…never two close together (the shortest gap: ${(Math.min(...gaps, Infinity) / DAY).toFixed(1)} days)`, gaps.every(g => g >= REST_WATCH.gapMs));
const repeat = got.find((c, i) => got.slice(0, i).some(x => x._targetPlayerId === c._targetPlayerId && c.deliverAtMs - x.deliverAtMs < REST_WATCH.samePlayerMs && !(c._restWorn && !x._restWorn)));
check('…the same player not again within six days (unless now worn down)', !repeat, repeat?.subject);
check('…each a decision: sit the player the next game, the backup named', got.every(c => c._raw?.onYes === 'day_off' && (c._playerIds || []).length === 1 && c.body.includes(P(c._playerIds[0]).name)));
if (process.env.DBG) for (const c of got) { const g = S().schedule.find(x => x.index === c._restGame?.index); console.log('    game', g?.gameTime - c.deliverAtMs, c.expiresAtMs - g?.gameTime, g?.status); }
check('…each well before first pitch, and gone when the game starts', got.every(c => {
  const g = S().schedule.find(x => x.index === c._restGame?.index);
  return g && c._restGame.gameTime - c.deliverAtMs >= REST_WATCH.leadMs && c.expiresAtMs < c._restGame.gameTime;
}));
const bad = got.map(c => [c, voiceProblems(c, personOf)]).filter(([c, v]) => v.length || GEN.test(c.body) || GEN.test(c.yesLabel));
check('…in the sender\'s own voice, gender-neutral', !bad.length, bad.map(([c, v]) => `${c.subject}: ${v.map(x => x.join(':'))}`).join(' | '));
check(`our manager never sat anyone without a message behind it${restedBy.length ? ` (${[...new Set(restedBy)].join(', ')})` : ''}`, !restedBy.length);
check('a game off clears the wear (anyone who sat the last game is fresh)', S().userTeam.rosterIds.map(P).filter(p => p && !['SP', 'RP'].includes(p.pos) && !S().userTeam.lineupSlots.some(s => s.playerId === p.id) && !p.straight).every(p => (p.wear || 0) === 0));

// ── The scenarios, step by step (deterministic): a fresh club in the season, hours before a game ──
seedRandom(53);
await startNewGame({ archetypeId: 'institution', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const game = S().schedule[S().currentGameIndex];
clock.set(game.gameTime - 6 * 3600_000);
SM.mutate(s => { s.phase = 'REGULAR_SEASON'; s.userTeam._lastGameAt = game.gameTime - DAY; });
/** A clean slate: no rest message open, the spacing reset; the staff looks now; the message about `id`. */
const fresh = () => {
  for (const c of restCards().filter(c => !c.resolved)) CE.resolve(c.instanceId, 'no');
  SM.mutate(s => { s.restWatch = {}; for (const id of s.userTeam.rosterIds) if (s.players[id]) { s.players[id].wear = 0; s.players[id].straight = 0; } });
};
const ask = (id, wear, straight) => {
  SM.mutate(s => { Object.assign(s.players[id], { wear, straight }); });
  CE.syncRosterCards([], clock.get());
  const c = restCards().find(c => !c.resolved && c._targetPlayerId === id);
  if (c) CE.releaseDueCards(Math.max(clock.get(), c.deliverAtMs + 1000));
  return c;
};
const playGame = () => SM.mutate(s => { Dev.countGame(s, 'user', game.gameTime); });

console.log('Yes: the catcher sits, the backup catches');
const cSlot = S().userTeam.lineupSlots.findIndex(s => s.slot === 'C');
const catcher = P(S().userTeam.lineupSlots[cSlot].playerId);
fresh();
let card = ask(catcher.id, 10.5, 7);
check(`${catcher.name} has caught 7 straight: the manager or the pitching coach writes`, !!card && [staff().manager?.name, staff().pitchingCoach?.name].includes(card.sender), card?.sender);
console.log(`    “${card?.subject}” (${card?.sender}) — ${card?.body}`);
const backup = P(card._playerIds[0]);
check(`…naming the backup who'd catch (${backup.name}, ${backup.pos})`, card.body.includes(backup.name) && /\b7\b/.test(card.body) && backup.pos === 'C');
CE.resolve(card.instanceId, 'yes');
check(`yes: ${backup.name} takes the C slot, ${catcher.name} sits the next game`, S().userTeam.lineupSlots[cSlot].playerId === backup.id && P(catcher.id).unavailable?.reason === 'rest');
playGame();
check(`after that game: ${catcher.name} is back behind the plate, the wear gone`, S().userTeam.lineupSlots[cSlot].playerId === catcher.id && (P(catcher.id).wear || 0) === 0 && P(catcher.id).straight === 0 && !P(catcher.id).unavailable);

console.log('The GM benches the player on the Team screen instead');
const [reg, worn, fine] = S().userTeam.lineupSlots.filter(x => x.slot !== 'C' && x.playerId).map(x => P(x.playerId));
fresh();
card = ask(reg.id, 13, 13);
check(`${reg.name}, tired: the hitting coach writes`, !!card && card.sender === staff().hittingCoach?.name, card?.sender);
const swap = moveOptions(S(), reg.id).find(o => o.key.startsWith('in:'));
check('…the GM swaps a bench bat in on the Team screen', !!swap && gmMove(reg.id, swap.key, clock.get()).ok);
check('…and the message is withdrawn (nothing left to decide)', !restCards().some(c => c.instanceId === card?.instanceId));
const back = moveOptions(S(), reg.id).find(o => o.key.startsWith('slot:'));
if (back) gmMove(reg.id, back.key, clock.get());

console.log('Worn down and no answer by first pitch: the manager sits the player');
fresh();
card = ask(worn.id, WEAR.worn + 1, 19);
console.log(`    “${card?.subject}” (${card?.sender}) — ${card?.body}`);
check(`${worn.name}, worn down: the team physician writes, and says what happens with no answer`, !!card && card.sender === 'Team Physician' && /no answer by first pitch/.test(card.body) && card._raw.onAuto === 'rest_auto');
CE.expire(card.instanceId, card.expiresAtMs);
check(`no answer: the manager sat ${worn.name} for the game, and says so in the news`, P(worn.id).unavailable?.reason === 'rest'
      && restCards().find(c => c.instanceId === card.instanceId)?.choice === 'auto'
      && (S().activityFeed || []).some(e => /no answer on the rest/.test(JSON.stringify(e))));
playGame();

console.log('Tired, no answer: nothing happens');
fresh();
card = ask(fine.id, WEAR.tired + 1, 13);
check(`${fine.name}, tired: a message, but no step-in behind it`, !!card && card._raw.onAuto == null);
CE.expire(card.instanceId, card.expiresAtMs);
check(`no answer: ${fine.name} plays — the lineup stays the GM's`, P(fine.id).unavailable?.reason !== 'rest' && S().userTeam.lineupSlots.some(x => x.playerId === fine.id)
      && restCards().find(c => c.instanceId === card.instanceId)?.choice === 'auto');

console.log('Spacing');
fresh();
const one = ask(reg.id, 13, 13);
SM.mutate(s => { s.players[fine.id].wear = 13; s.players[fine.id].straight = 13; });
CE.syncRosterCards([], clock.get());
check('one open at a time: a second tired regular waits', !!one && !restCards().some(c => !c.resolved && c._targetPlayerId === fine.id));
CE.resolve(one.instanceId, 'no');
CE.syncRosterCards([], clock.get());
check(`…and the spacing holds after an answer (${REST_WATCH.gapMs / DAY} days between any two)`, !restCards().some(c => !c.resolved && c._targetPlayerId === fine.id));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
