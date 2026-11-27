/**
 * engine/cards/RosterCards.js
 * CardEngine, roster cards on the roster clock (§65): injuries, the IL, open spots, needs, the manager filling a spot.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { PHASE, PLAYER_GROUP, INJURY_MRI_COST_K, INJURY_MRI_RESULT_MIN_MS, INJURY_MRI_RESULT_MAX_MS, INJURY_MORNING_EXAM_HOUR } from '../../data/constants.js';
import { confirmDiagnosis, dayToDayAllowed, ilMinDays } from '../InjuryEngine.js';
import * as When from '../When.js';
import { reconcileRoster, openSpots, managerFillAt, managerFillsNow, pendingArrivals, nextLineupGame, laterOpenSpots, sweepLineupPlans, HITTER_TARGET, PITCHER_TARGET, nextCalendarDay } from '../RosterEngine.js';
import { tradeBlockers } from '../TradeEngine.js';
import { getRosterNeeds, rankPickups, decisionDeadlineAfter, vacancyDeadline, rosterIsFull, sideOf } from '../TransactionEngine.js';
import { formatK } from '../CardTokens.js';
import * as Offseason from '../OffseasonEngine.js';
import { adviceFor } from '../RosterAdvice.js';
import { CARD_ACTIONS, cardFeasible } from '../CardActions.js';
import { signingTerms } from '../MarketEngine.js';
import { isAvailable } from '../PlayerFactory.js';
import { dealByKey } from '../TradeAdvice.js';
import * as Negotiation from '../Negotiation.js';
import { buildActivityFeedEntry, pruneActivityFeed } from '../SeasonEngine.js';
import { reliefValue } from '../PitchingEngine.js';
import { clockNow } from '../Clock.js';
import { dice, diceSeed, withDice } from '../Dice.js';
import { primaryPos, posLabel, eligibleAt } from '../Positions.js';
import { _list } from './AllStarCards.js';
import { _cardsWithKey, _clock, _day, _deliverAt, _hand, _randBetween, _rosterCard, _withdraw } from './Delivery.js';
import { _uuid } from './Helpers.js';
import { _leagueTradeCards } from './LeagueTradeCards.js';
import { _adviceHeld, _adviceWatch, _f3, _lineNow, _lineupNudges, _nextStarter, _restWatch } from './LineupAdvice.js';
import { _claimLostCard, _deliverSimReport, _deliverTeachReport, _positionNotes, _who, syncWinterOffers } from './OffseasonCards.js';
import { _faWatchSweep, _scoutFindsGone } from './PlayerCards.js';
import { expire } from './Promises.js';
import { _deliverDevelopmentReport } from './ScoutingTips.js';

function _ordinalInning(n) {
  return `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}


export function _managerName(state) {
  return state.userTeam.coachingStaff?.manager?.name || 'The manager';
}


export function _needFor(player) {
  if (!player) return { side: 'hitter', pos: null };
  if (['SP', 'RP'].includes(player.pos)) return { side: 'pitcher', pos: player.pos };
  return { side: 'hitter', pos: primaryPos(player) };
}


/**
 * deliverInjuryAct1(playerId, atMs)
 * Act 1 — the trainer's report right after the game: exam tonight or wait?
 * An MRI tonight ($) returns a diagnosis in 1–2 hours, so a roster move made
 * before midnight reports tomorrow. Waiting means the morning exam — free,
 * but the replacement can't report until the day after.
 */
export function deliverInjuryAct1(playerId, atMs = clockNow()) {
  const state  = StateManager.get();
  const player = state.players[playerId];
  if (!player || player.injury?.status !== 'evaluating') return null;
  const label  = (player.injury.label || 'injury').toLowerCase();
  // §118 hurt on a play: the inning they left in.
  const inn    = Number.isFinite(player.injury.inning) ? ` in the ${_ordinalInning(player.injury.inning)}` : '';
  const card = _rosterCard(state, {
    cardId:   'injury_act1',
    tag:      'INJURY',
    sender:   'Head Trainer',
    _rosterKey: `injury:${playerId}:act1`,
    _targetPlayerId: playerId,
    subject:  `${player.name} hurt — evaluation needed`,
    preview:  `${player.name}${_hand(player)} came out of today's game${inn} with a possible ${label}.`,
    body:     `${player.name}${_hand(player)} (${player.pos}) came out of today's game${inn} with what looks like ${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}. ${player.name} is unavailable until we know more. An MRI now returns results in an hour or two, so any roster move can be made before midnight and the replacement reports tomorrow. Or we wait for the team physician's exam in the morning, which costs nothing, but a signing made tomorrow won't report until the day after.`,
    yesLabel: `MRI Now (${'$'}${INJURY_MRI_COST_K}K)`,
    noLabel:  'Wait for the morning exam',
    _budgetCost: INJURY_MRI_COST_K,
    // Answer by midnight (at least an hour) or the doctor waits for morning.
    expiresAtMs: Math.max(nextCalendarDay(atMs), atMs + 60 * 60_000),
    _raw: { onYes: 'injury_mri_now', onNo: 'injury_mri_wait', onAuto: 'injury_mri_wait' },
    _autoLabel: 'No answer — morning exam',
  });
  return _deliverAt(card, atMs);
}


/**
 * deliverInjuryAct2(playerId, atMs)
 * Act 2 — the diagnosis. The exam revises the Act 1 read (better / as feared
 * / worse). §122 the decision is keep or cut, with what each costs:
 *   - IL him (he stays on our payroll) and sign a replacement now — the best
 *     free agents who fit, with their price (a pickup reports the next day) —
 *     or IL him and pick the replacement ourselves;
 *   - cut him: waivers, injured; his salary leaves the payroll at once (a club
 *     may claim him), and his spot opens;
 *   - for a short timeline, day-to-day: the roster spot stays, the bench covers.
 * Due before the next roster deadline; if nobody answers, he goes on the IL and
 * the manager signs the replacement.
 */
