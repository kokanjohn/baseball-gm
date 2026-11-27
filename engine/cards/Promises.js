/**
 * engine/cards/Promises.js
 * CardEngine, r147 promises: a decision whose words say something will happen later.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { FOLLOWUP_POOL } from '../../data/cards-pool.js';
import * as GMP from '../GMProfile.js';
import { beginInjury } from '../InjuryEngine.js';
import { resolvePromise, PROMISE_WHEN } from '../Promises.js';
import { exposeRatings } from '../Diamonds.js';
import * as Development from '../DevelopmentEngine.js';
import { CARD_ACTIONS } from '../CardActions.js';
import * as Finance from '../FinanceEngine.js';
import { stampSender } from '../Senders.js';
import { buildActivityFeedEntry, pruneActivityFeed } from '../SeasonEngine.js';
import { clockNow } from '../Clock.js';
import { dice, diceId, diceSeed, eventRand } from '../Dice.js';
import * as Impact from '../DecisionImpact.js';
import { _logChoice } from './CardLog.js';
import { _deliverAt, _rosterCard } from './Delivery.js';
import { _resolveBudgetCost } from './Helpers.js';
import { _deliverFollowupDef } from './PlayerCards.js';
import { _applyRelationships, _applySoftEffects } from './Resolution.js';
import { deliverInjuryAct2 } from './RosterCards.js';
import { _applyRosterAction } from './ScoutingTips.js';

/**
 * _maybeChainFollowup(instance, choice, atMs)
 * §74: a card with `_followup: { on, chance, delayMin, delayMax, subtype? }`
 * sets its FOLLOWUP_POOL card in motion when the GM's choice matches — about
 * the same players, a few days later (delays were written in games; the
 * league plays about one a day).
 */
// ─────────────────────────────────────────────────────────────
// r147 PROMISES — a decision whose words say something will happen later
// ─────────────────────────────────────────────────────────────

/**
 * _makePromise(instance, choice, atMs) — the card's `_promise[choice]`, if any:
 * an agent's grudge is marked at once; a promise judged N days later is
 * parked as a placeholder message now; one judged at a moment of the year
 * (season's end, the winter, free agency, next spring) waits in
 * state.promises for that moment (keepPromises). See engine/Promises.js.
 */
export function _makePromise(instance, choice, atMs) {
  const def = instance._raw?._promise?.[choice === 'auto' ? (instance.autoResolve === 'yes' ? 'yes' : 'no') : choice];
  if (!def) return;
  const st = StateManager.get();
  const tp = instance._tokenPlayers || {};
  const playerId = (def.player && tp[def.player]) || instance._targetPlayerId || Object.values(tp)[0] || null;
  if (def.kind === 'agent_grudge') {
    if (playerId) StateManager.mutate(s => { if (s.players[playerId]) s.players[playerId]._agentGrudge = true; });
    return;
  }
  const rec = {
    id: diceId(dice(diceSeed(st), 'promise', instance.instanceId, choice)),
    kind: def.kind, cardId: instance.cardId, choice: choice === 'auto' ? (instance.autoResolve === 'yes' ? 'yes' : 'no') : choice,
    madeAtMs: atMs, season: st.seasonNum || 1, playerId,
    costK: instance._budgetCost || null, costNoK: instance._budgetCostNo || null,
    params: def.params || null, when: def.when || null, redeal: def.redeal || null,
  };
  if (def.afterDays) { _schedulePromise(rec, atMs + def.afterDays * 86_400_000); return; }
  StateManager.mutate(s => { s.promises = [...(s.promises || []), rec]; });
}


function _schedulePromise(rec, atMs, expiresAtMs = null) {
  const st = StateManager.get();
  return _deliverAt(_rosterCard(st, {
    cardId: `promise_${rec.kind}`, _rosterKey: `promise:${rec.id}`, _promiseRec: rec,
    tag: 'NOTE', noLabel: null, yesLabel: 'Understood', autoResolve: 'skip',
    expiresAtMs: expiresAtMs || atMs + 24 * 3600_000, _raw: {},
  }), atMs);
}


/**
 * keepPromises(when, atMs, expiresAtMs) — the moment of the year has come:
 * every promise waiting for it becomes a message at `atMs` (staggered a few
 * minutes apart). A promise "for next spring" made last season, one "for the
 * season's end" made this season. A re-deal promise brings its card back.
 */
