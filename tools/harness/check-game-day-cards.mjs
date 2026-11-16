// §122.57 r182 The game day's cards follow the game, and the pools deal what's true — checks, in a real league.
//   node tools/harness/check-game-day-cards.mjs
//   1. A game called off: its cards before first pitch and during the game don't come (and never count as dealt).
//   2. A held start and a delay: the in-game cards move onto the game as it's played; past its end, they don't come.
//   3. The tarp on before first pitch: the anthem, a ceremony or a sponsor on the field don't come; the rest do.
//   4. How a card comes back: a story once a season; a game-day moment weeks apart; a requeued card settled by a yes.
//   5. Sponsors: an offer for a slot we sold this season isn't made; a card about our sponsor needs one.
//   6. The half hour before first pitch: 12–30 minutes out, answered by first pitch, home games only.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CardEngine from '../../engine/CardEngine.js';
import { DECISIONS_POOL, PREGAME30_POOL, PREGAME_POOL, INGAME_POOL } from '../../data/cards-pool.js';
import { GAME_STATUS, PHASE } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const defOf = (id) => [...DECISIONS_POOL, ...PREGAME30_POOL, ...PREGAME_POOL, ...INGAME_POOL].map(e => e?.card || e).find(d => d?.id === id);
let n = 0;
/** A pool card parked for game `T` (as the day's plan parks it). */
function park(id, moment, T, at, extra = {}) {
  const d = defOf(id);
  const c = { instanceId: `t-${++n}`, cardId: id, subject: d.subject, body: d.body, yesLabel: d.yesLabel, noLabel: d.noLabel, type: 'normal', tag: d.tag,
              resolved: false, _raw: d, _season: SM.get().seasonNum || 1, _moment: moment, _gameTime: T, deliverAtMs: at,
              ...(moment === 'ingame' ? { _ingameAt: at - T, expiresAtMs: T + 210 * MIN } : { expiresAtMs: T }), ...extra };
  SM.mutate(s => { s.scheduledCards = [...(s.scheduledCards || []), c].sort((a, b) => a.deliverAtMs - b.deliverAtMs);
                   const e = ((s.cardLog ||= {})[id] ||= { n: {}, lastMs: null, choice: null, choiceSeason: null }); e.n[c._season] = (e.n[c._season] || 0) + 1; e.lastMs = at; });
  return c;
}
const parked = (id) => (SM.get().scheduledCards || []).find(c => c.instanceId === id);
const inInbox = (id) => (SM.get().inbox || []).find(c => c.instanceId === id && !c.resolved);

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId ?? sl.id);
seedRandom(57);
clock.set(Date.UTC(2400, 0, 1));
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers', abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
SM.mutate(s => { s.scheduledCards = []; s.inbox = []; });
const homes = SM.get().schedule.filter(g => g.isHome && !g.isSpring && !g.isPlayoff);

console.log('A game called off');
{
  const T = homes[3].gameTime;
  const a = park('pg30_concessions', 'pregame', T, T - 20 * MIN);
  const b = park('ig_concourse_incident', 'ingame', T, T + 60 * MIN);
  const other = park('ig_concourse_incident', 'ingame', homes[4].gameTime, homes[4].gameTime + 60 * MIN);
  const before = SM.get().cardLog.ig_concourse_incident.n[1];
  CardEngine.withdrawGameDayCards(T);
  check('its cards before first pitch and during the game are withdrawn', !parked(a.instanceId) && !parked(b.instanceId));
  check('another game\'s cards stay', !!parked(other.instanceId));
  check('a withdrawn card never counts as dealt', SM.get().cardLog.ig_concourse_incident.n[1] === before - 1 && SM.get().cardLog.pg30_concessions.n[1] === 0);
  SM.mutate(s => { s.scheduledCards = []; });
}

