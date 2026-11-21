/**
 * engine/StretchStory.js
 * r216 §122.95 The stretch run and the postseason, as a story — written from the race as it stands.
 *
 * Every club in a division plays in October; the race is for the seeds. The top seed skips the one-game wild card
 * and waits for its winner; seeds 2 and 3 play a short series; seeds 4 and 5 play the one-game wild card.
 *
 *   race       (25 games left) the manager: where we stand in the seeding; push the regulars, or keep the rest days
 *   tickets    (18) the ticket office: the last homestands — raise prices on the race, or keep them where they are
 *   toll       (12) pushed: the physician on who's wearing down (a day off, or keep pushing); rested: the legs are fresh
 *   lastweek   (6)  our seed set: rest the regulars? Still moving: the owner's bonus for the clubhouse
 *   lastday    (1)  the manager: what's at stake today
 *   preview:<series>  game 1 of each of our series: the scouts on the opponent; at home the ticket office, on the road
 *                     the travel coordinator (the families on the trip)
 *   after:<series>    the morning after each of our series: won — the clubhouse (celebrate, or one more round);
 *                     lost — the owner, and the manager's word to the fans; the title — the parade
 *
 * State: s.stretch = { season, done: {}, push }. PURE: no StateManager. Builders return card fields.
 */
import { REGULAR_SEASON_GAME_COUNT, STRETCH_STORY } from '../data/constants.js';
import { dice, diceSeed } from './Dice.js';
import { findSeries } from './PlayoffEngine.js';
import { computeAge, baseballYear, isAvailable } from './PlayerFactory.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ROUND_NAME = { WILD_CARD: 'wild-card game', FIRST_ROUND: 'first round', DIVISION_SERIES: 'division series', WORLD_SERIES: 'World Series' };

function _dayAt(ms, h, m = 0) { const d = new Date(ms); d.setHours(h, m, 0, 0); return d.getTime(); }
function _regular(state) { return (state.schedule || []).filter(g => g && !g.isSpring && !g.isPlayoff); }

