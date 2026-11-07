/**
 * tools/harness/multi-season.mjs
 * DEV/TEST ONLY — §112.6 Phase F: several seasons in a row, one franchise.
 *
 * Plays every game, the postseason and the whole offseason, season after
 * season, with a simple GM answering cards (yes, no, or leaving some for the
 * deadline), and checks what has to hold at every turn of the year: the
 * calendar's flip from the last out to March 14, the league year and ages,
 * the rosters, the staff, the books, the offseason's decisions all settled,
 * and the league's integrity.
 *
 *   node tools/harness/multi-season.mjs [seasons=3] [seed=1]     ARCH=ember|contender|empire|…
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve as resolveCard, getInbox } from '../../engine/CardEngine.js';
import * as Offseason from '../../engine/OffseasonEngine.js';
import * as Finance from '../../engine/FinanceEngine.js';
import * as Coach from '../../engine/CoachEngine.js';
import { eligibleSlotsFor } from '../../engine/RosterEngine.js';
import { computeAge, baseballYear } from '../../engine/PlayerFactory.js';
import { baseballDateIso, springStartIso } from '../../engine/WeatherClimate.js';
import { writeFileSync } from 'node:fs';
import { GAME_STATUS, PHASE, ROSTER_LIMITS, PLAYER_GROUP, OFFSEASON_DAYS } from '../../data/constants.js';

const SEASONS = parseInt(process.argv[2] || '3', 10);
const SEED = parseInt(process.argv[3] || '1', 10);
const ARCH = process.env.ARCH || 'contender';
let pass = 0, fail = 0;
const fails = [];
const check = (name, ok, info = '') => {
  if (ok) pass++; else { fail++; fails.push(name); }
  if (!ok || process.env.VERBOSE) console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const say = (s) => console.log(s);

// ── A simple GM: answers most cards, leaves some for their deadline ──
const seen = new Set();
const tally = {};
function gmActs() {
  for (let guard = 0; guard < 60; guard++) {
    const c = getInbox().find(x => !seen.has(x.instanceId) && !(x._seed && x._tradeOffer)
      && (x.autoResolve === 'roster' || !!x._rosterKey || (!!x._tradeOffer && !x._seed)));
    if (!c) break;
    seen.add(c.instanceId);
    const r = Math.random();
    const ans = r < 0.45 ? 'yes' : r < 0.78 ? 'no' : null;   // ~1 in 5 left for the deadline
    tally[c.cardId] = tally[c.cardId] || { yes: 0, no: 0, left: 0 };
    tally[c.cardId][ans || 'left']++;
    if (ans) resolveCard(c.instanceId, ans);
  }
}

/**
 * MANAGER=1: the GM plays the best nine and the best five before every game
 * (what a real GM does by hand on the Team screen): healthy, active players
 * only, scarcest positions first. Without it, the lineup is only ever patched
 * by the engine (an injury's replacement keeps the job).
 */
const MANAGE = !!process.env.MANAGER;
function manage() {
  if (!MANAGE) return;
  SM.mutate(s => {
    const u = s.userTeam, P = (id) => s.players[id];
    const ok = (p) => p && !p.isInjured && p.group !== PLAYER_GROUP.IL && p.group !== PLAYER_GROUP.IN_TRANSIT && p.teamId === 'user';
    const hitters = u.rosterIds.map(P).filter(p => ok(p) && p.pos !== 'SP' && p.pos !== 'RP');
    const used = new Set();
    const slots = (u.lineupSlots || []).map(sl => ({ ...sl, playerId: null, emergency: false }));
    const order = [...slots.keys()].sort((a, b) => hitters.filter(p => eligibleSlotsFor(p).includes(slots[a].slot)).length
                                                 - hitters.filter(p => eligibleSlotsFor(p).includes(slots[b].slot)).length);
    for (const i of order) {
      const best = hitters.filter(p => !used.has(p.id) && eligibleSlotsFor(p).includes(slots[i].slot)).sort((a, b) => b.ovr - a.ovr)[0];
      if (best) { slots[i].playerId = best.id; used.add(best.id); }
    }
    if (slots.every(sl => sl.playerId)) {
      u.lineupSlots = slots;   // (lineupSlots is the source of truth; hitters stay in the bench-hitters group)
    }
    const sps = u.rosterIds.map(P).filter(p => ok(p) && p.pos === 'SP').sort((a, b) => b.ovr - a.ovr);
    if (sps.length >= 5) {
      const five = sps.slice(0, 5).map(p => p.id);
      u.rotation = { ...(u.rotation || {}), order: five, currentIndex: (u.rotation?.currentIndex || 0) % 5 };
      for (const p of sps) p.group = five.includes(p.id) ? PLAYER_GROUP.STARTING_PITCHERS : PLAYER_GROUP.PITCHER_BENCH;
    }
  });
}