console.log('A held start and a delay');
{
  const T = homes[5].gameTime;
  const early = park('ig_broadcast_feed', 'ingame', T, T + 30 * MIN);
  const mid   = park('ig_sponsor_activation', 'ingame', T, T + 70 * MIN);
  const late  = park('ig_suite_complaint', 'ingame', T, T + 150 * MIN);
  const plan = { startAt: T + 50 * MIN, endT: T + 4 * HOUR, delays: [{ startT: T + 10 * MIN, endT: T + 50 * MIN }, { startT: T + 100 * MIN, endT: T + 130 * MIN }] };
  CardEngine.retimeGameCards(T, plan);
  const at = (c) => (parked(c.instanceId)?.deliverAtMs - T) / MIN;
  check(`the same time into the game after a held start (30 min in → ${at(early)} min after the scheduled start)`, at(early) === 80);
  check(`pushed past a delay (70 min in → ${at(mid)})`, at(mid) === 150);
  check(`past the game's end, it doesn't come (150 min in → ${at(late) || 'withdrawn'})`, !parked(late.instanceId));
  check('it lapses after the game, not before', parked(mid.instanceId).expiresAtMs >= plan.endT + 30 * MIN);
  SM.mutate(s => { s.scheduledCards = []; });
}

console.log('The tarp on before first pitch');
{
  const T = homes[6].gameTime;
  const anthem = park('pg30_anthem', 'pregame', T, T - 15 * MIN);
  const elev   = park('pg30_elevator', 'pregame', T, T - 25 * MIN);
  const ceremony = park('pg30_sth_recognition', 'pregame', T, T - 40 * MIN);
  // the ceremony card has arrived and waits unanswered
  SM.mutate(s => { const c = s.scheduledCards.find(x => x.instanceId === ceremony.instanceId); s.scheduledCards = s.scheduledCards.filter(x => x !== c); s.inbox = [...(s.inbox || []), { ...c, arrivedAtMs: T - 40 * MIN }]; });
  CardEngine.withdrawNoWeatherHold(T);
  check('the anthem, still to come, is withdrawn', !parked(anthem.instanceId));
  check('the ceremony on the field, arrived and unanswered, is withdrawn', !inInbox(ceremony.instanceId));
  check('a card that doesn\'t need the field stays (the elevator)', !!parked(elev.instanceId));
  SM.mutate(s => { s.scheduledCards = []; s.inbox = []; });
}

/** The eligible cards at the next game day's moments (the day planned afresh). */
function eligibleNow() {
  const got = {};
  CardEngine.cardDebug.onEligible = (moment, ids) => { (got[moment] ||= new Set()); for (const id of ids) got[moment].add(id); };
  CardEngine.checkAndDeliver(buildCardContext());
  CardEngine.cardDebug.onEligible = null;
  SM.mutate(s => { s.scheduledCards = []; s.inbox = []; });
  return got;
}
const all = (got) => new Set(Object.values(got).flatMap(x => [...x]));

