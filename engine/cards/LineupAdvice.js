/**
 * engine/cards/LineupAdvice.js
 * CardEngine, the staff on the lineup: back from injury (§113), nudges, roster advice, the next starter, rest.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { PHASE, REST_WATCH, ROSTER_ADVICE, PLAYER_GROUP, ROSTER_LIMITS, GAME_STATUS } from '../../data/constants.js';
import * as When from '../When.js';
import * as Development from '../DevelopmentEngine.js';
import { adviceFor, adviceStamp } from '../RosterAdvice.js';
import { baseballYear, computeAge, isAvailable } from '../PlayerFactory.js';
import { starterRested } from '../PitchingEngine.js';
import { dice, diceSeed, eventRand, withDice } from '../Dice.js';
import { canPlay, stretchOf, pitchRoles } from '../Positions.js';
import { _cardsWithKey, _deliverAt, _randBetween, _rosterCard } from './Delivery.js';
import { _benchCoach } from './OffseasonCards.js';
import { _deliverNotice, _managerName, _slotPlayed, _slotWhere, _whoHasSpot } from './RosterCards.js';
import { withHistory } from '../MessageHistory.js';   // r292 §122.174 answered messages that dropped off

// ── §113 Back from an injury, but not back in the lineup ──────────────────

export const _f3 = (x) => x.toFixed(3).replace(/^0/, '');

/** A season line in a few words ("hitting .281/.344/.455" / "a 3.88 ERA in 64 innings"). */
export function _lineNow(p) {
  const s = p?.stats || {};
  if (['SP', 'RP'].includes(p?.pos)) return s.ip >= 5 ? `a ${(9 * (s.er || 0) / s.ip).toFixed(2)} ERA in ${Math.round(s.ip)} innings` : null;
  if (!(s.ab >= 20)) return null;
  const pa = s.ab + (s.bb || 0) + (s.hbp || 0);
  return `hitting ${_f3((s.h || 0) / s.ab)}/${_f3(((s.h || 0) + (s.bb || 0) + (s.hbp || 0)) / pa)}/${_f3((s.tb || 0) / s.ab)}`;
}


/** Our next game that hasn't started, after `t` (its first pitch is when the lineup locks). */
function _nextUserGame(state, t) {
  return (state.schedule || []).find(g => !g._committed && !g.cancelled && Number.isFinite(g.gameTime) && g.gameTime > t
    && (g.status === GAME_STATUS.SCHEDULED || g.status === GAME_STATUS.PRE_GAME_WATCH)) || null;
}


const _nudgeEpisode = (p) => p?._lostSlot?.atMs ?? p?.injury?.injuredAt ?? 0;


/**
 * The coaching staff asks about putting a player back in the spot an injury
 * took (`_lostSlot`): the hitting coach for a bat, the pitching coach for a
 * starter (the manager when the chair is empty), before our next game. Once an
 * episode: r279 §122.158 the reminder is the message's own follow-up (FollowUps).
 */
function _deliverLineupNudge(state, player, n, atMs) {
  const spot = _whoHasSpot(state, player);
  if (!spot) return null;
  const game = _nextUserGame(state, atMs + 10 * 60_000);
  if (!game) return null;
  const staff = state.userTeam.coachingStaff || {};
  const coach = staff[{ lineup: 'hittingCoach', rotation: 'pitchingCoach', bullpen: 'pitchingCoach' }[spot.kind]];
  const mgr = _managerName(state);
  const sender = !coach || coach.vacant ? mgr : coach.name;
  const X = player, Y = spot.player;
  const diff = (X.ovr || 0) - (Y.ovr || 0);
  const xLine = _lineNow(X), yLine = _lineNow(Y);
  const K = {
    lineup:   { where: _slotWhere(spot.slot), bench: 'the bench',
                ready: `${X.name} is back to full strength and took a full round of batting practice today, no restrictions. The timing's there.`,
                has: `${_slotPlayed(spot.slot)} since ${X.name} went down` },
    rotation: { where: 'in the rotation', bench: 'the pitcher bench',
                ready: `${X.name} threw a full bullpen session today and is ready to take the ball every fifth day again.`,
                has: 'is the weakest starter in the rotation' },
    bullpen:  { where: 'in the bullpen', bench: 'the pitcher bench',
                ready: `${X.name} threw a clean side session today, no restrictions, and is ready to pitch out of the pen again.`,
                has: 'is the weakest arm in the bullpen right now' },
  }[spot.kind];
  const vote = diff >= -1
    ? `My vote: ${X.name} back ${K.where}, ${Y.name} to ${K.bench}.`
    : `Honestly, ${Y.name} has earned a longer look. ${X.name} can wait on ${K.bench} until the job opens up again.`;
  const when = When.untilFull(game.gameTime, atMs);
  const card = _rosterCard(state, {
    cardId: 'lineup_return', tag: 'LINEUP', sender, avatar: spot.kind === 'lineup' ? '🏏' : '⚾', type: 'normal',
    _rosterKey: `lineup:${X.id}:${_nudgeEpisode(X)}:${n}`, _targetPlayerId: X.id, _spotKind: spot.kind, _nudge: n,
    subject: `Get ${X.name} back ${K.where}?`,
    preview: `${Y.name} ${K.has}.`,
    body: `${K.ready} ${Y.name} (OVR ${Y.ovr}${yLine ? `, ${yLine}` : ''}) ${K.has}; ${X.name} is OVR ${X.ovr}${xLine ? `, ${xLine}` : ''}.`
        + ` ${vote} Your call. ${spot.kind === 'lineup' ? `The lineup for ${when} locks at first pitch.` : `Our next game is ${when}.`}`,
    yesLabel: `Put ${X.name} back ${K.where}`,
    noLabel: `Keep ${Y.name} ${K.where}`,
    expiresAtMs: game.gameTime,
    _raw: { onYes: 'lineup_restore', onNo: 'lineup_keep', onAuto: 'lineup_auto' },
    _autoLabel: `No answer — ${Y.name} stayed ${K.where}`,
  });
  return _deliverAt(card, atMs);
}


