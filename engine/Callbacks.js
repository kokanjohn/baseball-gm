/**
 * engine/Callbacks.js
 * r220 §122.99 Callbacks (release 7): a later message that goes back to a decision the GM actually made — read from
 * the GM's record (GMProfile: state.gmRecord.log), never invented. Each callback names who and what it was about,
 * only while they're still around, and quotes what happened since from the real numbers. About half are news; the
 * rest open a new decision.
 *
 *   CALLBACKS                       the catalog: { key, from: [cardIds], choices, days: [min, max], fits, build }
 *   pickCallback(state, atMs, rand) a callback due now: { cb, e, ctx } (or null)
 *   useKey(cb, e)                   the key that marks it used (one callback per decision, per kind)
 *   playerKey(cb, e)                the same kind about the same player: not again for CALLBACK.samePlayerDays
 *
 * State: s.callbacks = { used: { [key]: atMs } }. PURE: no StateManager.
 */
import { CALLBACK as CB, PHASE } from '../data/constants.js';
import { hometownPlayer } from './AwayDays.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (ms) => MONTH[new Date(ms).getMonth()];
const isP = (p) => p?.pos === 'SP' || p?.pos === 'RP';
const avg3 = (h, ab) => (ab ? (h / ab).toFixed(3).replace(/^0/, '') : '.000');
const era2 = (er, ip) => (ip ? ((er * 9) / ip).toFixed(2) : '0.00');
const ours = (state, id) => !!id && state.players?.[id]?.teamId === 'user' && (state.userTeam?.rosterIds || []).includes(id);
const IN_SEASON = new Set([PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE, PHASE.ALL_STAR_BREAK]);
const _fmt = (k) => (k >= 1000 ? `$${(k / 1000).toFixed(1).replace(/\.0$/, '')}M` : `$${k}K`);
const _k = (k) => Math.max(5, Math.round(k / 5) * 5);

/** A player's games since a moment (their log): { games, ab, h, hr, ip, er, … }. */
export function since(p, atMs) {
  const sum = { games: 0 };
  for (const e of p?._impGameLog || []) {
    if (!(e.atMs > atMs)) continue;
    sum.games++;
    for (const [k, v] of Object.entries(e.stats || {})) if (typeof v === 'number') sum[k] = (sum[k] || 0) + v;
  }
  return sum;
}
const line = (p, x) => (isP(p) ? `an ERA of ${era2(x.er || 0, x.ip)} in ${Math.round(x.ip)} innings` : `${avg3(x.h || 0, x.ab)} with ${x.hr || 0} home run${(x.hr || 0) === 1 ? '' : 's'} in ${x.ab} at-bats`);
/** The same line, as a sentence's verb: "is hitting .312 with 9 home runs in 200 at-bats" / "has an ERA of 3.10 in 80 innings". */
export const doing = (p, x) => (isP(p) ? `has ${line(p, x)}` : `is hitting ${line(p, x)}`);
export const enough = (p, x) => (isP(p) ? (x.ip || 0) >= 15 : (x.ab || 0) >= 25);
export const good = (p, x) => (isP(p) ? (x.er || 0) * 9 / x.ip <= 3.5 : (x.h || 0) / x.ab >= 0.27);
export const bad = (p, x) => (isP(p) ? (x.er || 0) * 9 / x.ip >= 5.5 : (x.h || 0) / x.ab < 0.21);
const club = (state, id) => (state.leagueTeams || []).find(t => t.id === id) || null;
const mgr = (state) => { const m = state.userTeam?.coachingStaff?.manager; return m && !m.vacant && m.name ? `${m.name} (Manager)` : 'Manager'; };
const coach = (state, role, title) => { const c = state.userTeam?.coachingStaff?.[role]; return c && !c.vacant && c.name ? `${c.name} (${title})` : title; };
const news = (o) => ({ yesLabel: 'Got It', noLabel: null, autoResolve: 'yes', _news: true, ...o });

const EVENT = { rv1: 'the concert promoter', rv2: 'the youth tournament', rv4: 'the corporate rental', rv6: 'the festival company', rv7: 'the high school association',
  rv8: 'the film producers', rv9: 'the charity run', rv10: 'the city\'s fireworks committee', rv11: 'a couple of season-ticket holders' };