export function deliverInjuryAct2(playerId, atMs = clockNow()) {
  let state = StateManager.get();
  const p0  = state.players[playerId];
  if (!p0 || p0.injury?.status !== 'evaluating') return null;

  // Lock in the diagnosis now (the Team screen still says "being evaluated").
  const dx = confirmDiagnosis(p0, atMs);
  if (dx.injury) StateManager.mutate(s => Object.assign(s.players[playerId], dx));
  state = StateManager.get();
  const player = state.players[playerId];
  const inj    = player.injury;
  const report = player.injuryReport;
  const v      = player._act2Variance;
  const varianceNote = v === 'better' ? 'Good news — it is less serious than it looked on the field.'
                     : v === 'worse'  ? 'The scans showed more than we hoped. The timeline is longer.'
                     : 'The scans confirm what we saw on the field.';
  const seasonEnding = inj.severity === 'season';
  const ilDays     = Math.max(inj.days, ilMinDays(player));
  const eligibleAt = inj.injuredAt + ilDays * 86_400_000;
  const picks      = rankPickups(state, 'user', _needFor(player)).slice(0, 2);
  const dtd        = dayToDayAllowed(player);
  const deadline   = vacancyDeadline(state, atMs);   // §122 a signing made by then reports in time when it can
  const salary     = player.contractSalary || 0;
  const lastYear   = Offseason.contractIsUp(player, state.seasonNum || 1);
  // Cutting is the better call when he's gone for the year and his deal ends with it.
  const cutFirst   = seasonEnding && lastYear;

  const ilLine = seasonEnding
    ? `${player.name} is out for the rest of the season.`
    : `On the ${ilMinDays(player)}-day IL (backdated to the injury), ${player.name} is eligible to return ${_day(eligibleAt, atMs)}.`;
  const moneyLine = ` On the IL ${player.name} stays on our payroll (${formatK(salary)} a year), and a replacement is paid on top of that. `
    + `Cut ${player.name} instead and the salary comes off at once: ${player.name} goes on waivers, where a club may make a claim${seasonEnding ? '' : ' and wait out the injury'}.`;
  const dtdLine = dtd
    ? ` Or we manage it day-to-day: the roster spot stays put and ${player.name} should be available in about ${inj.days} days, but we play a player short until then.`
    : '';
  const fitLine = picks.length
    ? ` Best fits among the free agents: ${_list(picks.map(p => `${p.name}${_hand(p)} (${posLabel(p)}, OVR ${p.ovr}, ${formatK(signingTerms(state, p).salary || 0)} a year)`))}. A signing reports tomorrow.`
    : ' No healthy free agent fits right now.';
  const dlLine = deadline
    ? ` We need a decision by ${_clock(deadline)} (${_day(deadline, atMs)}) or ${_managerName(state)} will put ${player.name} on the IL and sign someone.`
    : '';

  const ilChoices = [
    ...picks.map(p => ({ key: `il:${p.id}`, label: `IL ${player.name} — sign ${p.name}`,
      sub: `${posLabel(p)}, OVR ${p.ovr}, ${formatK(signingTerms(state, p).salary || 0)} a year; ${player.name} stays paid` })),
    { key: 'il', label: `IL ${player.name} — I'll pick the replacement`, sub: `${player.name} stays on the payroll; the open spot waits for your pick` },
  ];
  const cutChoice = { key: 'cut', label: `Cut ${player.name}`,
    sub: `Waivers, injured: ${formatK(salary)} a year comes off at once; the spot opens` };

  const card = _rosterCard(state, {
    cardId:   'injury_act2',
    tag:      'INJURY',
    sender:   'Team Physician',
    _rosterKey: `injury:${playerId}:act2`,
    _targetPlayerId:  playerId,
    _choices: cutFirst ? [cutChoice, ...ilChoices] : [...ilChoices, cutChoice],
    subject:  seasonEnding
      ? `${player.name} — ${(inj.label || 'injury').toLowerCase()}, out for the season`
      : `${player.name} — ${(inj.label || 'injury').toLowerCase()}, about ${inj.days} days`,
    preview:  `${varianceNote} ${seasonEnding ? 'Season-ending.' : `About ${inj.days} days.`} IL or cut?`,
    body:     `${report?.detailedText || ''} ${varianceNote} ${ilLine}${moneyLine}${dtdLine}${fitLine}${dlLine}`.replace(/\s+/g, ' ').trim(),
    yesLabel: 'Decide',
    noLabel:  dtd ? 'Day-to-day — keep the roster spot' : null,
    expiresAtMs: deadline,
    _raw: {
      onYes:  'injury_decide',
      onNo:   dtd ? 'day_to_day' : null,
      onAuto: 'injury_auto',
    },
    _autoLabel: `No decision — placed on IL, ${_managerName(state)} signed a replacement`,
  });

  const delivered = _deliverAt(card, atMs);
  if (delivered && (seasonEnding || ilDays > 14)) {
    StateManager.mutate(s => {
      s.history = [...(s.history || []), {
        id:       _uuid(),
        type:     'injury',
        season:   s.seasonNum || 1,
        gameIdx:  s.currentGameIndex || 0,
        headline: seasonEnding ? `${player.name} — season-ending injury` : `${player.name} — ${ilDays}-day IL stint`,
        detail:   `${player.name} (${player.pos}). ${report?.detailedText || ''}`,
        playerId,
        icon:     '🩹',
        userNote: '',
      }];
    });
  }
  return delivered;
}


/** When Act 2 arrives, given when Act 1 was answered and how. */
export function _act2Time(state, decidedAtMs, mriNow) {
  if (mriNow) return decidedAtMs + _randBetween(INJURY_MRI_RESULT_MIN_MS, INJURY_MRI_RESULT_MAX_MS);
  const d = new Date(decidedAtMs);
  if (d.getHours() >= INJURY_MORNING_EXAM_HOUR) d.setDate(d.getDate() + 1);
  d.setHours(INJURY_MORNING_EXAM_HOUR, 0, 0, 0);
  let t = d.getTime() + _randBetween(0, 90) * 60_000;
  // Always in hand at least 30 minutes before the roster deadline.
  const dl = decisionDeadlineAfter(state, decidedAtMs);
  if (dl && t > dl - 30 * 60_000) t = Math.max(decidedAtMs + 15 * 60_000, dl - 30 * 60_000);
  return t;
}


const _SLOT_WORDS = { C: 'catcher', '1B': 'first base', '2B': 'second base', '3B': 'third base', SS: 'shortstop', OF: 'the outfield', DH: 'designated hitter' };

const _slotWords = (slot) => _SLOT_WORDS[slot] || slot;

// "back {where}" and "{who} {played}"
const _SLOT_WHERE  = { C: 'behind the plate', '1B': 'at first base', '2B': 'at second base', '3B': 'at third base', SS: 'at shortstop', OF: 'in the outfield', DH: 'at DH' };

const _SLOT_PLAYED = { C: 'has caught', OF: 'has played the outfield', DH: 'has been the DH' };

export const _slotWhere  = (slot) => _SLOT_WHERE[slot] || `at ${slot}`;

export const _slotPlayed = (slot) => _SLOT_PLAYED[slot] || `has played ${_slotWords(slot)}`;


/** §113 who has the returning player's spot now: the lineup slot he lost, or the rotation's weakest turn. */
export function _whoHasSpot(state, player) {
  const u = state.userTeam, lost = player?._lostSlot;
  if (!lost) return null;
  if (lost.kind === 'lineup') {
    const i = (u.lineupSlots || []).findIndex(sl => sl.slot === lost.slot && sl.playerId && sl.playerId !== player.id);
    const p = i >= 0 ? state.players[u.lineupSlots[i].playerId] : null;
    return p ? { kind: 'lineup', slot: lost.slot, index: i, player: p } : null;
  }
  if (lost.kind === 'bullpen') {
    if (player.group === PLAYER_GROUP.BULLPEN) return null;
    const pen = (u.rosterIds || []).map(id => state.players[id]).filter(p => p && p.group === PLAYER_GROUP.BULLPEN && isAvailable(p));
    const weakest = pen.sort((a, b) => reliefValue(a) - reliefValue(b))[0];
    return weakest ? { kind: 'bullpen', player: weakest } : null;
  }
  const order = u.rotation?.order || [];
  if (order.includes(player.id)) return null;
  const weakest = order.map(id => state.players[id]).filter(Boolean).sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0];
  return weakest ? { kind: 'rotation', index: order.indexOf(weakest.id), player: weakest } : null;
}