/** Players back from an injury who haven't got their spot back, and haven't been asked twice. */
export function _lineupNudges(atMs) {
  let state = StateManager.get();
  let delivered = 0;
  const u = state.userTeam;
  const seated = new Set([...(u.lineupSlots || []).map(sl => sl.playerId).filter(Boolean), ...(u.rotation?.order || []),
                          ...(u.rosterIds || []).filter(id => state.players[id]?.group === PLAYER_GROUP.BULLPEN)]);
  const queue = new Set(state.ilReturnQueue || []);
  for (const id of u.rosterIds || []) {
    const p = state.players[id];
    if (!p?._lostSlot || seated.has(id) || queue.has(id) || !isAvailable(p) || p.group === PLAYER_GROUP.IL) continue;
    const prefix = `lineup:${id}:${_nudgeEpisode(p)}:`;
    const mine = [...withHistory(state), ...(state.scheduledCards || [])].filter(c => (c._rosterKey || '').startsWith(prefix));   // r292 §122.174 with the history
    // r279 §122.158 asked once an episode: a reminder is the message's own follow-up (FollowUps), no second ask
    if (mine.length) continue;
    // A little after the news, and well before our next first pitch.
    const g = _nextUserGame(state, atMs);
    let at = atMs + _randBetween(20, 50) * 60_000;
    if (g && at > g.gameTime - 30 * 60_000) at = Math.max(atMs, g.gameTime - 30 * 60_000);
    if (_deliverLineupNudge(state, p, 1, at)) delivered++;
    state = StateManager.get();
  }
  return delivered;
}


/**
 * r196 §122.73 when the staff looks at the roster: 4 hours after our last game (3 after the takeover,
 * before there's been one). The roster clock makes it an event of its own (GameEngine, 'staff'), so the
 * rest and roster-advice watches decide at that moment — once — and never at whenever the clock happened
 * to run next. (They decided at every look: with the app open the clock ran every few minutes, and a
 * spacing gate that opened at 6:22 let one message through that a closed app, next looking at 9:24, gave
 * to the other.)
 */
export function staffLookAt(st) {
  const u = st?.userTeam;
  return Math.max((u?._lastGameAt ?? -Infinity) + 4 * 3600_000, (u?._takeoverAt ?? -Infinity) + 3 * 3600_000);
}

/** True once per look for a watch (`key`: its state), from the look on; marks it looked. */
function _staffLooks(st, atMs, key) {
  const look = staffLookAt(st);
  if (!Number.isFinite(look) || atMs < look || (st[key]?.lookAt ?? -Infinity) >= look) return false;
  StateManager.mutate(s => { s[key] = { ...(s[key] || {}), lookAt: look }; });
  return true;
}


/**
 * r162 §122.34 the staff's roster suggestions: a better bat on the bench (the hitting coach), a better
 * arm on the pitcher bench (the pitching coach), a young player who'd grow with regular playing time
 * (the scouting director). A decision: make the change, or "I have a plan" — then quiet for that
 * pairing until something changes (ROSTER_ADVICE). Never a pile-up: one open at a time, two days
 * apart, never within half a day of a rest message (nor while one waits).
 */
export function _adviceWatch(atMs) {
  const st = StateManager.get(), u = st.userTeam;
  if (!u?.lineupSlots?.length || ![PHASE.SPRING_TRAINING, PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE, PHASE.ALL_STAR_BREAK, PHASE.POSTSEASON].includes(st.phase)) return 0;
  if (!_staffLooks(st, atMs, 'adviceWatch')) return 0;   // r196 once, at the staff's look
  const cur = st.schedule?.[st.currentGameIndex];
  if (cur && !cur._committed && Number.isFinite(cur.gameTime) && cur.gameTime <= atMs && !cur.cancelled) return 0;   // (between games)
  const W = st.adviceWatch || {};
  if (atMs - (W.lastAt ?? -Infinity) < ROSTER_ADVICE.gapMs) return 0;
  const all = [...(st.inbox || []), ...(st.scheduledCards || [])];
  if (all.some(c => (c.cardId === 'roster_advice' || c.cardId === 'rest_ask') && !c.resolved)) return 0;
  if (all.some(c => c.cardId === 'rest_ask' && Math.abs((c.deliverAtMs ?? c.arrivedAtMs ?? 0) - atMs) < 12 * 3600_000)) return 0;
  const quiet = st.adviceQuiet || {};
  const cands = adviceFor(st, _adviceHeld(st, atMs));
  if (!cands.length) return 0;
  const a = cands[0];
  // (the moment is the situation's: after the last game or the takeover, and the spacing — not when
  //  the roster clock happened to look)
  return withDice(dice(diceSeed(st), 'advice', a.key, u._lastGameAt ?? u._takeoverAt ?? 0), () => {
    const answered = all.filter(x => x.cardId === 'roster_advice' || x.cardId === 'rest_ask').map(x => x.resolvedAtMs || 0);
    const from = Math.max((u._lastGameAt ?? -Infinity) + 4 * 3600_000, (u._takeoverAt ?? -Infinity) + 3 * 3600_000,
                          (W.lastAt ?? -Infinity) + ROSTER_ADVICE.gapMs, ...answered);
    const at = Number.isFinite(from) ? from + _randBetween(20, 50) * 60_000 : atMs;
    const card = _adviceCard(st, a, at);
    StateManager.mutate(s => { s.adviceWatch = { ...(s.adviceWatch || {}), lastAt: at, asked: { ...(s.adviceWatch?.asked || {}), [a.key]: at } }; });
    return _deliverAt(card, at) ? 1 : 0;
  });
}


