/**
 * engine/GMProfile.js
 * r219 §122.98 The GM's profile — felt, never shown (message plan, release 6).
 *
 * Every decision the GM answers (or lets lapse) leans the profile, by what the decision was: money spent or saved,
 * a player kept or let go, a trade made or passed, the community asked and answered, a player's development or
 * the win tonight, the staff left to decide. The record is kept in full (state.gmRecord):
 *
 *   log      every decision of the last three seasons: { s, at, id, c, d: { dim: lean }, k (money spent, K),
 *            p (the player it was about), tm (the other club), r (money it brought, K), x (numbers it quoted) }
 *   seasons  older seasons, folded: { [s]: { n, d: { dim: sum }, k, ids: { cardId: n } } }
 *
 * The profile reads it all, each season counting less the further back it is (PROFILE.fade a season; this season
 * and the last count most), and needs a few weeks of answers before it moves.
 *
 *   DIMS                       spender, loyal, aggressive, communityFocused, handsOn, processDriven
 *   decisionLean(card, choice) how one answer leans the profile: { dim: lean } (empty: it says nothing)
 *   recordDecision(draft, card, choice, atMs)   append it (call inside a mutate)
 *   profile(state)             { dim: −1…+1, _n } — what the club around the GM has come to expect
 *   seasonTotals(state)        this season's numbers (the decisions, the money spent on the small asks, …)
 *
 * PURE: no StateManager.
 */
import { PROFILE } from '../data/constants.js';

export const DIMS = Object.freeze(['spender', 'loyal', 'aggressive', 'communityFocused', 'handsOn', 'processDriven']);

const LOYAL_YES = new Set(['os_resign', 'os_extend', 'retain_active_hitter', 'retain_active_pitcher', 'os_mgr_extend', 'os_coach_renew', 'os_coach_keep', 'il_return_activate']);
const LOYAL_NO = new Set(['os_walk', 'os_release', 'release_active_hitter', 'release_active_pitcher', 'os_coach_letgo', 'os_coach_fire', 'os_mgr_replace', 'il_return_waive', 'waiver_dfa', 'fin_release']);
const TRADE_MADE = new Set(['trade_execute', 'lt_offer_send', 'talk_finalize', 'talk_take_counter', 'trade_acquire_hitter', 'trade_acquire_pitcher',
  'trade_send_hitter_get_hitter', 'trade_send_hitter_get_prospects', 'trade_send_pitcher_get_pitcher', 'trade_send_pitcher_cash_only', 'dl3_acquire', 'fin_dump_yes']);
const TRADE_PASSED = new Set(['trade_decline', 'talk_walk', 'lt_pass', 'talk_backout', 'fin_dump_no']);
const SIGN = new Set(['os_fa_sign', 'sign_acquire_hitter', 'sign_veteran_hitter', 'sign_acquire_pitcher', 'sign_prospect_pitcher', 'sign_intl_player',
  'sign_intl_flyer', 'sign_dfa', 'fa_pos_sign', 'claim_next', 'os_mgr_hire_a', 'os_mgr_hire_b', 'os_hire_a', 'os_hire_b', 'st_push', 'dl_ahead']);
const PASS = new Set(['os_fa_pass', 'dl_hold']);
const DEVELOP = new Set(['train_hitter', 'train_pitcher_sp', 'train_pitcher_bp', 'offday_session', 'coach_work', 'dev_program', 'teach_position',
  'sim_games', 'day_off', 'arm_rest', 'rest_active_hitter', 'bench_active_pitcher', 'audition_promote', 'callup_hitter']);

const add = (d, k, v) => { if (v) d[k] = Math.round(((d[k] || 0) + v) * 100) / 100; };

/** Was this a decision at all (a notice, a piece of news, says nothing)? */
export function isDecision(card) {
  return !!card && !!(card.noLabel || card._choices?.length || card._raw?.onYes || card._raw?.onNo) && !card._news && !card._toastOnly;
}

/**
 * How one answer leans the profile. `choice`: 'yes' | 'no' | 'auto' (let it lapse: the card's own default happened).
 */
