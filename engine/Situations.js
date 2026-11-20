/**
 * engine/Situations.js
 * r218 §122.97 Messages from what is happening (message plan, release 5): after each of our regular-season games, the
 * club as it stands is read, and the one situation most worth a word comes the next morning (at most one a day).
 *
 *   milestone   a player reaches a round number this season (a 30th home run, a 15th win, a 200th strikeout): at
 *               home next, mark it (a moment on the scoreboard, a giveaway); on the road, the news
 *   rookie      a first-year player on a tear (hitting .330+ over 15 games, or an ERA under 2.50 over four starts):
 *               the press wants them — let them talk, or keep them to their routine
 *   injuries    three or more of ours on the IL, one this week: an outside specialist for the conditioning program
 *   slump       a regular 10 games cold (under .150): sit them tonight (a day off), or let them hit out of it
 *   rival       a series against the division club closest to us in the standings: at home, a rivalry weekend; on
 *               the road, the manager's word
 *
 *   findSituations(state, atMs)   the candidates, most worth a word first: [{ kind, key, ... }]
 *   buildCard(sit, state, atMs)   the message's fields (a roster-style card)
 *
 * State: s.situations = { done: { [key]: atMs } } (a key once; slumps and injuries come back after a gap — a slump's
 * gap is per player, and `slump` between any two).
 * PURE: no StateManager.
 */
import { SITUATIONS as SX, PLAYER_GROUP } from '../data/constants.js';
import { computeAge, baseballYear } from './PlayerFactory.js';


const HOUR = 3_600_000, DAY = 24 * HOUR;
const isP = (p) => p?.pos === 'SP' || p?.pos === 'RP';
const ord = (n) => { const v = n % 100; return `${n}${(v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`; };
const avg3 = (h, ab) => (ab ? (h / ab).toFixed(3).replace(/^0/, '') : '.000');
const era = (er, ip) => (ip ? ((er * 9) / ip).toFixed(2) : '0.00');

/** The milestones: the stat, its round numbers, how far past one it can be and still be news (a game's worth). */
const MILESTONES = Object.freeze([
  { stat: 'hr', marks: [30, 40, 50], slack: 1, word: 'home run', p: false },
  { stat: 'h', marks: [150, 200], slack: 3, word: 'hit', p: false },
  { stat: 'rbi', marks: [100, 125], slack: 4, word: 'RBI', p: false },
  { stat: 'sb', marks: [40, 60], slack: 1, word: 'stolen base', p: false },
  { stat: 'w', marks: [15, 20], slack: 1, word: 'win', p: true },
  { stat: 'k', marks: [200, 250], slack: 12, word: 'strikeout', p: true },
  { stat: 'sv', marks: [30, 40], slack: 1, word: 'save', p: true },
]);

const ACTIVE = new Set([PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS, PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN]);
const ours = (state) => (state.userTeam?.rosterIds || []).map(id => state.players?.[id]).filter(Boolean);

/** A player's last `n` games (their log), summed. */
function recent(p, n) {
  const log = (p._impGameLog || []).slice(-n);
  const sum = {};
  for (const e of log) for (const [k, v] of Object.entries(e.stats || {})) if (typeof v === 'number') sum[k] = (sum[k] || 0) + v;
  return { games: log.length, ...sum };
}

/** Our next game, and the series it opens (if it does). */
function nextGame(state) {
  const sched = state.schedule || [];
  const i = sched.findIndex(g => !g._committed && !g.cancelled && !g.isSpring && !g.isPlayoff);
  return i < 0 ? null : { g: sched[i], i, opener: i === 0 || sched[i - 1].opponent !== sched[i].opponent || !!sched[i - 1].isHome !== !!sched[i].isHome };
}