/**
 * r166 the suggestions on hold at `atMs`: answered "I have a plan" (and nothing's changed), or asked
 * recently (`except`: one that's on its way or waiting — it doesn't hold itself back).
 */
export function _adviceHeld(st, atMs, except = null) {
  const W = st.adviceWatch || {}, quiet = st.adviceQuiet || {};
  return (a) => {
    if (a.key === except) return false;
    const q = quiet[a.key];
    if (q && q.stamp === adviceStamp(st, a) && atMs - q.atMs < ROSTER_ADVICE.quietMs && a.gap < q.gap + ROSTER_ADVICE.quietGrow) return true;   // "I have a plan"
    const asked = W.asked?.[a.key];
    return !!(asked && atMs - asked < ROSTER_ADVICE.samePairMs);
  };
}


/** The suggestion in the sender's own words (two ways each). */
function _adviceCard(st, a, at) {
  const staff = st.userTeam.coachingStaff || {};
  const person = (role) => (staff[role] && !staff[role].vacant ? staff[role].name : null);
  const IN = st.players[a.inId], OUT = a.outId ? st.players[a.outId] : null;
  const X = IN.name, Y = OUT?.name || '';
  const v = eventRand() < 0.5 ? 0 : 1;
  const age = computeAge(IN.dob, baseballYear(st));
  const spot = a.slot === 'rotation' ? 'the rotation' : a.slot === 'bullpen' ? 'the bullpen' : a.slot === 'DH' ? 'DH' : a.slot === 'OF' ? 'the outfield' : a.slot;
  let sender, avatar, subject, preview, body, yesLabel;
  if (a.kind === 'bat') {
    sender = person('hittingCoach') || person('manager') || 'Front Office'; avatar = '🏏';
    subject = v ? `${X} should be playing` : `${X} over ${Y} at ${a.slot}?`;
    preview = `The better bat is on the bench (${IN.ovr} to ${OUT.ovr}).`;
    body = v ? `${X} is the better hitter right now, ${IN.ovr} to ${OUT.ovr}, yet sits on the bench while ${Y} plays ${spot}. I'd start ${X} there.`
             : `I've watched ${X} and ${Y} in the cage. ${X} is ahead (${IN.ovr} to ${OUT.ovr}) and it isn't close. If it were up to me, ${X} plays ${spot} and ${Y} comes off the bench.`;
    yesLabel = `Start ${X} at ${a.slot}`;
  } else if (a.kind === 'rotation' || a.kind === 'pen') {
    sender = person('pitchingCoach') || person('manager') || 'Front Office'; avatar = '⚾';
    const where = a.kind === 'rotation' ? 'the rotation' : 'the bullpen';
    subject = v ? `${X} belongs in ${where}` : `${X} for ${Y}?`;
    preview = `A better arm is on the pitcher bench (${IN.ovr} to ${OUT.ovr}).`;
    body = v ? `${X} has better stuff than ${Y} right now (${IN.ovr} to ${OUT.ovr}), yet isn't pitching. I'd put ${X} in ${where} and send ${Y} to the pitcher bench.`
             : `Watching the bullpen sessions, ${X} is the better arm (${IN.ovr} to ${OUT.ovr}). I'd swap ${X} in for ${Y} in ${where}.`;
    yesLabel = a.kind === 'rotation' ? `Put ${X} in the Rotation` : `Put ${X} in the Bullpen`;
  } else if (a.kind === 'stretch') {   // r167 §122.35 a reliever with a starter's stamina
    sender = person('pitchingCoach') || person('manager') || 'Front Office'; avatar = '⚾';
    const need = Math.max(1, 3 - stretchOf(IN));
    subject = v ? `${X} could start` : `Stretch ${X} out?`;
    preview = `The stamina is there (${IN.subRatings?.stamina ?? '—'}).`;
    body = (v ? `${X} has a starter's stamina (${IN.subRatings?.stamina ?? '—'}) and the arm to match: ${X} is as good as anyone in the back of our rotation.`
              : `I keep looking at ${X} in short stints and thinking there's more there. The stamina (${IN.subRatings?.stamina ?? '—'}) says ${X} can go longer.`)
         + ` I'd stretch ${X} out: ${need === 1 ? 'one sim game' : `${need} sim games`}, a few days apart, and then three starts makes it official.`;
    yesLabel = 'Start the Sim Games';
  } else if (a.kind === 'to_pen') {   // r167 §122.35 a starter who can't go deep
    sender = person('pitchingCoach') || person('manager') || 'Front Office'; avatar = '⚾';
    subject = v ? `${X} in the bullpen?` : `${X} isn't going deep`;
    preview = `${a.ipPerStart} innings a start, with a reliever's stuff.`;
    body = v ? `${X} is averaging ${a.ipPerStart} innings a start and the bullpen is picking up the rest. The stuff (${IN.subRatings?.stuff ?? '—'}) would play up in short bursts. I'd move ${X} to the bullpen and give the turn to someone who can go deeper.`
             : `Every fifth day we're asking the bullpen for four innings behind ${X} (${a.ipPerStart} a start). One or two innings at a time, ${X}'s stuff is a weapon. I'd make the move.`;
    yesLabel = `Move ${X} to the Bullpen`;
  } else if (a.kind === 'cover') {   // r166 §122.35 a thin spot the Bench Coach could cover by teaching
    sender = _benchCoach(st); avatar = '🧢';
    const at = { C: 'catcher', '1B': 'first', '2B': 'second', '3B': 'third', SS: 'short', OF: 'the outfield' }[a.slot] || a.slot;
    const starter = st.players[(st.userTeam.lineupSlots || []).find(sl => sl.slot === a.slot)?.playerId];
    subject = v ? `Nobody behind ${starter?.name || 'the starter'} at ${a.slot}` : `Cover for ${a.slot}`;
    preview = `If ${starter?.name || 'the starter'} goes down, nobody on the bench plays ${at}.`;
    body = (v ? `If ${starter?.name || 'our starter'} goes down, nobody on the bench plays ${at}, and whoever we put there is out of position.`
              : `We're thin at ${a.slot}: ${starter?.name || 'the starter'} and nobody behind.`)
         + ` ${X} is the one I'd teach: ${a.difficulty === 'easy' ? `it's an easy move for ${X}` : a.difficulty === 'C' ? `catching is a long road for anyone, but ${X} is the best bet we have` : `it's a step up for ${X}, but doable`}. Extra reps in practice, no time away, no cost.`;
    yesLabel = `Teach ${X} ${a.slot}`;
  } else {
    const sd = person('scoutingDirector');
    sender = sd || 'Scouting Director'; avatar = '📈';
    const reps = a.slot === 'rotation' ? 'regular starts' : 'regular at-bats';
    subject = v ? `${X} needs to play` : `Playing time for ${X}`;
    preview = `${age} years old, and ${OUT.ovr - IN.ovr <= 1 ? 'right with' : 'not far behind'} ${Y}.`;
    body = (v ? `${X} is ${age} and still growing, and the growing happens in games. ${Y} is only a little better today (${OUT.ovr} to ${IN.ovr}). With ${reps} now, ${X} should come out of the winter a better player than sitting would make ${X}.`
              : `A thought from the development side: ${X} (${age}) would get more out of this year with ${reps}${a.slot === 'rotation' ? '' : ` at ${spot}`}. ${Y} has the edge today, ${OUT.ovr} to ${IN.ovr}, but young players who sit grow slower.`);
    yesLabel = a.slot === 'rotation' ? `Put ${X} in the Rotation` : `Start ${X} at ${a.slot}`;
  }
  return _rosterCard(st, {
    cardId: 'roster_advice', tag: 'LINEUP', sender, avatar, type: 'normal',
    _rosterKey: `advice:${a.key}`, _targetPlayerId: a.inId, _playerIds: a.outId ? [a.outId] : [], _advice: a,
    subject, preview, body,
    yesLabel, noLabel: 'I Have a Plan',
    yesMsg: a.kind === 'cover' ? `I'll start with ${X} at ${a.slot} tomorrow.` : a.kind === 'stretch' ? `${X} throws the first sim game tomorrow.`
          : a.kind === 'to_pen' ? `Done. ${X} is in the bullpen, and the turn goes to the next starter.` : `Done. ${X} is in, and ${Y} ${a.slot === 'rotation' || a.slot === 'bullpen' ? 'goes to the pitcher bench' : 'comes off the bench'}.`,
    noMsg: `Understood. You have your reasons; I'll leave it unless something changes.`,
    expiresAtMs: at + ROSTER_ADVICE.expireMs,
    _raw: { onYes: 'advice_move', onNo: 'advice_quiet', onAuto: null },
    _autoLabel: 'No answer',
  });
}