/** §113 put the returning player in `spot` (from _whoHasSpot); whoever had it goes to the bench. */
export function _restoreSpot(s, player, spot) {
  const u = s.userTeam;
  if (spot.kind === 'lineup') {
    const sl = (u.lineupSlots || [])[spot.index];
    if (!sl || sl.slot !== spot.slot) return false;
    for (const x of u.lineupSlots) if (x.playerId === player.id) { x.playerId = null; }
    sl.playerId = player.id; sl.emergency = false;
    player.group = PLAYER_GROUP.BENCH_HITTERS;   // (lineupSlots is the source of truth for who starts)
  } else if (spot.kind === 'bullpen') {
    if (s.players[spot.player.id]?.teamId === 'user') s.players[spot.player.id].group = PLAYER_GROUP.PITCHER_BENCH;
    player.group = PLAYER_GROUP.BULLPEN;
  } else {
    const order = [...(u.rotation?.order || [])];
    const i = order.indexOf(spot.player.id);
    if (order.includes(player.id)) return true;
    if (i >= 0) order[i] = player.id;
    else if (order.length < 5) order.splice(Math.min(spot.index ?? order.length, order.length), 0, player.id);   // (the fill-in already left)
    else return false;
    u.rotation = { ...(u.rotation || {}), order };
    player.group = PLAYER_GROUP.STARTING_PITCHERS;
    if (s.players[spot.player.id]?.teamId === 'user') s.players[spot.player.id].group = PLAYER_GROUP.PITCHER_BENCH;
  }
  player._lostSlot = null;
  return true;
}


/**
 * IL return decision — delivered the moment the player is cleared (Team
 * Physician). §114 with a full roster on the player's side, someone has to go
 * on waivers first (§122): the card offers our three lowest-rated reserves on
 * that side (never a starter, a rotation arm or a bullpen arm), the lowest
 * recommended. §122 it has a deadline — the next roster deadline; unanswered,
 * the manager waives the recommended one and activates the player. The other
 * choice: the returning player goes on waivers.
 */
function _deliverILReturnCard(playerId, atMs) {
  const state  = StateManager.get();
  const player = state.players[playerId];
  if (!player || !(state.ilReturnQueue || []).includes(playerId)) return null;
  const full     = rosterIsFull(state, 'user', sideOf(player));   // his side's spots (§76)
  const deadline = decisionDeadlineAfter(state, atMs);
  const ref      = `${player.name}${_hand(player)} (${player.pos})`;
  const spot     = _whoHasSpot(state, player);
  const choices  = full ? _sendDownChoices(state, player) : [];
  const where    = (c) => `${c.name} (${posLabel(c)}, OVR ${c.ovr})`;
  const what     = !spot ? null : spot.kind === 'lineup' ? _slotWhere(spot.slot) : spot.kind === 'bullpen' ? 'in the bullpen' : 'a spot in the rotation';
  const reserve  = sideOf(player) === 'pitcher' ? 'the pitcher bench' : 'the bench';
  const stuck    = full && !choices.length;   // (nobody who could go down: rare — the card waits)

  const card = _rosterCard(state, {
    cardId:   'il_return',
    tag:      'IL_RETURN',
    sender:   'Team Physician',
    _rosterKey: `ilreturn:${playerId}`,
    _targetPlayerId: playerId,
    _choices: choices.length ? choices : null,
    _needsRoom: full,
    subject:  `${player.name} cleared to return`,
    preview:  full ? `${ref} is cleared. Who goes on waivers to make room?` : `${ref} has been cleared — roster decision needed.`,
    body:     `${ref} has completed the recovery and is cleared for game action.`
            + (spot ? ` While ${player.name} was out, ${where(spot.player)} ${spot.kind === 'rotation' ? `took ${what}` : `took over ${what}`}.` : '')
            + (full
                ? (_overSide(state, player)
                    ? ` We're carrying ${_overSide(state, player)} ${sideOf(player) === 'pitcher' ? 'pitchers' : 'position players'}, more than the 14 a roster carries, so ${sideOf(player) === 'pitcher' ? 'pitchers' : 'position players'} have to go on waivers before ${player.name} can be activated (one at a time; this message comes back until there's room).`
                    : ` The active roster is full, so someone has to go on waivers before ${player.name} can be activated. Whoever goes comes off the payroll at once; any club can put in a claim over the next 72 hours.`)
                  + (choices.length ? ` These are our lowest-rated ${sideOf(player) === 'pitcher' ? 'arms' : 'bats'} off ${reserve}.` : ` Nobody on ${reserve} can go right now.`)
                  + (choices.length && deadline ? ` If you haven't chosen by ${_clock(deadline)} (${_day(deadline, atMs)}), ${_managerName(state)} will waive ${choices[0].name} and activate ${player.name}.` : ` ${player.name} stays on the injured list until you choose.`)
                : ' There is room on the active roster.')
            + ` ${player.name} rejoins on ${reserve}; ${sideOf(player) === 'pitcher'
                ? `a return to ${player.pos === 'SP' ? 'the rotation' : 'the bullpen'} is your call.`
                : 'a return to the lineup is your call.'}`,
    yesLabel: choices.length ? choices[0].label : stuck ? 'Understood' : `Activate ${player.name}`,
    noLabel:  `Place ${player.name} on waivers`,
    type:     'urgent',
    expiresAtMs: choices.length ? deadline : null,
    _raw: { onYes: stuck ? 'il_return_wait' : 'il_return_activate', onNo: 'il_return_waive', onAuto: choices.length ? 'il_return_auto' : null },
    _autoLabel: choices.length ? `No answer — ${_managerName(state)} waived ${choices[0].name}` : undefined,
  });
  return _deliverAt(card, atMs);
}


/** §114 the active players on the returning player's side, when it's past its 14 even after one goes down (else 0). */
function _overSide(state, player) {
  const side = sideOf(player);
  const n = (state.userTeam.rosterIds || []).map(id => state.players[id])
    .filter(p => p && p.group !== PLAYER_GROUP.IL && p.id !== player.id && sideOf(p) === side).length;
  return n - 1 >= (side === 'pitcher' ? PITCHER_TARGET : HITTER_TARGET) ? n : 0;
}


/**
 * §114 who could go down for a returning player: our three lowest-rated
 * reserves on that side — bench hitters for a hitter; pitcher-bench arms for a
 * pitcher — never a lineup starter, a rotation arm or a bullpen arm. The
 * lowest-rated is recommended (listed first).
 */
export function _sendDownChoices(state, player) {
  const t = state.userTeam;
  const side = sideOf(player);
  const pen = new Set((t.rosterIds || []).filter(id => state.players[id]?.group === PLAYER_GROUP.BULLPEN));
  const locked = new Set([...(t.lineupSlots || []).map(s => s.playerId).filter(Boolean), ...(t.rotation?.order || []), ...pen]);
  return (t.rosterIds || []).map(id => state.players[id])
    .filter(p => p && p.id !== player.id && p.group !== PLAYER_GROUP.IL && !p.isInjured && !locked.has(p.id) && sideOf(p) === side)
    .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))
    .slice(0, 3)
    .map(p => ({
      key: p.id, name: p.name,
      label: `Activate ${player.name} — waive ${p.name}`,
      sub: `${p.name} (${posLabel(p)}, OVR ${p.ovr})${_lineNow(p) ? `, ${_lineNow(p)}` : ''}`,
    }));
}


