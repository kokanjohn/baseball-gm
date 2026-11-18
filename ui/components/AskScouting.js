/**
 * ui/components/AskScouting.js
 * r208 §122.86 "Ask Scouting" about a deal on the table, from wherever it's asked (the trade message,
 * the counter screen): the Compose question, sent with the deal already picked. The answer comes as a
 * message on the staff's clock. Once asked, every one of these buttons reads "Scouting Asked".
 */

import * as App from '../App.js';
import * as EventBus from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { scoutingDeal } from '../../engine/TradeAdvice.js';

/** The button: Ask Scouting, Scouting Asked (disabled), or nothing (no deal on the table, no director). */
export function askScoutingButton(state, where, cls = 'btn-revise btn-deal') {
  const s = scoutingDeal(state, where, Date.now());
  if (!s) return '';
  return s.asked
    ? `<button type="button" class="${cls}" data-ask-scouting="${s.deal.key}" disabled>Scouting Asked</button>`
    : `<button type="button" class="${cls}" data-ask-scouting="${s.deal.key}">Ask Scouting</button>`;
}

/** Send the question. Returns true when it went. */
export async function askScouting(key) {
  const st = StateManager.get();
  const s = scoutingDeal(st, { key }, Date.now());
  if (!s) { App.showToast('That deal is no longer waiting on us.', 'neutral', 2500); return false; }
  if (s.asked) { App.showToast('Scouting is already on it.', 'neutral', 2500); return false; }
  const { deal } = s;
  try {
    const { deliverComposeCard } = await import('../../engine/CardEngine.js');
    deliverComposeCard('sc_trade', 'scouting', { topicLabel: deal.label, arg: { key: deal.key, label: deal.label, instanceId: deal.instanceId, expiresAtMs: deal.expiresAtMs } });
    import('../PushClient.js').then(P => P.syncPushSchedule()).catch(() => {});
  } catch (err) { console.error('AskScouting:', err); return false; }
  const dir = st.userTeam?.coachingStaff?.scoutingDirector;
  App.showToast(`Sent to ${dir?.name || 'Scouting'}. You'll hear back.`, 'positive', 2500);
  EventBus.emit('inbox:changed');
  return true;
}