/** This season's moments: [{ key, atMs, series? }]. */
export function storyMoments(state) {
  const season = state.seasonNum || 1;
  const reg = _regular(state);
  const out = [];
  for (const [key, left] of Object.entries(STRETCH_STORY.gamesLeft)) {
    const g = reg[REGULAR_SEASON_GAME_COUNT - left];
    if (!g) continue;
    const r = dice(diceSeed(state), 'stretch', season, key);
    out.push({ key, atMs: key === 'lastday' ? Math.min(_dayAt(g.gameTime, 9) + Math.floor(r() * 60) * MIN, g.gameTime - 2 * HOUR)
                                             : _dayAt(g.gameTime, 10) + Math.floor(r() * 150) * MIN });
  }
  // Our series: game 1's morning, and the morning after it ends.
  const bySeries = new Map();
  for (const g of state.schedule || []) if (g?.isPlayoff && g.seriesId) (bySeries.get(g.seriesId) || bySeries.set(g.seriesId, []).get(g.seriesId)).push(g);
  for (const [id, games] of bySeries) {
    const r = dice(diceSeed(state), 'stretch', season, id);
    const first = games.reduce((a, b) => (a.gameTime <= b.gameTime ? a : b));
    out.push({ key: `preview:${id}`, series: id, atMs: Math.max(_dayAt(first.gameTime, 8), first.gameTime - 5 * HOUR) + Math.floor(r() * 45) * MIN });
    const s = findSeries(state.playoffBracket, id);
    if (s?.status === 'final') {
      const played = games.filter(g => g._committed || g.status === 'final' || g.boxScore);
      const last = (played.length ? played : games).reduce((a, b) => (a.gameTime >= b.gameTime ? a : b));
      out.push({ key: `after:${id}`, series: id, atMs: _dayAt(last.gameTime + DAY, 9, 30) + Math.floor(r() * 90) * MIN });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

const PHASES = new Set(['REGULAR_SEASON', 'ALL_STAR_BREAK', 'TRADE_DEADLINE', 'PLAYOFF_BRACKET_BUILD', 'WILD_CARD', 'FIRST_ROUND', 'DIVISION_SERIES', 'WORLD_SERIES', 'SEASON_SUMMARY', 'OFFSEASON']);

/** The next moment due (not yet done), or null. */
export function nextStepAt(state, clockMs) {
  if (!PHASES.has(state.phase)) return null;
  const season = state.seasonNum || 1;
  const done = state.stretch?.season === season ? state.stretch.done || {} : {};
  return storyMoments(state).find(x => !done[x.key] && x.atMs <= clockMs) || null;
}

// ── The race ─────────────────────────────────────────────────

/** Our seed and its neighbours: { seed, me, above, below, gapUp, gapDown, left, locked }. */
export function seeding(state) {
  const st = state.standings || {};
  const div = (state.userTeam?.divisionId === 'B' ? st.divB : st.divA) || [];
  const rows = [...div].sort((a, b) => (b.wins / Math.max(1, b.wins + b.losses)) - (a.wins / Math.max(1, a.wins + a.losses)));
  const i = rows.findIndex(t => t.id === 'user');
  if (i < 0) return null;
  const gb = (a, b) => ((a.wins - b.wins) + (b.losses - a.losses)) / 2;   // games a is ahead of b
  const me = rows[i], above = rows[i - 1] || null, below = rows[i + 1] || null;
  const left = Math.max(0, REGULAR_SEASON_GAME_COUNT - _regular(state).filter(g => g._committed).length);
  const gapUp = above ? gb(above, me) : null, gapDown = below ? gb(me, below) : null;
  return { seed: i + 1, me, above, below, gapUp, gapDown, left, locked: (gapUp == null || gapUp > left) && (gapDown == null || gapDown > left) };
}

const g1 = (n) => `${n % 1 ? n.toFixed(1) : n} game${n === 1 ? '' : 's'}`;
function _picture(s) {
  if (!s) return 'The race is tight.';
  const up = s.above ? `${g1(s.gapUp)} behind the ${s.above.name} for ${s.seed - 1 === 1 ? 'the top seed' : `seed ${s.seed - 1}`}` : '';
  const down = s.below ? `${g1(s.gapDown)} ahead of the ${s.below.name}` : '';
  const what = s.seed === 1 ? 'The top seed skips the wild-card game and has home field.' : s.seed <= 3 ? 'As it stands we play a short series in the first round; fourth means the one-game wild card.' : 'As it stands we\'re in the one-game wild card; third or better avoids it.';
  return `We're seed ${s.seed}${up || down ? ` — ${[up, down].filter(Boolean).join(', ')}` : ''}. ${what}`;
}

/** The regular who has played the most in a row (by age, the oldest, as the tiebreak). */
function _worn(state) {
  const u = state.userTeam, year = baseballYear(state);
  return (u.lineupSlots || []).map(x => state.players[x.playerId]).filter(p => p && isAvailable(p))
    .sort((a, b) => computeAge(b.dob, year) - computeAge(a.dob, year))[0] || null;
}

function _revenueK(state, share) {
  const pay = state.userTeam?.finances?.payroll || state.userTeam?.finances?.payrollTarget || 0;
  return Math.max(STRETCH_STORY.minK, Math.round(pay * share / 10) * 10);
}

// ── The messages ─────────────────────────────────────────────

export function buildStep(m, state, ctx, atMs) {
  const u = state.userTeam;
  const season = state.seasonNum || 1;
  const sv = state.stretch || {};
  const mgr = u.coachingStaff?.manager?.name || 'The manager';
  const owner = u.ownerName || 'Ownership';
  const s = seeding(state);
  const base = (k) => ({ cardId: `stretch_${k.split(':')[0]}`, tag: 'ROSTER', type: 'normal', _stretchStory: k, _rosterKey: `stretch:${season}:${k}` });
  const key = m.key;

  if (key === 'race') {
    return { ...base(key), sender: mgr, avatar: '📋',
      subject: 'The stretch: where we stand',
      preview: `Twenty-five games left. ${s ? `We're seed ${s.seed}` : 'Here\'s the race'}…`,
      body: `Twenty-five games left. ${_picture(s)} I can push the regulars every day from here, or keep their rest days and have them fresh for October. Pushing wins games now, and it costs legs later.`,
      yesLabel: 'Push the Regulars', noLabel: 'Keep the Rest Days',
      yesEffect: { morale: 2 }, noEffect: { manConf: 1 },
      yesMsg: 'Every day from here. They\'re fired up.', noMsg: 'Rest days stay. They\'ll thank us in October.',
      autoResolve: 'no', expiresAtMs: atMs + 30 * HOUR, _raw: { onYes: 'st_push', onNo: null } };
  }

  if (key === 'tickets') {
    const tight = s && ((s.gapUp != null && s.gapUp <= 3) || (s.gapDown != null && s.gapDown <= 3));
    const k = _revenueK(state, STRETCH_STORY.ticketShare);
    return { ...base(key), sender: 'Ticket Office', avatar: '🎟️', tag: 'MARKETING', _revenueK: k,
      subject: tight ? 'The race is selling tickets' : 'Tickets for the last homestands',
      preview: tight ? 'Demand is up for the last homestands…' : 'The last homestands are coming up…',
      body: tight
        ? `Demand is up: the seeding race has people buying for the last homestands. Raising prices brings in about ${_fmt(k)}, and some of the regulars in the stands will be priced out. Holding them where they are keeps the place loud.`
        : `The last homestands are coming up, and the seeding isn't much of a race right now. We could raise prices anyway, for about ${_fmt(k)}, or hold them and keep the fans who've stuck with us.`,
      yesLabel: 'Raise Prices', noLabel: 'Hold Them',
      yesEffect: { atmo: tight ? -2 : -3 }, noEffect: { atmo: 2 },
      yesMsg: 'Prices are up for the last homestands.', noMsg: 'Prices hold. The fans will notice.',
      autoResolve: 'no', expiresAtMs: atMs + 30 * HOUR, _raw: {} };
  }

  if (key === 'toll') {
    if (sv.push) {
      const p = _worn(state);
      if (!p) return null;
      return { ...base(key), sender: 'Team Physician', avatar: '🩺', tag: 'HEALTH', _targetPlayerId: p.id,
        subject: `${p.name} is wearing down`,
        preview: `Pushing the regulars is showing, most on ${p.name}…`,
        body: `Pushing the regulars every day is showing, most on ${p.name}: slower to get loose, and sore the morning after. A day off now helps. Keep pushing, and it's the kind of wear that turns into an injury in October.`,
        yesLabel: `Give ${p.name} a Day`, noLabel: 'Keep Pushing',
        yesEffect: { morale: 1 }, noEffect: { morale: -2 },
        yesMsg: `${p.name} gets a day.`, noMsg: 'We keep pushing.',
        autoResolve: 'no', expiresAtMs: atMs + 20 * HOUR, _raw: { onYes: 'rest_active_hitter', onNo: null, _restGames: 1 } };
    }
    return { ...base(key), sender: 'Team Physician', avatar: '🩺', tag: 'HEALTH',
      subject: 'The rest days are paying off',
      preview: 'The regulars\' legs are fresh for this time of year…',
      body: 'For this time of year, the regulars\' legs are as fresh as I\'ve seen them. The rest days are paying off.',
      yesLabel: 'Got It', noLabel: null, yesEffect: { morale: 1 }, autoResolve: 'yes', expiresAtMs: atMs + 12 * HOUR, _news: true, _raw: {} };
  }

  if (key === 'lastweek') {
    if (s?.locked) {
      return { ...base(key), sender: mgr, avatar: '📋',
        subject: `Seed ${s.seed} is ours — rest the regulars?`,
        preview: `Nothing can move us off seed ${s.seed} now…`,
        body: `Nothing can move us off seed ${s.seed} now. I'd like to rest the regulars this last week and give the bench some at-bats, so everyone is sharp and healthy for October. The fans paying to see the regulars won't love it.`,
        yesLabel: 'Rest the Regulars', noLabel: 'Play to Win Every Game',
        yesEffect: { manConf: 1, morale: 1, atmo: -1 }, noEffect: { atmo: 1 },
        yesMsg: 'The regulars get a breather.', noMsg: 'Full lineup every day.',
        autoResolve: 'no', expiresAtMs: atMs + 24 * HOUR, _raw: {} };
    }
    const k = _revenueK(state, STRETCH_STORY.bonusShare);
    const aim = s && s.above && s.gapUp <= s.left ? `catch the ${s.above.name} for ${s.seed - 1 === 1 ? 'the top seed' : `seed ${s.seed - 1}`}` : `hold on to seed ${s?.seed || ''}`.trim();
    return { ...base(key), sender: owner, avatar: '💼', tag: 'OWNERSHIP', _budgetCost: k,
      subject: 'A bonus for the clubhouse',
      preview: `One week left. If they ${aim}…`,
      body: `One week left. If they ${aim}, I'd like the clubhouse to know it's worth something: a ${_fmt(k)} bonus pool for the players. Your call.`,
      yesLabel: 'Announce the Bonus', noLabel: 'Let Them Play for It',
      yesEffect: { morale: 3 }, noEffect: {},
      yesMsg: 'Announced. The clubhouse loved it.', noMsg: 'They\'ll play for the ring.',
      autoResolve: 'no', expiresAtMs: atMs + 24 * HOUR, _raw: {} };
  }

  if (key === 'lastday') {
    const stake = !s ? 'The seeds are about to be set.' : s.locked ? `Seed ${s.seed} is set, whatever happens today.`
      : `${s.above && s.gapUp <= 1 ? `A win today and a ${s.above.name} loss moves us up. ` : ''}${s.below && s.gapDown <= 1 ? `A loss today and a ${s.below.name} win drops us a seed.` : ''}`.trim() || `Seed ${s.seed} is all but set.`;
    return { ...base(key), sender: mgr, avatar: '📋', type: 'urgent',
      subject: 'The last day', preview: stake,
      body: `Last day of the regular season. ${stake} Whatever happens, October starts right after.`,
      yesLabel: 'Got It', noLabel: null, autoResolve: 'yes', expiresAtMs: atMs + 10 * HOUR, _news: true, _raw: {} };
  }

  // ── Our series ──
  const ser = m.series ? findSeries(state.playoffBracket, m.series) : null;
  if (!ser) return null;
  const weA = ser.teamA?.id === 'user';
  const opp = weA ? ser.teamB : ser.teamA;
  const host = weA;   // the higher seed hosts every game
  const round = ROUND_NAME[ser.round] || 'series';

  if (key.startsWith('preview:')) {
    if (!opp) return null;
    const t = (state.leagueTeams || []).find(x => x.id === opp.id);
    const best = (t?.rosterIds || []).map(id => state.players[id]).filter(p => p && isAvailable(p)).sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
    const bat = best.find(p => p.pos !== 'SP' && p.pos !== 'RP'), arm = best.find(p => p.pos === 'SP');
    const dir = u.coachingStaff?.scoutingDirector;
    const scout = { ...base(`${key}:scout`), cardId: 'stretch_preview_scout', sender: dir && !dir.vacant ? dir.name : 'Scouting', avatar: '🔭', tag: 'SCOUTING',
      subject: `The ${round}: the ${opp.name}`,
      preview: `Our read on the ${opp.name}…`,
      body: `The ${round} against the ${opp.name} (${opp.wins}–${opp.losses}) starts today${ser.bestOf > 1 ? `, best of ${ser.bestOf}` : ', one game, win or go home'}. ${bat ? `The bat to worry about is ${bat.name} (OVR ${bat.ovr}).` : ''} ${arm ? `${arm.name} (OVR ${arm.ovr}) is their best arm.` : ''} ${host ? 'Every game is at our place.' : 'Every game is at theirs.'}`.replace(/\s+/g, ' ').trim(),
      yesLabel: 'Got It', noLabel: null, autoResolve: 'yes', expiresAtMs: atMs + 10 * HOUR, _news: true, _raw: {} };
    const k = _revenueK(state, STRETCH_STORY.playoffShare);
    const deal = host
      ? { ...base(`${key}:gate`), cardId: 'stretch_preview_gate', sender: 'Ticket Office', avatar: '🎟️', tag: 'MARKETING', _revenueK: k,
          subject: `Pricing the ${round}`, preview: 'Every seat is spoken for. How we price them is up to you…',
          body: `Every seat for the ${round} is spoken for. Playoff pricing brings in about ${_fmt(k)} more. Holding regular-season prices puts the fans who were here all year in the seats, and they'll be loud.`,
          yesLabel: 'Playoff Pricing', noLabel: 'Regular-Season Prices', yesEffect: { atmo: -1 }, noEffect: { atmo: 3 },
          yesMsg: 'Playoff pricing it is.', noMsg: 'Regular prices. The place will shake.',
          autoResolve: 'no', expiresAtMs: atMs + 6 * HOUR, _raw: {} }
      : { ...base(`${key}:trip`), cardId: 'stretch_preview_trip', sender: 'Travel Coordinator', avatar: '✈️', tag: 'OPERATIONS', _budgetCost: Math.round(k / 2 / 10) * 10,
          subject: 'The families on the trip?', preview: `For the ${round} on the road, we could bring the families…`,
          body: `The ${round} is on the road. Bringing the players' families on the trip costs about ${_fmt(Math.round(k / 2 / 10) * 10)}. It's a long way from home in October, and they'd love it.`,
          yesLabel: 'Bring the Families', noLabel: 'Team Only', yesEffect: { morale: 2 }, noEffect: {},
          yesMsg: 'Booked. The families are coming.', noMsg: 'Team only.',
          autoResolve: 'no', expiresAtMs: atMs + 6 * HOUR, _raw: {} };
    return [scout, deal];
  }

  if (key.startsWith('after:')) {
    const won = (ser.winner === 'A') === weA;
    if (won && ser.round === 'WORLD_SERIES') {
      const k = _revenueK(state, STRETCH_STORY.paradeShare);
      return { ...base(key), cardId: 'stretch_parade', sender: 'Community Relations', avatar: '🏆', tag: 'MARKETING', _budgetCost: k,
        subject: 'Champions — the parade',
        preview: 'The city wants a parade…',
        body: `Champions. The city wants a parade: the full route downtown costs us about ${_fmt(k)} for our share of the security and the floats. Or a rally at the ballpark, smaller and cheaper. Either way, the city is going to celebrate.`,
        yesLabel: 'The Full Parade', noLabel: 'A Rally at the Ballpark',
        yesEffect: { atmo: 6, ownerTrust: 1 }, noEffect: { atmo: 3 },
        yesMsg: 'The full parade. The city will never forget it.', noMsg: 'A rally at the ballpark it is.',
        autoResolve: 'no', expiresAtMs: atMs + 24 * HOUR, _raw: {} };
    }
    if (won) {
      return { ...base(key), cardId: 'stretch_won', sender: mgr, avatar: '📋', tag: 'CULTURE', _budgetCost: STRETCH_STORY.celebrateK,
        subject: `We won the ${round}`,
        preview: `We beat the ${opp?.name}. The room wants to celebrate…`,
        body: `We beat the ${opp?.name}. The room wants a proper celebration, champagne and all, about ${_fmt(STRETCH_STORY.celebrateK)} for the clubhouse staff. Or we keep it low-key and save it for the end.`,
        yesLabel: 'Celebrate', noLabel: 'One More Round First',
        yesEffect: { morale: 2 }, noEffect: { manConf: 1 },
        yesMsg: 'Champagne it is.', noMsg: 'Low-key. Eyes on the next round.',
        autoResolve: 'no', expiresAtMs: atMs + 12 * HOUR, _raw: {} };
    }
    const far = ['DIVISION_SERIES', 'WORLD_SERIES'].includes(ser.round);
    return [
      { ...base(`${key}:owner`), cardId: 'stretch_out_owner', sender: owner, avatar: '💼', tag: 'OWNERSHIP',
        subject: 'The season is over', preview: far ? 'We were close…' : 'Out early…',
        body: far ? `We were close. The ${opp?.name} beat us in the ${round}, and it stings, but this was a real season. Let's talk about next year soon.`
                  : `Out in the ${round}. The ${opp?.name} were better, and that's not where I expected us to finish. We'll talk about what changes for next year.`,
        yesLabel: 'Got It', noLabel: null, yesEffect: { ownerTrust: far ? 1 : -1 }, autoResolve: 'yes', expiresAtMs: atMs + 24 * HOUR, _news: true, _raw: {} },
      { ...base(`${key}:fans`), cardId: 'stretch_out_fans', sender: mgr, avatar: '📋', tag: 'MARKETING',
        subject: 'A word to the fans?', preview: 'The fans were with us all year…',
        body: `The fans were with us all year. I'd like us to put out a letter thanking them, from both of us. Or we let the season speak for itself.`,
        yesLabel: 'Thank the Fans', noLabel: 'Let the Season Speak',
        yesEffect: { atmo: 2 }, noEffect: {},
        yesMsg: 'The letter is out.', noMsg: 'We\'ll let it speak.',
        autoResolve: 'no', expiresAtMs: atMs + 24 * HOUR, _raw: {} },
    ];
  }
  return null;
}

function _fmt(k) { return k >= 1000 ? `$${(k / 1000).toFixed(1).replace(/\.0$/, '')}M` : `$${k}K`; }