function stepTo(t) {
  for (let guard = 0; guard < 400; guard++) {
    const next = (SM.get().scheduledCards || []).map(c => c.deliverAtMs).filter(x => x > clock.get() && x < t).sort((a, b) => a - b)[0];
    if (next === undefined) break;
    clock.set(next + 1000); advanceClock(clock.get()); releaseDueCards(); gmActs();
  }
}

function playToFinal(idx) {
  for (let guard = 0; guard < 6000; guard++) {
    const g = SM.get().schedule[idx];
    if (!g) return false;
    if (g.status === GAME_STATUS.FINAL) return true;
    if (g.status === GAME_STATUS.POSTPONED && g.cancelled) return true;
    if (g.status === GAME_STATUS.SCHEDULED || g.status === GAME_STATUS.PRE_GAME_WATCH
        || (g.status === GAME_STATUS.SUSPENDED && g.gameTime > clock.get())) {
      advanceClock(clock.get()); releaseDueCards(); gmActs();
      const id0 = g.id, t0 = g.gameTime;
      stepTo(t0 || clock.get());
      const now = SM.get().schedule[idx];
      if (!now || now.id !== id0 || now.gameTime !== t0) continue;
      clock.set((t0 || clock.get()) + 60_000);
    } else if (g.status === GAME_STATUS.LIVE) {
      const np = g.plays?.[g.livePlayIndex];
      if (np && np._timestamp) clock.set(np._timestamp + (g._tickOffset || 0) + 1_000);
      else clock.advance(60_000);
    } else clock.advance(60 * 60_000);
    tick(); releaseDueCards();
  }
  return false;
}

/** The season and the postseason, to the last out. */
async function playSeason() {
  let games = 0;
  for (let guard = 0; guard < 6000; guard++) {
    const st = SM.get();
    if (st.phase === PHASE.SEASON_SUMMARY || st.phase === PHASE.OFFSEASON) break;
    const idx = st.currentGameIndex;
    const g = st.schedule[idx];
    if (g && !g._committed) {
      if (g.status === GAME_STATUS.SCHEDULED) manage();
      if (!playToFinal(idx)) { check(`season ${st.seasonNum}: game ${idx} reaches FINAL`, false, SM.get().schedule[idx]?.status); return games; }
      await commitGame(idx); releaseDueCards(); gmActs(); games++;
      continue;
    }
    // Nothing of ours left today: live the league clock to its next event.
    let next = Infinity;
    for (const cg of Object.values(st.leagueSchedule?.dayMap || {}).flat()) {
      if (cg.played) continue;
      const t = cg.status === GAME_STATUS.LIVE && cg.plays?.length ? cg.plays[cg.plays.length - 1]._timestamp : cg.gameTime;
      if (t > clock.get() - 1 && t < next) next = t;
    }
    const sched = (st.scheduledCards || []).map(c => c.deliverAtMs).filter(t => t > clock.get());
    if (sched.length) next = Math.min(next, ...sched);
    if (!Number.isFinite(next)) clock.advance(6 * 3600_000); else clock.set(next + 1000);
    advanceClock(clock.get()); releaseDueCards(); gmActs();
  }
  return games;
}

