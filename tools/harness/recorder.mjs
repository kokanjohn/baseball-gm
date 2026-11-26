/**
 * tools/harness/recorder.mjs
 * DEV/TEST ONLY — §122.168 the record: exactly what a fixed-dice run produced.
 *
 * Reads the state only (never mutates it, never draws a random number), so recording doesn't change the run.
 *   - every message: what it is, when it was planned and arrived, who sent it, what it said (subject in clear,
 *     the rest as a short hash), its deadline, and how it ended (the answer, when, by the GM or by the clock);
 *   - every game of every season, ours and the league's: the teams, the status, the score, and a hash of the box;
 *   - at each season's end: the standings, a hash of every player and of our club.
 *
 * multi-season.mjs calls note() as it plays and season() at each season's end; RECORD=file writes the record.
 * check-record.mjs compares a fresh run with the one kept in tools/harness/records/.
 */
import { createHash } from 'node:crypto';

const h = (v) => createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex').slice(0, 12);

const messages = new Map();   // instanceId → record (first seen, then its ending)
const seasons = [];

/** What a message is and says (fixed at arrival). */
function said(c) {
  return {
    id: c.instanceId, card: c.cardId ?? null, season: c._season ?? null,
    planned: c.deliverAtMs ?? null, arrived: c.arrivedAtMs ?? null, expires: c.expiresAtMs ?? null,
    sender: c.sender ?? null, subject: c.subject ?? null,
    text: h([c.preview, c.body, c.yesLabel, c.noLabel, (c._choices || []).map(x => [x.key, x.label]), c.yesMsg, c.noMsg]),
  };
}
/** How it ended. */
function ended(c) {
  return { choice: c.choice ?? null, pick: c._pick ?? null, resolvedAt: c.resolvedAtMs ?? null,
           auto: !!c.autoResolved, impact: c._impact ? h(c._impact) : null };
}

/** Look at the inbox: note each new message, and each one's ending once it has one. */
export function note(state) {
  // Planned (not here yet): noted so a message withdrawn before it arrived is part of the record too.
  for (const c of state.scheduledCards || []) {
    if (c?.instanceId && !messages.has(c.instanceId)) messages.set(c.instanceId, { ...said(c), arrived: null, planned: c.deliverAtMs ?? null });
  }
  for (const c of state.inbox || []) {
    if (!c?.instanceId) continue;
    let r = messages.get(c.instanceId);
    if (!r || r.arrived == null) { r = { ...said(c), ...(r ? { planned: r.planned } : {}) }; messages.set(c.instanceId, r); }
    if (c.resolved && !r.end) r.end = ended(c);
  }
}

/** A season's end: every game, the standings, the players and our club. */
export function season(state) {
  note(state);
  const game = (g, ours) => ({
    id: g.id ?? g.index ?? null, t: g.gameTime ?? null, date: g.date ?? null,
    home: ours ? (g.isHome ? 'user' : g.opponentId ?? null) : g.homeId ?? null,
    away: ours ? (g.isHome ? g.opponentId ?? null : 'user') : g.awayId ?? null,
    status: g.status ?? null, played: !!(g.played || g._committed),
    score: ours ? [g.ourScore ?? null, g.theirScore ?? null, g.result ?? null] : [g.homeScore ?? null, g.awayScore ?? null],
    gate: ours ? null : [g.attendance ?? null, g.gateK ?? null],
    box: g.boxScore ? h(g.boxScore) : null,
  });
  const league = [];
  for (const [day, list] of Object.entries(state.leagueSchedule?.dayMap || {})) for (const g of list || []) league.push({ day, ...game(g, false) });
  const players = {};
  for (const [id, p] of Object.entries(state.players || {})) players[id] = h(p);
  seasons.push({
    season: state.seasonNum ?? null, phase: state.phase ?? null,
    ours: (state.schedule || []).map(g => game(g, true)),
    league,
    standings: [{ id: 'user', w: state.userTeam?.wins, l: state.userTeam?.losses },
                ...(state.leagueTeams || []).map(t => ({ id: t.id, w: t.wins, l: t.losses }))],
    club: h(state.userTeam), players,
  });
}

/** The whole record. */
export function record(meta = {}) {
  return { ...meta, messages: [...messages.values()], seasons };
}
