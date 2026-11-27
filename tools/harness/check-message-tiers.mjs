/**
 * tools/harness/check-message-tiers.mjs
 * DEV/TEST ONLY — r295 §122.178 (step 7 groundwork): each message's tier (engine/MessageTiers.js), and the mode.
 *
 *   - The rules, as decided with the user: a trade, an injury, the weather, an emergency, the owner, roster events,
 *     operations, facilities, player discipline, money and legal — important; scouting finds, health and training,
 *     culture, marketing, the staff's routine check-ins — optional; an optional one worth $50K or more — important;
 *     what the GM asked for (a Compose reply, a watched player) — important; a message's own tier wins.
 *   - In play (spring and 30 games): every message in Messages and the schedule carries its tier from Entry.
 *   - The mode: Normal for a new club, the names in one place; Settings offers Important only and Normal (r296), not
 *     Hardcore yet.
 *
 *   node tools/harness/check-message-tiers.mjs
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import fs from 'node:fs';
import path from 'node:path';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { tierWhy } from '../../engine/MessageTiers.js';
import { MESSAGE_MODES, MESSAGE_MODE_NAMES, MESSAGE_MODES_SHOWN } from '../../data/constants.js';
import { liveUntil } from './drive.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();

// ── The rules ──
const CASES = [
  ['a trade offer', { cardId: 'trade_x', tag: 'GENERAL', _tradeOffer: {} }, 'important'],
  ['an injury', { cardId: 'injury_act1', tag: 'INJURY' }, 'important'],
  ['the weather (no card id, the grounds crew)', { cardId: null, tag: 'WEATHER', _wxGameTime: 1 }, 'important'],
  ['an emergency', { cardId: 'em_x', tag: 'MARKETING', _emergency: true }, 'important'],
  ['the owner', { cardId: 'owner_x', tag: 'OWNERSHIP' }, 'important'],
  ['an open spot', { cardId: 'open_spots', tag: 'ROSTER' }, 'important'],
  ['operations', { cardId: 'op1', tag: 'OPERATIONS' }, 'important'],
  ['facilities', { cardId: 'fac1', tag: 'FACILITIES' }, 'important'],
  ['player discipline (the user\'s choice)', { cardId: 'd1', tag: 'DISCIPLINE' }, 'important'],
  ['money (finance)', { cardId: 'f1', tag: 'FINANCE' }, 'important'],
  ['legal', { cardId: 'l1', tag: 'LEGAL' }, 'important'],
  ['a scouting find', { cardId: 'sc1', tag: 'SCOUTING' }, 'optional'],
  ['health', { cardId: 'h1', tag: 'HEALTH' }, 'optional'],
  ['training', { cardId: 't1', tag: 'TRAINING' }, 'optional'],
  ['culture', { cardId: 'c1', tag: 'CULTURE' }, 'optional'],
  ['marketing', { cardId: 'm1', tag: 'MARKETING' }, 'optional'],
  ['roster advice (a routine check-in, though its tag is LINEUP)', { cardId: 'roster_advice', tag: 'LINEUP' }, 'optional'],
  ['a rest ask (routine)', { cardId: 'rest_ask', tag: 'LINEUP' }, 'optional'],
  ['the nudge when a player returns (routine)', { cardId: 'lineup_return', tag: 'LINEUP' }, 'optional'],
  ['the next starter (routine)', { cardId: 'next_starter', tag: 'ROTATION' }, 'optional'],
  ['marketing worth $50K (the money line)', { cardId: 'm2', tag: 'MARKETING', _budgetCost: 50 }, 'important'],
  ['marketing worth $49K', { cardId: 'm3', tag: 'MARKETING', _budgetCost: 49 }, 'optional'],
  ['culture with $60K revenue', { cardId: 'c2', tag: 'CULTURE', _revenueK: 60 }, 'important'],
  ['a Compose reply (the GM asked)', { cardId: 'compose_x', tag: 'CULTURE', isCompose: true }, 'important'],
  ['a watched player (the GM asked)', { cardId: 'watch_alert', tag: 'SCOUTING' }, 'important'],
  ['a message\'s own tier wins', { cardId: 'x', tag: 'TRADE', _raw: { _tier: 'optional' } }, 'optional'],
];
const wrong = CASES.filter(([, c, want]) => tierWhy(c)[0] !== want).map(([name, c, want]) => `${name}: ${tierWhy(c).join(' — ')} (want ${want})`);
check(`the rules, as decided (${CASES.length} kinds of message)`, wrong.length === 0, wrong.join('\n      '));

// ── In play ──
for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(295);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
check(`the mode: ${MESSAGE_MODE_NAMES[S().settings.messageMode]} for a new club`, S().settings.messageMode === MESSAGE_MODES.NORMAL);
await liveUntil(S().schedule.filter(g => !g.isSpring)[29].gameTime + 6 * 3_600_000);
const all = [...(S().inbox || []), ...(S().scheduledCards || [])];
const none = all.filter(c => c._tier !== 'important' && c._tier !== 'optional');
const n = (t) => all.filter(c => c._tier === t).length;
check(`in play, every message carries its tier from Entry (${all.length}: ${n('important')} important, ${n('optional')} optional)`,
  none.length === 0 && n('important') > 0 && n('optional') > 0, none.slice(0, 5).map(c => c.cardId).join(', '));
const routine = all.filter(c => ['roster_advice', 'rest_ask', 'lineup_return', 'next_starter'].includes(c.cardId));
check(`…the staff's routine check-ins are optional (${routine.length})`, routine.every(c => c._tier === 'optional'));

// ── The names in one place; in Settings (r296): Important only and Normal, not Hardcore yet ──
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const ui = ['ui', 'ui/screens', 'ui/components'].flatMap(d => fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(root, d, f), 'utf8'))).join('\n')
  + fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const names = Object.values(MESSAGE_MODE_NAMES);
// ('Normal' is also the setup screen's difficulty group, so the names only the modes use are looked for)
const own = [MESSAGE_MODE_NAMES.important, MESSAGE_MODE_NAMES.hardcore];
check(`the mode's names are kept in one place (${names.join(' / ')}): the screens write none of them`, !own.some(x => ui.includes(x)));
check(`…Settings offers ${MESSAGE_MODES_SHOWN.map(m => MESSAGE_MODE_NAMES[m]).join(' and ')}, not Hardcore yet`,
  JSON.stringify(MESSAGE_MODES_SHOWN) === JSON.stringify(['important', 'normal']) && /MESSAGE_MODES_SHOWN/.test(ui));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
