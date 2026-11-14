/**
 * engine/Strategy.js
 * r169 how the GM wants the club to play — set through Compose (the Manager, the Bench Coach, the
 * Bullpen Coach), used by the sim for our club. The CPU clubs play the defaults.
 *
 *   team.strategy = { order, run, hook }
 *     order  'classic'  speed and contact at the top, the best bat third, power fourth and fifth
 *            'onbase'   the best contact hitters at the top, then the same
 *            'best'     the best bats at the top: most plate appearances to the best hitters
 *     run    'less' | 'normal' | 'more'     how often runners try to steal (and who goes)
 *     hook   'quick' | 'normal' | 'long'    how long the starter stays in
 *   team.penRoles = { closer: id|null, setup: [id, id] }   the GM's bullpen roles (the rest by value)
 *
 * Pure: never imports StateManager.
 */

import { STRATEGY } from '../data/constants.js';

export const ORDER_STYLES = Object.freeze({
  classic: { label: 'Traditional',          sub: 'Speed and contact at the top, power in the middle' },
  onbase:  { label: 'On-Base at the Top',   sub: 'The best contact hitters first, then the power' },
  best:    { label: 'Best Bats at the Top', sub: 'The best hitters get the most trips to the plate' },
});
export const RUN_STYLES = Object.freeze({
  more:   { label: 'Run More',  sub: 'More steal attempts, and slower runners go too' },
  normal: { label: 'Run Normally', sub: 'The fast runners pick their spots' },
  less:   { label: 'Run Less',  sub: 'Only the fastest runners, and only the best chances' },
});
export const HOOK_STYLES = Object.freeze({
  quick:  { label: 'Quick Hook', sub: 'Go to the bullpen early: fresher arms, a busier bullpen' },
  normal: { label: 'Normal Hook', sub: 'Starters go as far as their stamina carries them' },
  long:   { label: 'Long Leash', sub: 'Let starters work deeper: a rested bullpen, tired starters' },
});

/** The club's strategy, with the defaults filled in. */
export function strategyOf(team) {
  const s = team?.strategy || {};
  return {
    order: ORDER_STYLES[s.order] ? s.order : 'classic',
    run: RUN_STYLES[s.run] ? s.run : 'normal',
    hook: HOOK_STYLES[s.hook] ? s.hook : 'normal',
  };
}

/** Set one part of the strategy on the draft (a style it doesn't know is ignored). */
export function setStrategy(team, part, style) {
  const known = { order: ORDER_STYLES, run: RUN_STYLES, hook: HOOK_STYLES }[part];
  if (!team || !known?.[style]) return false;
  team.strategy = { ...strategyOf(team), [part]: style };
  return true;
}

// ── The batting order ───────────────────────────────────────────

const sr = (p, k, d = 50) => p?.subRatings?.[k] ?? d;

/**
 * battingOrder(pool, style) — the nine in batting order. `pool` is the starting nine (any order).
 * Deterministic: ties by id.
 */
export function battingOrder(pool, style = 'classic') {
  const p9 = (pool || []).filter(Boolean).slice(0, 9);
  if (!p9.length) return [];
  const by = (score) => [...p9].sort((a, b) => (score(b) - score(a)) || String(a.id).localeCompare(String(b.id)));
  const used = new Set();
  const pick = (arr) => { const p = arr.find(x => !used.has(x.id)); if (p) used.add(p.id); return p; };
  const overall = by(p => p.ovr || 0);
  const power = by(p => sr(p, 'power', p.ovr));
  const rest = () => overall.filter(p => !used.has(p.id));
  if (style === 'best') {
    // the four best bats first (the best on-base of them leading off), then by overall
    const top = overall.slice(0, 4);
    const lead = [...top].sort((a, b) => (sr(b, 'contact') - sr(a, 'contact')) || String(a.id).localeCompare(String(b.id)))[0];
    used.add(lead.id);
    const order = [lead, ...top.filter(p => p.id !== lead.id)];
    for (const p of order) used.add(p.id);
    return [...order, ...rest()];
  }
  const top = style === 'onbase'
    ? by(p => sr(p, 'contact', p.ovr) * 0.85 + (p.ovr || 0) * 0.15)
    : by(p => sr(p, 'contact', p.ovr) * 0.55 + sr(p, 'speed') * 0.45);
  const s1 = pick(top), s2 = pick(top), s3 = pick(overall), s4 = pick(power), s5 = pick(power);
  return [s1, s2, s3, s4, s5, ...rest()].filter(Boolean);
}