/**
 * r161 who starts for us at `atMs` by the rotation — the one in turn, or the next who has had his four
 * days (the sim's rule) — skipping `skipId` (who'd take the turn if that one sat).
 */
export function _nextStarter(team, players, atMs, skipId = null) {
  const order = team?.rotation?.order || [];
  const n = order.length;
  for (let k = 0; k < n; k++) {
    const id = order[((team.rotation.currentIndex || 0) + k) % n];
    const p = players[id];
    if (id !== skipId && p && isAvailable(p) && starterRested(p, atMs)) return id;
  }
  return null;
}


/** r243 §122.122 who starts the next game as things stand (rested, in turn): an id, or null. */
export function nextStarterId(state, atMs) {
  return _nextStarter(state.userTeam, state.players || {}, atMs);
}


/**
 * r243 §122.122 the GM took the starter who was next up out of the rotation (to the pitcher bench or the bullpen):
 * the pitching coach says who starts that game now (the next rested starter in turn), and offers to fix it —
 * put that pitcher back in line, or start a rested starter from the pitcher bench in the open turn. Leaving it
 * is the GM's other answer. With nothing to offer, a notice. Withdrawn when the game starts or the pitcher is back.
 */
export function deliverNextStarterCard(benchedId, gameTime, atMs) {
  const st = StateManager.get();
  const players = st.players || {}, u = st.userTeam;
  const B = players[benchedId];
  const g = (st.schedule || []).find(x => x.gameTime === gameTime);
  if (!B || !g) return null;
  const key = `nextsp:${gameTime}:${benchedId}`;
  if (_cardsWithKey(st, key).some(c => !c.resolved)) return null;
  const staff = u.coachingStaff || {};
  const sender = (!staff.pitchingCoach?.vacant && staff.pitchingCoach?.name) || _managerName(st);
  const X = players[_nextStarter(u, players, gameTime)] || null;
  const order = u.rotation?.order || [];
  const room = order.length < ROSTER_LIMITS.STARTING_PITCHERS;
  const rested = (p) => p && isAvailable(p) && starterRested(p, gameTime);
  const choices = [];
  if (room && rested(B) && (u.rosterIds || []).includes(B.id)) choices.push({ key: 'back', label: `Put ${B.name} back in line`, sub: `${B.name} starts it, as planned` });
  if (room) {
    (u.rosterIds || []).map(id => players[id])
      .filter(p => p && p.id !== B.id && p.group === PLAYER_GROUP.PITCHER_BENCH && pitchRoles(p).includes('SP') && rested(p))
      .sort((a, b) => b.ovr - a.ovr).slice(0, 2)
      .forEach(p => choices.push({ key: `pick:${p.id}`, label: `Start ${p.name}`, sub: `From the pitcher bench, OVR ${p.ovr}: into the open turn, next up` }));
  }
  const when = When.untilFull(g.gameTime, atMs);
  const vs = `${g.isHome ? 'against' : 'at'} the ${g.opponent}`;
  const who = X ? `${X.name} is up next: ${when} ${vs}, rested and in turn.` : `Nobody left in the rotation is rested for ${when} ${vs}.`;
  const fill = room ? ' If the open turn is still open at the deadline, it gets filled, and that pitcher slots in behind.' : '';
  const orList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);
  const benchNames = choices.filter(c => c.key !== 'pick' && c.key.startsWith('pick:')).map(c => c.label.replace(/^Start /, ''));
  const fixBits = [
    ...(choices.some(c => c.key === 'back') ? [`put ${B.name} back in line`] : []),
    ...(benchNames.length ? [`start ${orList(benchNames)} from the bench`] : []),
  ];
  const fixes = fixBits.length ? ` If you'd rather, I can ${fixBits.join(', or ')}.` : '';
  const fields = {
    cardId: 'next_starter', tag: 'ROTATION', sender, avatar: '⚾', type: 'normal',
    _rosterKey: key, _targetPlayerId: B.id, _nextspGame: g.gameTime,
    subject: X ? `${X.name} starts ${When.untilDay(g.gameTime, atMs)}` : `Nobody rested for ${When.untilDay(g.gameTime, atMs)}`,
    preview: `With ${B.name} out of the rotation, ${X ? `${X.name} is up next` : 'nobody rested is in line'}.`,
    body: `With ${B.name} out of the rotation, ${who}${fill}${fixes}`,
  };
  if (!choices.length) return _deliverNotice(key, fields, atMs);
  return _deliverAt(_rosterCard(st, {
    ...fields,
    _choices: choices, _noRec: true,
    yesLabel: choices[0].label, noLabel: X ? `Leave it: ${X.name} starts` : 'Leave it',
    autoResolve: 'no', expiresAtMs: g.gameTime - 10 * 60_000,
    _raw: { onYes: 'nextsp_fix', onNo: null, onAuto: null },
    _autoLabel: X ? `No answer — ${X.name} started` : 'No answer — left as it was',
  }), atMs);
}


