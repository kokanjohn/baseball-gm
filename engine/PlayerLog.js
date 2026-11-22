/**
 * PlayerLog.js — r253 §122.132 what happened to one of our players over the season, for the player card's
 * History: rests and other time out, training and how it went, position lessons, injuries.
 *   p.log = [{ at, kind, text }] — newest last, the last 60. Written only while the player is ours (the
 *   history goes with them if they leave; a player who joins us starts theirs here). Injuries come from
 *   p.injuryLog (kept for every player).
 * Pure: writes on the draft it's handed.
 */

const CAP = 60;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const WHO = { hittingCoach: 'the hitting coach', pitchingCoach: 'the pitching coach', benchCoach: 'the bench coach', program: 'the complex' };

export function logPlayer(draft, playerId, kind, text, atMs) {
  const p = draft?.players?.[playerId];
  if (!p || p.teamId !== 'user' || !text) return;
  p.log = [...(p.log || []), { at: atMs, kind, text }].slice(-CAP);
}

/** Time out (setUnavailable): a rest, a sickness, a benching, leave, a suspension, a sim game. (Training: logPlanStart.) */
export function logAway(draft, playerId, { reason, games = 0, untilMs = null }, atMs) {
  if (reason === 'training') return;
  const span = untilMs ? plural(Math.max(1, Math.round((untilMs - atMs) / 86_400_000)), 'day') : plural(games || 1, 'game');
  const text = {
    rest: `Rested (${span})`, illness: `Out sick (${span})`, benched: `Sat down (${span})`, leave: `On leave (${span})`,
    suspended: `Suspended (${span})`, 'sim game': 'Pitched a sim game',
  }[reason] || `Out (${span})`;
  logPlayer(draft, playerId, reason, text, atMs);
}

/** Development work started: the skill, who, and any days away. */
export function logPlanStart(draft, plan, atMs, { days = 0 } = {}) {
  const k = (plan.keys || []).join(' and ');
  const by = WHO[plan.owner] || null;
  const text = plan.owner === 'program' ? `Development program: ${k}${days ? ` (${plural(days, 'day')} away)` : ''}`
    : `Training: ${k}${by ? ` with ${by}` : ''}${days ? ` (${plural(days, 'day')} away)` : ''}`;
  logPlayer(draft, plan.playerId, 'training', text, atMs);
}

/** Development work done: where each skill went (or that it didn't take). */
export function logPlanDone(draft, plan, to, atMs) {
  const moves = (plan.keys || []).map(k => ({ k, from: plan.from?.[k], to: to?.[k] })).filter(x => Number.isFinite(x.from) && Number.isFinite(x.to));
  const up = moves.filter(x => x.to > x.from);
  const text = up.length ? `Training done: ${up.map(x => `${x.k} ${x.from} → ${x.to}`).join(', ')}`
    : `Training done: ${(plan.keys || []).join(' and ')} didn't move`;
  logPlayer(draft, plan.playerId, 'training', text, atMs);
}

/** A position lesson started or finished. */
export function logTeach(draft, playerId, pos, done, atMs, { learned = false } = {}) {
  logPlayer(draft, playerId, 'teach', done ? (learned ? `Learned ${pos}` : `Lessons at ${pos} done`) : `Learning ${pos}`, atMs);
}

/**
 * historyOf(state, p) → [{ at, kind, text }] newest first: the log, the injuries (p.injuryLog), and — for work
 * from before the log (r253) — the development plans still on record.
 */
export function historyOf(state, p) {
  if (!p) return [];
  const log = p.log || [];
  const since = log.length ? log[0].at : Infinity;
  const inj = (p.injuryLog || []).map(x => ({ at: x.atMs, kind: 'injury', text: `Hurt: ${String(x.label || 'injury').toLowerCase()}${x.days ? ` (${plural(x.days, 'day')})` : ''}` }));
  const older = (state?.developmentPlans || []).filter(x => x.playerId === p.id && x.createdAt < since)
    .map(x => ({ at: x.createdAt, kind: 'training', text: `${x.owner === 'program' ? 'Development program' : 'Training'}: ${(x.keys || []).join(' and ')}${x.status === 'done' ? ' (done)' : ''}` }));
  return [...log, ...inj, ...older].filter(x => Number.isFinite(x.at)).sort((a, b) => b.at - a.at);
}