/** The offseason, hour by hour, to spring training. Returns what happened on the way. */
function playOffseason() {
  const seen = { dates: new Set(), cards: new Map(), meetingsOn: false, days: new Set() };
  for (let guard = 0; guard < 24 * (OFFSEASON_DAYS + 4); guard++) {
    if (process.env.DUMP && SM.get().offseason?.springAt && clock.get() + 3600_000 >= SM.get().offseason.springAt && SM.get().phase === PHASE.OFFSEASON)
      writeFileSync(`${process.env.DUMP}/prespring-${ARCH}-${SEED}-${SM.get().seasonNum}.json`, JSON.stringify(SM.get()));
    clock.advance(3600_000); advanceClock(clock.get()); releaseDueCards();
    const st = SM.get();
    if (st.offseason) {
      seen.days.add(Offseason.offseasonDay(st, clock.get()));
      const d = baseballDateIso(st.weatherCalendar, clock.get());
      if (d && st.phase === PHASE.OFFSEASON) seen.dates.add(d);
      if (st.offseason.meetings) seen.meetingsOn = true;
    }
    for (const c of getInbox()) if (/^(os_|fo_|lt_)/.test(c.cardId || '')) seen.cards.set(c.instanceId, c);
    gmActs();
    if (st.phase === PHASE.SPRING_TRAINING) break;
  }
  return seen;
}