/** The lowest-value droppable active player (never a lineup starter or rotation arm). */
function _dropCandidate(state, exceptId) {
  const t = state.userTeam;
  const returning = state.players[exceptId];
  const samSide = (p) => ['SP', 'RP'].includes(p.pos) === ['SP', 'RP'].includes(returning?.pos);
  const locked = new Set([...(t.lineupSlots || []).map(s => s.playerId).filter(Boolean), ...(t.rotation?.order || [])]);
  const pool = (t.rosterIds || []).map(id => state.players[id]).filter(p =>
    p && p.id !== exceptId && p.group !== PLAYER_GROUP.IL && !p.isInjured && !locked.has(p.id));
  // Same side of the roster first (a returning pitcher replaces a pitcher).
  return pool.sort((a, b) => (samSide(b) - samSide(a)) || ((a.ovr || 0) - (b.ovr || 0)))[0] || null;
}


/** r153 the manager's fill in words: "Pai at SS", "Pai at SS (out of position)", "Ruiz into the rotation". */
function _spotMoves(st, moves) {
  return (moves || []).filter(m => st.players[m.playerId]).map(m => {
    const n = st.players[m.playerId].name;
    return m.slot === 'rotation' ? `${n} into the rotation` : m.slot === 'bullpen' ? `${n} into the bullpen`
      : `${n} at ${m.slot}${m.emergency ? ' (out of position)' : ''}`;
  });
}


/** r153 what the manager would do with our open spots now: the fill, as moves. */
function _managerWouldFill(st) {
  const u = st.userTeam;
  const mut = reconcileRoster(st, 'user', { fill: true });
  const after = mut.userTeam || {};
  const moves = [];
  (after.lineupSlots || []).forEach((sl, i) => { if (sl.playerId && sl.playerId !== u.lineupSlots?.[i]?.playerId) moves.push({ playerId: sl.playerId, slot: sl.slot, emergency: !!sl.emergency }); });
  const rot = new Set(u.rotation?.order || []);
  for (const id of after.rotation?.order || []) if (!rot.has(id)) moves.push({ playerId: id, slot: 'rotation' });
  for (const [id, upd] of Object.entries(mut.players || {})) {
    if (upd.group === PLAYER_GROUP.BULLPEN && st.players[id]?.group !== PLAYER_GROUP.BULLPEN) moves.push({ playerId: id, slot: 'bullpen' });
  }
  return moves;
}


/**
 * r153 our open spots wait for the GM until the roster deadline (an hour
 * before first pitch), when the manager fills them. One message per game's
 * deadline, a little after a spot opens: what's open, what the manager will
 * do, and the choice to have it done now or set it in Team. Withdrawn once
 * the spots are filled (by anyone) or the deadline moves.
 */
function _deliverOpenSpotsCard(atMs) {
  const st = StateManager.get();
  const fillAt = managerFillAt(st);
  if (!Number.isFinite(fillAt)) return null;
  // The next game's spots: until its deadline (after it, the manager's turn). r239 §122.118 the GM opened them
  // after the deadline, knowingly: no word (filled at first pitch).
  const held = Number.isFinite(st.userTeam?.fillHeldFor) && fillAt === st.userTeam.fillHeldFor;
  const spots0 = managerFillsNow(st, atMs) || held ? { lineup: [], rotation: 0, bullpen: 0, any: false } : openSpots(st);
  // r243 §122.122 the pitching coach already told the GM about the open turn (and its fill): not again
  const ng = nextLineupGame(st);
  const told = !!ng && [...(st.inbox || []), ...(st.scheduledCards || [])].some(c => c._rosterKey?.startsWith(`nextsp:${ng.gameTime}:`));
  const spots = told && spots0.rotation ? { ...spots0, rotation: 0, any: spots0.lineup.length > 0 || spots0.bullpen > 0 } : spots0;
  const moves = spots.any ? _managerWouldFill(st).filter(m => !(told && m.slot === 'rotation')) : [];
  const nextOpen = moves.length ? [
    ...spots.lineup.map(x => x.emergency ? `${x.slot} (played out of position)` : x.slot),
    ...(spots.rotation ? [spots.rotation > 1 ? `${spots.rotation} rotation spots` : 'a rotation spot'] : []),
    ...(spots.bullpen ? [spots.bullpen > 1 ? `${spots.bullpen} bullpen spots` : 'a bullpen spot'] : []),
  ] : [];
  // r241 §122.120 and the lineups set ahead: a slot a roster change opened (each game, as it stands)
  const later = laterOpenSpots(st);
  if (!nextOpen.length && !later.length) return null;
  // One message per change: a new one when something opened that the last didn't say (it replaces that one).
  const sig = [...nextOpen.map(x => `next:${x}`), ...later.map(x => `${x.gameTime}:${x.slot}`)];
  const base = `openspots:${fillAt}`;
  const mine = [...(st.inbox || []), ...(st.scheduledCards || [])].filter(c => c._rosterKey === base || c._rosterKey?.startsWith(`${base}:`));
  const said = new Set(mine.flatMap(c => c._openSig || (c._rosterKey === base ? nextOpen.map(x => `next:${x}`) : [])));
  if (sig.every(x => said.has(x))) return null;
  const ids = new Set(mine.map(c => c.instanceId));
  _withdraw(c => ids.has(c.instanceId));
  const at = Math.max(atMs, Math.min(atMs + 20 * 60_000, fillAt - 10 * 60_000));
  const coming = pendingArrivals(st, 'user').map(t => st.players[t.playerId]).filter(Boolean).map(p => p.name);
  const game = nextLineupGame(st);
  const parts = [];
  if (nextOpen.length) {
    const when = game ? When.untilFull(game.gameTime, at) : 'the next game';
    parts.push(`For our game ${when}, ${_list(nextOpen)} ${nextOpen.length > 1 ? 'are' : 'is'} open. `
      + `If ${nextOpen.length > 1 ? 'they\'re' : 'it\'s'} still open at ${_clock(fillAt)}, an hour before first pitch, I'll go with ${_list(_spotMoves(st, moves))}.`);
  }
  // later: by slot, its games in order ("SS is open Tuesday at 7:05 PM and Wednesday at 1:10 PM")
  const bySlot = new Map();
  for (const x of later) bySlot.set(x.slot, [...(bySlot.get(x.slot) || []), x.gameTime]);
  const laterWords = [...bySlot].map(([slot, ts]) => `${slot} is open ${_list(ts.map(t => When.untilFull(t, at)))}`);
  if (laterWords.length) {
    parts.push(`In the lineups you set ahead, ${_list(laterWords)}. I'll fill ${later.length > 1 ? 'those' : 'that'} at each game's deadline if you don't.`);
  }
  const n = nextOpen.length + later.length;
  const subject = !later.length ? (nextOpen.length > 1 ? 'Open spots before the next game' : `${nextOpen[0][0].toUpperCase()}${nextOpen[0].slice(1)} is open`)
    : !nextOpen.length && bySlot.size === 1 ? `${[...bySlot.keys()][0]} is open in the lineups ahead`
    : 'Open spots in the lineups ahead';
  const card = _rosterCard(st, {
    cardId: 'open_spots', tag: 'LINEUP', sender: _managerName(st), avatar: '📋', type: 'normal',
    _rosterKey: `${base}:${sig.join(',')}`, _rosterKind: 'openspots', _openSig: sig,
    subject,
    preview: nextOpen.length ? `Open: ${_list(nextOpen)}. I'll fill ${nextOpen.length > 1 ? 'them' : 'it'} at ${_clock(fillAt)} if you don't.`
      : `${_list(laterWords)}.`,
    body: parts.join(' ')
        + (coming.length ? ` ${_list(coming)} ${coming.length > 1 ? 'report' : 'reports'} at midnight and ${coming.length > 1 ? 'land' : 'lands'} on the bench, so you could wait for that and move them in yourself.` : '')
        + ` Or set it however you like in Team.`,
    yesLabel: n > 1 ? 'Fill the Spots' : 'Fill the Spot',
    noLabel: "I'll set it in Team",
    expiresAtMs: fillAt,
    _raw: { onYes: 'openspots_fill', onNo: 'openspots_defer', onAuto: 'openspots_auto' },
    _autoLabel: nextOpen.length ? `No answer — ${_managerName(st)} filled them at the deadline` : 'No answer — left for each game\'s deadline',
  });
  return _deliverAt(card, at);
}


