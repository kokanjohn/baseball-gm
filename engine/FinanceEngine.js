/**
 * engine/FinanceEngine.js
 * Club Funds (§78) — PURE: takes state (or an in-place draft) and returns
 * results; never imports StateManager.
 *
 * One account per club: `team.finances.funds` ($K). Every dollar in or out is
 * posted to the club's ledger with its reason, so the season's income and
 * spending by category always reconcile to the funds.
 *
 *   Money in:  the league media share and local media/sponsors (installments on
 *              paydays), the gate at every home game (attendance from the
 *              park's atmosphere, the club's form, the day of the week), card
 *              revenue, the All-Star host's share, cash received in trades.
 *   Money out: salaries — accrued DAILY through the regular season for every
 *              player paid that day, settled on paydays (the 1st and 15th, and
 *              once after the last game); coaching staff the same way; dead
 *              money for players released in season; card costs, signing
 *              bonuses and cash sent in trades at once.
 *
 * Who is paid: everyone on the active roster or the IL, and players in the
 * farm on a major-league contract (`contractMLB`). Prospects on minor-league
 * deals cost nothing until they're called up (§78.1).
 *
 * The owner (§78.4): a soft payroll target, and his patience — archetype +
 * the season's pace against the win target + his trust (+ the Gambler's
 * mood) — against the club's financial strain (payroll over target, red ink
 * projected for the season's end, for the Lab cost per win). Evaluated each
 * payday: content → watching → concerned → ordering cuts.
 *
 * team.finances = {
 *   funds, payrollTarget, payroll,
 *   market:  { capacity, perFan, localAnnual },
 *   ledger:  [{ at, k, cat, label }],                 // this season
 *   season:  { income: { cat: $K }, spend: { cat: $K } },
 *   history: [{ seasonNum, income, spend, net, fundsEnd, payrollTarget }],
 *   cal:     { seasonNum, startDay, endDay, days, paydays: [ms], paid,
 *              accruedThrough, owed: { payroll, staff, dead }, mediaPer, localPer },
 *   dead:    [{ playerId, salary, endDay }],
 *   owner:   { stage, mood, order: null|{ amountK, fromPayroll, dueAt, playerId },
 *              targetPenalty, lastReviewAt },
 * }
 */

import {
  PLAYER_GROUP, REGULAR_SEASON_GAME_COUNT,
  FIN_MEDIA_SHARE_K, FIN_BREAK_EVEN_MARGIN, FIN_CARDS_ALLOWANCE, FIN_LOCAL_SHARE, FIN_LOCAL_PER_TIER,
  FIN_PAYDAYS, FIN_PAYDAY_HOUR, FIN_PLAYOFF_GATE_MULT, FIN_START_FUNDS_SHARE,
  FIN_CAPACITY_BASE, FIN_CAPACITY_PER_M, FIN_ATTENDANCE,
  OWNER_PROFILE, OWNER_PATIENCE, OWNER_STAGE, OWNER_TRUST_FX, OWNER_ORDER_TARGET_PENALTY,
  FIN_TOLERANCE_MAX, FIN_OVERDRAFT_SHARE, FIN_BOOKS_OFFER, FIN_CPU, FIN_MIN_MOVE_K,
} from '../data/constants.js';
import { dayOf } from './PitchingEngine.js';

const DAY = 86_400_000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v) => Math.round(v);
const PAID_GROUPS = new Set([PLAYER_GROUP.BENCH_HITTERS, PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.STARTING_PITCHERS,
                             PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH, PLAYER_GROUP.IL]);
export const STAGES = Object.freeze(['content', 'watching', 'concerned', 'cuts']);
export const INCOME_LABELS = Object.freeze({ gate: 'Home gates', media: 'League media share', local: 'Local media & sponsors',
  cards: 'Deals & promotions', allstar: 'All-Star Game', trade: 'Cash in trades', owner: 'Owner covered the shortfall', other: 'Other' });
export const SPEND_LABELS = Object.freeze({ payroll: 'Player payroll', staff: 'Coaching staff', dead: 'Released players (dead money)',
  cards: 'Front-office decisions', bonus: 'Signing bonuses', trade: 'Cash in trades', other: 'Other' });