/**
 * r160 §122.32 the rest watch: a regular in our lineup wearing down → one of the
 * staff writes, a decision (give the player the next game off, or not). Our
 * lineup is the GM's: the manager only sits the player when the message went
 * unanswered and the player is worn down. Who writes fits the case — about a
 * catcher, the manager or the pitching coach (who'd notice the framing and the
 * blocks); about a tired bat, the hitting coach; about one worn down, the team
 * physician; otherwise the manager. Never a pile-up (REST_WATCH): one open at a
 * time, a gap between any two, the same player not again for days (unless now
 * worn down), and not the day the staff already asked about a lineup spot.
 */
export function _restWatch(atMs) {
  const st = StateManager.get(), u = st.userTeam;
  if (!u?.lineupSlots?.length || ![PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE, PHASE.ALL_STAR_BREAK, PHASE.POSTSEASON].includes(st.phase)) return 0;
  if (!_staffLooks(st, atMs, 'restWatch')) return 0;   // r196 once, at the staff's look
  // (not while one of our games is on: the staff writes between games)
  const cur = st.schedule?.[st.currentGameIndex];
  if (cur && !cur._committed && Number.isFinite(cur.gameTime) && cur.gameTime <= atMs && !cur.cancelled) return 0;
  const W = st.restWatch || {};
  if (atMs - (W.lastAt ?? -Infinity) < REST_WATCH.gapMs) return 0;
  const all = [...(st.inbox || []), ...(st.scheduledCards || [])];
  if (all.some(c => String(c._rosterKey || '').startsWith('rest:') && !c.resolved)) return 0;
  if (all.some(c => c.cardId === 'lineup_return' && (!c.resolved || Math.abs((c.deliverAtMs ?? c.arrivedAtMs ?? 0) - atMs) < 12 * 3600_000))) return 0;
  if (all.some(c => c.cardId === 'roster_advice' && Math.abs((c.deliverAtMs ?? c.arrivedAtMs ?? 0) - atMs) < 12 * 3600_000)) return 0;   // r162
  const game = _nextUserGame(st, atMs);
  if (!game) return 0;
  const latest = game.gameTime - REST_WATCH.leadMs;
  if (latest < atMs) return 0;   // (too close to first pitch — a doubleheader's second game)
  const cands = [];
  u.lineupSlots.forEach((sl) => {
    const p = sl.playerId ? st.players[sl.playerId] : null;
    if (!p || p.teamId !== 'user' || ['SP', 'RP'].includes(p.pos) || !isAvailable(p)) return;
    const w = Development.wearOf(p);
    const catcher = sl.slot === 'C';
    if (w.wear < (catcher ? REST_WATCH.catcherAt : REST_WATCH.hitterAt)) return;
    const last = W.byPlayer?.[p.id];
    if (last && atMs - last.atMs < REST_WATCH.samePlayerMs && !(w.worn && !last.worn)) return;
    const sub = Development.fillInFor(st, u, p);
    if (!sub) return;
    cands.push({ p, w, catcher, sub, slot: sl.slot });
  });
  // r161 §122.33 the arms: the next game's starter (his workload as of first pitch — the pitching coach
  // would skip his turn) and the relievers (two days down).
  const next = _nextStarter(u, st.players, game.gameTime);
  for (const id of u.rosterIds || []) {
    const p = st.players[id];
    if (!p || p.teamId !== 'user' || !['SP', 'RP'].includes(p.pos) || !isAvailable(p)) continue;
    const starter = (u.rotation?.order || []).includes(id);
    if (starter ? id !== next : p.group !== PLAYER_GROUP.BULLPEN) continue;
    const w = Development.wearOf(p, game.gameTime);
    if (w.wear < REST_WATCH.pitcherAt) continue;
    const last = W.byPlayer?.[p.id];
    if (last && atMs - last.atMs < REST_WATCH.samePlayerMs && !(w.worn && !last.worn)) continue;
    const sub = starter ? st.players[_nextStarter(u, st.players, game.gameTime, id)] : null;
    if (starter && !sub) continue;   // (nobody to take the turn)
    cands.push({ p, w, catcher: false, arm: starter ? 'starter' : 'reliever', sub, slot: null });
  }
  if (!cands.length) return 0;
  cands.sort((a, b) => (b.w.worn - a.w.worn) || (b.catcher - a.catcher) || (b.w.wear - a.w.wear));
  const c = cands[0];
  // (its moment and its words are the situation's — the game before and the one it's about — never
  //  when the roster clock happened to look, so the message lands the same with the app open or closed)
  return withDice(dice(diceSeed(st), 'rest', c.p.id, u._lastGameAt ?? 0, game.index), () => {
    // After the last game (first pitch + a game), and no sooner than the spacing allows; a moment the
    // roster clock reaches late (the app closed) still lands then. Never before the GM answered an
    // earlier rest message, nor within half a day of the staff's lineup-spot message.
    const lastRest = all.filter(x => x.cardId === 'rest_ask' || x.cardId === 'lineup_return')
      .map(x => (x.cardId === 'lineup_return' ? (x.resolvedAtMs || x.expiresAtMs || 0) + 12 * 3600_000 : x.resolvedAtMs || 0));
    const prev = W.byPlayer?.[c.p.id];
    const from = Math.max((u._lastGameAt ?? atMs) + 4 * 3600_000, (W.lastAt ?? -Infinity) + REST_WATCH.gapMs,
      prev && !(c.w.worn && !prev.worn) ? prev.atMs + REST_WATCH.samePlayerMs : -Infinity, ...lastRest);
    const at = Math.min(latest, from + _randBetween(20, 50) * 60_000);
    return _restDeliver(st, c, game, at);
  });
}