// ── What has to hold when a new season opens ──
function checkTurn(prev, os, label) {
  const st = SM.get();
  if (process.env.DUMP) writeFileSync(`${process.env.DUMP}/turn-${ARCH}-${SEED}-${st.seasonNum}.json`, JSON.stringify(st));
  const N = st.seasonNum;
  const year = baseballYear(st);
  check(`${label}: season ${N} opens in spring training (phase ${st.phase})`, st.phase === PHASE.SPRING_TRAINING && N === prev.seasonNum + 1);
  check(`${label}: the league year moves on one (${prev.year} → ${year})`, year === prev.year + 1);

  // The calendar: last out (Sept/Oct) → no date through the offseason → March 14.
  const first = st.schedule[0];
  check(`${label}: the new schedule opens on March 14 (${first?.date})`, first?.date === springStartIso(year));
  check(`${label}: the calendar reads March 14 at the first pitch of spring (${baseballDateIso(st.weatherCalendar, first.gameTime)})`,
        baseballDateIso(st.weatherCalendar, first.gameTime) === springStartIso(year));
  check(`${label}: the last game was played in ${prev.lastDate?.slice(5, 7) === '10' ? 'October' : 'September'} (${prev.lastDate})`,
        /^(\d{4})-(09|10)-/.test(prev.lastDate || '') && prev.lastDate.slice(0, 4) === String(prev.year));
  check(`${label}: no baseball date during the offseason (${[...os.dates].slice(0, 3).join(',') || 'none'})`, os.dates.size === 0);
  check(`${label}: every offseason day came (${[...os.days].sort((a, b) => a - b).join(',')})`,
        Array.from({ length: OFFSEASON_DAYS }, (_, i) => i + 1).every(d => os.days.has(d)));
  const cal = st.weatherCalendar || [];
  const starts = cal.map(a => (a.kind === 'season' ? a.realStartMs : a.fromMs));
  check(`${label}: the calendar's entries run forward, one season and one offseason each (${cal.map(a => `${a.kind}:${a.season}`).join(' ')})`,
        starts.every((t, i) => i === 0 || t > starts[i - 1])
        && cal.filter(a => a.kind === 'season').length === N && cal.filter(a => a.kind === 'offseason').length === N - 1);
  check(`${label}: the schedule's dates run forward`, st.schedule.every((g, i) => i === 0 || g.date >= st.schedule[i - 1].date));

  // Ages: everyone one year older (baseball age, July 1).
  const older = Object.values(st.players).filter(p => prev.ages[p.id] != null);
  const wrong = older.filter(p => computeAge(p.dob, year) !== prev.ages[p.id] + 1);
  check(`${label}: every player is a year older (${older.length} players)`, wrong.length === 0, wrong.slice(0, 3).map(p => p.name).join(','));

  // The offseason is over and settled.
  check(`${label}: the offseason is closed (no offseason state, meetings over)`, !st.offseason);
  check(`${label}: the winter meetings ran`, os.meetingsOn);
  const open = getInbox().filter(c => /^(os_|fo_)/.test(c.cardId || '') && !c.resolved);
  check(`${label}: every offseason decision is settled (${open.length} open)`, open.length === 0, open.map(c => c.cardId).join(','));

  // Our club: a legal roster, a lineup, a rotation, a full staff, live contracts.
  const u = st.userTeam;
  const active = (u.rosterIds || []).map(id => st.players[id]).filter(p => p && p.group !== PLAYER_GROUP.IL);
  check(`${label}: our roster is legal (${(u.rosterIds || []).length} active)`, (u.rosterIds || []).length <= ROSTER_LIMITS.SPRING_TOTAL && active.length >= 24);
  check(`${label}: nine in the lineup`, (u.lineupSlots || []).filter(sl => st.players[sl.playerId]).length === 9);
  // Five turns — or every healthy starter we have, when the GM let it get thinner than five.
  const healthySP = (u.rosterIds || []).map(id => st.players[id]).filter(p => p && p.pos === 'SP' && !p.isInjured && p.group !== PLAYER_GROUP.IL).length;
  const rot = (u.rotation?.order || []).filter(id => st.players[id]).length;
  check(`${label}: five in the rotation (or every healthy starter: ${rot} of ${healthySP})`, rot === Math.min(5, healthySP));
  const expired = (u.rosterIds || []).map(id => st.players[id]).filter(p => p && (p.contractExpiry ?? 99) <= N);
  check(`${label}: nobody on our roster is playing on an expired deal`, expired.length === 0, expired.map(p => `${p.name} ${p.contractExpiry}`).join(','));
  const staff = u.coachingStaff || {};
  check(`${label}: every coaching chair is filled, every deal runs into season ${N}`,
        Coach.COACH_ROLES.every(r => staff[r] && !staff[r].vacant && staff[r].name && Number.isFinite(staff[r].quality) && staff[r].contractExpiry > N)
        && staff.manager?.name && (staff.manager.contractExpiry ?? 99) > N,
        JSON.stringify(Coach.COACH_ROLES.map(r => [r, staff[r]?.name, staff[r]?.contractExpiry, staff[r]?.vacant])));

  // The books.
  const fin = u.finances;
  check(`${label}: the books are sound (funds ${Math.round(fin.funds)}K, payroll ${fin.payroll}K, target ${Finance.seasonTarget(fin)}K)`,
        Number.isFinite(fin.funds) && fin.payroll > 0 && Finance.seasonTarget(fin) > 0 && fin.cal?.seasonNum === N);
  check(`${label}: no dead money owed for a past season`, !(fin.deadFuture || []).some(d => d.season <= N));
  check(`${label}: ticket price and facilities in range (price ×${fin.ticketPrice || 1}, ${JSON.stringify(u.facilities || {})})`,
        (fin.ticketPrice || 1) >= 0.5 && (fin.ticketPrice || 1) <= 2 && Object.values(u.facilities || {}).every(v => v >= 0 && v <= 3));
  check(`${label}: last season's campaign is done`, !fin.campaign || fin.campaign.season >= N);

  // The league: every player in one place.
  const where = new Map();
  let dup = 0;
  for (const t of [u, ...st.leagueTeams]) for (const id of [...(t.rosterIds || []), ...(t.farmIds || [])]) { if (where.has(id)) dup++; where.set(id, t.id || 'user'); }
  check(`${label}: every player belongs to one club at most (${where.size} rostered)`, dup === 0);
  const fa = new Set(st.freeAgentPool || []);
  const both = [...fa].filter(id => where.has(id));
  check(`${label}: free agents aren't on rosters`, both.length === 0, both.slice(0, 3).join(','));
  const badCpu = st.leagueTeams.filter(t => (t.rosterIds || []).length > ROSTER_LIMITS.SPRING_TOTAL || (t.rosterIds || []).length < 24
    || (t.lineupSlots || []).filter(sl => st.players[sl.playerId]).length !== 9);
  check(`${label}: every league club has a legal roster and a lineup`, badCpu.length === 0, badCpu.map(t => `${t.abbr} ${(t.rosterIds || []).length}`).join(','));
}