console.log('How a card comes back');
{
  // a home regular-season game next, mid-season
  const i = SM.get().schedule.findIndex(g => g.isHome && !g.isSpring && !g.isPlayoff && (g.regularSeasonIndex ?? 0) >= 40);
  const g = SM.get().schedule[i];
  SM.mutate(s => { s.currentGameIndex = i; s.phase = PHASE.REGULAR_SEASON; s.cardLog = {}; s.userTeam.wins = 25; s.userTeam.losses = 25; });
  clock.set(g.gameTime - 20 * HOUR);
  const base = all(eligibleNow());
  check(`a fresh day deals from the half-hour pool too (${[...base].filter(x => x.startsWith('pg30_')).length} of its cards eligible)`, [...base].some(x => x.startsWith('pg30_')));
  const season = SM.get().seasonNum || 1;
  const now = clock.get();
  const story = [...base].find(id => CardEngine.cardRepeatRule(id)?.once && CardEngine.cardRepeatRule(id).pool === 'DECISIONS_POOL');
  const ops = [...base].find(id => CardEngine.cardRepeatRule(id)?.pool === 'INGAME_POOL');
  SM.mutate(s => { s.cardLog = { [story]: { n: { [season]: 1 }, lastMs: now - 60 * DAY, choice: 'no', choiceSeason: season },
                                 [ops]:   { n: { [season]: 1 }, lastMs: now - 5 * DAY, choice: 'yes', choiceSeason: season } }; });
  let got = all(eligibleNow());
  check(`a story (${story}) comes once a season`, !got.has(story));
  check(`a game-day moment (${ops}) waits two weeks`, !got.has(ops));
  SM.mutate(s => { s.cardLog[ops].lastMs = now - 20 * DAY; });
  got = all(eligibleNow());
  check('… and comes back after them', got.has(ops));
  SM.mutate(s => { s.cardLog[ops].n[season] = 3; });
  check('… three times a season at most', !all(eligibleNow()).has(ops));
  // a card that comes back after a no (f1, the facility upgrade): settled by a yes
  const f1 = DECISIONS_POOL.find(d => d.id === 'f1');
  if (f1 && base.has('f1')) {
    SM.mutate(s => { s.cardLog = { f1: { n: { [season]: 1 }, lastMs: now - 40 * DAY, choice: 'no', choiceSeason: season } }; });
    const afterNo = all(eligibleNow()).has('f1');
    SM.mutate(s => { s.cardLog.f1.choice = 'yes'; });
    check('a declined proposal comes back after its cooldown; an accepted one doesn\'t', afterNo && !all(eligibleNow()).has('f1'));
  }

  console.log('Sponsors');
  SM.mutate(s => { s.cardLog = {}; });
  got = all(eligibleNow());
  check('without a jersey-patch sponsor, no card about one', !got.has('jersey_patch_wear'));
  check('without a section sponsor, no card about the section renamed', !got.has('pg_sth_complaint'));
  SM.mutate(s => { s.cardLog = { ad2: { n: { [season]: 1 }, lastMs: now - 40 * DAY, choice: 'yes', choiceSeason: season },
                                 m3:  { n: { [season]: 1 }, lastMs: now - 40 * DAY, choice: 'yes', choiceSeason: season },
                                 fn2: { n: { [season]: 1 }, lastMs: now - 40 * DAY, choice: 'yes', choiceSeason: season } }; });
  got = all(eligibleNow());
  check('the scoreboard sold: no second scoreboard offer (ad5)', !got.has('ad5'));
  check('a jersey-patch sponsor: their card can come', got.has('jersey_patch_wear'));
  check('a section sponsor: the season-ticket holders\' complaint can come', got.has('pg_sth_complaint'));
  SM.mutate(s => { s.cardLog = { sp_renew: { n: { [season]: 1 }, lastMs: now - 10 * DAY, choice: 'no', choiceSeason: season } }; });
  got = all(eligibleNow());
  check('the presenting sponsor walked: no card about them', !got.has('pg_sponsor_unhappy') && !got.has('pg30_sponsor_field'));

  console.log('The half hour before first pitch');
  SM.mutate(s => { s.cardLog = {}; });
  let ok = 0, tries = 0, times = [];
  for (let k = 0; k < 60 && ok < 3; k++) {
    tries++;
    SM.mutate(s => { s.cardPlanKey = null; s.scheduledCards = []; s.inbox = []; s.cardLog = {}; });
    CardEngine.checkAndDeliver(buildCardContext());
    for (const c of (SM.get().scheduledCards || []).filter(c => c._raw?._isPreGame30)) { ok++; times.push({ lead: (g.gameTime - c.deliverAtMs) / MIN, exp: c.expiresAtMs === g.gameTime }); }
  }
  check(`dealt at 12–30 minutes before first pitch, answered by it (${times.map(t => Math.round(t.lead)).join(', ')} min)`, times.length > 0 && times.every(t => t.lead >= 12 && t.lead <= 30 && t.exp));
  const road = SM.get().schedule.findIndex((x, j) => j > i && !x.isHome && !x.isSpring && !x.isPlayoff);
  SM.mutate(s => { s.currentGameIndex = road; s.cardLog = {}; });
  clock.set(SM.get().schedule[road].gameTime - 20 * HOUR);
  check('never before a road game', ![...all(eligibleNow())].some(x => x.startsWith('pg30_')));
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
