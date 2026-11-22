/**
 * tools/harness/check-emergencies.mjs — r213 §122.91
 *   - no quiet hours: a message's alert sounds when it arrives, any hour; a game's news as it happens; the game
 *     reminder for a night game; planned messages still keep to the staff's working day;
 *   - 2–4 emergency nights a season, each the night before a regular-season game of ours (11:30pm–4:30am),
 *     spread out;
 *   - at its moment: an urgent message that fits (home / road), due by morning and before first pitch, pushed then;
 *   - answered: its choice; slept through: the staff handle it (their way, their action), sometimes badly;
 *   - variety: a situation once a season, versions not repeated until the bank runs out.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { planEmergencies, pickEmergency, nextGameAfter } from '../../engine/Emergencies.js';
import { EMERGENCIES } from '../../data/cards-emergency.js';
import { EMERGENCY } from '../../data/constants.js';
import { rainHolds } from '../../engine/FieldCare.js';   // r256 a storm only on a night it stormed
import { dice } from '../../engine/Dice.js';
import { senderLabel } from '../../engine/Senders.js';
import { voiceProblems } from './voice-rules.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const H = 3_600_000;
const hourOf = (ms) => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; };
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;

seedRandom(21);
await startNewGame({ archetypeId: 'lab', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });

// ── No quiet hours ──
console.log('No quiet hours');
{
  const at = (() => { const d = new Date(clock.get() + 24 * H); d.setHours(23, 40, 0, 0); return d.getTime(); })();
  const st = structuredClone(S());
  st.scheduledCards = [...(st.scheduledCards || []), { instanceId: 'late', sender: 'Pro Scouting', subject: 'Late news', deliverAtMs: at, expiresAtMs: at + 9 * H }];
  const p = CE.getPushSchedule(st, clock.get()).find(x => x.id === 'late');
  check('a message that arrives at 11:40pm sounds at 11:40pm (the phone\'s own settings silence it)', p?.deliverAt === at, JSON.stringify(p));
  const g = S().schedule.find(x => !x.isSpring && new Date(x.gameTime).getHours() >= 19);
  if (g) {
    const st2 = structuredClone(S()); st2.currentGameIndex = st2.schedule.indexOf(st2.schedule.find(x => x.gameTime === g.gameTime));
    const rem = CE.gameReminders(st2, g.gameTime - 2 * H).find(x => x.id === `game-reminder-${g.gameTime}`);
    check(`the reminder for a night game comes 30 minutes before it (${new Date(g.gameTime).toTimeString().slice(0, 5)})`, rem?.deliverAt === g.gameTime - 30 * 60_000);
  }
}

// ── The nights ──
console.log('\nThe nights');
{
  const plan = S().emergencies?.plan || [];
  for (const x of plan) console.log(`    ${new Date(x.atMs).toString().slice(0, 21)} — before ${new Date(nextGameAfter(S(), x.atMs).gameTime).toString().slice(0, 21)}`);
  const games = S().schedule;
  const nextIdx = (x) => games.indexOf(nextGameAfter(S(), x.atMs));
  check(`a new team: ${plan.length} nights this season (2–4)`, plan.length >= 2 && plan.length <= 4);
  check('each in the night (11:30pm–4:30am), the night before a regular-season game, 8+ hours ahead',
        plan.every(x => { const h = hourOf(x.atMs); const g = nextGameAfter(S(), x.atMs); return (h >= 23.5 || h <= 4.5) && !g.isSpring && g.gameTime - x.atMs >= 8 * H && g.gameTime - x.atMs <= 30 * H; }));
  check(`spread out (${plan.map(nextIdx).join(', ')})`, plan.every((x, i) => i === 0 || nextIdx(x) - nextIdx(plan[i - 1]) >= EMERGENCY.minGapGames - 1));
  const counts = [];
  for (let k = 0; k < 60; k++) counts.push(planEmergencies(S(), clock.get(), dice(k, 'p')).length);
  check(`over many seasons: ${[2, 3, 4].map(n => `${n}: ${counts.filter(c => c === n).length}`).join(', ')}`, [2, 3, 4].every(n => counts.includes(n)) && counts.every(c => c >= 2 && c <= 4));
}

// ── One comes ──
console.log('\nOne comes');
const night0 = S().emergencies.plan[0].atMs;
clock.set(night0);
const c1 = CE.deliverEmergency(night0, buildCardContext());
{
  const card = CE.getInbox().find(c => c.instanceId === c1?.instanceId);
  const g = nextGameAfter(S(), night0);
  console.log(`    ${new Date(night0).toTimeString().slice(0, 5)}  ${senderLabel(card, S())} — ${card?.subject}\n    ${card?.body}`);
  check('it arrives at its moment, urgent', !!card && card.arrivedAtMs === night0 && card.type === 'urgent' && card._emergency);
  check(`due by morning and before first pitch (${new Date(card.expiresAtMs).toTimeString().slice(0, 5)})`, card.expiresAtMs <= night0 + EMERGENCY.answerH * H && card.expiresAtMs <= g.gameTime - 2 * H && card.expiresAtMs > night0 + 3 * H);
  const def = EMERGENCIES.find(d => d.id === card.cardId);
  check(`it fits the next game (${g.isHome ? 'home' : 'road'}: ${def._needs || 'either'})`, !def._needs || (def._needs === 'home') === !!g.isHome);
  check('in the sender\'s own voice, gender-neutral', voiceProblems(card, (s) => (String(s).match(/^(.+?) \(/) || [])[1] || null).filter(([r]) => r !== 'deptSelf').length === 0 && !GEN.test(card.body + card.preview), JSON.stringify(voiceProblems(card, () => null)));
}

// ── Answered, slept through ──
console.log('\nAnswered; slept through');
{
  // Every version: answered yes / no, and unanswered (good and bad), on copies.
  const bad = [], good = [];
  for (const [di, def] of EMERGENCIES.entries()) {
    for (const choice of ['yes', 'no', 'sleep']) {
      SM.speculate(() => {
        const at = night0 + (di + 1) * 60_000;
        const g = nextGameAfter(S(), at);
        SM.mutate(s => { const x = s.schedule.find(y => y.gameTime === g.gameTime); x.isHome = def._needs ? def._needs === 'home' : x.isHome; s.emergencies.situations = []; s.emergencies.used = EMERGENCIES.filter(d => d.id !== def.id).map(d => d.id); });
        // r256 a storm's version: on a weather where it stormed that night (another seed of the same save's weather)
        for (let k = 0; def._needsRain && k < 400 && !rainHolds(S(), def._needsRain, at); k++) SM.mutate(s => { s.weatherSeed = `storm-${k}`; });
        const m0 = S().userTeam.morale ?? S().userTeam.clubhouseMorale;
        const c = CE.deliverEmergency(at, buildCardContext());
        if (!c || c.cardId !== def.id) { bad.push(`${def.id}: not delivered (${c?.cardId})`); return; }
        const p = c._targetPlayerId ? S().players[c._targetPlayerId] : null;
        if (choice !== 'sleep') CE.resolve(c.instanceId, choice);
        else CE.expireDueRosterCards(c.expiresAtMs + 1000);
        const done = [...(S().inbox || []), ...(S().history || [])].find(x => x.instanceId === c.instanceId);
        if (!done?.resolved) { bad.push(`${def.id} ${choice}: not resolved`); return; }
        if (/\{/.test(done.expireMsg || '') || /\{/.test(done.yesMsg + done.noMsg)) bad.push(`${def.id}: a raw token`);
        const away = p ? S().players[p.id].unavailable : null;
        const acts = choice === 'sleep' ? (def.autoResolve === 'yes' ? def.onYes : def.onNo) : choice === 'yes' ? def.onYes : def.onNo;
        if (acts && p && !away) bad.push(`${def.id} ${choice}: ${acts} didn't happen`);
        if (choice === 'sleep') good.push({ id: def.id, bad: !!c._emergencyBad, msg: done.expireMsg, away: away?.reason || null });
      });
    }
  }
  check(`every version, answered either way or slept through, does what it says (${EMERGENCIES.length} versions × 3)`, bad.length === 0, bad.slice(0, 6).join(' | '));
  for (const g of good.slice(0, 4)) console.log(`    slept through ${g.id}${g.bad ? ' (went badly)' : ''}: ${g.msg}`);
  check('slept through: the staff say what they did', good.every(g => g.msg && /^No answer, so /.test(g.msg)));
  const nb = good.filter(g => g.bad).length;
  check(`…and sometimes it goes badly (${nb} of ${good.length} this time), in their words`, nb > 0 && nb < good.length && good.filter(g => g.bad).every(g => EMERGENCIES.find(d => d.id === g.id)._staffBad.msg.split(' ')[3] === g.msg.split(' ')[3]));
}

// ── Variety ──
console.log('\nVariety');
{
  const seen = new Set(); let dupSituation = false;
  SM.speculate(() => {
    for (let season = 1; season <= 5; season++) {
      SM.mutate(s => { s.emergencies = { ...(s.emergencies || {}), situations: [] }; });
      for (let k = 0; k < 3; k++) {
        const at = night0 + (season * 10 + k) * 1000;
        const def = pickEmergency(S(), at, dice(season, k));
        if (!def) continue;
        if ((S().emergencies.situations || []).includes(def._situation)) dupSituation = true;
        seen.add(def.id);
        SM.mutate(s => { s.emergencies.used = [...new Set([...(s.emergencies.used || []), def.id])]; s.emergencies.situations = [...(s.emergencies.situations || []), def._situation]; });
      }
    }
  });
  check(`five seasons, three a season: ${seen.size} different versions; never a situation twice in a season`, !dupSituation && seen.size >= 10);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
