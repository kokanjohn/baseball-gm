/**
 * engine/CardEngine.js
 * Card selection, token resolution, delivery, expiry, and effect application.
 *
 * r290 §122.171 (foundation step 2): a thin front. The code lives in engine/cards/, one file per area, moved
 * as it was; this module re-exports exactly what it exported before, so every importer is unchanged.
 *
 * Rules:
 *   - This module imports StateManager — it is the second module (after GameEngine)
 *     that writes to state. All other engines are pure functions.
 *   - checkAndDeliver() is called by GameEngine after every game commit.
 *   - resolve() applies card effects and queues follow-ups.
 *   - Token resolver enforces pitcher handedness: all pitcher name tokens
 *     automatically append "(R)" or "(L)". Card authors never include it manually.
 *   - No card computes its own situation — context is always passed from GameEngine.
 *
 * Section references: Section 10 (card system), Section 11 (injury two-act),
 *   Section 9.6 (counter-offer), Section 22.5 (gmRelationship effects)
 */

export {
  deliverTradeCall, deliverTradeOffer, withdrawTalkCards, deliverTalkReply,
} from './cards/TradeOffers.js';
export {
  checkAndDeliver, _testDeliverAt, askedInCompose, processFollowupQueue,
} from './cards/Delivery.js';
export {
  resolve, _relForChecks,
} from './cards/Resolution.js';
export {
  keepPromises, expire,
} from './cards/Promises.js';
export {
  deliverInjuryAct1, deliverInjuryAct2, syncRosterCards, expireDueRosterCards,
} from './cards/RosterCards.js';
export {
  staffLookAt, nextStarterId, deliverNextStarterCard,
} from './cards/LineupAdvice.js';
export {
  cardSituation, fitsSituation,
} from './cards/Situation.js';
export {
  setSeenMoments, seenMoments, deliverMomentCard, releaseDueCards, takeReleased, onRelease, getPushSchedule, gameReminders,
} from './cards/FirstMoments.js';
export {
  deliverSeedTradeOffer, scheduleFirstDay, deliverEmergency, deliverDeadlineStep, deliverStretchStep, deliverWinterStep, deliverSituation, deliverRetirePlans, deliverCallback, advanceArcs, scheduleSpringGms, deliverSeedCards, deliverCardById, deliverComposeCard, pendingComposeReplies, inboxCounts, getInbox, markRead, getHistory, clearHistory, restoreHistory,
} from './cards/Compose.js';
export {
  resolveTokens, recentPoorCalls, profileWeightForChecks,
} from './cards/Selection.js';
export {
  cardDebug, cardRepeatRule,
} from './cards/CardLog.js';
export {
  deliverAllStarHostCard, deliverAllStarLobbyCard, deliverAllStarSelectionCard, scheduleAllStarWeekCards, deliverAllStarMvpCard, deliverAllStarTradeOffer, withdrawAllStarLobbyCard,
} from './cards/AllStarCards.js';
export {
  deliverRainStartCard, deliverDoubleheaderCard, deliverFieldPrepCard, deliverDrainageCard, deliverCrewMessage, deliverWeatherDecision, noteWeatherCall, expireGameWeatherDecisions, withdrawNoWeatherHold, withdrawGameDayCards, retimeGameCards, STH_CARD_IDS, withdrawScheduledWeather, withdrawWeatherCards, deliverOwnerFinanceCard, deliverOwnerCutOrder, deliverOwnerOrderResult,
} from './cards/WeatherCards.js';
export {
  priorityNow, deliverMeetingsTargets, runWatches, deliverDeadlineIdea,
} from './cards/LeagueTradeCards.js';
export {
  deliverOwnershipCard, deliverPriorityCard, deliverResignCard, deliverExtensionCard, deliverAgentAsk, deliverReleaseCard, deliverManagerContractCard, deliverManagerHireCard, deliverCoachReviewCard, deliverCoachHireCard, deliverFreeAgentCards, deliverTicketCard, deliverCampaignCard, syncWinterOffers, deliverFacilityCard, deliverFanEventCard, deliverGateReminder, deliverRetirementNotice, leaguePositionNews, deliverPositionsTurnNotice,
} from './cards/OffseasonCards.js';
export {
  directorTips, HANDLED_CARD_ACTIONS,
} from './cards/ScoutingTips.js';
