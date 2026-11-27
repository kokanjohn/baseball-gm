/**
 * engine/cards/Resolution.js
 * CardEngine, resolving a card: answers, effects, expiry.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import * as GMP from '../GMProfile.js';
import { teamRating, recordRating } from '../RosterEngine.js';
import { setFlag } from '../NarrativeEngine.js';
import { clampWinTarget } from '../PrestigeEngine.js';
import * as Development from '../DevelopmentEngine.js';
import { CARD_ACTIONS } from '../CardActions.js';
import * as AllStar from '../AllStarEngine.js';
import * as Finance from '../FinanceEngine.js';
import { clockNow } from '../Clock.js';
import { dice, diceSeed } from '../Dice.js';
import * as Impact from '../DecisionImpact.js';
import { _logChoice } from './CardLog.js';
import { _resolveSubject } from './Helpers.js';
import { syncWinterOffers } from './OffseasonCards.js';
import { _applyChoiceMoney, _keepImpact, _makePromise, _maybeChainFollowup, expire } from './Promises.js';
import { HANDLED_CARD_ACTIONS, _applyRosterAction } from './ScoutingTips.js';

// ─────────────────────────────────────────────────────────────
// CARD RESOLUTION
// ─────────────────────────────────────────────────────────────

/**
 * resolve(instanceId, choice)
 * Applies the effects of a card decision and queues any follow-ups.
 *
 * @param {String} instanceId
 * @param {String} choice  — 'yes' | 'no'
 * @returns {void}
 */
export function resolve(instanceId, choice, { pick = null } = {}) {
  let state    = StateManager.get();
  let instance = (state.inbox || []).find(c => c.instanceId === instanceId);
  if (!instance) throw new Error(`CardEngine.resolve: instance '${instanceId}' not found`);
  if (instance.resolved) return;
  // r196 §122.73 a "no" the card doesn't offer (no second button: Messages never shows one) is not an
  // answer. Taken as one, it closed an injury report with no decision — the player stuck "being
  // evaluated" for months, holding a roster spot nobody could fill.
  if (choice === 'no' && !instance.noLabel) return;
  // §113 a card with choices (`_choices`): the one the GM tapped. The
  // Completed tab shows it as the decision.
  if (choice === 'yes' && pick != null && (instance._choices || []).some(c => c.key === pick)) {
    const label = instance._choices.find(c => c.key === pick).label;
    StateManager.mutate(s => {
      const card = s.inbox.find(c => c.instanceId === instanceId);
      if (card) { card._pick = pick; card.yesLabel = label; }
    });
    state = StateManager.get();
    instance = state.inbox.find(c => c.instanceId === instanceId);
  }

  const effects = choice === 'yes' ? (instance.yesEffect || {}) : (instance.noEffect || {});
  const before = Impact.snapshot(state, instance, clockNow());   // r255 §122.134

  // §74: whether the decision can still happen is judged on the world the GM
  // tapped in — before this card's own cost is charged below. (A card's
  // feasibility already counts its own price; re-judging after the charge
  // would count it twice.)
  const actionId = choice === 'yes' ? instance._raw?.onYes : choice === 'no' ? instance._raw?.onNo : null;
  const actionOk = CARD_ACTIONS[actionId] ? CARD_ACTIONS[actionId].feasible(state, { ...instance, choice }) : null;

  StateManager.mutate(s => {
    // Mark resolved
    const card = s.inbox.find(c => c.instanceId === instanceId);
    if (card) {
      card.resolved    = true;
      card.resolvedAt  = s.currentGameIndex || 0;
      card.choice      = choice;
      card.resolvedAtMs = clockNow();   // §95 when the decision was made (Completed tab)
    }
    _logChoice(s, instance, choice);   // §122.57
    GMP.recordDecision(s, instance, choice, clockNow());   // r219 §122.98 the GM's profile

    // Apply soft metric effects
    _applySoftEffects(s, effects, choice, instance);
    // §75: ballpark decisions shape the league's impression (hosting score).
    if (instance._raw?._hosting && s.allStar) AllStar.accrueCard(s, instance._raw._hosting, choice);

    // Apply budget cost / revenue — the exact amounts the card text showed.
    _applyChoiceMoney(s, instance, choice);

    // Apply relationship effects (a player's with the GM, the manager's and the coaches' — §122.60)
    _applyRelationships(s, instance, choice);

    // Narrative flag instrumentation (Section 34.6 — LOCKED)
    // Centralized here — no scattered setFlag calls across other files.
    // Cards that generate flags declare flagKey (on 'no') and/or flagKeyYes (on 'yes').
    const flagKey = choice === 'yes'
      ? (instance._raw?.flagKeyYes || null)
      : (instance._raw?.flagKey    || null);

    if (flagKey) {
      s.narrativeFlags = setFlag(s, {
        key:     flagKey,
        subject: instance._raw?.flagSubject
                   ? _resolveSubject(instance._raw.flagSubject, instance)
                   : null,
        gameIdx: s.currentGameIndex || 0,
        season:  s.seasonNum        || 1,
        choice,
        context: instance._raw?.flagContext || null,
      });
    }

    // Queue follow-up card if specified
    const followupType = choice === 'yes'
      ? (instance._raw?.onYes)
      : (instance._raw?.onNo);

    if (followupType && !HANDLED_CARD_ACTIONS.has(followupType)) {
      s.followupQueue = [...(s.followupQueue || []), {
        type:    followupType,
        atGame:  (s.currentGameIndex || 0) + 1,
        payload: {
          instanceId,
          choice,
          playerId:    instance._targetPlayerId || null,
          act2Variance: instance._act2Variance || null,
        },
      }];
    }
  });

  // Handle roster actions
  _applyRosterAction(instance, choice, StateManager.get(), { atMs: clockNow(), feasible: actionOk });
  _maybeChainFollowup(instance, choice, clockNow());
  _makePromise(instance, choice, clockNow());
  syncWinterOffers(clockNow());   // §122.60 a decision that spent money: an offer it no longer covers is off the table
  _keepImpact(instanceId, before, choice === 'yes' ? 'yes' : 'no', instance);
  // r154 §95 a decision that changed the club's rating (a release, a call-up)
  // is a point on its history at the moment it was made — not at the next tick.
  const after = StateManager.get(), last = (after.ratingHistory || []).slice(-1)[0];
  if (last && (teamRating(after, 'user') !== last.r || last.s !== (after.seasonNum || 1))) StateManager.mutate(s => { recordRating(s, clockNow()); });
}


