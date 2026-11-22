/**
 * engine/DecisionImpact.js — r255 §122.134 what a decision changed, and by how much (the Completed tab).
 *
 * The decision's effects land through many paths (soft effects, money, relationships, roster actions, rest and
 * training, the default's tax). Rather than describe each path, CardEngine takes a snapshot of what the GM can
 * see before the decision and again after it, and keeps the difference on the card (`card._impact`).
 *
 *   snapshot(state, card) → a plain object of the numbers that matter for that card
 *   diff(before, after)   → [{ label, from, to, delta, unit }]  (unit: 'pts' | 'k' | 'pct' | 'text')
 *
 * Pure: reads state, writes nothing.
 */
import { statusOf } from './PlayerStatus.js';
import { teamRating } from './RosterEngine.js';

const STAFF = Object.freeze([['manager', 'Manager'], ['pitchingCoach', 'Pitching coach'], ['hittingCoach', 'Hitting coach'], ['benchCoach', 'Bench coach']]);
const num = (v) => (Number.isFinite(v) ? v : null);
const last = (n) => String(n || '').trim().split(/\s+/).slice(-1)[0] || '';

/** The players a card is about: its named players and its target. */
function _cardPlayers(card) {
  const ids = new Set(Object.values(card?._tokenPlayers || {}).filter(x => typeof x === 'string'));
  if (card?._targetPlayerId) ids.add(card._targetPlayerId);
  return [...ids];
}

export function snapshot(state, card, atMs = Date.now()) {
  const u = state?.userTeam || {};
  const fin = u.finances || {};
  const staff = {};
  for (const [k] of STAFF) { const c = u.coachingStaff?.[k]; if (c && !c.vacant) staff[k] = { name: c.name, rel: num(c.relationship ?? 50) }; }
  const players = {};
  for (const id of _cardPlayers(card)) {
    const p = state?.players?.[id];
    if (!p) continue;
    players[id] = { name: p.name, rel: num(p.gmRelationship ?? 50), status: statusOf(state, p, atMs)?.full || null, logN: (p.log || []).length,
                    onTeam: p.teamId === 'user' };
  }
  return {
    rating: num(teamRating(state, 'user')), morale: num(u.morale), atmo: num(u.atmosphere), ownerTrust: num(u.ownerTrust), manConf: num(u.managerConfidence),
    winTarget: num(u._ownerWinTarget), funds: num(fin.funds), targetAdj: num(fin.seasonTargetAdj || 0),
    localAnnual: num(fin.market?.localAnnual), promo: fin.promo ? { ...fin.promo } : null,
    roster: [...(u.rosterIds || [])], staff, players,
  };
}

/**
 * diff(before, after, state) — what changed, in the order the GM would read it: the club, the money, the people.
 * Players named by the card: their view of the GM, their status ("Away training. Back Thursday.") and what was
 * started for them (their History's new lines). Players who joined or left the roster.
 */
export function diff(before, after, state) {
  if (!before || !after) return [];
  const out = [];
  const pts = (label, a, b) => { if (a != null && b != null && Math.round(b) !== Math.round(a)) out.push({ label, from: Math.round(a), to: Math.round(b), delta: Math.round(b - a), unit: 'pts' }); };
  pts('Team rating', before.rating, after.rating);
  pts('Team morale', before.morale, after.morale);
  pts('Stadium atmosphere', before.atmo, after.atmo);
  pts('Owner trust', before.ownerTrust, after.ownerTrust);
  pts('Manager confidence', before.manConf, after.manConf);
  pts('Owner\'s win target', before.winTarget, after.winTarget);
  if (before.funds != null && after.funds != null && Math.round(after.funds) !== Math.round(before.funds)) {
    out.push({ label: 'Club funds', from: Math.round(before.funds), to: Math.round(after.funds), delta: Math.round(after.funds - before.funds), unit: 'k' });
  }
  const dAdj = (after.targetAdj || 0) - (before.targetAdj || 0);
  if (Math.abs(dAdj) >= 0.005) out.push({ label: 'Payroll target this season', from: null, to: null, delta: Math.round(dAdj * 100), unit: 'pct' });
  if (before.localAnnual != null && after.localAnnual != null && Math.round(after.localAnnual) !== Math.round(before.localAnnual)) {
    out.push({ label: 'Local income a season', from: Math.round(before.localAnnual), to: Math.round(after.localAnnual), delta: Math.round(after.localAnnual - before.localAnnual), unit: 'k' });
  }
  const pr = after.promo;
  if (pr && JSON.stringify(pr) !== JSON.stringify(before.promo)) {
    const price = pr.price ? `${pr.price > 0 ? '+' : '−'}${Math.round(Math.abs(pr.price) * 100)}% prices` : null;
    out.push({ label: 'Tickets', text: [price, `next ${pr.gamesLeft} home game${pr.gamesLeft === 1 ? '' : 's'}`].filter(Boolean).join(', '), unit: 'text' });
  }
  for (const [k, role] of STAFF) {
    const a = before.staff?.[k], b = after.staff?.[k];
    if (a && b && a.name === b.name && a.rel != null && b.rel != null && Math.round(b.rel) !== Math.round(a.rel)) {
      out.push({ label: `${last(b.name)}'s view of you`, sub: role, from: Math.round(a.rel), to: Math.round(b.rel), delta: Math.round(b.rel - a.rel), unit: 'pts' });
    }
  }
  for (const [id, b] of Object.entries(after.players || {})) {
    const a = before.players?.[id];
    if (!a) continue;
    if (a.rel != null && b.rel != null && Math.round(b.rel) !== Math.round(a.rel)) {
      out.push({ label: `${last(b.name)}'s view of you`, from: Math.round(a.rel), to: Math.round(b.rel), delta: Math.round(b.rel - a.rel), unit: 'pts' });
    }
    const log = (state?.players?.[id]?.log || []).slice(a.logN);
    const said = new Set();
    for (const e of log) if (e?.text && !said.has(e.text)) { said.add(e.text); out.push({ label: last(b.name), text: e.text, unit: 'text' }); }
    if (b.status && b.status !== a.status && !said.size) out.push({ label: last(b.name), text: b.status, unit: 'text' });
  }
  const was = new Set(before.roster || []), now = new Set(after.roster || []);
  for (const id of after.roster || []) if (!was.has(id)) out.push({ label: 'Joined the roster', text: state?.players?.[id]?.name || 'A player', unit: 'text' });
  for (const id of before.roster || []) if (!now.has(id)) out.push({ label: 'Left the roster', text: state?.players?.[id]?.name || 'A player', unit: 'text' });
  return out;
}