const EVENT_WHAT = { rv1: 'the concert', rv2: 'the tournament', rv4: 'the rental', rv6: 'the festival', rv7: 'the championship game', rv8: 'the film shoot',
  rv9: 'the charity run', rv10: 'the fireworks show', rv11: 'an anniversary party' };

export const CALLBACKS = [
  // The flight home on an off day, said yes to.
  { key: 'flight', from: ['od1'], choices: ['yes'], days: [20, 70],
    fits: (st, e) => (ours(st, e.p) ? {} : null),
    build: (st, e) => news({ sender: mgr(st), avatar: '📋', tag: 'CULTURE', _targetPlayerId: e.p, _tokenPlayers: { pl_player: e.p },
      subject: `${st.players[e.p].name} hasn't forgotten`,
      preview: `${st.players[e.p].name} brought up the flight home…`,
      body: `${st.players[e.p].name} stopped by my office today and brought up the flight home in ${monthOf(e.at)}. Their family still talks about it. They asked me to tell you they haven't forgotten.`,
      yesEffect: {}, _raw: { _relYes: { pl_nm: 1 } } }) },

  // A regular we sat in a slump (or left in): what happened since.
  { key: 'slump', from: ['sit_slump'], choices: ['yes', 'no'], days: [12, 35],
    fits: (st, e) => { const p = st.players[e.p]; if (!ours(st, e.p) || !e.x) return null; const x = since(p, e.at); return enough(p, x) ? { x } : null; },
    build: (st, e, { x }) => {
      const p = st.players[e.p], then = `${e.x.h}-for-${e.x.ab}`;
      const what = e.c === 'yes' ? `You sat ${p.name} when they were ${then}.` : `You left ${p.name} in when they were ${then}.`;
      if (!bad(p, x)) return news({ sender: coach(st, 'hittingCoach', 'Hitting Coach'), avatar: '🎯', tag: 'ROSTER', _targetPlayerId: p.id,
        subject: `${p.name}, since the slump`, preview: `${what} Since then: ${avg3(x.h || 0, x.ab)}…`,
        body: `${what} Since then: ${line(p, x)}. ${good(p, x) ? 'They came out of it.' : 'Not all the way back, but better.'}`, yesEffect: { morale: 1 } });
      return { sender: coach(st, 'hittingCoach', 'Hitting Coach'), avatar: '🎯', tag: 'TRAINING', _targetPlayerId: p.id,
        subject: `${p.name} is still cold`, preview: `${what} It hasn't turned…`,
        body: `${what} It hasn't turned: ${line(p, x)} since. I'd like an hour a day in the cage with them, before anyone else is in the building — a week of it, and their off-day rest goes with it. Or we leave it alone and trust the at-bats.`,
        yesLabel: 'Start the Work', noLabel: 'Trust the At-Bats', yesEffect: { morale: -1 }, noEffect: {},
        yesMsg: 'We start tomorrow at one.', noMsg: 'We\'ll leave it alone.', autoResolve: 'no', _raw: { onYes: 'offday_session', _trainGain: 1 } };
    } },

  // A booking of the ballpark while we were away: they want to come back.
  { key: 'event_back', from: ['rv1', 'rv2', 'rv4', 'rv6', 'rv7', 'rv8', 'rv9', 'rv10', 'rv11'], choices: ['yes'], days: [150, 420],
    fits: (st, e) => (IN_SEASON.has(st.phase) && e.r > 0 ? {} : null),
    build: (st, e) => {
      const k = _k(e.r * CB.backShare);
      return { sender: 'Partnerships', avatar: '📅', tag: 'REVENUE', _revenueK: k,
        subject: `${EVENT_WHAT[e.id][0].toUpperCase()}${EVENT_WHAT[e.id].slice(1)}, again?`,
        preview: `${EVENT[e.id][0].toUpperCase()}${EVENT[e.id].slice(1)} asked to come back…`,
        body: `${EVENT[e.id][0].toUpperCase()}${EVENT[e.id].slice(1)} asked to come back — ${EVENT_WHAT[e.id]} at the ballpark while we're on the road, like last ${monthOf(e.at)}. This time they're offering ${_fmt(k)}. Same field, same risks as before. Or we pass and keep the ballpark quiet.`,
        yesLabel: 'Book Them Again', noLabel: 'Pass This Time', yesEffect: { atmo: 1 }, noEffect: {},
        yesMsg: 'Booked. They were glad to hear it.', noMsg: 'Passed. We thanked them for asking.', autoResolve: 'no' };
    } },

  // A player's family in their hometown, seated last time: the next visit.
  { key: 'hometown', from: ['rd3'], choices: ['yes'], days: [20, 400],
    fits: (st, e, atMs, next) => (ours(st, e.p) && next && !next.isHome && next.opener && hometownPlayer(st, next.opponent)?.id === e.p ? { opp: next.opponent } : null),
    build: (st, e, { opp }) => {
      const p = st.players[e.p], k = e.k || 10;
      return { sender: 'Travel Coordinator', avatar: '✈️', tag: 'CULTURE', _budgetCost: k, _targetPlayerId: p.id, _tokenPlayers: { pl_player: p.id },
        subject: `${p.name}'s family, again`, preview: `We're back near ${p.name}'s hometown, and the family asked…`,
        body: `We're back near ${p.name}'s hometown for the series against the ${opp}, and the family asked whether they could have the same seats as last ${monthOf(e.at)} — ${_fmt(k)}, same as before. Or they find their own this time.`,
        yesLabel: 'Same Seats', noLabel: 'Their Own This Time', yesEffect: { morale: 1 }, noEffect: {},
        yesMsg: 'Same block, same visit after BP.', noMsg: 'They\'ll find their own.', autoResolve: 'no', _raw: { _relYes: { pl_nm: 2 }, _relNo: { pl_nm: -1 } } };
    } },

  // A player who came over in a trade: how it's gone.
  { key: 'trade', from: null, match: (e) => /^trade_/.test(e.id || '') && e.c === 'yes', choices: ['yes'], days: [25, 45],
    fits: (st, e) => { const p = st.players[e.p]; if (!ours(st, e.p)) return null; const x = since(p, e.at); return enough(p, x) ? { x } : null; },
    build: (st, e, { x }) => {
      const p = st.players[e.p], t = club(st, e.tm);
      return news({ sender: 'Pro Scouting', avatar: '📊', tag: 'TRADE', _targetPlayerId: p.id,
        subject: `${p.name}, since the trade`, preview: `Since coming over${t ? ` from the ${t.name}` : ''} in ${monthOf(e.at)}…`,
        body: `Since coming over${t ? ` from the ${t.name}` : ''} in ${monthOf(e.at)}, ${p.name} ${doing(p, x)}. ${good(p, x) ? 'So far the trade looks like a good one.' : bad(p, x) ? 'It hasn\'t worked yet. We\'re watching it.' : 'About what we expected.'}` });
    } },

  // A player we let go in the winter, playing somewhere else.
  { key: 'gone', from: ['os_resign'], choices: ['no', 'auto'], days: [40, 200],
    fits: (st, e) => {
      const p = st.players[e.p];
      if (!p || !IN_SEASON.has(st.phase) || p.teamId === 'user' || !club(st, p.teamId)) return null;
      const x = p.stats || {};
      return (isP(p) ? (x.ip || 0) >= 30 : (x.ab || 0) >= 80) ? { x } : null;
    },
    build: (st, e, { x }) => {
      const p = st.players[e.p], t = club(st, p.teamId);
      return news({ sender: 'Pro Scouting', avatar: '📊', tag: 'ROSTER',
        subject: `${p.name}, with the ${t.name}`, preview: `${p.name}, who left us in the winter, is playing for the ${t.name}…`,
        body: `${p.name}, who we let go in the winter, ${doing(p, x)} for the ${t.name} this season. ${good(p, x) ? 'It stings a little.' : bad(p, x) ? 'It looks like the right call.' : 'About what we thought they\'d be.'}` });
    } },

  // A player we re-signed in the winter: how the deal is going.
  { key: 'kept', from: ['os_resign'], choices: ['yes'], days: [40, 200],
    fits: (st, e) => {
      const p = st.players[e.p];
      if (!ours(st, e.p) || !IN_SEASON.has(st.phase)) return null;
      const x = p.stats || {};
      return (isP(p) ? (x.ip || 0) >= 30 : (x.ab || 0) >= 80) ? { x } : null;
    },
    build: (st, e, { x }) => {
      const p = st.players[e.p];
      return news({ sender: 'Pro Scouting', avatar: '📊', tag: 'ROSTER', _targetPlayerId: p.id,
        subject: `${p.name}'s new deal`, preview: `The deal we gave ${p.name} in the winter…`,
        body: `The deal we gave ${p.name} in the winter: ${line(p, x)} so far. ${good(p, x) ? 'Money well spent.' : bad(p, x) ? 'Not what we paid for, yet.' : 'About what we paid for.'}` });
    } },

  // The exit meeting: we said we'd look at a bigger role.
  { key: 'exit', from: ['wt_exit'], choices: ['yes'], days: [40, 220],
    fits: (st, e) => {
      if (!ours(st, e.p) || st.phase !== PHASE.REGULAR_SEASON) return null;
      const G = (st.schedule || []).filter(g => g._committed && !g.isSpring && !g.isPlayoff).length;
      return G >= 25 ? { g: st.players[e.p].stats?.g || 0, G } : null;
    },
    build: (st, e, { g, G }) => {
      const p = st.players[e.p];
      if (g >= 0.6 * G) return news({ sender: mgr(st), avatar: '📋', tag: 'CULTURE', _targetPlayerId: p.id, _tokenPlayers: { pl_player: p.id },
        subject: `${p.name} got the bigger role`, preview: `${p.name} has played ${g} of our ${G} games…`,
        body: `Remember the exit meeting, when ${p.name} asked for a bigger role? They've played ${g} of our ${G} games. They noticed, and so did the rest of the room.`, yesEffect: { morale: 1 }, _raw: { _relYes: { pl_nm: 1 } } });
      return { sender: mgr(st), avatar: '📋', tag: 'CULTURE', _targetPlayerId: p.id, _tokenPlayers: { pl_player: p.id },
        subject: `${p.name} and the bigger role`, preview: `${p.name} reminded me about the exit meeting…`,
        body: `${p.name} reminded me about the exit meeting — we said we'd look at a bigger role. They've played ${g} of our ${G} games. I can tell them it's still coming if they keep working, or tell them where they stand now — better they hear that from me than from the lineup card.`,
        yesLabel: 'It\'s Still Coming', noLabel: 'Tell Them Where They Stand', yesEffect: {}, noEffect: {},
        yesMsg: 'I told them. They\'ll hold you to it.', noMsg: 'I told them. It was a hard conversation, but a clean one.',
        autoResolve: 'no', _raw: { _relYes: { pl_nm: 1 }, _relNo: { pl_nm: -2, mgr_nm: 1 } } };
    } },

  // Extra work we approved for a player (a camp, a program, a session): how it took, once it's done.
  { key: 'work', from: null, match: (e) => !!e.p && e.c === 'yes', choices: ['yes'], days: [20, 120],
    fits: (st, e) => {
      if (!ours(st, e.p)) return null;
      const plan = (st.developmentPlans || []).find(x => x.playerId === e.p && x.source === e.id && Math.abs((x.createdAt || 0) - e.at) < DAY && x.status !== 'active');
      return plan ? { took: (plan.applied || 0) >= 1 } : null;
    },
    build: (st, e, { took }) => {
      const p = st.players[e.p];
      return news({ sender: isP(p) ? coach(st, 'pitchingCoach', 'Pitching Coach') : coach(st, 'hittingCoach', 'Hitting Coach'), avatar: '🏋️', tag: 'TRAINING', _targetPlayerId: p.id,
        subject: `${p.name}'s extra work`, preview: `The work you approved for ${p.name} in ${monthOf(e.at)} is done…`,
        body: took ? `The work you approved for ${p.name} in ${monthOf(e.at)} is done, and it took: they're a better player for it. They know who signed off on it.`
                   : `The work you approved for ${p.name} in ${monthOf(e.at)} is done. It didn't take this time — nothing we can see in their game yet. It happens.`,
        ...(took ? { _raw: { _relYes: { pl_nm: 1 } }, _tokenPlayers: { pl_player: p.id } } : {}) });
    } },

  // A free agent we signed: how it's going.
  { key: 'signed', from: ['os_free_agent'], choices: ['yes'], days: [40, 200],
    fits: (st, e) => {
      const p = st.players[e.p];
      if (!ours(st, e.p) || !IN_SEASON.has(st.phase)) return null;
      const x = p.stats || {};
      return (isP(p) ? (x.ip || 0) >= 30 : (x.ab || 0) >= 80) ? { x } : null;
    },
    build: (st, e, { x }) => {
      const p = st.players[e.p];
      return news({ sender: 'Pro Scouting', avatar: '📊', tag: 'ROSTER', _targetPlayerId: p.id,
        subject: `${p.name}, since we signed them`, preview: `${p.name}, signed in the winter…`,
        body: `${p.name}, who we signed in the winter, ${doing(p, x)} so far. ${good(p, x) ? 'The signing looks like a good one.' : bad(p, x) ? 'Not what we signed them for, yet.' : 'About what we expected.'}` });
    } },

  // Winter ball: did it carry over?
  { key: 'winterball', from: ['wt_winterball'], choices: ['yes'], days: [40, 200],
    fits: (st, e) => {
      const p = st.players[e.p];
      if (!ours(st, e.p) || !IN_SEASON.has(st.phase) || (p.stats?.ab || 0) < 60) return null;
      const plan = (st.developmentPlans || []).filter(x => x.playerId === p.id && x.source === 'wt_winterball').at(-1);
      return plan ? { gain: plan.applied || 0 } : null;
    },
    build: (st, e, { gain }) => {
      const p = st.players[e.p], x = p.stats;
      return news({ sender: coach(st, 'hittingCoach', 'Hitting Coach'), avatar: '🎯', tag: 'TRAINING', _targetPlayerId: p.id,
        subject: `${p.name}'s winter ball`, preview: `The winter ball ${gain >= 1 ? 'paid off' : 'didn\'t carry over'}…`,
        body: gain >= 1 ? `The winter ball paid off: ${p.name} came back a better hitter, and it shows — ${line(p, x)} so far.`
                        : `The winter ball didn't carry over the way I hoped. ${p.name} is at ${line(p, x)} so far. It happens; we'll keep working.` });
    } },
];