// ─────────────────────────────────────────────────────────────
// EFFECT APPLICATION
// ─────────────────────────────────────────────────────────────

export function _applySoftEffects(state, effects, choice, instance) {
  if (!effects) return;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  if (effects.morale     !== undefined) state.userTeam.morale           = clamp((state.userTeam.morale     || 50) + effects.morale,     0, 100);
  if (effects.atmo       !== undefined) state.userTeam.atmosphere       = clamp((state.userTeam.atmosphere || 50) + effects.atmo,       0, 100);
  // r147 what ownership expects this season: the win target the season-end review holds us to.
  if (effects.winTarget  !== undefined) state.userTeam._ownerWinTarget  = clampWinTarget((state.userTeam._ownerWinTarget || 75) + effects.winTarget, state.archetype);   // §122.67
  if (effects.atmosphere !== undefined) state.userTeam.atmosphere       = clamp((state.userTeam.atmosphere || 50) + effects.atmosphere, 0, 100);
  if (effects.ownerTrust !== undefined) state.userTeam.ownerTrust       = clamp((state.userTeam.ownerTrust || 60) + effects.ownerTrust, 0, 100);
  // Manager confidence: cards were written with both spellings (§78.8 audit —
  // `managerConf` was silently ignored).
  const mc = effects.manConf ?? effects.managerConf;
  if (mc !== undefined) state.userTeam.managerConfidence = clamp((state.userTeam.managerConfidence || 60) + mc, 0, 100);
  // Money (§78): `funds` in $K; the older `budget` effect was written in $M and
  // never applied — both now move Club Funds.
  const fundsK = (effects.funds ?? 0) + (effects.budget !== undefined ? effects.budget * 1000 : 0);
  if (fundsK && state.userTeam.finances) {
    Finance.post(state.userTeam.finances, fundsK, 'cards', instance?.subject || 'Front-office decision', clockNow());
  }
  // §78.8 decisions that move the economy itself, not just a payment:
  //   target — the owner loosens / tightens this season's payroll target (share)
  //   gate   — a ticket promotion { price, fill, homeGames }
  //   local  — sponsor / rights income won or lost from here on (share)
  const fin = state.userTeam.finances;
  if (fin) {
    if (effects.target) Finance.adjustSeasonTarget(fin, effects.target);
    if (effects.gate)   Finance.startPromo(fin, effects.gate);
    if (effects.local)  Finance.adjustLocalIncome(fin, effects.local);
  }

  // OVR effect (§71) — on the players the card names, and only them (r270 §122.149: never one picked
  // at random): a `_group` card's players, else the player its text is about. A gain is a development
  // plan that lands over time; a loss is a temporary dip in condition for a few games.
  if (effects.ovr !== undefined && effects.ovr !== 0) {
    const rosterIds = state.userTeam.rosterIds || [];
    // §118 how long: this answer's own draw.
    const rand = dice(diceSeed(state), 'card-ovr', instance?.instanceId || instance?.cardId || 'card', choice);
    const named = instance?._groupPlayerIds?.length ? instance._groupPlayerIds : instance?._targetPlayerId ? [instance._targetPlayerId] : [];
    const atMs = clockNow();
    for (const targetId of named.filter(id => rosterIds.includes(id))) {
      if (effects.ovr > 0) Development.startPlan(state, targetId, { gain: effects.ovr, source: instance?.cardId || 'card' }, atMs);
      else Development.setCondition(state, targetId, { amount: Math.abs(effects.ovr) * 2, games: 2 + Math.floor(rand() * 4), reason: instance?.cardId || 'card' });
    }
  }
}


