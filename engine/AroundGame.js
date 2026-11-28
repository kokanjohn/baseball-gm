/**
 * engine/AroundGame.js
 * r297 §122.183 Around the game, the first set (§122.182): the situations that call for one of its messages
 * (data/cards-around.js), and each one's facts.
 *
 *   scout   the next game opens a regular-season series: the advance scout's report (every series, the user's choice)
 *   form    a player of ours on a run over his last games: a hot bat, a hot arm, a cold arm (a cold bat is the
 *           manager's slump message, Situations.js)
 *   crowd   a soft stretch of crowds, or a run of sellouts, at our park
 *   media   our last game was a big one: a walk-off, a shutout, a win in extra innings, a blowout either way
 *   memory  r298 §122.185 a warm party offers a favor, a cool or sour one pulls back (Memory.js)
 *
 *   aroundCandidates(state, context, atMs) → [{ id, kind, key, rank, facts: { values, amountsK }, preset, segment }]
 *     most timely first. `preset` names the player the message is about (the usual role tokens).
 *   aroundSegment(state, context) → 'spring' | 'season' | 'stretch' (the part of the year a budget is kept for)
 *   noteAround(draft, cand, atMs)  records a sent one (inside a mutate): its key, and the part of the year's count.
 *
 * The year is budgeted (AROUND.budget, the user's choice): each kind may take so many in spring, in the season and
 * in the stretch run, so the late season isn't bare. State: s.around = { season, done: { key: ms }, n: { kind:
 * { spring, season, stretch } } }, this season's only.
 * PURE: no StateManager.
 */
import { AROUND, PHASE, PLAYER_GROUP } from '../data/constants.js';
import { AROUND_POOL } from '../data/cards-around.js';
import { sameOpponent } from './Opponents.js';
import { dice, diceSeed } from './Dice.js';
import { partiesWithRecord, standingOf, partyName, kindOf } from './Memory.js';   // r298 §122.185
import { MEMORY } from '../data/parties.js';