/**
 * Open roster spot — one card per open spot, tied to the current deadline.
 * §122 it offers the free agents who fit, best first, with their price (a
 * signing reports the next day); or the GM picks in League → Players. At the
 * deadline the manager signs the best affordable fit himself.
 */
function _deliverNeedCard(state, need, index, needs, atMs) {
  const deadline = needs.deadlineAt;
  const picks    = rankPickups(state, 'user', need).slice(0, 3);
  const what     = need.pos ? (need.side === 'pitcher' ? (need.pos === 'SP' ? 'a starting pitcher' : 'a reliever') : `a ${need.pos}`)
                            : (need.side === 'pitcher' ? 'a pitcher' : 'a position player');
  const winter   = state.phase === PHASE.OFFSEASON && !!state.offseason?.springAt;   // §122 the camp call
  const choices  = picks.map(p => {
    const t = signingTerms(state, p);
    const line = _lineNow(p) || _lastLine(p);
    return { key: p.id, label: `Sign ${p.name}`,
             sub: `${posLabel(p)}, OVR ${p.ovr}, ${formatK(t.salary || 0)} a year${line ? `; ${line}` : ''}` };
  });
  const card = _rosterCard(state, {
    cardId:   'roster_need',
    tag:      'ROSTER',
    sender:   _managerName(state),
    type:     'urgent',
    _rosterKey: `need:${deadline}:${index}`,
    _rosterKind: 'need',
    _need:    need,
    _choices: choices.length ? choices : null,
    subject:  needs.short > 1 ? `${needs.short} open roster spots` : 'Open roster spot',
    preview:  winter ? `Camp opens ${_day(state.offseason.springAt, atMs)}: we're ${needs.short} short of 28.` : `We're ${needs.short} short of 28 — I need ${what}.`,
    body:     (winter ? `Camp opens ${_day(state.offseason.springAt, atMs)}, and we have ${28 - needs.short} players under contract for it. I need ${what}.`
                      : `We're carrying ${28 - needs.short} active players. I need ${what}.`)
            + (picks.length ? ` These are the best free agents who fit, with what they're asking for a one-year deal (paid only for the days on our roster). ${winter ? 'A signing reports when camp opens.' : 'A signing reports tomorrow.'}`
                            : ' No free agent fits right now — look at the waiver wire or make a trade.')
            + ` Or pick anyone in League → Players.`
            + (deadline ? ` If nothing's done by ${_clock(deadline)} (${_day(deadline, atMs)}), I'll sign someone myself.` : ''),
    yesLabel: picks.length ? `Sign ${picks[0].name}` : 'Understood',
    noLabel:  `I'll choose in League → Players`,
    expiresAtMs: deadline,
    _raw: { onYes: picks.length ? 'need_callup' : 'need_defer', onNo: 'need_defer', onAuto: 'need_auto' },
    _autoLabel: `No decision — ${_managerName(state)} signed someone`,
  });
  return _deliverAt(card, atMs);
}


/**
 * r196 §122.73 a full roster that can't field nine for a game: who's out, and the move — the day-to-day
 * bat out longest to the IL (backdated), a free-agent bat into the spot, reporting in time for that game.
 * At the deadline the manager makes it.
 */
function _deliverBatsCard(state, deadline, atMs) {
  const needs = getRosterNeeds(state, 'user', atMs);
  const need = needs.bats?.[0], game = needs.batsGame;
  const ilP = need && state.players[need.ilFirst];
  if (!ilP || !game) return null;
  const T = game.gameTime, players = state.players;
  const out = (state.userTeam.rosterIds || []).map(id => players[id]).filter(p => p && !['SP', 'RP'].includes(p.pos) && p.group !== PLAYER_GROUP.IL);
  const dtd = out.filter(p => p.injury?.status === 'dtd' && (p.injury.returnAt ?? Infinity) > T);
  const away = out.filter(p => !p.isInjured && (p.onPersonalLeave || (p.unavailable && p.unavailable.reason !== 'rest' && !(p.unavailable.untilMs && p.unavailable.untilMs <= T))));
  const why = [dtd.length ? `${_list(dtd.map(p => p.name))} ${dtd.length > 1 ? 'are' : 'is'} day-to-day` : '',
               away.length ? `${_list(away.map(p => p.name))} ${away.length > 1 ? 'are' : 'is'} away` : ''].filter(Boolean);
  const picks = rankPickups(state, 'user', { side: 'hitter', pos: null }).slice(0, 3);
  const choices = picks.map(p => {
    const t = signingTerms(state, p), line = _lineNow(p) || _lastLine(p);
    return { key: p.id, label: `IL ${ilP.name}, Sign ${p.name}`, sub: `${posLabel(p)}, OVR ${p.ovr}, ${formatK(t.salary || 0)} a year${line ? `; ${line}` : ''}` };
  });
  const when = When.untilFull(T, atMs);
  const card = _rosterCard(state, {
    cardId: 'bats_short', tag: 'ROSTER', sender: _managerName(state), avatar: '📋', type: 'urgent',
    _rosterKey: `bats:${deadline}`, _targetPlayerId: ilP.id, _choices: choices.length ? choices : null,
    subject: `We can't field nine ${when}`,
    preview: `${_list(why)}. ${ilP.name} to the IL and a signing would fix it.`,
    body: `For our game ${when}, only ${9 - needs.batsShort} of our hitters can play: ${_list(why)}. `
        + `Putting ${_who(ilP)} on the IL (backdated) opens a spot, and a bat signed before ${_clock(deadline)} reports in time for that game. `
        + (picks.length ? 'These are the best free agents for it, on one-year deals (paid only for the days on our roster).' : 'No free agent we can afford fits right now; look at the waiver wire.')
        + ` If nothing's done by ${_clock(deadline)} (${_day(deadline, atMs)}), I'll make the move myself.`,
    yesLabel: picks.length ? `IL ${ilP.name}, Sign ${picks[0].name}` : 'Understood',
    noLabel: "I'll handle it in Team",
    expiresAtMs: deadline,
    _raw: { onYes: picks.length ? 'bats_fix' : 'need_defer', onNo: 'need_defer', onAuto: 'need_auto' },
    _autoLabel: `No decision — ${_managerName(state)} made the move`,
  });
  return _deliverAt(card, atMs);
}