/**
 * §122.60 a card's effect on the people in it (`_relYes` / `_relNo` on the card): the manager's and the coaches'
 * relationship with the GM (a coach's shapes how much his players develop — DevelopmentEngine.gainMultiplier), and a
 * player's (his player card; what his injury reports tell us — InjuryEngine). Each point on a card is REL_UNIT on the
 * 0–100 scale. A player key names the player the card's text is about (its role token).
 */
const REL_UNIT = 3;

const REL_STAFF = Object.freeze({ mgr_nm: 'manager', pc_nm: 'pitchingCoach', hc_nm: 'hittingCoach', bc_nm: 'benchCoach' });

const REL_PLAYER = Object.freeze({ act_pi: 'active_pitcher', act_hi: 'active_hitter', ldr_nm: 'leader_player', pl_nm: 'pl_player', ht_pl: 'hometown_player' });

export function _applyRelationships(state, instance, choice) {
  if (instance._playerRelationshipEffect) _applyPlayerRelationshipEffect(state, instance._playerRelationshipEffect, choice);
  const rel = choice === 'yes' ? instance._raw?._relYes : choice === 'no' ? instance._raw?._relNo : null;
  if (!rel) return;
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  const staff = state.userTeam?.coachingStaff || {};
  const tp = instance._tokenPlayers || {};
  for (const [key, n] of Object.entries(rel)) {
    if (!n) continue;
    if (REL_STAFF[key]) {
      const c = staff[REL_STAFF[key]];
      if (c && !c.vacant) c.relationship = clamp((c.relationship ?? 50) + n * REL_UNIT);
    } else if (REL_PLAYER[key]) {
      const p = state.players?.[tp[REL_PLAYER[key]] || (key === 'pl_nm' ? instance._targetPlayerId : null)];
      if (p) p.gmRelationship = clamp((p.gmRelationship ?? 50) + n * REL_UNIT);
    }
  }
}

export const _relForChecks = Object.freeze({ REL_UNIT, REL_STAFF, REL_PLAYER });


function _applyPlayerRelationshipEffect(state, effect, choice) {
  if (!effect || !effect.playerId) return;
  const amount   = choice === 'yes' ? (effect.yesAmount || 0) : (effect.noAmount || 0);
  if (amount === 0) return;
  const player   = state.players[effect.playerId];
  if (player) {
    player.gmRelationship = Math.max(0, Math.min(100, (player.gmRelationship || 50) + amount));
  }
}


// ─────────────────────────────────────────────────────────────
// CARD EXPIRY
// ─────────────────────────────────────────────────────────────

export function _expireCards(state, context) {
  const gameIdx  = state.currentGameIndex || 0;
  const now      = clockNow();
  const toExpire = (state.inbox || []).filter(c => {
    if (c.resolved) return false;
    if (c.autoResolve === 'roster') return false;   // roster clock (§65)
    if (c.expiresAt   !== null && c.expiresAt   <= gameIdx) return true;
    if (c.expiresAtMs !== null && c.expiresAtMs <= now)     return true;
    return false;
  });

  for (const card of toExpire) {
    expire(card.instanceId);
  }
}