export const useKey = (cb, e) => `${cb.key}:${e.s}:${e.at}`;
export const playerKey = (cb, e) => `${cb.key}@${e.p}`;

/** Our next game, and whether it opens a series. */
function nextGame(state) {
  const sched = state.schedule || [];
  const i = sched.findIndex(g => !g._committed && !g.cancelled && Number.isFinite(g.gameTime));
  return i < 0 ? null : { ...sched[i], opener: i === 0 || sched[i - 1].opponent !== sched[i].opponent || !!sched[i - 1].isHome !== !!sched[i].isHome };
}

/** A callback due now (the decision in its window, its people still around, not yet used), picked by `rand`. */
export function pickCallback(state, atMs, rand) {
  const used = state.callbacks?.used || {};
  const next = nextGame(state);
  const found = [];
  for (const e of state.gmRecord?.log || []) {
    for (const cb of CALLBACKS) {
      if (cb.match ? !cb.match(e) : !cb.from.includes(e.id)) continue;
      if (!cb.choices.includes(e.c)) continue;
      const age = (atMs - e.at) / DAY;
      if (age < cb.days[0] || age > cb.days[1] || used[useKey(cb, e)] != null) continue;
      if (e.p && atMs - (used[playerKey(cb, e)] ?? -Infinity) < CB.samePlayerDays * DAY) continue;   // (not the same story about the same player again soon)
      const ctx = cb.fits(state, e, atMs, next);
      if (ctx) found.push({ cb, e, ctx });
    }
  }
  if (!found.length) return null;
  return found[Math.floor(rand() * found.length)];
}
