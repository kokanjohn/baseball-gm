// r238 §122.117 Compose and the incoming messages know about each other.
//   node tools/harness/check-compose-overlap.mjs [seed=1]
// (1) Scouting's first-day offer to look at the market isn't sent once the GM has asked Scouting for the free
//     agents in Compose; asking withdraws one waiting in Messages too. The director's reply, their first word to
//     the GM, says who they are. (2) The groundskeeper's extra-crew message and the Compose question about it:
//     never both for one game.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick } from '../../engine/GameEngine.js';
import { releaseDueCards, deliverComposeCard, askedInCompose } from '../../engine/CardEngine.js';
import { writeComposeReply } from '../../engine/ComposeReplies.js';
import { COMPOSE_OVERLAP } from '../../data/constants.js';

const SEED = parseInt(process.argv[2] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const isScoutOffer = (c) => COMPOSE_OVERLAP.cards[c.cardId] === 'sc_free_agents';
let _slot = 0;
const ARCH = ['contender', 'lab', 'institution'];
const fresh = async (seed) => {
  seedRandom(seed);
  await startNewGame({ archetypeId: ARCH[_slot++ % 3], gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                       abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
  tick(); releaseDueCards();
};

// ── (1a) asked before the offer arrives ──
// (three saves in all, one per archetype: a seed whose first day has Scouting's offer — 1 does)
await fresh(SEED);
const s1 = SEED + 1;
const offer = (SM.get().scheduledCards || []).find(isScoutOffer);
check(`a new team's first day has Scouting's offer on its way (seed ${SEED})`, !!offer);
if (offer) {
  check('…and no Scouting message has arrived yet', !(SM.get().inbox || []).some(isScoutOffer));
  deliverComposeCard('sc_free_agents', 'scouting', { topicLabel: 'Free agents worth a look' });
  const st = SM.get();
  check('asking in Compose withdraws the offer on its way', !(st.scheduledCards || []).some(isScoutOffer));
  check('…the question counts as asked', askedInCompose(st, 'sc_free_agents'));
  // Through the whole first day: the offer never comes; the reply does, and introduces the director.
  const end = Math.max(...(st.scheduledCards || []).map(c => c.deliverAtMs), offer.deliverAtMs) + 60_000;
  clock.set(end); tick(); releaseDueCards();
  const inbox = SM.get().inbox || [];
  check('the offer never arrives', !inbox.some(isScoutOffer), inbox.filter(isScoutOffer).map(c => c.subject).join(' | '));
  const reply = inbox.find(c => c.isCompose && c._composeTopic === 'sc_free_agents');
  check(`the director's reply arrives, introducing them: “${(reply?.body || '').split('\n\n')[0]}”`, !!reply && /^I run our scouting/.test(reply.body));
  // A second question to Scouting is not an introduction.
  const again = writeComposeReply(SM.get(), { topicId: 'sc_free_agents', channelId: 'scouting', atMs: clock.get() + 3_600_000 });
  check('a later reply from the director opens as usual', !!again && !/^I run our scouting/.test(again.body), again?.body?.split('\n\n')[0]);
}

// ── (1b) the offer already in Messages, unanswered: asking withdraws it ──
if (offer) {
  await fresh(s1 - 1);
  const o = (SM.get().scheduledCards || []).find(isScoutOffer);
  clock.set(o.deliverAtMs + 1000); tick(); releaseDueCards();
  check('the offer is in Messages, unanswered', (SM.get().inbox || []).some(c => isScoutOffer(c) && !c.resolved));
  deliverComposeCard('sc_free_agents', 'scouting', { topicLabel: 'Free agents worth a look' });
  check('asking in Compose takes it out of Messages', !(SM.get().inbox || []).some(c => isScoutOffer(c) && !c.resolved));
}

// ── (2) the extra crew: the card and the Compose question ──
await fresh(SEED);
let st = SM.get();
const g = (st.schedule || []).find(x => x.isHome && !x.isSpring && x.gameTime - clock.get() > 30 * 3_600_000);
check('a home game to ask about', !!g);
if (g) {
  clock.set(g.gameTime - 30 * 3_600_000);
  const sent = { instanceId: 'fp-test', cardId: 'field_prep', sender: 'Head Groundskeeper', subject: 'Rain in the forecast', resolved: false,
                 deliverAtMs: clock.get() - 3_600_000, _fieldGameTime: g.gameTime, _fieldCostK: 40 };
  SM.mutate(s => { s.inbox = [...(s.inbox || []), sent]; });
  const rep = writeComposeReply(SM.get(), { topicId: 'gk_prep', channelId: 'groundskeeper', atMs: clock.get() });
  check(`the crew's message is waiting: the reply points to it, no second decision (“${rep?.preview}”)`,
        !!rep && !rep.decision && /already sent you a note/.test(rep.body));
  // The other way: the GM's decision (from Compose) for the game is in Messages; the crew's card for it is dropped.
  SM.mutate(s => {
    s.inbox = (s.inbox || []).filter(c => c.instanceId !== 'fp-test')
      .concat({ instanceId: 'gkp-test', cardId: 'compose_gk_prep', isCompose: true, _composeTopic: 'gk_prep', resolved: false, deliverAtMs: clock.get() - 60_000, _fieldGameTime: g.gameTime });
    s.scheduledCards = [...(s.scheduledCards || []), { ...sent, instanceId: 'fp-late', deliverAtMs: clock.get() + 60_000 }];
  });
  clock.set(clock.get() + 120_000); releaseDueCards();
  st = SM.get();
  check('the crew\'s card for a game the GM already has a decision on never arrives',
        !(st.inbox || []).some(c => c.instanceId === 'fp-late') && !(st.scheduledCards || []).some(c => c.instanceId === 'fp-late'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