export function decisionLean(card, choice) {
  const d = {};
  if (!isDecision(card)) return d;
  const raw = card._raw || {};
  const auto = choice === 'auto' || choice === 'skip';
  const eff = auto ? (card.autoResolve === 'yes' ? 'yes' : 'no') : choice;
  // Letting the staff decide, or deciding.
  // (even weights: the lean is the share answered — about a third answered reads as leaving it to the staff)
  add(d, 'handsOn', auto ? -PROFILE.handsOnLean : PROFILE.handsOnLean);
  if (auto) return d;   // (a default nobody chose says nothing about the GM's leanings)

  // Money: an optional cost paid, or turned down; money taken over the fans.
  const cost = eff === 'yes' ? (card._budgetCost || 0) : (card._budgetCostNo || 0);
  if (cost > 0) add(d, 'spender', 1);
  else if (eff === 'no' && (card._budgetCost || 0) > 0) add(d, 'spender', -1);
  const yesFx = card.yesEffect || {}, noFx = card.noEffect || {};
  if (card._revenueK > 0) {
    if (eff === 'yes' && (noFx.atmo || 0) > (yesFx.atmo || 0)) add(d, 'communityFocused', -1);
    else if (eff === 'no' && (noFx.atmo || 0) > (yesFx.atmo || 0)) add(d, 'communityFocused', 1);
  } else if ((yesFx.atmo || 0) >= 2 && (card.tag === 'MARKETING' || card.tag === 'COMMUNITY')) {
    add(d, 'communityFocused', eff === 'yes' ? 1 : -1);
  }

  // People: our players (a relationship the answer moves), contracts, trades.
  const action = eff === 'yes' ? raw.onYes : raw.onNo;
  const rel = eff === 'yes' ? raw._relYes : raw._relNo;
  const playerRel = Object.entries(rel || {}).filter(([k]) => !['mgr_nm', 'pc_nm', 'hc_nm', 'bc_nm'].includes(k)).reduce((a, [, v]) => a + v, 0);
  if (playerRel > 0) add(d, 'loyal', 0.5);
  else if (playerRel < 0) add(d, 'loyal', -0.5);
  if (LOYAL_YES.has(action)) add(d, 'loyal', 1);
  if (LOYAL_NO.has(action)) add(d, 'loyal', -1);
  if (TRADE_MADE.has(action)) { add(d, 'aggressive', 1); add(d, 'loyal', -0.5); }
  if (TRADE_PASSED.has(action)) add(d, 'aggressive', -0.5);
  if (SIGN.has(action)) add(d, 'aggressive', 1);
  if (PASS.has(action)) add(d, 'aggressive', -0.5);

  // The long run or tonight: development and rest, or the extra edge now.
  if (DEVELOP.has(action)) add(d, 'processDriven', 1);
  else if (eff === 'no' && DEVELOP.has(raw.onYes)) add(d, 'processDriven', -0.5);
  else if ((eff === 'yes' ? yesFx : noFx).ovr > 0 && ((eff === 'yes' ? yesFx : noFx).morale || 0) < 0) add(d, 'processDriven', -0.5);
  return d;
}

/** Record an answer (inside a mutate). Seasons more than two back are folded into their totals. */
export function recordDecision(draft, card, choice, atMs) {
  if (!isDecision(card)) return;
  const s = card._season ?? draft.seasonNum ?? 1;
  const d = decisionLean(card, choice);
  const auto = choice === 'auto' || choice === 'skip';
  const eff = auto ? (card.autoResolve === 'yes' ? 'yes' : 'no') : choice;
  const k = eff === 'yes' ? (card._budgetCost || 0) : (card._budgetCostNo || 0);
  const rec = (draft.gmRecord ||= { log: [], seasons: {} });
  // r220 §122.99 what a callback needs later: who it was about, the club on the other side, the money it brought, the
  // numbers it quoted.
  const tp = card._tokenPlayers || {};
  const pid = card._targetPlayerId || tp.hometown_player || tp.pl_player || card._tradeOffer?.incomingIds?.[0] || null;
  const r = eff === 'yes' ? (card._revenueK || 0) : 0;
  rec.log.push({ s, at: atMs, id: card.cardId || null, c: auto ? 'auto' : choice, d, ...(k > 0 ? { k } : {}),
    ...(pid ? { p: pid } : {}), ...(card._proposingTeamId ? { tm: card._proposingTeamId } : {}), ...(r > 0 ? { r } : {}),
    ...(card._cbData ? { x: card._cbData } : {}) });
  const cur = draft.seasonNum || 1;
  if (rec.log.some(e => e.s < cur - 2)) {
    const keep = [];
    for (const e of rec.log) {
      if (e.s >= cur - 2) { keep.push(e); continue; }
      const t = (rec.seasons[e.s] ||= { n: 0, d: {}, k: 0, ids: {} });
      t.n++; t.k += e.k || 0;
      for (const [dim, v] of Object.entries(e.d || {})) add(t.d, dim, v);
      if (e.id) t.ids[e.id] = (t.ids[e.id] || 0) + 1;
    }
    rec.log = keep;
  }
}

/** The profile: −1…+1 a dimension (0: nothing to go on, or balanced). */
export function profile(state) {
  const rec = state?.gmRecord;
  const out = Object.fromEntries(DIMS.map(k => [k, 0]));
  if (!rec) return { ...out, _n: 0 };
  const cur = state.seasonNum || 1;
  const w = (s) => PROFILE.fade ** Math.max(0, cur - 1 - s);   // (this season and the last: full weight; before that, less each season)
  const sum = Object.fromEntries(DIMS.map(k => [k, 0]));
  let n = 0;
  for (const e of rec.log || []) { const x = w(e.s); n += x; for (const [k, v] of Object.entries(e.d || {})) if (k in sum) sum[k] += v * x; }
  for (const [s, t] of Object.entries(rec.seasons || {})) { const x = w(+s); n += t.n * x; for (const [k, v] of Object.entries(t.d || {})) if (k in sum) sum[k] += v * x; }
  const scale = PROFILE.base + PROFILE.perDecision * n;
  for (const k of DIMS) out[k] = Math.max(-1, Math.min(1, Math.round(sum[k] / scale * 100) / 100));
  return { ...out, _n: Math.round(n) };
}

/** This season's numbers: decisions, lapsed, the money spent on asks, the community asks turned down. */
export function seasonTotals(state) {
  const s = state?.seasonNum || 1;
  const log = (state?.gmRecord?.log || []).filter(e => e.s === s);
  return {
    decisions: log.length,
    lapsed: log.filter(e => e.c === 'auto').length,
    spentK: log.reduce((a, e) => a + (e.k || 0), 0),
    spentCount: log.filter(e => (e.k || 0) > 0).length,
    communityNo: log.filter(e => (e.d?.communityFocused || 0) < 0).length,
  };
}