/** A club's strength: the average OVR of its best 26 (roster and farm). */
function strength(st, t) {
  const ovrs = [...(t.rosterIds || []), ...(t.farmIds || [])].map(id => st.players[id]?.ovr || 0).sort((a, b) => b - a).slice(0, 26);
  return ovrs.length ? ovrs.reduce((a, b) => a + b, 0) / ovrs.length : 0;
}
const trend = [];
function logStrength(label) {
  const st = SM.get();
  const lg = st.leagueTeams.map(t => strength(st, t));
  const avg = lg.reduce((a, b) => a + b, 0) / lg.length;
  trend.push({ label, user: strength(st, st.userTeam), avg, min: Math.min(...lg), max: Math.max(...lg),
               n: st.leagueTeams.map(t => (t.rosterIds || []).length) });
}

function snapshot() {
  const st = SM.get();
  const last = st.schedule.filter(g => g._committed && !g.cancelled).map(g => g.date).sort().pop();
  return { seasonNum: st.seasonNum, year: baseballYear(st), lastDate: last,
           ages: Object.fromEntries(Object.values(st.players).map(p => [p.id, computeAge(p.dob, baseballYear(st))])) };
}

// ── Main ──
seedRandom(SEED);
await startNewGame({ archetypeId: ARCH, gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: process.env.REGION || 'north' });
await SM.init();
const story = [];
logStrength('start');
for (let n = 1; n <= SEASONS; n++) {
  const games = await playSeason();
  // (A season that ends in the World Series' last out still needs the league's clock to the summary.)
  for (let g = 0; g < 200 && SM.get().phase !== PHASE.SEASON_SUMMARY && SM.get().phase !== PHASE.OFFSEASON; g++) { clock.advance(3600_000); advanceClock(clock.get()); releaseDueCards(); gmActs(); }
  const prev = snapshot();
  const rec = `${SM.get().userTeam.wins}–${SM.get().userTeam.losses}`;
  if (n === SEASONS) { story.push(`season ${n}: ${rec}; ${games} games`); break; }
  const os = playOffseason();
  advanceClock(clock.get()); releaseDueCards();   // (the app's next tick: the new season's books open)
  const R = os.cards.size ? [...os.cards.values()] : [];
  const h = (SM.get().seasonHistory || []).filter(x => x.seasonNum === n).pop() || {};
  const outcome = [...(os.cards.values())].find(c => c.cardId === 'fo_event')?._foOffer?.kind;
  const kinds = [...new Set(R.map(c => c.cardId))].sort();
  story.push(`season ${n}: ${rec}, ${h.postseason?.result || '—'}; ${games} games; offseason cards: ${kinds.join(' ')}; fan event ${outcome || '—'}`);
  checkTurn(prev, os, `season ${n}→${n + 1}`);
  logStrength(`spring ${n + 1}`);
}

say(`\n${ARCH} seed ${SEED}, ${SEASONS} seasons`);
for (const s of story) say(`  ${s}`);
const st = SM.get();
say(`  staff now: ${Coach.COACH_ROLES.map(r => `${st.userTeam.coachingStaff[r].name} ${st.userTeam.coachingStaff[r].quality}`).join(', ')}`);
say(`  books: funds ${Math.round(st.userTeam.finances.funds)}K, price ×${st.userTeam.finances.ticketPrice || 1}, facilities ${JSON.stringify(st.userTeam.facilities || {})}, atmosphere ${st.userTeam.atmosphere}`);
say(`  strength (best 26): ${trend.map(t => `${t.label}: us ${t.user.toFixed(1)} · league ${t.avg.toFixed(1)} (${t.min.toFixed(1)}–${t.max.toFixed(1)})`).join(' | ')}`);
{
  const a = trend[0], z = trend[trend.length - 1];
  check(`the league's talent holds across ${SEASONS} seasons (league ${a.avg.toFixed(1)} → ${z.avg.toFixed(1)})`, Math.abs(z.avg - a.avg) <= 4);
  check(`no league club falls apart (weakest ${z.min.toFixed(1)}, league ${z.avg.toFixed(1)})`, z.avg - z.min <= 8);
}
say(`  card answers: ${Object.entries(tally).filter(([k]) => /^(os_|fo_|il_return|lineup_return)/.test(k)).map(([k, v]) => `${k} ${v.yes}/${v.no}/${v.left}`).join(', ')}`);
say(`\n${pass}/${pass + fail} checks passed${fail ? ` — FAILED: ${[...new Set(fails)].join(' | ')}` : ''}`);
process.exit(fail ? 1 : 0);