function _restDeliver(st, c, game, at) {
  const card = _restCard(st, c, game, at);
  StateManager.mutate(s => {
    s.restWatch = { ...(s.restWatch || {}), lastAt: at, byPlayer: { ...(s.restWatch?.byPlayer || {}), [c.p.id]: { atMs: at, worn: c.w.worn } } };
  });
  return _deliverAt(card, at) ? 1 : 0;
}


/** The rest message itself: who writes it and how (two ways each, so they don't read the same). */
function _restCard(st, cand, game, at) {
  if (cand.arm) return _armRestCard(st, cand, game, at);
  const { p, w, catcher, sub, slot } = cand;
  const staff = st.userTeam.coachingStaff || {};
  const person = (role) => (staff[role] && !staff[role].vacant ? staff[role].name : null);
  const mgr = person('manager'), pc = person('pitchingCoach'), hc = person('hittingCoach');
  const X = p.name, B = sub.name, n = Math.max(w.straight, 1);
  const when = When.untilFull(game.gameTime, at), day = When.untilDay(game.gameTime, at);
  const subC = canPlay(sub, 'C');   // r163 Positions
  const where = slot === 'C' ? 'catch' : slot === 'DH' ? 'DH' : `play ${slot === 'OF' ? 'the outfield' : slot}`;
  const cover = catcher && !subC ? `We don't carry another catcher, so ${B} would catch, out of position.` : `${B} can ${where}.`;
  const v = eventRand() < 0.5 ? 0 : 1;
  // Who writes: about one worn down, the physician; about a catcher, the manager or the pitching coach;
  // about a tired bat, the hitting coach; else the manager (whoever's chair is filled).
  const role = w.worn ? 'physician' : catcher ? (pc && (v === 1 || !mgr) ? 'pitchingCoach' : 'manager') : (w.tired && hc ? 'hittingCoach' : 'manager');
  // The manager steps in only for one worn down, and only with no answer by first pitch.
  const autoSit = w.worn;
  const mgrSits = autoSit ? (role === 'manager' ? ` If I don't hear from you by first pitch, I'll sit ${X} myself.`
                                                : ` If there's no answer by first pitch, ${mgr || 'the manager'} will sit ${X}.`) : '';
  let sender, avatar, subject, preview, body;
  if (role === 'physician') {
    sender = 'Team Physician'; avatar = '🩺';
    subject = v ? `${X} is worn down` : `A day for ${X}`;
    preview = `${n} straight starts without a real day off.`;
    body = (v ? `${X} is worn down: ${n} straight starts without a real day off. This is when hamstrings and obliques go. I'd sit ${X} ${when}.`
              : `I've been watching ${X}'s workload: ${n} starts in a row, and the body is showing it. Worn-down players get hurt. My advice is a day off ${when}.`)
         + ` ${cover}${mgrSits}`;
  } else if (role === 'pitchingCoach') {
    sender = pc; avatar = '⚾';
    subject = v ? `${X} needs a day` : `${X} behind the plate`;
    preview = `${n} straight behind the plate.`;
    body = (v ? `${X} has caught ${n} straight. My pitchers notice when a catcher's legs go: the low strikes stop getting framed and the blocks get slow. Give ${X} a day off ${when} and the pitchers get a fresh catcher back.`
              : `That's ${n} in a row behind the plate for ${X}. I'd like ${X} fresh for the next turn through our rotation, so I'm asking for a day off ${when}.`)
         + ` ${cover}${mgrSits}`;
  } else if (role === 'hittingCoach') {
    sender = hc; avatar = '🏏';
    subject = v ? `${X}'s bat has slowed` : `A day for ${X}?`;
    preview = `${n} straight starts. The swing is a step late.`;
    body = (v ? `${X} has started ${n} straight and the bat has slowed down. The swing is fine; it's legs and hands. A day off ${when} clears it.`
              : `I'm seeing late swings from ${X}. ${n} starts in a row will do that. One day out of the lineup ${when} and the timing comes back.`)
         + ` ${cover}${mgrSits}`;
  } else {
    sender = mgr || 'Front Office'; avatar = '📋';
    subject = catcher ? (v ? `A day for ${X}?` : `${X} could use a day`) : `${X} could use a day`;
    preview = catcher ? `${n} straight behind the plate.` : `${n} straight starts.`;
    body = (catcher
      ? (v ? `${X} has caught ${n} straight and it's starting to show: slower out of the crouch, a step late on the blocks. I'd like to give ${X} a full day ${when}.`
           : `That's ${n} games in a row behind the plate for ${X}. I'd rather give ${X} a day now than lose the bat for a week later. I'd sit ${X} ${when}.`)
      : (v ? `${X} has started ${n} straight and is starting to wear down. Better a day off now than a slump later: I'd like to give ${X} the day ${when}.`
           : `${n} starts in a row for ${X}. Nothing's wrong yet, but this is when I like to get ahead of it. I'd sit ${X} ${when}.`))
         + ` ${cover} Your call.${mgrSits}`;
  }
  return _rosterCard(st, {
    cardId: 'rest_ask', tag: 'LINEUP', sender, avatar, type: 'normal',
    _rosterKey: `rest:${p.id}:${game.index}:${game.gameTime}`, _targetPlayerId: p.id, _playerIds: [sub.id], _restWorn: !!w.worn,
    _restGame: { index: game.index, gameTime: game.gameTime },   // (our games have no id: the index, and the time — a game moved by weather is a new question)
    subject, preview, body,
    yesLabel: `Sit ${X} ${day === 'today' ? 'Today' : day === 'tomorrow' ? 'Tomorrow' : 'Next Game'}`,
    noLabel: `Keep ${X} In`,
    yesMsg: `Done. ${X} gets the day and ${B} is in.`,
    noMsg: `Understood. ${X} plays.`,
    expiresAtMs: game.gameTime - 10 * 60_000,
    _raw: { onYes: 'day_off', onNo: null, onAuto: autoSit ? 'rest_auto' : null },
    _autoLabel: autoSit ? `No answer — ${mgr || 'the manager'} sat ${X}` : `No answer — ${X} played`,
  });
}