/**
 * orderValue(order) — what an order is worth, roughly: the plate appearances each spot gets times
 * what the spot asks of its hitter (getting on at the top, power in the middle, the rest overall).
 */
const PA_WEIGHT = [1.12, 1.09, 1.06, 1.03, 1.0, 0.97, 0.94, 0.91, 0.88];
export function orderValue(order) {
  return (order || []).reduce((sum, p, i) => {
    const v = i < 2 ? sr(p, 'contact', p.ovr) * 0.6 + sr(p, 'speed') * 0.15 + (p.ovr || 0) * 0.25
            : i < 5 ? sr(p, 'power', p.ovr) * 0.45 + (p.ovr || 0) * 0.55
            : (p.ovr || 0);
    return sum + PA_WEIGHT[i] * v;
  }, 0);
}

/** The style the manager would pick for this nine (the current one when it's close: no flip-flopping). */
export function recommendOrder(pool, current = 'classic') {
  const val = (k) => orderValue(battingOrder(pool, k)) + (k === current ? 1.5 : 0);
  return Object.keys(ORDER_STYLES).sort((a, b) => val(b) - val(a))[0];
}

/** The choices for one part of the strategy: the recommended first; the current marked "Keep". */
export function styleChoices(part, current, rec, subFor = null) {
  const styles = { order: ORDER_STYLES, run: RUN_STYLES, hook: HOOK_STYLES }[part];
  return Object.keys(styles).sort((a, b) => (b === rec) - (a === rec))
    .map(k => ({ key: `${part}:${k}`, label: k === current ? `Keep It: ${styles[k].label}` : styles[k].label, sub: subFor ? subFor(k) : styles[k].sub }));
}

// ── The running game ────────────────────────────────────────────

/** How much more (or less) often runners try, and how much slower a runner may be and still go. */
export function runStyle(team) {
  return STRATEGY.run[strategyOf(team).run];
}

// ── The hook ────────────────────────────────────────────────────

/** The starter's innings wanted and batters before tiring, moved by the hook. */
export function hookStyle(team) {
  return STRATEGY.hook[strategyOf(team).hook];
}

// ── The bullpen's roles ─────────────────────────────────────────

/** The GM's roles, kept only for pitchers still on the club. */
export function penRolesOf(team) {
  const r = team?.penRoles || {};
  const on = new Set(team?.rosterIds || []);
  return { closer: r.closer && on.has(r.closer) ? r.closer : null, setup: (r.setup || []).filter(id => on.has(id)).slice(0, 2) };
}

/**
 * setPenRole(team, playerId, role) — 'closer' | 'setup' | 'auto' (the manager decides). A new closer
 * replaces the old (who goes back to the manager's say); a third setup man pushes out the first.
 */
export function setPenRole(team, playerId, role) {
  if (!team || !playerId) return false;
  const r = penRolesOf(team);
  r.setup = r.setup.filter(id => id !== playerId);
  if (r.closer === playerId) r.closer = null;
  if (role === 'closer') r.closer = playerId;
  else if (role === 'setup') r.setup = [...r.setup, playerId].slice(-2);
  else if (role !== 'auto') return false;
  team.penRoles = r;
  return true;
}

/** The role the GM gave this pitcher, if any. */
export function penRoleOf(team, playerId) {
  const r = penRolesOf(team);
  return r.closer === playerId ? 'closer' : r.setup.includes(playerId) ? 'setup' : null;
}