/** The local calendar day's first moment, from a day number (PitchingEngine.dayOf). */
export function dayStartMs(day) {
  const d = new Date(day * DAY);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

function _club(state, teamId) {
  return teamId === 'user' ? state.userTeam : (state.leagueTeams || []).find(t => t.id === teamId) || null;
}

// ─────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────

/** Annual coaching-staff salaries ($K). */
export function staffAnnual(team) {
  const named = Object.values(team?.coachingStaff || {}).reduce((a, s) => a + (s?.salary || 0), 0);
  // A CPU club's staff is not modelled person by person: a budget line (§78.5).
  return named || team?.finances?.staffK || 0;
}

/** The crowd's response to the club's winning percentage. */
function _formAt(winPct) {
  const A = FIN_ATTENDANCE;
  return clamp(1 + A.formWeight * (winPct - 0.5), A.formMin, A.formMax);
}

/** Fraction of seats filled for an atmosphere, a form factor and a day factor. */
function _fill(atmo, form = 1, dayMult = 1, noise = 1) {
  const A = FIN_ATTENDANCE;
  return clamp((A.base + A.perAtmo * atmo) * form * dayMult * noise, A.min, 1);
}

/**
 * initFinances(team, { payrollTarget, atmosphere, startFundsShare })
 * The club's market and opening funds — set once, when the franchise (or the
 * league) is created. Income is calibrated so the club runs near break-even
 * at its starting payroll level and atmosphere; from there, winning and a
 * livelier park earn more.
 */
export function initFinances(team, { payrollTarget, atmosphere = 60, startFundsShare = FIN_START_FUNDS_SHARE, winPct = 0.5,
                                     calibrateOn = payrollTarget, cardsAllowance = FIN_CARDS_ALLOWANCE }) {
  const P = payrollTarget;
  const spend  = calibrateOn + staffAnnual(team) + calibrateOn * cardsAllowance;
  const income = spend * FIN_BREAK_EVEN_MARGIN;
  const nonMedia = Math.max(0, income - FIN_MEDIA_SHARE_K);
  const localAnnual = nonMedia * FIN_LOCAL_SHARE;
  const gateAnnual  = nonMedia - localAnnual;
  const homeGames   = REGULAR_SEASON_GAME_COUNT / 2;
  const capacity    = round(FIN_CAPACITY_BASE + (P / 1000) * FIN_CAPACITY_PER_M);
  // Calibrated at the expected pace (the owner's win target): meeting
  // expectations breaks even; beating them is where the profit is.
  const perFan      = (gateAnnual * 1000 / homeGames) / (capacity * _fill(atmosphere, _formAt(winPct)));   // dollars per fan
  team.finances = {
    ...(team.finances || {}),
    funds:         round(P * startFundsShare),
    payrollTarget: P,
    market:        { capacity, perFan: Math.round(perFan * 100) / 100, localAnnual: round(localAnnual) },
    ledger: [], season: { income: {}, spend: {} }, history: team.finances?.history || [],
    cal: null, dead: [],
    owner: { stage: 'content', mood: 0, order: null, targetPenalty: 0, lastReviewAt: null },
  };
  return team.finances;
}

/**
 * initClubBooks(draft, teamId, { atMs }) — §78.5 a CPU club's books: its
 * owner's personality (one of the archetypes, kept for the franchise's life),
 * a payroll target at the payroll it opened with, a park whose atmosphere
 * follows the club's standing, and a market calibrated like ours — the club
 * breaks even when it plays to its owner's expectations.
 */
export function initClubBooks(draft, teamId) {
  const t = _club(draft, teamId);
  if (!t || teamId === 'user') return null;
  const types = Object.keys(OWNER_PROFILE);
  t.ownerArchetype ||= types[Math.floor(Math.random() * types.length)];
  t.atmosphere     ??= Math.round(clamp(50 + ((t.str ?? 0.5) - 0.5) * 120, 35, 75));
  t._ownerWinTarget ??= Math.round(REGULAR_SEASON_GAME_COUNT * clamp(t.str ?? 0.5, 0.4, 0.6));
  const payroll = payrollOf(draft, teamId);
  // The owner budgets a little over the opening payroll for the season's
  // call-ups and injuries — and never below what the league's market asks of
  // a club (a weak roster is not a reason for a budget that can't fix it).
  // The market is calibrated on what the club will really carry (no front-
  // office card budget), so it breaks even at its pace.
  const floor = cpuTargetFloor(draft);
  const target = Math.max(1000, floor, Math.round(payroll * (1 + FIN_CPU.targetHeadroom) / 50) * 50);
  t.finances = { ...(t.finances || {}), staffK: Math.round(payroll * FIN_CPU.staffShare) };
  initFinances(t, {
    payrollTarget:   target,
    calibrateOn:     Math.max(payroll * (1 + FIN_CPU.inSeasonLift), floor),
    cardsAllowance:  0,
    atmosphere:      t.atmosphere,
    startFundsShare: startFundsShareFor(t.ownerArchetype),
    winPct:          t._ownerWinTarget / REGULAR_SEASON_GAME_COUNT,
  });
  t.finances.payroll = payroll;
  return t.finances;
}

/** §78.5 the least a CPU owner budgets: a share of the league's median payroll. */
export function cpuTargetFloor(state) {
  const pays = (state.leagueTeams || []).map(t => payrollOf(state, t.id)).filter(x => x > 0).sort((a, b) => a - b);
  if (!pays.length) return 0;
  const median = pays[Math.floor(pays.length / 2)];
  return Math.round(median * FIN_CPU.targetFloorShare / 50) * 50;
}

/** Opening-funds share for an archetype (the Gambler's is a roll). */
export function startFundsShareFor(archetypeId) {
  const sf = OWNER_PROFILE[archetypeId]?.startFunds ?? FIN_START_FUNDS_SHARE;
  return Array.isArray(sf) ? sf[0] + Math.random() * (sf[1] - sf[0]) : sf;
}

// ─────────────────────────────────────────────────────────────
// THE LEDGER
// ─────────────────────────────────────────────────────────────

/** post(fin, k, cat, label, at) — money in (k > 0) or out (k < 0), with its reason. */
export function post(fin, k, cat, label, at) {
  if (!fin || !k) return;
  k = Math.round(k);
  if (!k) return;
  fin.funds = (fin.funds || 0) + k;
  fin.ledger = [...(fin.ledger || []), { at, k, cat, label }];
  fin.season = fin.season || { income: {}, spend: {} };
  const side = k > 0 ? 'income' : 'spend';
  fin.season[side] = { ...(fin.season[side] || {}), [cat]: (fin.season[side]?.[cat] || 0) + Math.abs(k) };
}

/** Convenience: post for a club by id. */
export function postFor(draft, teamId, k, cat, label, at) {
  const t = _club(draft, teamId);
  if (t?.finances) post(t.finances, k, cat, label, at);
}

// ─────────────────────────────────────────────────────────────
// WHAT CARDS CAN DO TO THE BOOKS (§78.8)
// ─────────────────────────────────────────────────────────────

/** This season's payroll target: the owner's target, loosened (or tightened) by any mid-season decision. */
export function seasonTarget(fin) {
  return Math.round((fin?.payrollTarget || 0) * (1 + (fin?.seasonTargetAdj || 0)));
}

/** The owner loosens (+) or tightens (−) this season's payroll target by a share. */
export function adjustSeasonTarget(fin, pct) {
  if (!fin || !pct) return;
  fin.seasonTargetAdj = clamp((fin.seasonTargetAdj || 0) + pct, -0.15, 0.15);
}

/**
 * startPromo(fin, { price, fill, homeGames }) — a ticket promotion for the
 * next N home games: a price change (−0.15 = 15% off) and a lift in the
 * share of seats filled (+0.08). The gate the crowd pays is real (crowdFor).
 */
export function startPromo(fin, { price = 0, fill = 0, homeGames = 8 } = {}) {
  if (!fin) return;
  fin.promo = { price, fill, gamesLeft: homeGames };
}

/** A sponsor or rights deal won or lost: local income changes by a share from now on. */
export function adjustLocalIncome(fin, pct) {
  if (!fin?.market || !pct) return;
  fin.market.localAnnual = Math.round(fin.market.localAnnual * (1 + pct));
  if (fin.cal) fin.cal.localPer = fin.cal.localPer * (1 + pct);
}

// ─────────────────────────────────────────────────────────────
// PAYROLL
// ─────────────────────────────────────────────────────────────

/** Is this player paid by his club today? (active / IL, or a major-league deal in the farm) */
export function isPaid(p) {
  return !!p && (PAID_GROUPS.has(p.group) || (p.group === PLAYER_GROUP.PRACTICE_SQUAD && !!p.contractMLB));
}

/** The club's annual payroll: everyone it is paying (§78.3). */
export function payrollOf(state, teamId = 'user') {
  const t = _club(state, teamId);
  if (!t) return 0;
  const season = state.seasonNum || 1;
  let sum = 0;
  for (const id of [...(t.rosterIds || []), ...(t.farmIds || [])]) {
    const p = state.players[id];
    if (!(p && p.teamId === (teamId === 'user' ? 'user' : t.id) && isPaid(p))) continue;
    // §85 a share another club is still paying this season isn't ours.
    const kept = p.retained && p.retained.season === season && p.retained.payerId !== teamId ? p.retained.pct : 0;
    sum += (p.contractSalary || 0) * (1 - kept);
  }
  // §85 and the shares we keep paying on players we traded away.
  for (const r of t.finances?.retained || []) {
    if (r.season !== season) continue;
    const p = state.players[r.playerId];
    if (p && isPaid(p)) sum += (p.contractSalary || 0) * r.pct;
  }
  return Math.round(sum);
}

/**
 * retainSalary(draft, payerId, playerId, pct) — §85 the club that sends a
 * player keeps paying this share of the salary for the rest of the season
 * (paid on its paydays; counted on its payroll, not the new club's).
 */
export function retainSalary(draft, payerId, playerId, pct) {
  const payer = _club(draft, payerId), p = draft.players[playerId];
  if (!payer?.finances || !p || !(pct > 0)) return;
  const season = draft.seasonNum || 1;
  p.retained = { payerId, pct, season };
  payer.finances.retained = [...(payer.finances.retained || []).filter(r => r.playerId !== playerId), { playerId, pct, season }];
}

/** A player released in season is owed the rest of it: dead money on the club's books. */
export function addDeadMoney(draft, teamId, playerId, atMs) {
  const t = _club(draft, teamId);
  const fin = t?.finances, cal = fin?.cal;
  const p = draft.players[playerId];
  if (!fin || !cal || !p || !(p.contractSalary > 0)) return;
  const today = dayOf(atMs);
  if (today > cal.endDay || today < cal.startDay) return;    // offseason / spring: nothing owed
  fin.dead = [...(fin.dead || []), { playerId, salary: p.contractSalary, endDay: cal.endDay }];
}

// ─────────────────────────────────────────────────────────────
// THE SEASON'S CALENDAR — daily accrual, paydays
// ─────────────────────────────────────────────────────────────

/** The regular season's first and last days, from the club's schedule. */
function _seasonDays(state) {
  const reg = (state.schedule || []).filter(g => !g.isSpring && !g.isPlayoff && Number.isFinite(g.gameTime));
  if (!reg.length) return null;
  const times = reg.map(g => g.gameTime);
  return { startDay: dayOf(Math.min(...times)), endDay: dayOf(Math.max(...times)) };
}

/**
 * ensureSeason(draft, teamId) — the season's pay calendar for a club, built
 * once per season from the schedule: paydays on the 1st and 15th from Opening
 * Day to the last game, plus a settling payday the day after.
 */
export function ensureSeason(draft, teamId = 'user') {
  const t = _club(draft, teamId);
  const fin = t?.finances;
  if (!fin || fin.cal?.seasonNum === (draft.seasonNum || 1)) return false;
  const sd = _seasonDays(draft);
  if (!sd) return false;
  const paydays = [];
  for (let d = sd.startDay + 1; d <= sd.endDay; d++) {
    const date = new Date(dayStartMs(d));
    if (FIN_PAYDAYS.includes(date.getDate())) paydays.push(dayStartMs(d) + FIN_PAYDAY_HOUR * 3600_000);
  }
  paydays.push(dayStartMs(sd.endDay + 1) + FIN_PAYDAY_HOUR * 3600_000);   // settles the last days
  const N = paydays.length;
  const tier = draft.prestigeTier || 1;
  const localAnnual = (fin.market?.localAnnual || 0) * (1 + FIN_LOCAL_PER_TIER * (tier - 1));
  fin.cal = {
    seasonNum: draft.seasonNum || 1, startDay: sd.startDay, endDay: sd.endDay,
    days: sd.endDay - sd.startDay + 1, paydays, paid: 0, accruedThrough: sd.startDay - 1,
    owed: { payroll: 0, staff: 0, dead: 0 },
    mediaPer: FIN_MEDIA_SHARE_K / N, localPer: localAnnual / N,
  };
  return true;
}

/**
 * dueSteps(state, clockMs, teamId) — the money moments due by the clock, in
 * order: the start of each season day (pay accrues), each payday.
 */
export function dueSteps(state, clockMs, teamId = 'user') {
  const cal = _club(state, teamId)?.finances?.cal;
  if (!cal || cal.seasonNum !== (state.seasonNum || 1)) return [];
  const out = [];
  const nextDay = cal.accruedThrough + 1;
  if (nextDay <= cal.endDay && dayStartMs(nextDay) <= clockMs) out.push({ kind: 'accrue', day: nextDay, at: dayStartMs(nextDay), teamId });
  const pd = cal.paydays[cal.paid];
  if (pd != null && pd <= clockMs) out.push({ kind: 'payday', i: cal.paid, at: pd, teamId });
  return out.sort((a, b) => a.at - b.at);
}

/** accrueDay(draft, day, teamId) — one season day's salaries, staff and dead money are owed. */
export function accrueDay(draft, day, teamId = 'user') {
  const t = _club(draft, teamId);
  const fin = t?.finances, cal = fin?.cal;
  if (!cal || day !== cal.accruedThrough + 1) return;
  cal.owed.payroll += payrollOf(draft, teamId) / cal.days;
  cal.owed.staff   += staffAnnual(t) / cal.days;
  for (const d of fin.dead || []) if (day <= d.endDay) cal.owed.dead += d.salary / cal.days;
  cal.accruedThrough = day;
}

/**
 * payday(draft, i, atMs, teamId) — settle what's owed and take in the media
 * and local installments. Returns { paid, received } ($K) for the feed.
 */
export function payday(draft, i, atMs, teamId = 'user') {
  const t = _club(draft, teamId);
  const fin = t?.finances, cal = fin?.cal;
  if (!cal || i !== cal.paid) return null;
  const paid = { payroll: round(cal.owed.payroll), staff: round(cal.owed.staff), dead: round(cal.owed.dead) };
  post(fin, -paid.payroll, 'payroll', 'Payday — player salaries', atMs);
  post(fin, -paid.staff,   'staff',   'Payday — coaching staff', atMs);
  post(fin, -paid.dead,    'dead',    'Payday — released players', atMs);
  cal.owed = { payroll: 0, staff: 0, dead: 0 };
  const received = { media: round(cal.mediaPer), local: round(cal.localPer) };
  post(fin, received.media, 'media', 'League media share', atMs);
  post(fin, received.local, 'local', 'Local media & sponsors', atMs);
  cal.paid += 1;
  if (cal.paid >= cal.paydays.length) fin.dead = [];   // the season's dead money is settled
  return { paid, received, total: received.media + received.local - paid.payroll - paid.staff - paid.dead };
}

// ─────────────────────────────────────────────────────────────
// THE GATE
// ─────────────────────────────────────────────────────────────

/**
 * crowdFor(state, teamId, { atMs, playoff, atmosphere, wins, losses }) — the
 * crowd at a home game (known at first pitch) and the gate it will pay:
 * { attendance, gateK, sellout }. Pure — nothing is posted.
 */
export function crowdFor(state, teamId, { atMs, playoff = false, atmosphere = null, wins = null, losses = null }) {
  const t = _club(state, teamId);
  const fin = t?.finances;
  if (!fin?.market) return null;
  const A = FIN_ATTENDANCE;
  const w = wins ?? t.wins ?? 0, l = losses ?? t.losses ?? 0;
  const form = w + l >= A.formAfterGames ? _formAt(w / (w + l)) : 1;
  const dow = new Date(atMs).getDay();
  const dayMult = (dow === 5 || dow === 6 || dow === 0) ? A.weekend : A.weekday;
  const noise = 1 + (Math.random() * 2 - 1) * A.noise;
  let fill = _fill(atmosphere ?? t.atmosphere ?? 60, form, dayMult, noise);
  if (playoff) fill = Math.min(1, fill + A.playoffLift);
  // A ticket promotion (§78.8): its price and its crowd, regular-season home games.
  const promo = !playoff && fin.promo?.gamesLeft > 0 ? fin.promo : null;
  if (promo) fill = clamp(fill + (promo.fill || 0), A.min, 1);
  const attendance = round(fin.market.capacity * fill);
  const gateK = round(attendance * fin.market.perFan * (1 + (promo?.price || 0)) / 1000 * (playoff ? FIN_PLAYOFF_GATE_MULT : 1));
  return { attendance, gateK, sellout: fill >= 0.995 };
}

/**
 * homeGate(draft, teamId, opts) — post a home game's gate. `opts.crowd` (from
 * crowdFor at first pitch) is used when given; otherwise the crowd is drawn now.
 * Returns { attendance, gateK, sellout }.
 */
export function homeGate(draft, teamId, opts) {
  const t = _club(draft, teamId);
  const crowd = opts.crowd || crowdFor(draft, teamId, opts);
  if (!crowd || !t?.finances) return null;
  post(t.finances, crowd.gateK, 'gate', opts.playoff ? 'Playoff gate' : 'Home gate', opts.atMs);
  if (!opts.playoff && t.finances.promo?.gamesLeft > 0) t.finances.promo.gamesLeft -= 1;
  return crowd;
}

// ─────────────────────────────────────────────────────────────
// WHERE THE SEASON IS HEADED
// ─────────────────────────────────────────────────────────────

/** Average gate so far this season (or the baseline). */
function _avgGate(fin) {
  const n = (fin.ledger || []).filter(e => e.cat === 'gate' && e.label === 'Home gate');
  if (n.length) return n.reduce((a, e) => a + e.k, 0) / n.length;
  return (fin.market?.capacity || 0) * (fin.market?.perFan || 0) / 1000 * _fill(60);
}

/**
 * projection(state, teamId) — funds at the end of this regular season if
 * things go on as they are (today's payroll, today's average gate).
 */
export function projection(state, teamId = 'user') {
  const t = _club(state, teamId);
  const fin = t?.finances, cal = fin?.cal;
  if (!fin) return 0;
  if (!cal || cal.paid >= cal.paydays.length) return fin.funds || 0;
  const remDays = Math.max(0, cal.endDay - cal.accruedThrough);
  const owed = cal.owed.payroll + cal.owed.staff + cal.owed.dead;
  const remPay = (payrollOf(state, teamId) + staffAnnual(t)) * remDays / cal.days
               + (fin.dead || []).reduce((a, d) => a + d.salary * Math.max(0, d.endDay - cal.accruedThrough) / cal.days, 0);
  const remPaydays = cal.paydays.length - cal.paid;
  // Home games played this season = home gates banked (any club).
  const playedHome = (fin.ledger || []).filter(e => e.cat === 'gate' && e.label === 'Home gate').length;
  const remHome = Math.max(0, REGULAR_SEASON_GAME_COUNT / 2 - playedHome);
  const remIn = remPaydays * (cal.mediaPer + cal.localPer) + remHome * _avgGate(fin);
  return round((fin.funds || 0) - owed - remPay + remIn);
}

// ─────────────────────────────────────────────────────────────
// THE OWNER
// ─────────────────────────────────────────────────────────────

/** The club's owner personality: ours is the franchise archetype; a CPU club's is its own. */
const _profile = (state, teamId = 'user') =>
  OWNER_PROFILE[teamId === 'user' ? state.archetype : _club(state, teamId)?.ownerArchetype] || OWNER_PROFILE.contender;
/** A CPU owner has no trust relationship with a GM: he sits at the pivot. */
const _trust = (state, teamId) => (teamId === 'user' ? (state.userTeam.ownerTrust ?? 60) : OWNER_PATIENCE.trustPivot);

/** How the season is going against the win target, in projected wins (null early on). */
export function paceVsTarget(state, teamId = 'user') {
  const u = _club(state, teamId) || {};
  const n = (u.wins || 0) + (u.losses || 0);
  if (n < OWNER_PATIENCE.paceAfterGames) return null;
  const projected = (u.wins || 0) / n * REGULAR_SEASON_GAME_COUNT;
  return projected - (u._ownerWinTarget || 75);
}

/** The owner's patience: his personality, the season's pace, his trust in you, his mood. */
export function patience(state, teamId = 'user') {
  const P = OWNER_PATIENCE;
  const u = _club(state, teamId) || {};
  const pace = paceVsTarget(state, teamId);
  return _profile(state, teamId).patienceBase
    + (pace == null ? 0 : clamp(pace * P.pacePerWin, -P.paceMax, P.paceMax))
    + (_trust(state, teamId) - P.trustPivot) * P.trustWeight
    + (u.finances?.owner?.mood || 0);
}

/** Financial strain (points ≈ percent): payroll over target, projected red ink, cost per win. */
export function strain(state, teamId = 'user') {
  const u = _club(state, teamId) || {};
  const fin = u.finances || {};
  const target = seasonTarget(fin) || 1;
  const payroll = payrollOf(state, teamId);
  const projected = projection(state, teamId);
  // Money the club is projected to have covers some of the payroll over the
  // target — as much as this owner's personality allows.
  const prof = _profile(state, teamId);
  const cushion = Math.max(0, projected) * (prof.cushionUse ?? 0.5);
  const over = Math.max(0, (payroll - cushion) / target - 1) * 100;
  const red  = Math.max(0, -projected) / target * 100 * prof.redWeight;
  let cpw = 0;
  if (prof.costPerWin) {
    const n = (u.wins || 0) + (u.losses || 0);
    const lg = _leaguePayrollPerWin(state);
    if (n >= OWNER_PATIENCE.paceAfterGames && lg && (u.wins || 0) > 0
        && (payroll / u.wins) > lg * OWNER_PATIENCE.costPerWinOver) cpw = OWNER_PATIENCE.costPerWinStrain;
  }
  return { total: over + red + cpw, over, red, cpw, payroll, target, projected };
}

function _leaguePayrollPerWin(state) {
  const clubs = (state.leagueTeams || []).filter(t => (t.wins || 0) > 0);
  if (!clubs.length) return null;
  const per = clubs.map(t => payrollOf(state, t.id) / t.wins);
  return per.reduce((a, b) => a + b, 0) / per.length;
}

/** The strain he lets pass without a word. */
export function allowance(state, teamId = 'user') {
  const P = OWNER_PATIENCE;
  return clamp((patience(state, teamId) - P.allowanceFrom) * P.allowancePerPt, 0, P.allowanceMax);
}

/** The stage his patience is at, given the strain. */
export function ownerStage(state, teamId = 'user') {
  const excess = strain(state, teamId).total - allowance(state, teamId);
  return excess <= OWNER_STAGE.watching ? 'content'
       : excess <= OWNER_STAGE.concerned ? 'watching'
       : excess <= OWNER_STAGE.cuts ? 'concerned' : 'cuts';
}

/**
 * tolerance(state) — how far over the payroll target he'll let you go to add
 * salary right now (0 when he's concerned or worse).
 */
export function tolerance(state, teamId = 'user') {
  const stage = _club(state, teamId)?.finances?.owner?.stage || 'content';
  if (stage === 'concerned' || stage === 'cuts') return 0;
  return clamp((allowance(state, teamId) - strain(state, teamId).total) / 100, 0, FIN_TOLERANCE_MAX);
}

/** Can the club add this much annual salary (and send this much out)? */
export function canAddSalary(state, addK, outK = 0, teamId = 'user') {
  const fin = _club(state, teamId)?.finances;
  if (!fin) return true;                       // a club without books (old save, mid-migration)
  // However tight the books, a minimum-salary move to fill a hole is always
  // allowed — every club can claim or sign depth at the league minimum.
  return addK - outK <= Math.max(FIN_MIN_MOVE_K, payrollRoom(state, teamId));
}

/** Annual salary the club could still add with the owner's blessing ($K). */
export function payrollRoom(state, teamId = 'user') {
  const fin = _club(state, teamId)?.finances || {};
  return seasonTarget(fin) * (1 + tolerance(state, teamId)) - payrollOf(state, teamId);
}

/** Can the club spend this much now (a bonus)? A happy owner lets funds dip a little. */
export function canSpend(state, costK, teamId = 'user') {
  const fin = _club(state, teamId)?.finances || {};
  const overdraft = seasonTarget(fin) * tolerance(state, teamId) * FIN_OVERDRAFT_SHARE;
  return (fin.funds || 0) - costK >= -overdraft;
}

/**
 * ownerReview(draft, atMs) — after a payday: the owner looks at the books.
 * Moves his mood (the Gambler), applies trust for the stage, settles a cut
 * order that came due. Returns { stage, prev, strain, order, orderResult }.
 */
export function ownerReview(draft, atMs, teamId = 'user') {
  const u = _club(draft, teamId), fin = u.finances, o = fin.owner || (fin.owner = { stage: 'content', mood: 0, order: null, targetPenalty: 0 });
  const isUser = teamId === 'user';
  const prof = _profile(draft, teamId);
  if (prof.moodStep) o.mood = clamp((o.mood || 0) + (Math.random() * 2 - 1) * prof.moodStep, -prof.moodMax, prof.moodMax);
  let orderResult = null;
  if (o.order && atMs >= o.order.dueAt) {
    const cut = o.order.fromPayroll - payrollOf(draft, teamId);
    const met = cut >= o.order.amountK * 0.8;
    if (isUser) u.ownerTrust = clamp((u.ownerTrust ?? 60) + (met ? OWNER_TRUST_FX.orderMet : OWNER_TRUST_FX.orderMissed), 0, 100);
    if (!met) o.targetPenalty = (o.targetPenalty || 0) + OWNER_ORDER_TARGET_PENALTY;
    orderResult = { met, ...o.order, cutK: cut };
    o.order = null;
  }
  const prev = o.stage || 'content';
  const s = strain(draft, teamId);
  const stage = ownerStage(draft, teamId);
  o.stage = stage;
  o.lastReviewAt = atMs;
  if (!isUser) return { stage, prev, strain: s, order: o.order, orderResult };
  if (stage === 'concerned') u.ownerTrust = clamp((u.ownerTrust ?? 60) + OWNER_TRUST_FX.concernedPerPayday, 0, 100);
  if (stage === 'cuts')      u.ownerTrust = clamp((u.ownerTrust ?? 60) + OWNER_TRUST_FX.cutsPerPayday, 0, 100);
  return { stage, prev, strain: s, order: o.order, orderResult };
}

/**
 * cutOrderAmount(state) — the payroll reduction (annual $K) the owner asks for:
 * back within what he'd tolerate, or enough salary off to close the projected
 * red over the rest of the season.
 */
export function cutOrderAmount(state, teamId = 'user') {
  const s = strain(state, teamId);
  const allowPct = allowance(state, teamId);
  const overBy = s.payroll - s.target * (1 + allowPct / 100);
  const cal = _club(state, teamId)?.finances?.cal;
  const remShare = cal ? Math.max(0.15, (cal.endDay - cal.accruedThrough) / cal.days) : 1;
  const redBy = Math.max(0, -s.projected) / remShare;
  return Math.max(0, round(Math.max(overBy, redBy) / 50) * 50);
}

/** The contract the owner wants moved: the smallest salary that covers the cut (not a core player). */
export function contractToMove(state, amountK, teamId = 'user') {
  const u = _club(state, teamId) || {};
  // Someone on the active roster (a trade moves rostered players), healthy.
  const mine = (u.rosterIds || []).map(id => state.players[id])
    .filter(p => p && p.teamId === teamId && isPaid(p) && !p.isInjured
              && p.group !== PLAYER_GROUP.IL && p.group !== PLAYER_GROUP.IN_TRANSIT);
  const core = new Set([...mine].sort((a, b) => (b.ovr || 0) - (a.ovr || 0)).slice(0, 5).map(p => p.id));
  const pool = mine.filter(p => !core.has(p.id) && (p.contractSalary || 0) > 0);
  const covers = pool.filter(p => p.contractSalary >= amountK).sort((a, b) => a.contractSalary - b.contractSalary)[0];
  return covers || pool.sort((a, b) => b.contractSalary - a.contractSalary)[0] || null;
}

// ─────────────────────────────────────────────────────────────
// THE SEASON'S END
// ─────────────────────────────────────────────────────────────

/**
 * seasonEndReview(draft, atMs, teamId) — the season's books are closed: red
 * ink is covered by the owner (at a trust cost, the user's club), the
 * summary goes into history, and the ledger starts fresh. Funds carry over.
 * Returns the summary.
 */
export function seasonEndReview(draft, atMs, teamId = 'user') {
  const t = _club(draft, teamId);
  const fin = t?.finances;
  if (!fin) return null;
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  let covered = 0;
  if ((fin.funds || 0) < 0) {
    covered = -fin.funds;
    post(fin, covered, 'owner', 'Owner covered the shortfall', atMs);
    if (teamId === 'user') {
      const pct = covered / (fin.payrollTarget || 1) * 100;
      t.ownerTrust = clamp((t.ownerTrust ?? 60) + Math.max(OWNER_TRUST_FX.redInkMax, pct * OWNER_TRUST_FX.redInkPerPct), 0, 100);
    }
  }
  const income = { ...(fin.season?.income || {}) }, spend = { ...(fin.season?.spend || {}) };
  const summary = {
    seasonNum: draft.seasonNum || 1, income, spend,
    net: sum(income) - (income.owner || 0) - sum(spend), covered,
    fundsEnd: fin.funds || 0, payrollTarget: fin.payrollTarget || 0,
  };
  fin.history = [...(fin.history || []), summary];
  fin.ledger = [];
  fin.season = { income: {}, spend: {} };
  fin.dead = [];
  fin.seasonTargetAdj = 0;     // a mid-season loosening (or tightening) lasts the season
  fin.retained = [];           // §85 salary kept on traded players runs out with the season
  fin.promo = null;
  if (fin.owner) { fin.owner.order = null; fin.owner.stage = 'content'; }
  return summary;
}

/** The books' effect on next season's payroll target (± a few percent) and the missed-order penalty. */
export function booksOfferAdjustment(state, teamId = 'user') {
  const fin = _club(state, teamId)?.finances || {};
  const last = (fin.history || [])[fin.history.length - 1];
  const margin = last ? last.net / (last.payrollTarget || 1) : 0;
  const books = clamp(margin * FIN_BOOKS_OFFER.perMargin, -FIN_BOOKS_OFFER.max, FIN_BOOKS_OFFER.max);
  return { books, penalty: fin.owner?.targetPenalty || 0, net: last?.net ?? 0 };
}

/**
 * cpuNextTarget(draft, teamId) — §78.5 a CPU owner sets next season's payroll
 * target from the season's books: a profit lets the payroll grow, a loss
 * pulls it in (the same ± range as ours). Applied at the season's end.
 */
export function cpuNextTarget(draft, teamId) {
  const t = _club(draft, teamId);
  if (!t?.finances || teamId === 'user') return null;
  const { books } = booksOfferAdjustment(draft, teamId);
  const target = Math.max(1000, cpuTargetFloor(draft), Math.round(t.finances.payrollTarget * (1 + books) / 50) * 50);
  t.finances.payrollTarget = target;
  return target;
}