/**
 * r161 §122.33 the pitching coach (the physician about an arm worn down) on one of our arms: skip the
 * next start (the next man in the rotation takes the turn), or two days down for a reliever.
 */
function _armRestCard(st, { p, w, arm, sub }, game, at) {
  const staff = st.userTeam.coachingStaff || {};
  const person = (role) => (staff[role] && !staff[role].vacant ? staff[role].name : null);
  const mgr = person('manager'), pc = person('pitchingCoach');
  const X = p.name, starter = arm === 'starter';
  const when = When.untilFull(game.gameTime, at), day = When.untilDay(game.gameTime, at);
  const recent = (p.arm || []).filter(o => o.at <= at && game.gameTime - o.at < 7 * 86_400_000);
  const starts = (p.arm || []).filter(o => o.start).slice(-3);
  const deep = starts.length ? Math.round(starts.reduce((a, o) => a + o.outs, 0) / starts.length / 3) : 0;
  const v = eventRand() < 0.5 ? 0 : 1;
  const role = w.worn ? 'physician' : pc ? 'pitchingCoach' : 'manager';
  const autoSit = w.worn;
  const what = starter ? `skip ${X}'s start` : `give ${X} two days down`;
  const mgrSits = autoSit ? (role === 'manager' ? ` If I don't hear from you by first pitch, I'll ${what} myself.`
                                                : ` If there's no answer by first pitch, ${mgr || 'the manager'} will ${what}.`) : '';
  const cover = starter ? `${sub.name} can take the turn instead, and the rotation moves up a day behind.` : '';
  const many = recent.length >= 2;
  const used = many ? `pitched ${recent.length} times in the last week` : 'carried a heavy load lately';
  let sender, avatar, subject, preview, body;
  if (role === 'physician') {
    sender = 'Team Physician'; avatar = '🩺';
    subject = `${X}'s arm is worn down`;
    preview = starter ? 'The workload has caught up with the arm.' : many ? `Pitched ${recent.length} times in the last week.` : 'A heavy load lately.';
    body = `${X}'s arm is worn down: ${starter ? `the innings have piled up, ${deep ? `about ${deep} a start lately` : 'start after start'}` : used}. Tired arms are the ones that get hurt. My advice is to ${what}${starter ? '' : ` starting ${day === 'today' ? 'today' : 'with the next game'}`}. ${cover}${mgrSits}`;
  } else {
    sender = role === 'manager' ? (mgr || 'Front Office') : pc; avatar = role === 'manager' ? '📋' : '⚾';
    if (starter) {
      subject = v ? `Skip ${X}'s start?` : `${X} could use a turn off`;
      preview = deep ? `About ${deep} innings a start lately.` : 'The workload is building.';
      body = (v ? `${X} has been going deep${deep ? `, about ${deep} innings a start` : ''}, and the arm is carrying it: the fastball is a tick short late and the slider is flattening out. I'd skip the start ${when} and let the arm catch up.`
                : `The workload is catching up with ${X}. Nothing's hurt, but the bullpen sessions have been flat. One turn off now saves us a month on the shelf later.`)
           + ` ${cover}${role === 'manager' ? ' Your call.' : ''}${mgrSits}`;
    } else {
      subject = v ? `${X} needs a breather` : `Two days for ${X}?`;
      preview = many ? `Pitched ${recent.length} times in the last week.` : 'A heavy load lately.';
      body = (v ? `${X} has ${used}, and the arm is showing it: the velocity is down and the warm-ups take longer. I'd like to keep ${X} down for two days.`
                : `We've leaned on ${X}${many ? `: ${recent.length} times in the last week` : ' lately'}. Two days without throwing in a game and the arm comes back. The rest of the pen can cover.`)
           + `${role === 'manager' ? ' Your call.' : ''}${mgrSits}`;
    }
  }
  return _rosterCard(st, {
    cardId: 'rest_ask', tag: 'LINEUP', sender, avatar, type: 'normal',
    _rosterKey: `rest:${p.id}:${game.index}:${game.gameTime}`, _targetPlayerId: p.id, _playerIds: sub ? [sub.id] : [], _restWorn: !!w.worn,
    _restArm: arm, _restGame: { index: game.index, gameTime: game.gameTime },
    subject, preview, body,
    yesLabel: starter ? `Skip ${X}'s Start` : `Rest ${X} Two Days`,
    noLabel: starter ? `${X} Pitches` : `Keep ${X} Available`,
    yesMsg: starter ? `Done. ${sub.name} takes the turn and ${X} gets the extra rest.` : `Done. ${X} is down for two days.`,
    noMsg: `Understood. ${X} ${starter ? 'makes the start' : 'stays available'}.`,
    expiresAtMs: game.gameTime - 10 * 60_000,
    _raw: { onYes: 'arm_rest', onNo: null, onAuto: autoSit ? 'rest_auto' : null },
    _autoLabel: autoSit ? `No answer — ${mgr || 'the manager'} rested ${X}` : `No answer — ${X} stayed in line`,
  });
}
