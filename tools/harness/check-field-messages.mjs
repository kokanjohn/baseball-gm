/**
 * tools/harness/check-field-messages.mjs — r256 §122.135 the field's messages agree with the weather and each other.
 *   - The field is the groundskeeper's: no Stadium Ops message talks about the infield, the mound, the grass, the
 *     warning track, the tarp or the grounds crew.
 *   - "The infield is soft after the rain" (the spring opener) comes only when it rained at our park; a storm in the
 *     night (the tarp, the light tower) only on a night it stormed.
 *   - The groundskeeper's field report (Compose) tells the field message as the GM answered it (yes, no, left
 *     open), never "no complaints" beside it.
 *   - The spring travel message reads right with every context.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { writeComposeReply } from '../../engine/ComposeReplies.js';
import { rainHolds, rainAtPark } from '../../engine/FieldCare.js';
import { pickEmergency } from '../../engine/Emergencies.js';
import { EMERGENCIES } from '../../data/cards-emergency.js';
import { MOMENT_CARDS } from '../../data/cards-moments.js';
import * as POOL from '../../data/cards-pool.js';
import { WINTER_POOL } from '../../data/cards-winter.js';
import { AWAY_FOLLOWUPS, ROAD_POOL, OFFDAY_POOL } from '../../data/cards-away.js';
import { CARD_TOKEN_POOLS as CARD_TOKENS } from '../../data/card-tokens.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const all = (x) => (Array.isArray(x) ? x.flatMap(all) : x && typeof x === 'object' ? (x.id && (x.body || x.subject) ? [x] : Object.values(x).flatMap(all)) : []);
const H = 3_600_000;

{
  const cards = all([MOMENT_CARDS, Object.values(POOL), WINTER_POOL, AWAY_FOLLOWUPS, ROAD_POOL, OFFDAY_POOL, EMERGENCIES]).filter(c => !c._retired);
  const FIELD = /\b(infield|outfield grass|mound|sod|warning track|grounds crew|tarp|playing surface|field (is|was) (soft|wet))\b/i;
  const ops = cards.filter(c => /^Stadium Ops/.test(c.sender || '') && FIELD.test(`${c.subject} ${c.body} ${c.yesMsg} ${c.noMsg}`));
  check(`no Stadium Ops message talks about the field (${cards.filter(c => /^Stadium Ops/.test(c.sender || '')).length} of theirs)`, ops.length === 0, ops.map(c => c.id).join(', '));
  const gk = cards.filter(c => c.sender === 'Head Groundskeeper' && c.noLabel && !c._toastOnly && c.type === 'urgent');
  check(`every field problem the groundskeeper sends carries a field report line (${gk.length})`, gk.length >= 6 && gk.every(c => c._fieldNote?.yes && c._fieldNote?.no),
    gk.filter(c => !c._fieldNote).map(c => c.id).join(', '));
  const sp8 = cards.find(c => c.id === 'sp8');
  check('spring travel: the context is its own sentence (no "standard, but several veterans asked for the charter")',
    /standard\. \{sp8_context\}"?$/.test(sp8.body) && CARD_TOKENS.sp8_context.every(t => /^[A-Z].*\.$/.test(t)), sp8.body);
}

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(256);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'south' });
const S = () => SM.get();
const homes = S().schedule.filter(g => g.isHome && Number.isFinite(g.gameTime));

{
  // Nights before our home games: a storm emergency only when it stormed.
  const nights = homes.slice(0, 120).map(g => { const d = new Date(g.gameTime); d.setHours(2, 0, 0, 0); return d.getTime(); }).filter(t => t > clock.get());
  let wet = 0, stormWet = 0;
  const bad = [];
  for (const at of nights) {
    const isWet = rainAtPark(S(), at - 6 * H, at) >= 0.5;
    if (isWet) wet++;
    for (let k = 0; k < 12; k++) {
      const rand = () => (k + 0.5) / 12;   // every version, in turn
      const d = pickEmergency(S(), at, rand);
      if (d?._situation === 'storm') { if (!isWet) bad.push(new Date(at).toISOString()); else stormWet++; }
    }
  }
  check(`a storm in the night only after a storm (${nights.length} nights, ${wet} wet; storms picked on wet nights: ${stormWet})`, bad.length === 0 && (wet === 0 || stormWet > 0), bad.slice(0, 3).join(', '));
}

{
  // The spring opener: "the infield is soft" only when it rained; then the field report tells it as answered.
  const opener = S().schedule.find(g => g.isSpring && g.isHome) || S().schedule[0];
  const spec = MOMENT_CARDS.spring_opener.find(c => c.id === 'mo_spo_weather')._needsRain;
  const tries = [];
  for (let k = 0; k < 40; k++) {
    const r = SM.speculate(() => {
      SM.mutate(s => { s.weatherSeed = `fieldcheck-${k}`; s.momentsDone = {}; });
      const wet = rainHolds(S(), spec, opener.gameTime - 150 * 60_000);
      clock.set(opener.gameTime - 6 * H);
      const ids = [];
      for (let j = 0; j < 6; j++) {
        SM.mutate(s => { s.momentsDone = {}; s.scheduledCards = (s.scheduledCards || []).filter(c => !c._firstMoment); });
        globalThis.localStorage?.removeItem?.('bgm_seenMoments');
        CE.deliverMomentCard('spring_opener', buildCardContext(), opener, 'pregame');
        ids.push(...(S().scheduledCards || []).filter(c => c._firstMoment === 'spring_opener').map(c => c.cardId));
      }
      return { k, wet, soft: ids.includes('mo_spo_weather') };
    });
    tries.push(r);
  }
  const dry = tries.filter(t => !t.wet), wet = tries.filter(t => t.wet);
  check(`spring opener: "the infield is soft" only after rain (${dry.length} dry openers, ${wet.length} wet; soft on dry: ${dry.filter(t => t.soft).length}, on wet: ${wet.filter(t => t.soft).length})`,
    dry.every(t => !t.soft) && wet.length > 0 && wet.some(t => t.soft));

  // The field report beside the message: open, yes, no.
  const k = wet.find(t => t.soft)?.k;
  if (k != null) {
    for (const path of ['open', 'yes', 'no']) {
      const rep = SM.speculate(() => {
        SM.mutate(s => { s.weatherSeed = `fieldcheck-${k}`; s.momentsDone = {}; });
        clock.set(opener.gameTime - 6 * H);
        for (let j = 0; j < 30 && !(S().scheduledCards || []).some(c => c.cardId === 'mo_spo_weather'); j++) {
          SM.mutate(s => { s.momentsDone = {}; s.scheduledCards = (s.scheduledCards || []).filter(c => !c._firstMoment); });
          globalThis.localStorage?.removeItem?.('bgm_seenMoments');
          CE.deliverMomentCard('spring_opener', buildCardContext(), opener, 'pregame');
        }
        const sc = (S().scheduledCards || []).find(c => c.cardId === 'mo_spo_weather');
        if (!sc) return null;
        clock.set(sc.deliverAtMs + 60_000);
        CE.releaseDueCards(clock.get());
        const card = S().inbox.find(c => c.cardId === 'mo_spo_weather');
        if (path !== 'open') CE.resolve(card.instanceId, path);
        const at = clock.get() + 10 * 60_000;
        return { body: writeComposeReply(S(), { topicId: 'gk_field', channelId: 'groundskeeper', atMs: at })?.body || '', note: card._raw._fieldNote[path] };
      });
      check(`the field report with the soft infield ${path === 'open' ? 'still unanswered' : `answered ${path}`}: tells it, and no "no complaints"`,
        !!rep && rep.body.includes(rep.note) && !/No complaints|in good shape/i.test(rep.body), rep ? rep.body.slice(0, 260) : 'no message');
    }
  }
}

console.log(fail ? `\n${fail} FAILED — ${pass} passed` : `\nALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