/** §122.9 last season's line in a few words (a free agent with no games this year). */
function _lastLine(p) {
  const e = (p?.seasonLog || []).filter(x => x?.stats).at(-1);
  if (!e) return p?.origin === 'overseas' ? 'played overseas' : p?.origin === 'independent' ? 'independent ball' : p?.origin === 'rookie' ? 'rookie' : null;
  const s = e.stats;
  if (['SP', 'RP'].includes(p.pos)) return s.ip >= 5 ? `${e.year}: ${(9 * (s.er || 0) / s.ip).toFixed(2)} ERA in ${Math.round(s.ip)} innings` : null;
  if (!(s.ab >= 20)) return null;
  return `${e.year}: ${_f3((s.h || 0) / s.ab)}, ${s.hr || 0} HR in ${s.ab} AB`;
}


/** What the manager's signings cost (one-year deals). */
function _mfillTerms(st, ids) {
  const parts = ids.map(id => st.players[id]).filter(Boolean).map(p => `${formatK(p.contractSalary || signingTerms(st, p).salary || 0)}`);
  return parts.length === 1 ? ` (${parts[0]} for the year, paid only for the days on our roster)` : parts.length ? ` (one-year deals: ${_list(parts)})` : '';
}


/** One-button notice (manager's signing, voided trade). */
export function _deliverNotice(key, fields, atMs) {
  const state = StateManager.get();
  if (_cardsWithKey(state, key).length) return null;
  const card = _rosterCard(state, {
    tag: 'ROSTER', type: 'normal', noLabel: null, yesLabel: 'Understood',
    autoResolve: 'skip', expiresAtMs: atMs + 24 * 3600_000,
    _rosterKey: key, _raw: {},
    ...fields,
  });
  return _deliverAt(card, atMs);
}


/**
 * _ourNews(text, atMs) — r135 news about our club that needs no answer goes
 * to the Recent feed, not Messages (every message is a decision, or a
 * consequence the GM must know about — §117).
 */
export function _ourNews(text, atMs) {
  StateManager.mutate(s => {
    s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), buildActivityFeedEntry('ours', s.userTeam.abbr, text, Math.min(atMs, clockNow()))]);
  });
}


/**
 * The open-spot deadline passed and the manager signed free agents (§65,
 * §122), at a cost with ownership. r135 the signings don't report until
 * midnight, so the GM can keep them or release them and pick — the spot opens
 * again with a new deadline and the usual open-spot card. The ownership hit
 * stands either way. Nobody to sign ("playing short"): the consequence alone.
 */
function _deliverManagerFillCard(ev) {
  const st = StateManager.get();
  const ids   = (ev.playerIds || []).filter(id => st.players[id]);
  const names = ids.map(id => st.players[id].name);
  const mgr   = _managerName(st);
  const cost  = `Ownership noticed (Owner Trust ${ev.penalty?.ownerTrust ?? -2}, Atmosphere ${ev.penalty?.atmosphere ?? -1}).`;
  // r196 §122.73 we couldn't field nine: the manager put a day-to-day bat on the IL and signed one.
  if (ev.ilIds?.length) {
    const il = _list(ev.ilIds.map(id => st.players[id]?.name).filter(Boolean));
    return _deliverNotice(`managerfill:bats:${ev.atMs}`, {
      cardId: 'manager_fill_bats', sender: mgr, type: 'urgent',
      subject: names.length ? `I signed ${_list(names)}` : `${il} to the IL`,
      preview: `We couldn't field nine for the next game, so I made the move.`,
      body: `Nobody made a move before the deadline, and we couldn't field nine for the next game. I put ${il} on the IL (backdated)`
          + (names.length ? ` and signed ${_list(names)}${_mfillTerms(st, ids)}, reporting at midnight. ${cost}` : '.'),
    }, ev.atMs);
  }
  if (!ids.length) {
    return _deliverNotice(`managerfill:${ev.atMs}`, {
      sender: mgr, type: 'urgent',
      subject: 'We are playing short',
      preview: 'Nobody made a move on the open roster spot before the deadline.',
      body:    `Nobody made a move on the open roster spot before the deadline, and no free agent we can afford fits it. We'll play short until something changes — a free agent, the waiver wire or a trade. ${cost}`,
    }, ev.atMs);
  }
  const key = `managerfill:${ev.atMs}`;
  if (_cardsWithKey(st, key).length) return null;
  const reportAt = Math.min(...ids.map(id => (st.transactions || []).find(t => t.status === 'pending' && t.kind === 'arrival' && t.playerId === id)?.effectiveAt ?? nextCalendarDay(ev.atMs)));
  const them  = _list(names);
  const one   = ids.length === 1;
  const card = _rosterCard(st, {
    cardId:   'manager_fill',
    tag:      'ROSTER',
    sender:   mgr,
    type:     'urgent',
    _rosterKey: key,
    _fillIds: ids,
    subject:  `I signed ${them}`,
    preview:  'No move was made before the deadline, so I made it.',
    body:     `Nobody made a move on the open roster spot before the deadline, so I signed ${them}${_mfillTerms(st, ids)}. ${cost} `
            + `${one ? `${names[0]} reports` : 'They report'} at midnight. If you'd rather pick, I can release ${one ? names[0] : 'them'} before then (nothing owed before reporting) — the spot opens again, and you'll get the call to make before our next game.`,
    yesLabel: `Keep ${one ? names[0] : 'them'}`,
    noLabel:  `Release ${one ? names[0] : 'them'} — I'll pick`,
    expiresAtMs: reportAt,
    _raw: { onYes: 'mfill_keep', onNo: 'mfill_sendback', onAuto: 'mfill_keep' },
    _autoLabel: `No answer — ${them} reported`,
  });
  return _deliverAt(card, ev.atMs);
}


/**
 * syncRosterCards(events, atMs)
 * Brings the inbox in line with the roster, after every roster-clock step.
 *   - delivers cards for new situations (injuries, clearances, open spots,
 *     the manager's moves, voided trades);
 *   - withdraws every unresolved card whose situation is gone (§65 — no
 *     ghost messages, whichever screen the GM acted on).
 * @returns {{ delivered: Number, withdrawn: Number }}
 */
export function syncRosterCards(events = [], atMs = clockNow()) {
  // r139 §121 the roster clock runs this at the moment of each change (GameEngine._rosterStep),
  // so its draws are named for that moment.
  return withDice(dice(diceSeed(StateManager.get()), 'roster', atMs), () => _syncRosterCards(events, atMs));
}

function _syncRosterCards(events, atMs) {
  syncWinterOffers(atMs);   // §122.60
  // r241 §122.120 a roster change reaches the lineups set ahead: a player who can't play in a game leaves that slot open
  if ((StateManager.get().schedule || []).some(g => g.lineupPlan)) StateManager.mutate(s => { sweepLineupPlans(s); });
  let delivered = 0;
  const seed = diceSeed(StateManager.get());
  for (const ev of events) {
    // r139 §121 each event's draws are its own, whenever and in whatever batch it's handled.
    delivered += withDice(dice(seed, 'roster-ev', ev.type, ev.teamId ?? '', ev.playerId ?? '', ev.atMs ?? '', ev.tx?.id ?? ''), () => _rosterEventCards(ev, atMs));
  }
  return _rosterConditionCards(delivered, atMs);
}