export function keepPromises(when, atMs, expiresAtMs = null) {
  if (!PROMISE_WHEN.includes(when)) return 0;
  const st = StateManager.get();
  const season = st.seasonNum || 1;
  const due = (st.promises || []).filter(r => r.when === when && (when === 'spring' ? r.season < season : r.season <= season));
  if (!due.length) return 0;
  StateManager.mutate(s => { const ids = new Set(due.map(r => r.id)); s.promises = (s.promises || []).filter(r => !ids.has(r.id)); });
  due.forEach((rec, i) => {
    const at = atMs + i * 7 * 60_000;
    if (rec.redeal) _deliverFollowupDef(rec.redeal, {}, at);
    else _schedulePromise(rec, at, expiresAtMs);
  });
  return due.length;
}


/**
 * The placeholder lands: written from the world as it is now. Returns the
 * message (or null) and what lands with it; `_landPromises` applies those
 * inside the release, `_afterLanding` does what needs its own step (an injury).
 */
export function _writePromise(state, c) {
  const rec = c._promiseRec;
  const res = resolvePromise(state, rec, c.deliverAtMs);
  if (!res) return { card: null, land: null };
  if (!res.card) return { card: null, land: res.land };
  const f = res.card;
  const decision = !!f._decision;
  const card = {
    ...c, ...f, _promiseRec: undefined, _promiseKind: rec.kind,
    preview: f.preview || String(f.body || '').split('. ')[0] + '.',
    type: f.type || 'normal',
    ...(decision ? { autoResolve: 'no', _raw: {}, expiresAtMs: c.expiresAtMs } : { noLabel: null, yesLabel: 'Understood' }),
  };
  delete card._decision;
  return { card, land: res.land };
}


export function _landPromises(s, landed, atMs) {
  for (const { land, card } of landed) {
    if (!land) continue;
    if (land.effects) _applySoftEffects(s, land.effects, 'yes', card || {});
    if (land.fundsK) Finance.post(s.userTeam.finances, land.fundsK, 'cards', land.fundsLabel || card?.subject || 'Front office', atMs);
    if (land.dip && s.players[land.dip]) Development.setCondition(s, land.dip, { amount: 2, games: 3, reason: 'promise' });
    if (land.scouted && s.players[land.scouted]) s.players[land.scouted]._scoutedAt = atMs;
    if (land.sharpen && s.players[land.sharpen]) exposeRatings(s.players[land.sharpen], 300);
    if (land.feed) s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), buildActivityFeedEntry('ours', s.userTeam.abbr, land.feed, atMs)]);
  }
}


export function _afterLanding(landed, atMs) {
  for (const { land } of landed) {
    if (!land?.injure) continue;
    const id = land.injure;
    const st = StateManager.get();
    const p = st.players[id];
    if (!p || p.isInjured) continue;
    StateManager.mutate(s => { Object.assign(s.players[id], beginInjury(s.players[id], atMs, 'minor', dice(diceSeed(s), 'promise-injury', id, atMs))); });
    deliverInjuryAct2(id, atMs);
  }
}


export function _maybeChainFollowup(instance, choice, atMs) {
  const f = instance._raw?._followup;
  if (!f || (f.on && f.on !== choice) || eventRand() >= (f.chance ?? 1)) return;
  const options = FOLLOWUP_POOL.filter(e => e?.type === instance.cardId && e.card && !e.card._retired);
  if (!options.length) return;
  const pick = options[Math.floor(eventRand() * options.length)].card;
  const days = (f.delayMin ?? 2) + eventRand() * Math.max(0, (f.delayMax ?? f.delayMin ?? 4) - (f.delayMin ?? 2));
  const preset = Object.fromEntries(Object.entries(instance._tokenPlayers || {}).filter(([, id]) => id));
  _deliverFollowupDef(pick.id, preset, atMs + days * 86_400_000);
}


/**
 * expire(instanceId, atMs = clockNow())
 * Auto-resolves a card with its auto-resolve path and penalty. A roster card
 * (autoResolve 'roster', §65) runs its `_raw.onAuto` roster action at `atMs`
 * — the roster-clock moment of the deadline, which during catch-up is in the
 * past. A card that expires before it was ever released is moved into the
 * inbox first, so the Completed tab shows what happened.
 *
 * @param {String} instanceId
 * @param {Number} [atMs]
 */