const DAY = 86_400_000;
const isP = (p) => p?.pos === 'SP' || p?.pos === 'RP';
const ACTIVE = new Set([PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS, PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN]);
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n) => WORDS[n] ?? String(n);
const plural = (n, w) => `${word(n)} ${w}${n === 1 ? '' : 's'}`;
const avg3 = (h, ab) => (ab ? (h / ab).toFixed(3).replace(/^0/, '') : '.000');
const eraOf = (er, ip) => (ip ? (er * 9) / ip : 0);
const ipText = (ip) => { const outs = Math.round(ip * 3), w = Math.floor(outs / 3), f = outs % 3; return f ? `${w} ${f}/3` : String(w); };
const an = (x) => (/^(8|11|18)(\.|$)/.test(x) ? `an ${x}` : `a ${x}`);
const kFmt = (k) => (k >= 1000 ? `$${(k / 1000).toFixed(k % 1000 === 0 ? 0 : 1)}M` : `$${k}K`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The definitions, by id. */
export const AROUND_DEFS = Object.freeze(Object.fromEntries(AROUND_POOL.map(d => [d.id, d])));

/** A player's last `n` log entries, summed. */
function recent(p, n) {
  const log = (p?._impGameLog || []).slice(-n);
  const sum = { games: log.length };
  for (const e of log) for (const [k, v] of Object.entries(e.stats || {})) if (typeof v === 'number') sum[k] = (sum[k] || 0) + v;
  return sum;
}

/** The part of the year a budget is kept for. */
export function aroundSegment(state, context = {}) {
  if (state?.phase === PHASE.SPRING_TRAINING) return 'spring';
  return context?.nextGame?.isStretchRun ? 'stretch' : 'season';
}

/** This season's record of what was sent (read-only). */
function logOf(state) {
  const a = state?.around;
  return a && a.season === (state.seasonNum || 1) ? a : { done: {}, n: {} };
}

/** Record a sent one (inside a mutate). */
export function noteAround(draft, cand, atMs) {
  const season = draft.seasonNum || 1;
  if (!draft.around || draft.around.season !== season) draft.around = { season, done: {}, n: {} };
  for (const k of [cand.key, ...(cand.also || [])]) draft.around.done[k] = atMs;
  const n = (draft.around.n[cand.kind] ||= { spring: 0, season: 0, stretch: 0 });
  n[cand.segment] = (n[cand.segment] || 0) + 1;
}

/** Is one of this kind waiting (unanswered or on its way)? */
function waiting(state, kind) {
  const ids = new Set(AROUND_POOL.filter(d => d._around === kind).map(d => d.id));
  return [...(state.inbox || []).filter(c => !c.resolved), ...(state.scheduledCards || [])].some(c => ids.has(c.cardId));
}

/** The opponent's hot bat and arm (their last week), or null. */
function opponentForm(state, teamId) {
  const team = (state.leagueTeams || []).find(t => t.id === teamId);
  if (!team) return null;
  const players = (team.rosterIds || []).map(id => state.players?.[id]).filter(Boolean);
  let bat = null, arm = null;
  for (const p of players) {
    if (isP(p)) {
      const r = recent(p, p.pos === 'SP' ? 3 : 6);
      if ((r.ip || 0) < 6) continue;
      const e = eraOf(r.er || 0, r.ip);
      if (!arm || e < arm.era) arm = { p, era: e, ip: r.ip };
    } else {
      const r = recent(p, AROUND.formGames);
      if ((r.ab || 0) < 15) continue;
      const a = (r.h || 0) / r.ab + (r.hr || 0) * 0.01;
      if (!bat || a > bat.score) bat = { p, score: a, h: r.h || 0, ab: r.ab, hr: r.hr || 0, games: r.games };
    }
  }
  if (!bat || !arm) return null;
  return { team, bat, arm };
}

/** The scouting report: the next game opens a regular-season series. */
function scoutCandidate(state, context, atMs, log) {
  const g = context?.nextGame;
  if (!g || g.isSpring || g.isPlayoff || state.phase === PHASE.SPRING_TRAINING) return null;
  const sched = state.schedule || [];
  const i = sched.indexOf(g);
  const prev = i > 0 ? sched[i - 1] : null;
  const opener = !prev || prev.isSpring || !sameOpponent(prev, g) || !!prev.isHome !== !!g.isHome;
  if (!opener) return null;
  const key = `scout:${g.seriesId || g.gameTime}`;
  if (log.done[key] != null) return null;
  const f = opponentForm(state, g.opponentId);
  if (!f) return null;
  const rand = dice(diceSeed(state), 'around', key);
  const [lo, hi] = AROUND.scoutCostK;
  const costK = Math.max(5, Math.round((lo + rand() * (hi - lo)) / 5) * 5);
  const len = g.seriesLength || 3;
  const values = {
    opp_club: `the ${f.team.name}`,
    opp_club_cap: `The ${f.team.name}`,
    opp_record: `${f.team.wins || 0}–${f.team.losses || 0}`,
    series_len: word(len),
    series_where: g.isHome ? 'here' : 'in their park',
    opp_bat: f.bat.p.name,
    opp_bat_line: `${f.bat.h}-for-${f.bat.ab}${f.bat.hr ? ` with ${plural(f.bat.hr, 'homer')}` : ''} over the last ${word(f.bat.games)} games`,
    opp_arm: f.arm.p.name,
    opp_arm_line: `${an(f.arm.era.toFixed(2))} ERA over the last ${ipText(f.arm.ip)} innings`,
    scout_cost: kFmt(costK),
  };
  return { id: 'ag_scout', kind: 'scout', key, rank: 0, facts: { values, amountsK: { scout_cost: costK } }, preset: null };
}

/** A player of ours on a run. */
function formCandidate(state, context, atMs, log) {
  const since = (k, days) => log.done[k] == null || atMs - log.done[k] >= days * DAY;
  if (!since('form', AROUND.formTeamGapDays)) return null;
  const starting = new Set((state.userTeam?.lineupSlots || []).map(s => s?.playerId).filter(Boolean));
  let best = null;
  for (const id of state.userTeam?.rosterIds || []) {
    const p = state.players?.[id];
    if (!p || !ACTIVE.has(p.group) || p.isInjured || !since(`form:${p.id}`, AROUND.formGapDays)) continue;
    if (isP(p)) {
      const r = recent(p, p.pos === 'SP' ? 3 : 7);
      if ((r.ip || 0) < AROUND.minIp) continue;
      const e = eraOf(r.er || 0, r.ip);
      const line = `${an(e.toFixed(2))} ERA over the last ${ipText(r.ip)} innings`;
      if (e <= AROUND.hotEra) { const s = (AROUND.hotEra - e) + 1; if (!best || s > best.s) best = { s, id: 'ag_form_arm_hot', p, line, role: 'active_pitcher' }; }
      else if (e >= AROUND.coldEra) { const s = (e - AROUND.coldEra) / 3 + 1; if (!best || s > best.s) best = { s, id: 'ag_form_arm_cold', p, line, role: 'active_pitcher' }; }
    } else if (starting.has(p.id)) {
      const r = recent(p, AROUND.formGames);
      if ((r.ab || 0) < AROUND.minAb) continue;
      const a = (r.h || 0) / r.ab;
      if (a < AROUND.hotAvg) continue;
      const s = (a - AROUND.hotAvg) * 10 + 1;
      const line = `${r.h}-for-${r.ab}${r.hr ? ` with ${plural(r.hr, 'homer')}` : ''} (${avg3(r.h, r.ab)}) over the last ${word(r.games)} games`;
      if (!best || s > best.s) best = { s, id: 'ag_form_bat', p, line, role: 'active_hitter' };
    }
  }
  if (!best) return null;
  return { id: best.id, kind: 'form', key: `form:${best.p.id}`, also: ['form'], rank: 2, facts: { values: { form_line: best.line }, amountsK: {} }, preset: { [best.role]: best.p.id } };
}

/** Our crowds: soft, or selling out. */
function crowdCandidate(state, context, atMs, log) {
  if (state.phase === PHASE.SPRING_TRAINING) return null;
  if (log.done.crowd != null && atMs - log.done.crowd < AROUND.crowdGapDays * DAY) return null;
  const homes = (state.schedule || []).filter(g => g._committed && g.isHome && !g.isSpring && !g.isPlayoff && g.attendance);
  const last = homes.slice(-AROUND.crowdGames);
  if (last.length < AROUND.crowdGames) return null;
  const newest = last[last.length - 1];
  if (!Number.isFinite(newest.endedAt) || atMs - newest.endedAt > 2 * DAY) return null;   // (fresh: the homestand just played)
  const capacity = state.userTeam?.finances?.market?.capacity || 0;
  if (!capacity) return null;
  const avg = Math.round(last.reduce((a, g) => a + g.attendance, 0) / last.length);
  const sellouts = last.filter(g => g.sellout).length;
  const values = { crowd_games: word(last.length), crowd_avg: avg.toLocaleString('en-US'), capacity: capacity.toLocaleString('en-US'), sellouts: cap(word(sellouts)) };
  if (sellouts >= AROUND.sellouts) return { id: 'ag_crowd_hot', kind: 'crowd', key: `crowd:${newest.gameTime}`, also: ['crowd'], rank: 3, facts: { values, amountsK: {} }, preset: null };
  if (avg / capacity <= AROUND.softFill) return { id: 'ag_crowd_soft', kind: 'crowd', key: `crowd:${newest.gameTime}`, also: ['crowd'], rank: 3, facts: { values, amountsK: {} }, preset: null };
  return null;
}

/** Was our last game a big one? */
function mediaCandidate(state, context, atMs, log) {
  if (log.done.media != null && atMs - log.done.media < AROUND.mediaGapDays * DAY) return null;
  const played = (state.schedule || []).filter(g => g._committed && !g.isPlayoff && g.result && g.result !== 'postponed' && g.score);
  const g = played[played.length - 1];
  if (!g || !Number.isFinite(g.endedAt) || atMs - g.endedAt > 18 * 3_600_000) return null;
  const key = `media:${g.gameTime}`;
  if (log.done[key] != null) return null;
  const us = g.score.us, them = g.score.them;
  const opp = g.opponent || 'them';
  let id = null, line = null;
  const ls = g.boxScore?.linescore || {};
  const lastInn = Math.max(0, ...Object.keys(ls).map(Number).filter(Number.isFinite));
  const walkoff = g.isHome && us > them && lastInn >= 9 && (us - (ls[lastInn]?.bot || 0)) <= them;
  if (walkoff) { id = 'ag_media_win'; line = `the walk-off win over the ${opp}`; }
  else if (us > them && them === 0) { id = 'ag_media_win'; line = `the ${us}–0 shutout of the ${opp}`; }
  else if (AROUND.extras && us > them && lastInn >= 10) { id = 'ag_media_win'; line = `the ${lastInn}-inning win over the ${opp}`; }
  else if (us - them >= AROUND.blowout) { id = 'ag_media_win'; line = `the ${us}–${them} win over the ${opp}`; }
  else if (them - us >= AROUND.blowout) { id = 'ag_media_loss'; line = `the ${them}–${us} loss to the ${opp}`; }
  if (!id) return null;
  return { id, kind: 'media', key, also: ['media'], rank: 1, facts: { values: { game_line: line, game_line_cap: cap(line) }, amountsK: {} }, preset: null };
}

/**
 * r298 §122.185 Memory: a warm party offers a favor; a cool or sour one pulls back. The most strongly felt party, not
 * heard from this way in `MEMORY.partyGapDays`; clubs wait for the rivals release.
 */
function memoryCandidate(state, context, atMs, log) {
  if (log.done.memory != null && atMs - log.done.memory < AROUND.memoryGapDays * DAY) return null;
  let best = null;
  for (const party of partiesWithRecord(state)) {
    const kind = kindOf(party);
    if (!kind || kind === 'club') continue;
    const k = `mem:${party}`;
    if (log.done[k] != null && atMs - log.done[k] < MEMORY.partyGapDays * DAY) continue;
    const st = standingOf(state, party, atMs);
    if (st.standing === 'neutral') continue;
    if (!best || Math.abs(st.score) > Math.abs(best.st.score)) best = { party, kind, st };
  }
  if (!best) return null;
  const warm = best.st.standing === 'warm';
  const id = `mem_${warm ? 'favor' : 'cold'}_${best.kind}`;
  const name = partyName(state, best.party);
  const rand = dice(diceSeed(state), 'around', 'mem', best.party, String(log.done[`mem:${best.party}`] || 0));
  const range = warm ? AROUND.favorK : AROUND.mendK[best.kind] || [0, 0];
  const k = range[1] ? Math.max(5, Math.round((range[0] + rand() * (range[1] - range[0])) / 5) * 5) : 0;
  const values = { party_name: name, party_name_cap: cap(name), ...(best.st.moment ? { party_moment: best.st.moment } : {}), ...(warm ? { favor_amt: kFmt(k) } : { mend_cost: kFmt(k) }) };
  return { id, kind: 'memory', key: `mem:${best.party}`, also: ['memory'], rank: 4, party: best.party,
           facts: { values, amountsK: warm ? { favor_amt: k } : { mend_cost: k } }, preset: null };
}

/**
 * The situations calling for one of the set now, most timely first; each within its part of the year's budget and
 * with none of its kind waiting.
 */
export function aroundCandidates(state, context = {}, atMs) {
  const log = logOf(state);
  const segment = aroundSegment(state, context);
  const out = [];
  for (const find of [scoutCandidate, mediaCandidate, formCandidate, crowdCandidate, memoryCandidate]) {
    const c = find(state, context, atMs, log);
    if (!c) continue;
    const budget = AROUND.budget[c.kind]?.[segment] ?? 0;
    if ((log.n[c.kind]?.[segment] || 0) >= budget) continue;
    if (waiting(state, c.kind)) continue;
    out.push({ ...c, segment });
  }
  return out.sort((a, b) => a.rank - b.rank);
}