function _rosterEventCards(ev, atMs) {
  let delivered = 0;
  {
    if (ev.type === 'INJURY' && ev.teamId === 'user') {
      if (deliverInjuryAct1(ev.playerId, (ev.atMs ?? atMs) + _randBetween(5, 20) * 60_000)) delivered++;
    } else if (ev.type === 'MANAGER_FILL') {
      if (_deliverManagerFillCard(ev)) delivered++;
    } else if (ev.type === 'MANAGER_LINEUP') {
      // r153 news, not a message (§117): the manager filled the spots the GM left open.
      const st = StateManager.get();
      _ourNews(`${_managerName(st)} filled our open spots at the roster deadline: ${_list(_spotMoves(st, ev.moves))}`, ev.atMs ?? atMs);
    } else if (ev.type === 'WAIVER_CLAIMED' && ev.userClaimed) {
      // §73: how our waiver claim came out.
      const st = StateManager.get();
      const p = st.players[ev.playerId];
      const won = ev.teamId === 'user';
      const winner = won ? null : (st.leagueTeams || []).find(t => t.id === ev.teamId)?.name;
      // §122.66 lost: the next-best fit is a decision (claim, sign, or keep watching), when there is one.
      if (p && !won && _claimLostCard(st, p, winner, ev.atMs ?? atMs)) delivered++;
      else if (p && _deliverNotice(`claim:${ev.playerId}:${ev.atMs}`, {
        cardId: won ? 'claim_won' : 'claim_lost', tag: 'ROSTER',
        sender: 'Player Dev.', avatar: '📋', type: won ? 'good' : 'normal',
        subject: won ? `Claim awarded: ${p.name}` : `Claim lost: ${p.name}`,
        preview: won ? `${_who(p)} is ours — reporting tomorrow.` : `${winner || 'Another club'} was ahead of us in the claiming order.`,
        body: won ? `Our claim on ${_who(p)} came through. ${p.name} reports tomorrow.`
                  : `${winner || 'Another club'} had priority in the claiming order (worse record) and claimed ${_who(p)}.`,
      }, ev.atMs ?? atMs)) delivered++;
    } else if (ev.type === 'WAIVER_CLEARED' && ev.userClaimed) {
      // (cannot happen: a user claim always makes the user a claimant)
    } else if (ev.type === 'DEV_DONE' && ev.teamId === 'user') {
      if (_deliverDevelopmentReport(ev, ev.atMs ?? atMs)) delivered++;
    } else if (ev.type === 'SIM_DONE') {
      if (_deliverSimReport(ev, ev.atMs ?? atMs)) delivered++;
    } else if (ev.type === 'TEACH_DONE') {
      if (_deliverTeachReport(ev, ev.atMs ?? atMs)) delivered++;
    } else if (ev.type === 'ROLE_GAINED' && ev.teamId === 'user') {
      // r167 §122.35 a pitcher earns a designation: the news
      const p = StateManager.get().players[ev.playerId];
      if (p) _ourNews(`${p.name} is now ${posLabel(p)}: ${ev.role === 'RP' ? 'five relief outings' : 'three starts'} this season`, ev.atMs ?? atMs);
    } else if (ev.type === 'POS_GAINED' && ev.teamId === 'user') {
      // r164 §122.35 ten starts there: the news (Recent — no answer needed)
      const p = StateManager.get().players[ev.playerId];
      if (p) _ourNews(`${p.name} is now eligible at ${ev.pos}: ten starts there this season`, ev.atMs ?? atMs);
    } else if (ev.type === 'TRADE_EXECUTED' && ev.tx?.league) {
      delivered += _leagueTradeCards(ev.tx, ev.atMs ?? atMs);
    } else if (ev.type === 'TRADE_VOIDED' && !ev.tx?.league) {
      const st = StateManager.get();
      const team = (st.leagueTeams || []).find(t => t.id === ev.tx?.fromTeamId);
      if (_deliverNotice(`tradevoid:${ev.tx?.id}`, {
        sender:  team?.name || 'League Office',
        subject: 'Trade called off',
        preview: `The deal with ${team?.name || 'the other club'} did not go through.`,
        body:    `The trade with ${team?.name || 'the other club'} was voided before it could be finalized: ${ev.reason}. Nobody changes teams.`,
      }, ev.tx?.effectiveAt ?? atMs)) delivered++;
    }
  }

  return delivered;
}