export function expire(instanceId, atMs = clockNow()) {
  let state    = StateManager.get();
  let instance = (state.inbox || []).find(c => c.instanceId === instanceId);
  if (!instance) {
    const sched = (state.scheduledCards || []).find(c => c.instanceId === instanceId);
    if (!sched) return;
    StateManager.mutate(s => {
      s.scheduledCards = (s.scheduledCards || []).filter(c => c.instanceId !== instanceId);
      s.inbox = [...(s.inbox || []), stampSender({ ...sched, arrivedAtMs: Math.min(sched.deliverAtMs, atMs) }, s)];
    });
    state    = StateManager.get();
    instance = state.inbox.find(c => c.instanceId === instanceId);
  }
  if (!instance || instance.resolved) return;
  // r219 §122.98 a decision left to lapse: the staff decided (the profile notes it).
  StateManager.mutate(s => { GMP.recordDecision(s, instance, 'auto', atMs); });

  const before = Impact.snapshot(StateManager.get(), instance, atMs);   // r255 §122.134
  if (instance.autoResolve === 'roster') {
    StateManager.mutate(s => {
      const card = s.inbox.find(c => c.instanceId === instanceId);
      if (card) {
        card.resolved     = true;
        card.choice       = 'auto';
        card.resolvedAt   = s.currentGameIndex || 0;
        card.resolvedAtMs = atMs;
      }
    });
    _applyRosterAction(instance, 'auto', StateManager.get(), { atMs, auto: true });
    _keepImpact(instanceId, before, null, instance);
    return;
  }

  const autoPath = instance.autoResolve || 'no';
  if (autoPath === 'skip') {
    // Silently dismiss
    StateManager.mutate(s => {
      const card = s.inbox.find(c => c.instanceId === instanceId);
      if (card) { card.resolved = true; card.choice = 'skip'; card.resolvedAtMs = atMs; }
      _logChoice(s, instance, 'skip');
    });
    return;
  }

  // §78.8 an unanswered card does what its default choice does — the effects
  // and the money of that choice (a deal signed by default pays; an expense
  // absorbed by default is charged) — plus the tax for leaving it.
  const tax = instance.autoResolveTax || {};
  const def = autoPath === 'yes' ? 'yes' : 'no';
  StateManager.mutate(s => {
    const card = s.inbox.find(c => c.instanceId === instanceId);
    if (card) {
      card.resolved  = true;
      card.choice    = 'auto';
      card.autoChoice = def;
      card.resolvedAt = s.currentGameIndex || 0;
      card.resolvedAtMs = atMs;
    }
    _logChoice(s, instance, def);   // §122.57 what the unanswered card did
    _applySoftEffects(s, def === 'yes' ? instance.yesEffect : instance.noEffect, def, instance);
    _applyRelationships(s, instance, def);   // §122.60 the default's effect on the people involved, too
    _applyChoiceMoney(s, instance, def);
    _applySoftEffects(s, tax, 'auto', instance);
    // r213 §122.91 an emergency the staff handled: sometimes it goes badly (settled when it came)
    if (instance._emergencyBad) _applySoftEffects(s, instance._emergencyBad, 'auto', instance);
  });
  _makePromise(instance, def, atMs);   // r147 the default's promise, too
  _maybeChainFollowup(instance, def, atMs);   // §122.57 and what follows from it (an unanswered "no" has its sequel too)
  // §74: an unanswered card that resolves to "no" does what "no" does (e.g.
  // a player on personal leave still goes, for the minimum).
  const onNo = instance._raw?.onNo;
  if (autoPath === 'no' && onNo && (CARD_ACTIONS[onNo] || onNo.startsWith('as_'))) {
    _applyRosterAction(instance, 'no', StateManager.get(), { atMs });   // registry and All-Star actions alike
  }
  // r213 §122.91 an emergency the staff handled their way ("go, take the time"; "keep them away"): that action too
  const onYes = instance._raw?.onYes;
  if (instance._emergency && autoPath === 'yes' && onYes && CARD_ACTIONS[onYes]) {
    _applyRosterAction(instance, 'yes', StateManager.get(), { atMs });
  }
  _keepImpact(instanceId, before, def, instance);
}


/**
 * r255 §122.134 what the decision changed, kept on the card for the Completed tab: the difference between what
 * the GM could see before it and after every path it took (effects, money, people, the roster), plus whether
 * more comes of it later (a promise it made).
 */
export function _keepImpact(instanceId, before, choice, instance) {
  const after = StateManager.get();
  const rows = Impact.diff(before, Impact.snapshot(after, instance, clockNow()), after);
  const later = !!(choice && instance?._raw?._promise?.[choice]);
  StateManager.mutate(s => {
    const card = (s.inbox || []).find(c => c.instanceId === instanceId);
    if (card) { card._impact = rows; if (later) card._impactLater = true; }
  });
}


/** A decision's money — the exact amounts the card showed — into / out of Club Funds (§78). */
export function _applyChoiceMoney(s, instance, choice) {
  const costK = choice === 'yes' ? _resolveBudgetCost(instance._budgetCost)
              : choice === 'no'  ? _resolveBudgetCost(instance._budgetCostNo)
              : 0;
  if (costK) Finance.post(s.userTeam.finances, -costK, 'cards', instance.subject || 'Front-office decision', clockNow());
  if (choice === 'yes' && instance._revenueK) {
    Finance.post(s.userTeam.finances, instance._revenueK, 'cards', instance.subject || 'Deal', clockNow());
  }
}