export function findSituations(state, atMs) {
  const season = state.seasonNum || 1;
  const done = state.situations?.done || {};
  const since = (key, days) => done[key] == null || atMs - done[key] >= days * DAY;
  const out = [];
  const players = ours(state).filter(p => ACTIVE.has(p.group));
  const played = (state.schedule || []).filter(g => g._committed && !g.isSpring && !g.isPlayoff).length;
  if (played < SX.minGames) return out;
  const next = nextGame(state);

  // Milestones: the highest round number newly reached (and only within a game of it).
  for (const p of players) {
    for (const m of MILESTONES.filter(x => x.p === isP(p))) {
      const v = p.stats?.[m.stat] || 0;
      const mark = [...m.marks].reverse().find(t => v >= t && v - t <= m.slack);
      if (!mark) continue;
      const key = `ms:${season}:${p.id}:${m.stat}:${mark}`;
      if (done[key] == null) out.push({ kind: 'milestone', key, rank: 2, playerId: p.id, stat: m.stat, mark, word: m.word, home: !!next?.g.isHome });
    }
  }

  // A first-year player on a tear.
  const yr = baseballYear(state);
  for (const p of players) {
    if ((p.seasonLog || []).some(e => e?.stats && (e.stats.g || 0) > 0) || computeAge(p.dob, yr) > SX.rookieAge) continue;
    const key = `rookie:${season}:${p.id}`;
    if (done[key] != null) continue;
    if (isP(p)) {
      const r = recent(p, SX.rookieStarts);
      if ((r.ip || 0) >= SX.rookieIp && (r.er || 0) * 9 / r.ip <= SX.rookieEra) out.push({ kind: 'rookie', key, rank: 3, playerId: p.id, line: `an ERA of ${era(r.er || 0, r.ip)} over the last ${r.games} outings` });
    } else {
      const r = recent(p, SX.rookieGames);
      if ((r.ab || 0) >= SX.rookieAb && (r.h || 0) / r.ab >= SX.rookieAvg) out.push({ kind: 'rookie', key, rank: 3, playerId: p.id, line: `hitting ${avg3(r.h || 0, r.ab)} over the last ${r.games} games` });
    }
  }

  // A run of injuries.
  const il = ours(state).filter(p => p.group === PLAYER_GROUP.IL);
  const fresh = il.filter(p => Number.isFinite(p.injury?.injuredAt) && atMs - p.injury.injuredAt <= SX.ilRecentDays * DAY);
  if (il.length >= SX.ilRun && fresh.length && since('injuries', SX.ilGapDays)) out.push({ kind: 'injuries', key: 'injuries', rank: 4, ids: il.map(p => p.id), fresh: fresh.length });

  // A regular gone cold (needs a game tomorrow or later to sit).
  const starting = new Set((state.userTeam?.lineupSlots || []).map(s => s?.playerId).filter(Boolean));
  for (const p of players.filter(x => starting.has(x.id))) {
    const r = recent(p, SX.slumpGames);
    if (r.games < SX.slumpGames || (r.ab || 0) < SX.slumpAb || (r.h || 0) / r.ab >= SX.slumpAvg) continue;
    if (!next || next.g.gameTime - atMs < 3 * HOUR) continue;   // (time to sit them before first pitch)
    if (since(`slump:${p.id}`, SX.slumpGapDays) && since('slump', SX.slumpTeamGapDays)) out.push({ kind: 'slump', key: `slump:${p.id}`, also: ['slump'], rank: 1, playerId: p.id, h: r.h || 0, ab: r.ab, games: r.games });
  }

  // The series against the club closest to us.
  if (next?.opener) {
    const div = (state.userTeam?.divisionId === 'B' ? state.standings?.divB : state.standings?.divA) || [];
    const me = div.find(t => t.id === 'user'), them = div.find(t => t.name === next.g.opponent);
    if (me && them) {
      const gap = ((me.wins - them.wins) + (them.losses - me.losses)) / 2;
      const closest = div.filter(t => t.id !== 'user').every(t => Math.abs(((me.wins - t.wins) + (t.losses - me.losses)) / 2) >= Math.abs(gap));
      const key = `rival:${season}:${next.i}`;
      if (closest && Math.abs(gap) <= SX.rivalGap && done[key] == null) out.push({ kind: 'rival', key, rank: 0, opponent: them.name, gap, home: !!next.g.isHome, gameTime: next.g.gameTime });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

const _k = (state, share, min) => Math.max(min, Math.round(((state.userTeam?.finances?.payrollTarget || 0) * share) / 5) * 5);
const _fmt = (k) => (k >= 1000 ? `$${(k / 1000).toFixed(1).replace(/\.0$/, '')}M` : `$${k}K`);

export function buildCard(sit, state, atMs) {
  const p = sit.playerId ? state.players?.[sit.playerId] : null;
  const staff = state.userTeam?.coachingStaff || {};
  const nm = (role, fallback) => (staff[role] && !staff[role].vacant && staff[role].name ? `${staff[role].name} (${fallback})` : fallback);
  const base = { cardId: `sit_${sit.kind}`, tag: 'ROSTER', type: 'normal', _situation: sit.kind, _rosterKey: `sit:${sit.key}`, _raw: {} };

  if (sit.kind === 'milestone') {
    const what = `${ord(sit.mark)} ${sit.word}`;
    if (sit.home) {
      const k = _k(state, SX.markShare, 10);
      return { ...base, tag: 'MARKETING', sender: 'PR Dept.', avatar: '🎉', _targetPlayerId: p.id, _budgetCost: k, _tokenPlayers: { pl_player: p.id },
        subject: `${p.name}'s ${what}`,
        preview: `${p.name} reached ${sit.mark} last night…`,
        body: `${p.name} got their ${what} of the season last night. We'd like to mark it at the ballpark tonight — a moment on the scoreboard before the first pitch, and a giveaway at the gates (${_fmt(k)}). The fans love these nights, and so do the players. Or we let the number speak for itself.`,
        yesLabel: 'Mark It Tonight', noLabel: 'Let It Speak',
        yesEffect: { atmo: 2 }, noEffect: {},
        yesMsg: `It's on the scoreboard tonight.`, noMsg: 'Understood. A line in the game notes, then.',
        autoResolve: 'no', expiresAtMs: atMs + 8 * HOUR, _raw: { _relYes: { pl_nm: 2 } } };
    }
    return { ...base, tag: 'MARKETING', sender: 'PR Dept.', avatar: '🎉', _targetPlayerId: p.id,
      subject: `${p.name}'s ${what}`,
      preview: `${p.name} reached ${sit.mark} last night…`,
      body: `${p.name} got their ${what} of the season last night, on the road. The clubhouse made a fuss about it after the game; we'll mark it at the ballpark when we're home.`,
      yesLabel: 'Got It', noLabel: null, yesEffect: { morale: 1 }, autoResolve: 'yes', expiresAtMs: atMs + 12 * HOUR, _news: true };
  }

  if (sit.kind === 'rookie') {
    const coach = isP(p) ? nm('pitchingCoach', 'Pitching Coach') : nm('hittingCoach', 'Hitting Coach');
    return { ...base, sender: coach, avatar: isP(p) ? '⚾' : '🎯', _targetPlayerId: p.id, _tokenPlayers: { pl_player: p.id },
      subject: `${p.name} is getting noticed`,
      preview: `${p.name} is off to a fast start, and the press has noticed…`,
      body: `${p.name} has ${sit.line.replace(/^hitting/, 'been hitting').replace(/^an ERA/, 'put up an ERA')}, and the press has noticed — three outlets asked for interviews this week. I'd keep them to their routine for now; first-year players can get lost in all that. Or we let them talk — the city loves a new face, and so does the ticket office.`,
      yesLabel: 'Let Them Talk', noLabel: 'Keep Them to Their Routine',
      yesEffect: { atmo: 3 }, noEffect: {},
      yesMsg: 'Interviews are set for this week.', noMsg: 'No interviews for now. They\'re focused.',
      autoResolve: 'no', expiresAtMs: atMs + 24 * HOUR, _raw: { _relYes: { pl_nm: 1 }, _relNo: { [isP(p) ? 'pc_nm' : 'hc_nm']: 1 } } };
  }

  if (sit.kind === 'injuries') {
    const names = sit.ids.map(id => state.players[id]?.name).filter(Boolean);
    const k = _k(state, SX.specialistShare, 20);
    const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    return { ...base, tag: 'HEALTH', sender: 'Head Trainer', avatar: '🩹', _budgetCost: k,
      subject: `${names.length} on the injured list`,
      preview: `${names.length} of ours are on the injured list now…`,
      body: `${names.length} of ours are on the injured list now — ${list} — and ${sit.fresh === 1 ? 'one went on it' : `${sit.fresh} went on it`} this week. That's more than bad luck. We'd like to bring in an outside specialist to go through the conditioning program, ${_fmt(k)} for the rest of the season. Or we ride it out; injuries come in bunches.`,
      yesLabel: 'Bring In the Specialist', noLabel: 'Ride It Out',
      yesEffect: { morale: 2 }, noEffect: { morale: -1 },
      yesMsg: 'The specialist starts Monday.', noMsg: 'Riding it out.',
      autoResolve: 'no', expiresAtMs: atMs + 24 * HOUR };
  }

  if (sit.kind === 'slump') {
    const next = nextGame(state);
    return { ...base, sender: nm('hittingCoach', 'Hitting Coach'), avatar: '🎯', _targetPlayerId: p.id, _cbData: { h: sit.h, ab: sit.ab },
      subject: `${p.name} is ${sit.h}-for-${sit.ab}`,
      preview: `${p.name} is ${sit.h}-for-${sit.ab} over the last ${sit.games} games…`,
      body: `${p.name} is ${sit.h}-for-${sit.ab} over the last ${sit.games} games. The swing is long, and they know it — they've been in the cage before everyone and after. I'd sit them tonight; a day away does more than another round of swings. Or we leave them in and let them hit out of it. Regulars usually do.`,
      yesLabel: 'Sit Them Tonight', noLabel: 'Leave Them In',
      yesEffect: {}, noEffect: {},
      yesMsg: `${p.name} sits tonight. Back in tomorrow.`, noMsg: `${p.name} stays in. We'll keep working.`,
      autoResolve: 'no', expiresAtMs: next ? next.g.gameTime - 30 * 60_000 : atMs + 8 * HOUR, _raw: { onYes: 'day_off' } };
  }

  if (sit.kind === 'rival') {
    const gapWords = sit.gap === 0 ? 'dead even with them' : `${Math.abs(sit.gap) === 1 ? 'one game' : `${Math.abs(sit.gap)} games`} ${sit.gap > 0 ? 'ahead of them' : 'behind them'}`;
    if (sit.home) {
      const k = _k(state, SX.rivalShare, 10);
      return { ...base, tag: 'MARKETING', sender: 'Ticket Office', avatar: '🎟️', _budgetCost: k,
        subject: `The ${sit.opponent} are in town`,
        preview: `We're ${gapWords} in the standings, and they're here this week…`,
        body: `The ${sit.opponent} are in town, and we're ${gapWords} in the standings. We'd like to make it a rivalry weekend — rally towels at the gates, the old highlights on the scoreboard (${_fmt(k)}). The place would be loud. Or we let the standings sell it.`,
        yesLabel: 'Make It a Rivalry Weekend', noLabel: 'Let the Standings Sell It',
        yesEffect: { atmo: 3 }, noEffect: {},
        yesMsg: 'Towels are ordered.', noMsg: 'The standings will do it.',
        autoResolve: 'no', expiresAtMs: Math.min(atMs + 24 * HOUR, sit.gameTime) };
    }
    return { ...base, sender: nm('manager', 'Manager'), avatar: '📋',
      subject: `A series that matters`,
      preview: `We're ${gapWords}, and we see the ${sit.opponent} tonight…`,
      body: `We're ${gapWords}, and we start a series against the ${sit.opponent} tonight. The players know what it means; nobody had to say a word in the clubhouse. We'll be ready.`,
      yesLabel: 'Got It', noLabel: null, yesEffect: { morale: 1 }, autoResolve: 'yes', expiresAtMs: atMs + 10 * HOUR, _news: true };
  }
  return null;
}