function _rosterConditionCards(delivered, atMs) {
  _scoutFindsGone(atMs);
  delivered += _faWatchSweep(atMs);   // r204 §122.82
  let state = StateManager.get();

  // IL clearances → decision cards (at the moment of clearance).
  for (const id of state.ilReturnQueue || []) {
    if ((state.players[id]?._ilAskAfter || 0) > atMs) continue;
    const at = state.players[id]?.injury?.eligibleAt;
    if (_deliverILReturnCard(id, Number.isFinite(at) ? Math.min(at, atMs) : atMs)) delivered++;
  }

  // §113 back from an injury but not back in the lineup → the staff asks.
  delivered += _lineupNudges(atMs);

  // r160 §122.32 a regular wearing down → one of the staff asks about a day off.
  delivered += _restWatch(atMs);

  // r162 §122.34 a better player sitting, or a prospect who should play → the staff says so.
  delivered += _adviceWatch(atMs);

  // r164 §122.35 the Bench Coach on positions in reach and at risk, late in the season.
  delivered += _positionNotes(atMs);

  // r153 open spots waiting for the GM → the manager says what happens at the deadline.
  if (_deliverOpenSpotsCard(atMs)) delivered++;

  // Open roster spots → one card per spot, keyed to the current deadline.
  state = StateManager.get();
  const needs = getRosterNeeds(state, 'user');
  const liveNeedKeys = new Set();
  if (needs.applies && needs.short > 0 && needs.deadlineAt) {
    needs.needs.forEach((need, i) => {
      const key = `need:${needs.deadlineAt}:${i}`;
      liveNeedKeys.add(key);
      if (!_cardsWithKey(state, key).length && _deliverNeedCard(state, need, i, needs, atMs)) delivered++;
      state = StateManager.get();
    });
  }

  // r196 §122.73 a game we can't field nine for: one message, keyed to its deadline.
  state = StateManager.get();
  const bdl = state.userTeam?.batsDeadlineAt;
  if (Number.isFinite(bdl) && bdl > atMs && !_cardsWithKey(state, `bats:${bdl}`).length && _deliverBatsCard(state, bdl, atMs)) delivered++;

  // §89: an answer to our offer, decided when we sent it, that can no longer
  // be carried out (a player in it got hurt or moved, the window closed) is
  // replaced by their call that the deal is off — at the time the answer
  // would have reached us.
  state = StateManager.get();
  for (const c of [...(state.inbox || []).filter(x => !x.resolved), ...(state.scheduledCards || [])]) {
    if (!['talk_accepted', 'talk_counter'].includes(c.cardId) || !c._talkTeamId) continue;
    const talk = Negotiation.talkWith(state, c._talkTeamId);
    if (!talk || talk.id !== c._talkId || talk.round !== c._talkRound) continue;
    const offer = c.cardId === 'talk_counter' ? talk.counter : talk.offer;
    const reason = offer && tradeBlockers(offer, state, atMs, c._talkTeamId);
    if (!reason) continue;
    const name = (state.leagueTeams || []).find(t => t.id === c._talkTeamId)?.name || 'They';
    const when = Math.max(atMs, c.deliverAtMs || 0);
    _withdraw(x => x.instanceId === c.instanceId);
    Negotiation.callOff(c._talkTeamId, atMs);
    if (_deliverNotice(`talk:off:${talk.id}:${talk.round}`, {
      cardId: 'trade_off', tag: 'TRADE', sender: 'Scouting', avatar: '📞',
      subject: `The deal with ${name} is off`,
      preview: `Things changed before it could be done: ${reason}.`,
      body: `${name} called: ${c.cardId === 'talk_counter' ? 'they had a counter ready' : 'they were ready to do the deal'}, but things changed before it could be done — ${reason}. The talks are closed for now; we can start over with a new offer.`,
    }, when)) delivered++;
    state = StateManager.get();
  }

  // Withdraw cards whose situation no longer exists.
  state = StateManager.get();
  const players = state.players;
  const queue   = new Set(state.ilReturnQueue || []);
  const withdrawn = _withdraw(c => {
    const key = c._rosterKey || '';
    if (key.startsWith('injury:')) {
      const p = players[c._targetPlayerId];
      return !p || !(state.userTeam.rosterIds || []).includes(p.id) || p.injury?.status !== 'evaluating';
    }
    if (key.startsWith('ilreturn:')) return !queue.has(c._targetPlayerId);
    if (key.startsWith('lineup:')) {   // §113 back in the spot, hurt again, gone, or the GM already decided
      const p = players[c._targetPlayerId], u = state.userTeam;
      const seatedNow = (u.lineupSlots || []).some(sl => sl.playerId === p?.id) || (u.rotation?.order || []).includes(p?.id)
        || (p?._lostSlot?.kind === 'bullpen' && p.group === PLAYER_GROUP.BULLPEN);
      return !p || p.teamId !== 'user' || !p._lostSlot || seatedNow || !isAvailable(p) || !_whoHasSpot(state, p);
    }
    if (key.startsWith('advice:')) {   // r162 the suggestion no longer stands (the GM made the move, or things changed)
      const own = key.slice('advice:'.length);
      return !adviceFor(state, _adviceHeld(state, atMs, own)).some(a => a.key === own);
    }
    if (key.startsWith('rest:')) {   // r160 out of the lineup already (the GM moved them), hurt, away, gone, or the game is past
      const p = players[c._targetPlayerId];
      const gone = !p || p.teamId !== 'user' || !isAvailable(p);
      const out = c._restArm === 'starter' ? _nextStarter(state.userTeam, players, c._restGame?.gameTime) !== p?.id   // (no longer his turn)
        : c._restArm === 'reliever' ? p?.group !== PLAYER_GROUP.BULLPEN
        : !(state.userTeam.lineupSlots || []).some(sl => sl.playerId === p?.id);
      return gone || out
        || !(state.schedule || []).some(g => g.index === c._restGame?.index && g.gameTime === c._restGame?.gameTime && !g._committed && !g.cancelled);
    }
    if (c._rosterKind === 'need')    return !liveNeedKeys.has(key);
    if (key.startsWith('bats:'))     return key !== `bats:${state.userTeam?.batsDeadlineAt}`;   // r196 fixed, or the deadline moved
    // r243 §122.122 the next-starter message: the game started, or the pitcher is back in the rotation
    if (key.startsWith('nextsp:')) {
      const gt = c._nextspGame;
      const g = (state.schedule || []).find(x => x.gameTime === gt);
      return !g || g._committed || !!g.liveLineups || (state.userTeam.rotation?.order || []).includes(c._targetPlayerId);
    }
    // r241 §122.120 (the next game's spots, and the lineups set ahead)
    if (key.startsWith('openspots:')) {
      const base = `openspots:${managerFillAt(state)}`;
      return !(key === base || key.startsWith(`${base}:`)) || (!openSpots(state).any && !laterOpenSpots(state).length);
    }
    // §70: a free agent who signed elsewhere (or left); a re-sign card for a
    // player no longer ours (retired, traded).
    if (key.startsWith('os:fa:'))     return players[c._targetPlayerId]?.group !== PLAYER_GROUP.FREE_AGENT;
    if (key.startsWith('os:resign:')) return players[c._targetPlayerId]?.teamId !== 'user';
    // §71: a card about one of our players that can no longer apply (he left,
    // got hurt, or is already away) is withdrawn rather than left as a ghost.
    if ((!key || key.startsWith('followup:') || key.startsWith('indie:') || key.startsWith('tip:')) && CARD_ACTIONS[c._raw?.onYes]) return !cardFeasible(state, c);
    if (c._tradeOffer)               return !_tradeStillValid(state, c, atMs);
    // r150 the director's counter to a deal that's no longer waiting on us (taken, passed, ran out, called off).
    if (c._adviceDeal && !dealByKey(state, c._adviceDeal, atMs)) return true;
    // §90 a package Pro Scouting put together that can no longer be offered
    // (a player in it moved or got hurt, the window closed, the club cooled off).
    if (c._ideaOffer && c._ideaTeamId) return !!(tradeBlockers(c._ideaOffer, state, Math.max(atMs, c.deliverAtMs || 0), c._ideaTeamId)
                                                  || Negotiation.ourSideBlocker(state, c._ideaOffer));
    return false;
  });

  return { delivered, withdrawn };
}


/** §91 the offer can still be made: the window, every player where the deal needs him (roster or farm), healthy, settled. */
function _tradeStillValid(state, card, atMs = clockNow()) {
  const team = (state.leagueTeams || []).find(t => t.id === card._proposingTeamId);
  return !!team && !tradeBlockers(card._tradeOffer || {}, state, Math.max(atMs, card.deliverAtMs || 0), card._proposingTeamId);
}


/**
 * expireDueRosterCards(atMs)
 * Expires every unresolved roster card (inbox or not yet released) whose
 * deadline is at or before `atMs`, oldest deadline first, each at its own
 * deadline moment.
 * @returns {Number} count expired
 */
export function expireDueRosterCards(atMs) {
  const state = StateManager.get();
  const due = [...(state.inbox || []).filter(c => !c.resolved), ...(state.scheduledCards || [])]
    // Roster cards, pre-game cards (§74 — their question is moot at first pitch), and the
    // weather's questions (§104.2 — answered by first pitch or not at all; on the game clock,
    // not the wall clock, so an unanswered one never outlives its game).
    // (r217/r218: a card with a deadline of its own — an invitation for a time, the winter's, a situation's — on its clock too)
    .filter(c => (c.autoResolve === 'roster' || c._pool === 'PREGAME_POOL' || c._pool === 'INGAME_POOL' || c.tag === 'WEATHER' || c._emergency || c._deadlineStory || c._stretchStory
                  || c._winterCard || c._situation || c._callback || c._arc || c._raw?._expiresAfterMs)
                 && Number.isFinite(c.expiresAtMs) && c.expiresAtMs <= atMs)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  // r139 §121 what an unanswered card's deadline sets off draws from its own stream.
  const seed = diceSeed(state);
  for (const c of due) withDice(dice(seed, 'expire', c.instanceId, c.expiresAtMs), () => expire(c.instanceId, c.expiresAtMs));
  return due.length;
}
