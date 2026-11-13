/**
 * engine/ComposeReplies.js
 * §106 The staff write back. Every reply is written at the moment it is sent
 * back to the GM, by the person the GM wrote to, from the club as it stands
 * then (ComposeFacts): the forecast the GM can see, the field after last
 * night's rain, who pitched yesterday, the slump in numbers, last week's
 * gates, the decisions the GM made (and didn't), and what this person said
 * the last time the GM asked.
 *
 * Pure. writeComposeReply(state, { topicId, channelId, atMs, sentAtMs })
 *   → { sender, subject, body, memo }   (memo: what to remember of this reply)
 */

import { composeFacts, avgOf, fmtAvg, eraOf } from './ComposeFacts.js';
import { MS_HOUR, MS_DAY } from './WeatherClimate.js';
import { crowdFor, seasonTarget } from './FinanceEngine.js';
import { worthOf, trueOVR, isDiamond } from './Diamonds.js';
import { signingTerms } from './MarketEngine.js';
import { formatK } from './CardTokens.js';
import { scoutEye as directorEye, scoutLooks } from './CoachEngine.js';
import { dealByKey, fieldRead, suggestCounter, COUNTER_MARGIN, shopPlayer } from './TradeAdvice.js';
import { evaluateTrade, remainingShare, yearsAfterThis, rapportGrade, rapportOf, wouldStart } from './TradeEngine.js';
import { coachRead, programRead, restRead, healthRead, isPitcher as isArm, teachRead } from './PlayerWork.js';
import { PLAYER_WORK } from '../data/constants.js';
import { posLabel } from './Positions.js';   // r163 §122.35

// ─────────────────────────────────────────────────────────────
// SMALL WORDS
// ─────────────────────────────────────────────────────────────

function _rng(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1_000_000) / 1_000_000; };
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (n) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
const Cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const ip = (outs) => `${Math.floor(outs / 3)}${outs % 3 ? `.${outs % 3}` : ''}`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const pct = (x) => `${Math.round(x * 100)}%`;
const inches = (x) => (x >= 0.995 ? `${x.toFixed(1)} inches` : x >= 0.1 ? `${x.toFixed(2).replace(/^0/, '')} of an inch` : 'a trace');
const topicStem = (subject) => String(subject || '').replace(/^(URGENT|FYI|UPDATE|ALERT|BREAKING):\s*/i, '').split(' — ')[0].replace(/^[A-Z](?![A-Z])/, c => c.toLowerCase());
/** What a card was about, as a phrase: "the group sales conflict", "the high school championship game still scheduled at the ballpark". */
const aboutOf = (subject) => {
  const [stem, rest] = String(subject || '').replace(/^(URGENT|FYI|UPDATE|ALERT|BREAKING):\s*/i, '').split(' — ');
  // "Road trip extended — a high school championship game…": the headline is what happened, the rest what it's about.
  if (rest && /^(a|an|the) /i.test(rest) && /ed$/i.test(stem.trim()) && stem.split(' ').length <= 3) return `the ${rest.replace(/^(a|an|the) /i, '')}`;
  return `the ${topicStem(stem)}`;
};
/** One per subject (a card that came up several times counts once). */
const distinct = (xs) => { const seen = new Set(); return xs.filter(x => { const k = topicStem(x.subject || x.label); if (seen.has(k)) return false; seen.add(k); return true; }); };
const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
const ord = (i) => ORD[i] || `${i + 1}th`;
const line = (b) => `${b.h}-for-${b.ab}${b.hr ? `, ${plural(b.hr, 'homer')}` : ''}`;

/** Season lines. */
// In spring the numbers that count are the spring's (§106).
let SPRING = false;
const S = (p) => (SPRING ? p?.springStats : p?.stats) || {};
const avgS = (p) => avgOf(S(p)?.h || 0, S(p)?.ab || 0);
const obpS = (p) => { const s = S(p) || {}; const pa = (s.ab || 0) + (s.bb || 0) + (s.hbp || 0); return pa ? ((s.h || 0) + (s.bb || 0) + (s.hbp || 0)) / pa : 0; };
const slgS = (p) => { const s = S(p) || {}; return s.ab ? (s.tb || 0) / s.ab : 0; };
const eraS = (p) => eraOf(S(p)?.er || 0, S(p)?.ip || 0);
const statLine = (p) => `${fmtAvg(avgS(p))}/${fmtAvg(obpS(p))}/${fmtAvg(slgS(p))}`;

// ─────────────────────────────────────────────────────────────
// WHO IS WRITING
// ─────────────────────────────────────────────────────────────

const STAFF = {
  manager:         { key: 'manager',       role: 'Manager' },
  pitching_coach:  { key: 'pitchingCoach', role: 'Pitching Coach' },
  hitting_coach:   { key: 'hittingCoach',  role: 'Hitting Coach' },
  bench_coach:     { key: 'benchCoach',    role: 'Bench Coach' },
  bullpen_coach:   { key: 'bullpenCoach',  role: 'Bullpen Coach' },
  groundskeeper:   { rel: 'groundskeeperRelationship',  role: 'Head Groundskeeper' },
  facilities:      { rel: 'facilitiesRelationship',     role: 'Facilities & Ops' },
  ticket_office:   { rel: 'ticketOfficeRelationship',   role: 'Ticket Office' },
  scouting:        { key: 'scoutingDirector', role: 'Scouting Director' },
  media_relations: { role: 'Media Relations' },
  community:       { role: 'Community Affairs' },
  physician:       { role: 'Team Physician' },
};

function _who(state, channelId) {
  const s = STAFF[channelId] || { role: 'Staff' };
  const person = s.key ? state.userTeam?.coachingStaff?.[s.key] : null;
  const rel = person?.relationship ?? (s.rel ? state.userTeam?.[s.rel] : null) ?? 50;
  return { name: person?.name || null, role: s.role, rel, sender: person?.name ? `${person.name}, ${s.role}` : s.role };
}

/** The opening, in the writer's manner with this GM (warm, plain, or short). */
function _open(rel, r, topic) {
  if (rel >= 68) return [`Glad you asked about ${topic}.`, `Thanks for checking in on ${topic}.`, `Happy to give you the full picture on ${topic}.`][Math.floor(r() * 3)];
  if (rel <= 35) return [`Here's where ${topic} stands.`, `On ${topic}:`, `Quick answer on ${topic}.`][Math.floor(r() * 3)];
  return [`Here's my read on ${topic}.`, `Got your note about ${topic}.`, `Following up on ${topic}.`][Math.floor(r() * 3)];
}
function _sign(who) { return who.name ? `— ${who.name}` : `— ${who.role}`; }

// ─────────────────────────────────────────────────────────────
// SHARED PIECES
// ─────────────────────────────────────────────────────────────

/** The game we're talking about, in words: "tonight against Gulfport (7:05)". */
function gameWords(f, g) {
  if (!g) return '';
  const opp = g.opponent || f.oppTeam(g.opponentId)?.name || 'our opponent';
  return `${f.when(g.gameTime)} ${f.atHome(g) ? 'against' : 'at'} ${opp} (${f.clock(g.gameTime)})`;
}

/** "night" or "day", for a game. */
const nightOf = (f, g) => (new Date(g.gameTime + f.tz() * 60_000).getUTCHours() >= 17 ? 'night' : 'day');

/** The forecast for a game, the way the GM sees it on screen, in a sentence. */
function forecastWords(f, g) {
  const fc = f.forecastFor(g);
  if (!fc) return { fc: null, text: '' };
  const after = fc.whenHour && fc.whenHour > g.gameTime + 30 * 60_000 ? `, mostly after ${f.clock(fc.whenHour).replace(/:00$/, '')}` : '';
  const wind = fc.windMph >= 12 ? ` with the wind ${fc.windMph} mph ${fc.windText}` : '';
  const sky = fc.chance >= 10 ? `${fc.label.toLowerCase()} (${fc.chance}%${after})` : fc.label.toLowerCase();
  return { fc, text: `${fc.tempF}° and ${sky}${wind}` };
}

/** Decisions on this person's desk (newest first), by tag and words in the subject. */
function deskDecisions(f, { tags = [], words = null, days = 90 }) {
  return f.decisions().filter(d => f.atMs - d.at < days * MS_DAY
    && (tags.includes(d.tag) || (words && words.test(d.subject))));
}
/** Cards on this desk left unanswered (auto / skip), newest first. */
function deskIgnored(f, { tags = [], words = null, days = 45 }) {
  return (f.state.inbox || []).filter(c => c.resolved && (c.choice === 'auto' || c.choice === 'skip')
    && f.atMs - (c.resolvedAtMs || 0) < days * MS_DAY && (c.resolvedAtMs || 0) <= f.atMs
    && (tags.includes(c.tag) || (words && words.test(c.subject || ''))));
}

/** An injury in words: "oblique strain, about three weeks to go" / "done for the year". */
function injuryWords(f, p) {
  const lab = (p.injury?.label || 'injury').toLowerCase();
  if (p.injury?.severity === 'season') return `${lab}, done for the year`;
  const left = Number.isFinite(p.injury?.eligibleAt) ? Math.ceil((p.injury.eligibleAt - f.atMs) / (7 * MS_DAY)) : null;
  return left == null ? lab : left <= 0 ? `${lab}, eligible to come back now` : left === 1 ? `${lab}, about a week to go` : `${lab}, about ${num(left)} weeks to go`;
}

/** Since we last talked about this: { prev, days } or null. */
function lastTime(f, topicId) {
  const prev = f.pastReplies(topicId)[0];
  if (!prev) return null;
  return { prev, days: Math.max(0, Math.round((f.atMs - prev.atMs) / MS_DAY)), when: f.when(prev.atMs) };
}

/** No games for a while: the honest answer when there's nothing on the schedule. */
function offseasonNote(f) {
  if (f.upcoming().length) return '';
  return f.season === 'off' ? "There's nothing on the schedule until spring, so this is a look ahead more than a report."
    : "We're between games with nothing scheduled yet.";
}

/** The probable starters the other club lines up for a series. */
function theirStarters(f, team, n) {
  if (!team?.rotation?.order?.length) return [];
  const order = team.rotation.order, i = team.rotation.currentIndex || 0;
  const out = [];
  for (let k = 0; k < Math.min(n, order.length); k++) { const p = f.P(order[(i + k) % order.length]); if (p) out.push(p); }
  return out;
}
const theirBats = (f, team) => (team?.rosterIds || []).map(f.P).filter(p => p && p.pos !== 'SP' && p.pos !== 'RP' && (S(p)?.ab || 0) >= 40)
  .sort((a, b) => (obpS(b) + slgS(b)) - (obpS(a) + slgS(a)));
const vsRecord = (f, oppId) => {
  const gs = f.played().filter(g => g.opponentId === oppId && !g.isSpring);
  return { w: gs.filter(g => g.result === 'win').length, l: gs.filter(g => g.result !== 'win').length };
};

// ─────────────────────────────────────────────────────────────
// THE TOPICS
// ─────────────────────────────────────────────────────────────

const W = {};

// ── Head Groundskeeper ─────────────────────────────────────────

const GROUNDS_WORDS = /field|grounds|tarp|drain|mound|turf|crew|sod|irrigation|ballpark prep|infield|warning track/i;

W.gk_field = (f, r, who) => {
  const out = [];
  const rain24 = f.rainPast(24), rain72 = f.rainPast(72);
  const now = f.nowAt();
  const lastHome = f.lastHomeGame();
  const next = f.nextGame(), nh = f.nextHome();
  const events = f.homeWeatherEvents();
  const away = next && !f.atHome(next);

  // What the field has been through.
  if (now.precip?.kind && now.precip.rateMmH > 0.3) {
    out.push(`It's ${now.label.toLowerCase()} here right now${rain24 >= 0.05 ? ` — ${inches(rain24)} in the last day` : ''}. ${now.precip.rateMmH > 4 ? 'The tarp is on and staying on until it lets up.' : 'We have the infield covered and the crew is standing by.'}`);
  } else if (rain24 >= 0.5) {
    out.push(`We took ${inches(rain24)} of rain in the last 24 hours. The outfield is soft and we're keeping the mowers off it until it dries; the infield drained well and the mound is covered.`);
  } else if (rain24 >= 0.1) {
    out.push(`We had ${inches(rain24)} of rain in the last day. Nothing the drainage can't handle — the skin will be raked and dried well before batting practice.`);
  } else if (rain72 >= 0.5) {
    out.push(`It's been dry since the ${inches(rain72)} we took earlier this week, and the field has bounced back. Outfield's firm again.`);
  } else if (now.tempF >= 90) {
    out.push(`It's been hot and dry — ${Math.round(now.tempF)}° out there right now. We're watering the infield skin between innings and twice before first pitch so it doesn't crust over and play fast.`);
  } else if (now.tempF <= 45 && f.season !== 'off') {
    out.push(`It's cold — ${Math.round(now.tempF)}° right now. The mound clay stiffens up in this, so we're working it warm before each game and keeping the bullpen mounds covered overnight.`);
  } else {
    out.push(r() < 0.5 ? `The field is in good shape. Dry, firm, and playing true.` : `No complaints from the field. The surface is dry and the infield is playing true.`);
  }

  // The last game played on it.
  const fc = lastHome?.fieldCondition;
  if (fc && f.atMs - lastHome.gameTime < 5 * MS_DAY) {
    if ((fc.infieldSoftness || 0) > 0.3) out.push(`The infield was soft for ${f.when(lastHome.gameTime)}'s game after the rain${fc.rainBeforeIn ? ` (${inches(fc.rainBeforeIn)} before first pitch)` : ''}, and it showed in a couple of slow hops.`);
    else if ((fc.moundFirmness ?? 1) < 0.7) out.push(`The mound took a beating ${f.when(lastHome.gameTime)} — we rebuilt the landing area this morning.`);
  }
  // Weather trouble in the last two weeks.
  const ev = events[0];
  if (ev && f.atMs - ev.t < 10 * MS_DAY) {
    if (ev.kind === 'delay') out.push(`That ${ev.min}-minute ${ev.reason === 'lightning' ? 'lightning hold' : 'delay'} ${f.onWhen(ev.t)} — we got the tarp on in time, and the field came back without any soft spots.`);
    else if (ev.kind === 'postponed') out.push(`The rainout ${f.onWhen(ev.t)} gave the field a beating, but the extra day helped it recover.`);
    else out.push(`After the suspended game ${f.onWhen(ev.t)} we went over the whole infield again.`);
  }
  // Who's using it next.
  if (away && nh) out.push(`With the club on the road until ${f.when(nh.gameTime)}, we're using the time to aerate and top-dress the outfield — it'll be ready when you're back.`);
  else if (away && !nh) out.push(`With the club on the road, we're using the time for the maintenance we can't do on game days.`);
  else if (next && f.atHome(next)) {
    const { fc: nf, text } = forecastWords(f, next);
    if (nf && nf.chance >= 30) out.push(`For ${gameWords(f, next)}, the forecast is ${text}. The tarp crew will be here early.`);
    else if (nf) out.push(`For ${gameWords(f, next)}: ${text}. Should be a clean ${nightOf(f, next)} for the field.`);
  }
  // What the GM did for the crew.
  const mine = f.decisions().filter(d => ['FACILITIES', 'OPERATIONS', 'FINANCE', 'WEATHER'].includes(d.tag) && GROUNDS_WORDS.test(d.subject) && f.atMs - d.at < 120 * MS_DAY);
  const d = mine[0];   // the latest call the GM made on the crew's work
  if (d?.choice === 'yes') out.push(`${Cap(aboutOf(d.subject))} you signed off on ${f.atMs - d.at < 3 * MS_DAY ? 'is already' : 'has been'} making a difference.`);
  else if (d) out.push(`We're still making do without ${aboutOf(d.subject).replace(/^the /, 'the ')} — no complaints, but it's the first thing I'd ask for when there's room in the budget.`);
  const lt = lastTime(f, 'gk_field');
  if (lt && lt.days <= 3 && rain24 < 0.1) out.unshift(`Not much has changed since I wrote ${f.onWhen(lt.prev.atMs)}.`);
  return { body: out, memo: { rain24 } };
};

W.gk_weather = (f, r, who) => {
  const out = [];
  const homeGames = f.upcoming().filter(f.atHome).filter(g => g.gameTime - f.atMs <= 4 * MS_DAY && g.gameTime > f.atMs).slice(0, 3);
  const nh = f.nextHome();
  if (!homeGames.length) {
    if (!nh) return { body: [offseasonNote(f) || "We don't have a home game coming up, so there's nothing for the field to worry about. The crew is using the time for maintenance."], memo: {} };
    const day = Math.floor((nh.gameTime - f.atMs) / MS_DAY);
    const { fc, text } = forecastWords(f, nh);
    out.push(`We're not home again until ${f.when(nh.gameTime)}, ${plural(day, 'day')} out — too far for a forecast to mean much for the field. Right now it calls for ${text}, but I wouldn't plan around it yet.`);
    const rain = f.rainPast(48);
    if (rain >= 0.25) out.push(`We took ${inches(rain)} here in the last two days while you were away; the field will be dry long before you're back.`);
    return { body: out, memo: { chance: fc?.chance } };
  }
  const worst = homeGames.map(g => ({ g, ...forecastWords(f, g) })).sort((a, b) => (b.fc?.chance || 0) - (a.fc?.chance || 0));
  for (const { g, fc, text } of homeGames.map(g => ({ g, ...forecastWords(f, g) }))) {
    if (!fc) continue;
    const storms = fc.kind === 'storms' && fc.chance >= 30;
    const snow = (fc.kind === 'snow' || fc.kind === 'mix') && fc.chance >= 30;
    let plan;
    if (snow) plan = `Snow at a ballpark is a different problem — if it sticks, there's no playing on it, and the call would come early.`;
    else if (fc.chance >= 60) plan = storms
      ? `Storms are the real worry: lightning stops play no matter what the field looks like. Expect at least one hold, and I'd be surprised if we got through without the tarp.`
      : `I'd expect the tarp to come out at some point. If it's steady rain through first pitch, there's a real chance this one doesn't start on time.`;
    else if (fc.chance >= 30) plan = storms
      ? `It's the scattered kind — some games get missed entirely, some get a lightning hold. We'll have the crew on the tarp from first pitch on.`
      : `It's a maybe. If showers come, the field can take a fair amount before it's unplayable. We'll be watching the radar.`;
    else if (fc.chance >= 10) plan = `Only a slight chance. If something pops up, it won't be enough to hurt the field.`;
    else plan = r() < 0.5 ? `Nothing to worry about from the field's side.` : `A good ${nightOf(f, g)} for the field.`;
    out.push(`${Cap(gameWords(f, g))}: ${text}. ${plan}`);
  }
  // Rain that's already fallen, and what it means for the next one.
  const rain = f.rainPast(24);
  if (rain >= 0.4) out.push(`We already have ${inches(rain)} of rain in the ground from the last day, so the field has less room to take more than it normally would.`);
  // What has happened here lately.
  const ev = f.homeWeatherEvents()[0];
  if (ev && f.atMs - ev.t < 7 * MS_DAY && worst[0]?.fc?.chance >= 30) out.push(`Same pattern as ${f.onWhen(ev.t).replace(/^on /, '')}${ev.kind === 'delay' ? ` when we sat through ${plural(ev.min, 'minute')}` : ev.kind === 'postponed' ? ', when we lost the game' : ''}.`);
  // Honest about the forecast.
  const far = homeGames.find(g => g.gameTime - f.atMs > 48 * MS_HOUR);
  if (far) out.push(`The forecast that far out changes a lot — I'll know more the day before.`);
  return { body: out.filter(Boolean), memo: { chance: worst[0]?.fc?.chance ?? null, gameTime: worst[0]?.g?.gameTime ?? null } };
};

// ── Manager ────────────────────────────────────────────────────

W.mgr_lineup = (f, r, who) => {
  const out = [];
  const lu = f.lineup();
  if (!lu.length) return { body: ['We don\'t have a lineup set yet.'], memo: {} };
  const bats = f.recentBats(10);
  const top = lu.slice(0, 2).map(x => x.p), heart = lu.slice(2, 5).map(x => x.p);
  if (f.season === 'spring') out.push(`It's spring, so the lineup is still a working draft — I'm giving everybody looks before Opening Day.`);
  out.push(`At the top, ${list(top.map(p => `${p.name} (${fmtAvg(obpS(p))} on-base)`))}. ${top.every(p => obpS(p) >= .33) ? 'They\'re doing their job — getting on in front of the middle of the order.' : 'I want more traffic in front of the middle of the order than we\'re getting.'}`);
  const hot = lu.map(x => ({ p: x.p, b: bats[x.p.id] })).filter(x => x.b && x.b.ab >= 18 && avgOf(x.b.h, x.b.ab) >= .330).sort((a, b) => avgOf(b.b.h, b.b.ab) - avgOf(a.b.h, a.b.ab))[0];
  const cold = lu.map(x => ({ p: x.p, b: bats[x.p.id], i: lu.indexOf(x) })).filter(x => x.b && x.b.ab >= 20 && avgOf(x.b.h, x.b.ab) < .190).sort((a, b) => avgOf(a.b.h, a.b.ab) - avgOf(b.b.h, b.b.ab))[0];
  if (hot) out.push(`${hot.p.name} is the hottest bat we have — ${line(hot.b)} over the last ${plural(hot.b.g, 'game')}. ${lu.findIndex(x => x.p.id === hot.p.id) >= 5 ? 'I\'m thinking about moving that bat up.' : 'Right where I want that bat.'}`);
  if (cold) out.push(`${cold.p.name} is ${line(cold.b)} over the last ${plural(cold.b.g, 'game')}. ${cold.i <= 3 ? 'If it goes on much longer I\'ll drop that spot in the order to take some pressure off.' : 'Hitting down in the order for now, which is the right place to work through it.'}`);
  // The next opponent's starter.
  const ser = f.nextSeries();
  if (ser?.opp) {
    const sp = theirStarters(f, ser.opp, 1)[0];
    if (sp && S(sp)?.ip > 10) out.push(`${Cap(gameWords(f, ser.games[0]))} we probably see ${sp.name} (${eraS(sp).toFixed(2)} ERA). ${sp.subRatings?.stuff >= 75 ? 'Big stuff — I want our hitters ready to hit early in the count rather than chase.' : sp.subRatings?.control >= 75 ? 'Throws strikes, so we have to be ready to swing.' : 'Hittable if we stay patient.'}`);
  }
  // Recent arrivals in the order.
  const trade = f.tradesSince(f.atMs - 21 * MS_DAY)[0];
  if (trade) {
    const newIds = new Set(trade.offer?.incomingIds || []);
    const inOrder = lu.find(x => newIds.has(x.p.id));
    if (inOrder) out.push(`${inOrder.p.name} has settled in at ${inOrder.slot} since the trade, batting ${ord(lu.indexOf(inOrder))}.`);
  }
  const hurt = f.injured().filter(p => p.pos !== 'SP' && p.pos !== 'RP');
  if (hurt.length) out.push(`We're still without ${list(hurt.slice(0, 2).map(p => p.name))}, so it's not the lineup I'd draw up healthy.`);
  return { body: out, memo: { cold: cold?.p?.id || null } };
};

W.mgr_morale = (f, r, who) => {
  const out = [];
  const m = f.u.morale ?? 60;
  const ln = f.lastN(10), w10 = ln.filter(x => x.won).length;
  const { streak } = f.record();
  if (m >= 75) out.push(`The room is in a good place. ${streak >= 3 ? `Winning ${num(streak)} straight helps, but it's more than that — the players are pulling for each other.` : 'Loose, competitive, and nobody is pointing fingers.'}`);
  else if (m >= 55) out.push(`The clubhouse is steady. ${ln.length >= 5 ? `We're ${w10}-${ln.length - w10} over the last ${ln.length}, and the mood follows that pretty closely.` : 'Nothing I\'m worried about.'}`);
  else if (m >= 40) out.push(`I'd call the room tense. ${streak <= -3 ? `Losing ${num(-streak)} in a row wears on people.` : 'Nothing has boiled over, but there\'s some frustration.'}`);
  else out.push(`I won't sugarcoat it — morale is low. ${streak <= -3 ? `${Cap(num(-streak))} straight losses and the room feels it.` : 'There\'s grumbling, and I\'m spending a lot of time one-on-one.'}`);
  // Things that have hit the clubhouse.
  const trades = f.tradesSince(f.atMs - 14 * MS_DAY);
  if (trades.length) {
    const gone = trades.flatMap(t => t.offer?.outgoingIds || []).map(f.P).filter(Boolean).map(p => p.name);
    if (gone.length) out.push(`Losing ${list(gone.slice(0, 2))} in the trade stung a few players — ${gone.length > 1 ? 'they were' : 'that was'} part of the group. It's a business and they know it, but give it a few days.`);
  }
  const hurt = f.injured();
  if (hurt.length >= 3) out.push(`Having ${num(hurt.length)} players on the IL is a lot — the players filling in are getting real opportunities and they know it.`);
  const disc = deskDecisions(f, { tags: ['DISCIPLINE'], days: 30 })[0];
  const who2 = disc && (f.P(disc.card?._targetPlayerId)?.name || f.roster().map(p => p.name).find(n => new RegExp(`\\b${n}\\b`).test(disc.subject)));
  if (disc) {
    const what = who2 ? `the matter with ${who2}` : aboutOf(disc.subject);
    out.push(disc.choice === 'yes' ? `The way you handled ${what} set the right tone. Players noticed.` : `Some of the veterans noticed we let ${what} go. I'd keep an eye on that.`);
  }
  const leaves = (f.state.inbox || []).filter(c => c.resolved && /leave/i.test(c.cardId || '') && f.atMs - (c.resolvedAtMs || 0) < 30 * MS_DAY);
  if (leaves.length) out.push(`Giving a player time away for family matters went over well with the group.`);
  const sd = f.standing();
  if (f.season === 'regular' && sd) out.push(sd.place === 1 ? `Being in first gives everybody something to protect.` : sd.gb && sd.gb !== '-' && Number(sd.gb) <= 5 ? `We're ${sd.gb} back and everyone knows it. That's motivation.` : '');
  return { body: out.filter(Boolean), memo: { morale: m } };
};

W.mgr_rotation = (f, r, who) => {
  const out = [];
  const rot = f.rotation();
  if (!rot.order.length) return { body: ['We don\'t have a full rotation set right now.'], memo: {} };
  const arms = f.recentArms(15);
  const plan = f.nextStarters();
  if (!plan.length) return { body: [offseasonNote(f) || 'No games on the schedule to line the rotation up against.'], memo: {} };
  const rows = plan.map(({ g, p }) => {
    const last = (arms[p.id] || []).find(o => o.start);
    const lastTxt = last ? `last time out ${ip(last.outs)} innings, ${plural(last.er, 'run')}` : `${eraS(p).toFixed(2)} ERA`;
    return `${Cap(f.when(g.gameTime))}${f.atHome(g) ? ` vs. ${g.opponent || 'TBD'}` : ` at ${g.opponent || 'TBD'}`}: ${p.name} — ${lastTxt}`;
  });
  out.push(`Here's how the turns fall:\n${rows.map(x => `• ${x}`).join('\n')}`);
  const skipped = rot.order.filter(p => !plan.some(x => x.p.id === p.id) && f.isAvailable(p));
  if (skipped.length && plan.length >= rot.order.length) out.push(`${list(skipped.map(p => p.name))} ${skipped.length > 1 ? 'miss' : 'misses'} a turn this time through because of how the off days fall.`);
  const hurt = f.injured().filter(p => p.pos === 'SP');
  if (hurt.length) out.push(`${list(hurt.map(p => `${p.name} (${injuryWords(f, p)})`))} ${hurt.length > 1 ? 'are' : 'is'} still on the IL.`);
  const shaky = rot.order.filter(p => (arms[p.id] || []).filter(o => o.start).slice(0, 3).reduce((a, o) => a + o.er, 0) >= 12);
  if (shaky.length) out.push(`${shaky[0].name} has been hit hard the last few times out. I'm not making a change yet, but I've talked to the pitching coach about it.`);
  const dh = f.decisions().find(d => d.cardId === 'wx_doubleheader' && f.atMs - d.at < 10 * MS_DAY);
  if (dh) out.push(dh.choice === 'yes' ? `Going with the bullpen game in the doubleheader kept the rotation on schedule — that's why the turns line up the way they do.` : `We kept the rotation in order through the doubleheader, so everybody moved back a day.`);
  const hold = f.decisions().find(d => d.cardId === 'wx_rain_start' && f.atMs - d.at < 10 * MS_DAY);
  const held = hold && f.P(hold.card?._raw?.starterId)?.name;
  if (hold?.choice === 'yes') out.push(`Holding ${held || 'our starter'} back for the rain ${f.onWhen(hold.card?._wxGameTime || hold.at)} moved the turns back a day — that's why they fall the way they do.`);
  return { body: out.filter(Boolean), memo: {} };
};

W.mgr_matchup = (f, r, who) => {
  const out = [];
  const ser = f.nextSeries();
  if (!ser?.opp) return { body: [offseasonNote(f) || 'No series on the board yet.'], memo: {} };
  const o = ser.opp, vs = vsRecord(f, o.id);
  const n = ser.games.length;
  out.push(`${o.name} — ${n > 1 ? `${num(n)} games` : 'one game'} ${ser.home ? 'here' : 'on the road'}, starting ${f.when(ser.games[0].gameTime)} at ${f.clock(ser.games[0].gameTime)}. ${o.wins + o.losses ? `They're ${o.wins}-${o.losses}` : 'Their season hasn\'t started yet'}${o.streak >= 3 ? ` and have won ${num(o.streak)} straight` : o.streak <= -3 ? ` and have lost ${num(-o.streak)} straight` : ''}.${vs.w + vs.l ? ` We're ${vs.w}-${vs.l} against them this year.` : ''}`);
  const sps = theirStarters(f, o, n);
  if (sps.length) out.push(`Probable starters: ${list(sps.map(p => S(p).ip ? `${p.name} (${eraS(p).toFixed(2)} ERA)` : p.name))}.`);
  const bats = theirBats(f, o).slice(0, 2);
  if (bats.length) out.push(`The bats to worry about are ${list(bats.map(p => `${p.name} (${statLine(p)}${S(p)?.hr ? `, ${S(p).hr} HR` : ''})`))}. ${S(bats[0]).hr >= 15 ? `We don't give ${bats[0].name} anything to drive with runners on.` : 'We pitch them carefully and make the rest of the lineup beat us.'}`);
  const { fc, text } = forecastWords(f, ser.games[0]);
  if (fc && fc.chance >= 30) out.push(`One more thing: the opener's forecast is ${text}. I'll have a plan for the pitching if it starts late.`);
  return { body: out, memo: { opp: o.id } };
};

// ── Pitching Coach ─────────────────────────────────────────────

W.pc_rotation = (f, r, who) => {
  const out = [];
  const rot = f.rotation().order;
  const arms = f.recentArms(15);
  if (!rot.length) return { body: ['No rotation set at the moment.'], memo: {} };
  const rows = rot.map(p => {
    const starts = (arms[p.id] || []).filter(o => o.start).slice(0, 3);
    const er = starts.reduce((a, o) => a + o.er, 0), outs = starts.reduce((a, o) => a + o.outs, 0);
    const st = f.starterStatus(p);
    const tag = !starts.length ? (S(p).ip ? `${eraS(p).toFixed(2)} ERA` : 'no starts yet') : `${eraOf(er, outs / 3).toFixed(2)} ERA ${starts.length === 1 ? 'in the last start' : `over the last ${num(starts.length)} starts`}`;
    const arm = st.lastDays == null ? '' : st.lastDays <= 1 ? ', pitched yesterday' : `, ${plural(st.lastDays, 'day')} since the last outing`;
    return { p, er, outs, n: starts.length, txt: `${p.name}: ${tag}${arm}` };
  });
  out.push(`Arm by arm:\n${rows.map(x => `• ${x.txt}`).join('\n')}`);
  const heavy = rot.filter(p => (S(p)?.ip || 0) > 0).sort((a, b) => (S(b).ip / Math.max(1, S(b).gs || 1)) - (S(a).ip / Math.max(1, S(a).gs || 1)))[0];
  if (heavy && S(heavy)?.gs >= 5 && S(heavy).ip / S(heavy).gs >= 6.3) out.push(`${heavy.name} is averaging ${(S(heavy).ip / S(heavy).gs).toFixed(1)} innings a start. That's great for the bullpen, but I'm keeping a closer eye on that arm late in games.`);
  const bad = rows.filter(x => x.n >= 2 && eraOf(x.er, x.outs / 3) >= 6.5)[0];
  const good = rows.filter(x => x.n >= 2 && eraOf(x.er, x.outs / 3) <= 2.5)[0];
  if (bad) out.push(`${bad.p.name} is the one I'm working with. ${bad.p.subRatings?.control < 60 ? 'It\'s command — falling behind and paying for it.' : 'The stuff is there; the pitches are catching too much of the plate.'} We've got a bullpen session planned.`);
  if (good) out.push(`${good.p.name} is in a really good rhythm right now.`);
  const hurt = f.injured().filter(p => p.pos === 'SP' || p.pos === 'RP');
  if (hurt.length) out.push(`On the IL: ${list(hurt.slice(0, 3).map(p => `${p.name} (${injuryWords(f, p)})`))}.`);
  return { body: out, memo: {} };
};

W.pc_reliever = (f, r, who) => {
  const out = [];
  const bp = f.bullpen();
  const arms = f.recentArms(7);
  const usage = bp.arms.map(x => ({ ...x, apps: (arms[x.p.id] || []).filter(o => !o.start).length, outs: (arms[x.p.id] || []).filter(o => !o.start).reduce((a, o) => a + o.outs, 0) }))
    .sort((a, b) => b.outs - a.outs);
  if (!usage.length) return { body: ['The bullpen is thin right now — not much to report.'], memo: {} };
  const ng = f.nextGame();
  out.push(`Over our last ${plural(Math.min(7, f.played().length), 'game')}: ${list(usage.slice(0, 3).filter(x => x.apps).map(x => `${x.p.name} ${plural(x.apps, 'appearance')} (${ip(x.outs)} IP)`)) || 'nobody has been overworked'}.`);
  const down = usage.filter(x => x.status === 'down'), tired = usage.filter(x => x.status === 'tired');
  if (down.length) out.push(`${list(down.map(x => x.p.name))} ${down.length > 1 ? 'need' : 'needs'} the day off${ng ? ` ${f.when(ng.gameTime)}` : ''}.`);
  if (tired.length) out.push(`${list(tired.map(x => x.p.name))} ${tired.length > 1 ? 'are' : 'is'} available, but only if we really need ${tired.length > 1 ? 'them' : 'the arm'}.`);
  const closer = usage.find(x => x.role === 'closer');
  if (closer && S(closer.p).sv) out.push(`${closer.p.name} has ${plural(S(closer.p).sv, 'save')}${S(closer.p).bs ? ` and ${plural(S(closer.p).bs, 'blown save')}` : ''}${closer.status === 'fresh' ? ' and is fresh.' : '.'}`);
  else if (closer) out.push(`${closer.p.name} is closing${closer.status === 'fresh' ? ' and is fresh' : ''}.`);
  const recentEr = Object.values(arms).flat().filter(o => !o.start).reduce((a, o) => a + o.er, 0);
  const recentOuts = Object.values(arms).flat().filter(o => !o.start).reduce((a, o) => a + o.outs, 0);
  if (recentOuts >= 30) out.push(`As a group they've got a ${eraOf(recentEr, recentOuts / 3).toFixed(2)} ERA over that stretch${eraOf(recentEr, recentOuts / 3) > 5 ? ' — too many leads getting away' : ''}.`);
  const starterShort = f.played().slice(0, 5).map(g => f.ourSide(g)?.pitchers?.[0]).filter(Boolean).filter(p => (p.ipOuts || 0) < 15).length;
  if (starterShort >= 3) out.push(`The bigger issue is our starters not getting through five — ${num(starterShort)} of the last five. That's what's wearing the bullpen down.`);
  return { body: out, memo: {} };
};

W.pc_prospect = (f, r, who) => {
  const arms = f.young().filter(p => p.pos === 'SP' || p.pos === 'RP');
  if (!arms.length) return { body: ['We don\'t have a young pitcher worth a report right now.'], memo: {} };
  const reported = new Set(f.pastReplies('pc_prospect').slice(0, 2).map(x => x.memo?.playerId));
  // §122.9 the untested first: they're the ones we know least about.
  const ranked = arms.sort((a, b) => (!!b._ratingGap - !!a._ratingGap) || ((b.ovr - f.age(b)) - (a.ovr - f.age(a))));
  const p = ranked.find(x => !reported.has(x.id)) || ranked[0];
  const sr = p.subRatings || {};
  const best = ['stuff', 'control', 'stamina'].filter(k => sr[k] != null).sort((a, b) => sr[b] - sr[a]);
  const words = { stuff: 'the stuff', control: 'the command', stamina: 'the durability' };
  const out = [`${p.name}, ${f.age(p)}, ${p.pos === 'SP' ? 'a starter' : 'a reliever'} (${p.ovr} overall). The best thing about this arm is ${words[best[0]]} (${sr[best[0]]}); the work is ${words[best[best.length - 1]]} (${sr[best[best.length - 1]]}).`];
  const dev = f.devStatus(p);
  if (dev.active) out.push(dev.appliedActive >= 0.5 ? `The development plan is working — about ${dev.appliedActive.toFixed(1)} points gained so far.` : `The development plan has just started.`);
  const peers = p.pos === 'SP' ? f.rotation().order : f.bullpen().arms.map(x => x.p);
  const worst = peers.length ? Math.min(...peers.map(x => x.ovr)) : 99;
  const gap = worst - p.ovr;
  out.push(gap <= 2 ? `Honestly, ${p.name} could help us now — that's about where the back of our ${p.pos === 'SP' ? 'rotation' : 'bullpen'} is.` : gap <= 8 ? `Not ready yet, but closer than you'd think. Maybe later this year if it keeps going like this.` : `Still a ways off — a year or two of work before ${p.name} is ready to help.`);
  if (p._ratingGap) {
    const read = readOfUntested(p, r, 3);
    out.push(`${p.name} is ${ORIGIN_WORDS[p.origin] || 'still new to us'}. ${read > 0 ? 'From what I see in the bullpen sessions, there\'s more in this arm than the ratings show.' : read < 0 ? 'Honestly, I don\'t see all of what the reports promised yet.' : 'So far it looks about like the reports said.'} Innings and work will tell us for sure.`);
  }
  if (reported.has(p.id)) out.push(`(Same arm as last time — nobody else young is pushing for attention.)`);
  const offer = planOffer(p, f);
  if (offer) out.push(`If you want, I'll put ${p.name} on a development plan: a couple of days of focused work, out of action for two games.`);
  return { body: out, memo: { playerId: p.id }, decision: offer };
};

// ── §122.9 untested players: what the staff can see ───────────

const ORIGIN_WORDS = {
  rookie: 'a rookie, so the ratings are our scouts\' projection, not years of numbers',
  overseas: 'new to the league after playing overseas, so the ratings are our scouts\' estimate',
  independent: 'out of independent ball, so the ratings are mostly our scouts\' estimate',
};
const gauss = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
/** §122.15 how sharp our read on this player is: the scouting director's quality and specialty. */
const scoutEye = (f, p) => directorEye(f.state.userTeam?.coachingStaff, p);

/** A coach's or scout's read of an untested player against the ratings: +1 better, −1 worse, 0 about right. */
function readOfUntested(p, r, sigma) {
  if (!p?._ratingGap) return 0;
  const seen = trueOVR(p) - (p.ovr || 0) + gauss(r) * sigma;
  return seen >= 3 ? 1 : seen <= -3 ? -1 : 0;
}

/**
 * planOffer(p, who) — a development plan the coach offers (§122.9: the work also
 * shows what the player really has). The reply becomes a decision.
 */
function planOffer(p, f) {
  if (!p || f.devStatus(p).active || f.season === 'off') return null;
  return {
    playerId: p.id, yesLabel: `Start a development plan for ${p.name}`, noLabel: 'Not now',
    onYes: p.pos === 'SP' ? 'train_pitcher_sp' : p.pos === 'RP' ? 'train_pitcher_bp' : 'train_hitter',
    trainGain: 2, trainGames: 2, expiresInMs: 2 * MS_DAY,
  };
}

// ── Hitting Coach ──────────────────────────────────────────────

W.hc_slump = (f, r, who) => {
  const bats = f.recentBats(10);
  const lu = f.lineup().map(x => x.p);
  const rows = lu.map(p => ({ p, b: bats[p.id] })).filter(x => x.b && x.b.ab >= 18).sort((a, b) => avgOf(a.b.h, a.b.ab) - avgOf(b.b.h, b.b.ab));
  if (!rows.length) return { body: [f.season === 'spring' ? 'It\'s too early in camp to call anything a slump.' : 'Nobody has enough at-bats lately to call it a slump.'], memo: {} };
  const x = rows[0], a = avgOf(x.b.h, x.b.ab), kr = x.b.k / Math.max(1, x.b.ab + x.b.bb);
  const out = [];
  const prev = lastTime(f, 'hc_slump');
  if (prev && prev.prev.memo?.playerId && prev.prev.memo.playerId !== x.p.id) {
    const was = f.P(prev.prev.memo.playerId), wb = bats[prev.prev.memo.playerId];
    if (was && wb && wb.ab) out.push(`Good news first: ${was.name} has come around since we talked — ${line(wb)} over the last ${plural(wb.g, 'game')}.`);
  }
  if (a >= .240) {
    out.push(`Nobody is in a real slump right now. The coldest bat is ${x.p.name} at ${line(x.b)} over the last ${plural(x.b.g, 'game')}, and that's within normal.`);
    return { body: out, memo: { playerId: null } };
  }
  out.push(`${x.p.name} is the one — ${line(x.b)} over the last ${plural(x.b.g, 'game')}, with ${plural(x.b.k, 'strikeout')}.`);
  const sr = x.p.subRatings || {};
  if (kr >= 0.3) out.push(`It's the strikeouts. ${sr.contact < 55 ? 'Contact has never been the strength, and pitchers are attacking up in the zone.' : 'The swing gets long when the results aren\'t there, and the chase rate is up.'} We're working on shortening up with two strikes.`);
  else if (x.b.bb >= 4) out.push(`The approach is fine — ${plural(x.b.bb, 'walk')} in that stretch. The balls in play just aren't falling. I'm not changing much.`);
  else out.push(`The contact is weak — a lot of rollovers. ${sr.power >= 65 ? 'Trying to pull everything to get out of it.' : 'Getting jammed.'} We've been doing some opposite-field work in the cage.`);
  if (prev && prev.prev.memo?.playerId === x.p.id) out.push(`This is the same thing I wrote about ${f.onWhen(prev.prev.atMs)}, and it hasn't turned. If it goes another week, a day or two off might help more than more cage work.`);
  const i = f.lineup().findIndex(y => y.p.id === x.p.id);
  if (i >= 0 && i <= 3) out.push(`Batting ${['first', 'second', 'third', 'fourth'][i]} is a lot of weight to carry while working through this.`);
  return { body: out, memo: { playerId: x.p.id, ab: x.b.ab, h: x.b.h } };
};

W.hc_development = (f, r, who) => {
  const young = f.roster().filter(p => p.pos !== 'SP' && p.pos !== 'RP' && f.age(p) <= 25 && f.isAvailable(p))
    .sort((a, b) => (!!b._ratingGap - !!a._ratingGap) || (f.age(a) - f.age(b)));   // §122.9 the untested first
  const planned = f.roster().filter(p => p.pos !== 'SP' && p.pos !== 'RP' && f.devStatus(p).active);
  const p = planned.find(x => f.age(x) <= 26) || young[0] || planned[0];
  if (!p) return { body: ['We don\'t have a young hitter to report on right now.'], memo: {} };
  const out = [];
  const dev = f.devStatus(p);
  const lastYr = (p.seasonLog || []).filter(e => e?.stats?.ab).at(-1);
  out.push((S(p)?.ab || 0) >= 1 ? `${p.name}, ${f.age(p)}. Hitting ${statLine(p)} this year in ${plural(S(p)?.ab || 0, 'at-bat')}.`
    : lastYr ? `${p.name}, ${f.age(p)}. Hit ${fmtAvg(avgOf(lastYr.stats.h, lastYr.stats.ab))} with ${plural(lastYr.stats.hr || 0, 'homer')} in ${lastYr.stats.ab} at-bats last year.`
    : `${p.name}, ${f.age(p)}. No at-bats in this league yet.`);
  const sr = p.subRatings || {};
  const strong = ['contact', 'power', 'speed'].filter(k => sr[k] != null).sort((a, b) => sr[b] - sr[a]);
  const lo = strong[strong.length - 1];
  out.push(`The ${strong[0]} is the carrying tool (${sr[strong[0]]}). ${sr[lo] >= 65 ? `There's no real hole — the ${lo} (${sr[lo]}) is the lowest of the tools, and it's still good.` : `The ${lo} (${sr[lo]}) is where the work is.`}`);
  if (dev.active) out.push(dev.appliedActive >= 0.5 ? `The development plan you put in place is landing — about ${dev.appliedActive.toFixed(1)} points so far.` : `The development plan you put in place has only just started; it's too soon to see it in the numbers.`);
  else if (dev.recent.length) out.push(`The last development plan finished with ${dev.recent[dev.recent.length - 1].realized.toFixed(1)} points gained.`);
  else out.push(`There's no formal development plan on this player. It might be worth one — the age is right for it.`);
  const bats = f.recentBats(10)[p.id];
  if (bats && bats.ab >= 15) out.push(`Lately: ${line(bats)} over ${plural(bats.g, 'game')}.`);
  if (p._ratingGap) {
    const read = readOfUntested(p, r, 3);
    out.push(`${p.name} is ${ORIGIN_WORDS[p.origin] || 'still new to us'}. ${read > 0 ? 'In the cage I see more bat than the ratings give credit for.' : read < 0 ? 'In the cage it hasn\'t looked like what the reports said.' : 'In the cage it looks about like the reports said.'} At-bats and work will settle it.`);
  }
  const offer = planOffer(p, f);
  if (offer) out.push(`Say the word and I'll start a plan: a couple of days of work, out of the lineup for two games.`);
  return { body: out, memo: { playerId: p.id }, decision: offer };
};

W.hc_lineup = (f, r, who) => {
  const lu = f.lineup();
  if (lu.length < 9) return { body: ['We need a full lineup before I can say much about the order.'], memo: {} };
  const out = [];
  const ab = (p) => S(p)?.ab || 0;
  if (lu.every(x => ab(x.p) < 30)) return { body: ['It\'s early — not enough at-bats yet to argue about the order.'], memo: {} };
  const byObp = [...lu].filter(x => ab(x.p) >= 30).sort((a, b) => obpS(b.p) - obpS(a.p));
  const bySlg = [...lu].filter(x => ab(x.p) >= 30).sort((a, b) => slgS(b.p) - slgS(a.p));
  const lead = lu[0].p;
  const bestObp = byObp[0];
  if (bestObp && bestObp.p.id !== lead.id && obpS(bestObp.p) - obpS(lead) >= 0.03) out.push(`${bestObp.p.name} has the best on-base percentage on the club (${fmtAvg(obpS(bestObp.p))}) and is hitting ${ord(lu.indexOf(bestObp))}. ${lead.name} leads off at ${fmtAvg(obpS(lead))}. I'd flip that.`);
  else out.push(`${lead.name} at leadoff makes sense — ${fmtAvg(obpS(lead))} on-base.`);
  const power = bySlg[0];
  const pi = lu.indexOf(power);
  if (power && (pi < 2 || pi > 4)) out.push(`Our best slugger, ${power.p.name} (${fmtAvg(slgS(power.p))} slugging${S(power.p)?.hr ? `, ${S(power.p).hr} homers` : ''}), is hitting ${pi < 2 ? 'too high to drive anybody in' : 'too low to come up with runners on'}. Third or fourth is where that bat does the most damage.`);
  else if (power) out.push(`${power.p.name} in the middle of the order is right — that's where the power belongs.`);
  const weak = [...lu].filter(x => ab(x.p) >= 50).sort((a, b) => (obpS(a.p) + slgS(a.p)) - (obpS(b.p) + slgS(b.p)))[0];
  if (weak && lu.indexOf(weak) <= 4) out.push(`${weak.p.name} is hitting ${statLine(weak.p)} — too low for the ${lu.indexOf(weak) + 1 === 1 ? 'top' : 'middle'} of the order.`);
  out.push(`My suggestions are in. The manager has the final say on the order.`);
  return { body: out, memo: {} };
};

// ── Bench Coach ────────────────────────────────────────────────

W.bc_morale = (f, r, who) => {
  const out = [];
  if (f.played().filter(g => !g.isSpring).length < 5) return { body: ['Not enough games yet to see patterns in how we manage them.'], memo: {} };
  const one = f.oneRun(), xi = f.extraInnings();
  out.push(`In one-run games we're ${one.w}-${one.l}. ${one.w > one.l + 2 ? 'That\'s the bullpen and the late-inning calls holding up.' : one.l > one.w + 2 ? 'That\'s where the margins have gone against us — a lot of it is the bullpen.' : 'About even, which is what you\'d expect.'}`);
  if (xi.length) out.push(`We've gone extra innings ${plural(xi.length, 'time')} and won ${xi.filter(x => x.won).length}.`);
  const team = f.roster();
  const sb = team.reduce((a, p) => a + (S(p)?.sb || 0), 0), cs = team.reduce((a, p) => a + (S(p)?.cs || 0), 0);
  if (sb + cs >= 10) out.push(`On the bases: ${sb} steals in ${sb + cs} tries (${pct(sb / (sb + cs))}). ${sb / (sb + cs) >= 0.75 ? 'That success rate says keep running.' : 'Below 70%, the steals cost us more than they gain. I\'ve told the manager we should run less.'}`);
  const bs = team.reduce((a, p) => a + (S(p)?.bs || 0), 0);
  if (bs >= 3) out.push(`${plural(bs, 'blown save')} this year. Some of that is matchups — I've been pushing for the closer earlier in the high-leverage spots.`);
  const close = f.lastN(10).filter(x => !x.won && x.them - x.us <= 2);
  if (close.length >= 3) out.push(`We've lost ${num(close.length)} close games in the last ten. The tactics haven't been the problem — we haven't gotten the hits with runners in scoring position.`);
  return { body: out, memo: {} };
};

// ── Bullpen Coach ──────────────────────────────────────────────

W.bpc_health = (f, r, who) => {
  const bp = f.bullpen();
  if (!bp.arms.length) return { body: ['Nobody is in the bullpen right now.'], memo: {} };
  const g = f.nextGame();
  const forWhen = g && g.gameTime > f.atMs ? f.when(g.gameTime) : 'today';
  const arms = f.recentArms(4);
  const why = (x) => {
    const o = (arms[x.p.id] || []).filter(o => !o.start);
    if (!o.length) return '';
    const last = o[0];
    return ` (${ip(last.outs)} IP ${f.onWhen(last.at)}${o.length >= 2 ? `, ${num(o.length)} of the last four games` : ''})`;
  };
  const fresh = bp.arms.filter(x => x.status === 'fresh'), tired = bp.arms.filter(x => x.status === 'tired'), down = bp.arms.filter(x => x.status === 'down');
  const out = [`For ${forWhen}:`];
  if (fresh.length) out.push(`Good to go: ${list(fresh.map(x => `${x.p.name}${x.role === 'closer' ? ' (closer)' : ''}`))}.`);
  if (tired.length) out.push(`One inning at most: ${list(tired.map(x => `${x.p.name}${why(x)}`))}.`);
  if (down.length) out.push(`Unavailable: ${list(down.map(x => `${x.p.name}${why(x)}`))}.`);
  const cl = bp.arms.find(x => x.role === 'closer');
  if (cl && cl.status !== 'fresh') out.push(`With ${cl.p.name} ${cl.status === 'down' ? 'down' : 'limited'}, the ninth goes to ${bp.arms.find(x => x.role === 'setup' && x.status === 'fresh')?.p.name || 'whoever is fresh'}.`);
  if (down.length + tired.length >= Math.ceil(bp.arms.length / 2)) out.push(`That's a short bullpen. We need some length from the starter.`);
  return { body: out, memo: {} };
};

// ── Facilities & Ops ───────────────────────────────────────────

W.fac_status = (f, r, who) => {
  const out = [];
  const FAC = /clubhouse|ballpark|stadium|concession|lighting|scoreboard|seat|upgrade|facility|facilities|inspection|hvac|restroom|parking/i;
  const spent = f.ledger(e => e.k < 0 && FAC.test(e.label || ''), 120);
  const homes = f.homeGamesWithin(10);
  if (homes.length) {
    const first = homes[0], last = homes[homes.length - 1];
    out.push(`We have ${plural(homes.length, 'home game')} in the next ten days, starting ${f.when(first.gameTime)}${homes.length > 1 ? ` through ${f.when(last.gameTime)}` : ''}. Staffing and concessions are set for it.`);
    const fc = first.gameTime - f.atMs <= 4 * MS_DAY ? f.forecastFor(first) : null;
    if (fc?.tempF >= 90) out.push(`It's going to be hot — around ${fc.tempF}° at first pitch. We're adding water stations and the misting fans on the concourse.`);
    else if (fc && fc.tempF <= 50) out.push(`Only about ${fc.tempF}° at first pitch — the concourse heaters are going on and we're pushing hot drinks at the stands.`);
    if (fc?.chance >= 40) out.push(`The forecast for ${f.when(first.gameTime)} is ${fc.label.toLowerCase()} (${fc.chance}%), so the weather policy${fc.kind === 'snow' || fc.kind === 'mix' ? '' : ' and covered-seating info'} ${fc.kind === 'snow' || fc.kind === 'mix' ? 'goes' : 'go'} out to ticket holders.`);
  } else out.push(`No home games in the next ten days, so this is our window for maintenance.`);
  const sellouts = f.homeGates().filter(x => x.sellout).length;
  if (sellouts >= 3) out.push(`${Cap(num(sellouts))} of the last ${plural(f.homeGates().length, 'home game')} were sellouts. The building is holding up, but the restrooms and the concourse are working hard.`);
  if (spent.length) out.push(`The ${topicStem(spent[0].label)} work ${f.atMs - spent[0].at < 21 * MS_DAY ? 'is finished' : 'from earlier this year is holding up well'}.`);
  const no = deskDecisions(f, { tags: ['FACILITIES', 'OPERATIONS'], days: 120 }).filter(d => FAC.test(d.subject)).find(d => d.choice === 'no');
  if (no) out.push(`${Cap(aboutOf(no.subject))} we passed on is still on my list. It's not urgent, but it doesn't get cheaper.`);
  const ign = deskIgnored(f, { tags: ['FACILITIES', 'OPERATIONS'], days: 30 }).filter(c => FAC.test(c.subject || ''))[0];
  if (ign) out.push(`When ${aboutOf(ign.subject)} came up and couldn't wait, we handled it ourselves.`);
  if (out.length < 3) out.push(`Otherwise, nothing needs your attention.`);
  return { body: out, memo: {} };
};

// ── Ticket Office ──────────────────────────────────────────────

W.tix_attendance = (f, r, who) => {
  const out = [];
  const gates = f.homeGates(), cap = f.capacity();
  if (gates.length) {
    const avg = Math.round(gates.reduce((a, x) => a + x.n, 0) / gates.length);
    const wk = gates.filter(x => x.weekend), wd = gates.filter(x => !x.weekend);
    out.push(`We've averaged ${avg.toLocaleString()} over the last ${plural(gates.length, 'home game')}${cap ? ` — ${pct(avg / cap)} of capacity` : ''}${gates.filter(x => x.sellout).length ? `, with ${plural(gates.filter(x => x.sellout).length, 'sellout')}` : ''}.`);
    if (wk.length && wd.length) {
      const a = Math.round(wk.reduce((s, x) => s + x.n, 0) / wk.length), b = Math.round(wd.reduce((s, x) => s + x.n, 0) / wd.length);
      if (a - b > 2500) out.push(`Weekends are carrying us — about ${a.toLocaleString()} on weekends against ${b.toLocaleString()} on weeknights.`);
    }
  } else out.push(f.season === 'off' ? 'No games to sell right now; we\'re focused on next season.' : 'We haven\'t had enough home dates yet to talk about trends.');
  // (Spring games aren't part of the gate.)
  const homes = f.homeGamesWithin(7).filter(g => g.gameTime > f.atMs && !g.isSpring).slice(0, 4);
  if (f.season === 'spring' && !homes.length) out.push(`Spring games aren't part of our gate; we're focused on the home opener and the first homestand.`);
  if (homes.length) {
    // §110 our projection: the same crowd model the gate uses, with the forecast fans will see.
    const notes = homes.map(g => {
      const fc = g.gameTime - f.atMs <= 3 * MS_DAY ? f.forecastFor(g) : null;
      const base = crowdFor(f.state, 'user', { atMs: g.gameTime, playoff: !!g.isPlayoff, expected: true });
      const proj = fc ? crowdFor(f.state, 'user', { atMs: g.gameTime, playoff: !!g.isPlayoff, expected: true, weather: { chance: fc.chance, tempF: fc.tempF, wet: false } }) : base;
      const n = (x) => `${Math.round((x?.attendance || 0) / 500) * 500 >= 1000 ? (Math.round(x.attendance / 500) * 500).toLocaleString() : x?.attendance}`;
      const lost = (base?.attendance || 0) - (proj?.attendance || 0);
      const why = fc && fc.chance >= 30 ? `${fc.label.toLowerCase()}, ${fc.chance}%` : fc && fc.tempF < 55 ? `${fc.tempF}°` : fc && fc.tempF >= 90 ? `${fc.tempF}° heat` : '';
      const tail = proj?.sellout ? 'a sellout' : `about ${n(proj)}`;
      return lost >= 800 && why
        ? `${f.when(g.gameTime)}: ${tail} — the forecast (${why}) is costing us about ${(Math.round(lost / 100) * 100).toLocaleString()} walk-up sales`
        : `${f.when(g.gameTime)}: ${tail}`;
    });
    out.push(`Coming up at home:\n${notes.map(x => `• ${x}`).join('\n')}`);
    if (homes.some(g => g.gameTime - f.atMs > 3 * MS_DAY)) out.push(`(Those further out don't account for the weather yet — the walk-up decides on the day.)`);
    const promo = f.fin().promo;
    if (promo?.gamesLeft > 0) out.push(`The ticket promotion has ${plural(promo.gamesLeft, 'home game')} left on it.`);
  }
  const { streak } = f.record();
  if (streak >= 4) out.push(`The winning streak is selling tickets. Walk-up sales are up.`);
  else if (streak <= -4) out.push(`The losing streak has slowed walk-up sales. Advance sales are holding.`);
  const atm = f.u.atmosphere ?? 50;
  if (atm >= 80) out.push(`The atmosphere at the park is a selling point right now — people talk about it.`);
  return { body: out, memo: {} };
};

W.tix_renewals = (f, r, who) => {
  const out = [];
  const { w, l } = f.record();
  const wp = w + l ? w / (w + l) : 0.5;
  const atm = f.u.atmosphere ?? 50;
  const rate = Math.max(55, Math.min(96, Math.round(70 + (wp - 0.5) * 60 + (atm - 50) * 0.3)));
  const MKT = /season ticket|sth|renewal|group sales|ticket/i;
  if (f.season === 'off') out.push(`Renewals for next season are at about ${rate}%. ${rate >= 85 ? 'That\'s a strong number.' : rate >= 72 ? 'That\'s about normal for us.' : 'Soft. Holders are waiting to see what we do this winter.'}`);
  else if (f.season === 'spring') out.push(`Final renewals came in at about ${rate}%. ${rate >= 80 ? 'That\'s a good start to the year.' : 'There\'s some room to grow once we start winning.'}`);
  else out.push(`The renewal campaign for next season starts in the second half. Based on the season so far — ${w}-${l} — I'm projecting about ${rate}%. ${wp >= .55 && rate >= 82 ? 'A winning season makes it easy.' : wp >= .55 ? 'Even with the record, holders are cautious — the ballpark experience hasn\'t caught up with the wins.' : wp <= .45 ? 'Holders are frustrated with the record, and the renewal calls are going to be harder.' : 'It depends on how the second half goes.'}`);
  const ign = distinct(deskIgnored(f, { tags: ['MARKETING'], days: 60 }));
  if (ign.length) out.push(`${Cap(list(ign.slice(0, 2).map(c => aboutOf(c.subject))))} — left without an answer from the front office — came up on renewal calls. Those holders remember.`);
  const dec = deskDecisions(f, { tags: ['MARKETING'], days: 90 })[0];
  if (dec) out.push(dec.choice === 'yes' ? `The call you made on ${aboutOf(dec.subject)} went over well with holders.` : `Some holders are still asking about ${aboutOf(dec.subject)}.`);
  if (atm >= 80) out.push(`The ballpark atmosphere comes up a lot on the calls. It's our best selling point.`);
  return { body: out, memo: { rate } };
};

// ── Scouting / Development ─────────────────────────────────────

W.sc_prospect = (f, r, who) => {
  const farm = f.young();
  if (!farm.length) return { body: ['We\'re thin on young players right now — nothing worth a report.'], memo: {} };   // (our young players: there's no farm, §122)
  const reported = new Set(f.pastReplies('sc_prospect').slice(0, 3).map(x => x.memo?.playerId));
  const ranked = farm.sort((a, b) => (b.ovr - 0.8 * f.age(b)) - (a.ovr - 0.8 * f.age(a)));
  const p = ranked.find(x => !reported.has(x.id)) || ranked[0];
  const sr = p.subRatings || {};
  const keys = p.pos === 'SP' || p.pos === 'RP' ? ['stuff', 'control', 'stamina'] : ['contact', 'power', 'speed'];
  const ks = keys.filter(k => sr[k] != null).sort((a, b) => sr[b] - sr[a]);
  const out = [`${p.name} — ${p.pos}, ${f.age(p)} years old, ${p.ovr} overall right now.`];
  out.push(`Best tool: ${ks[0]} (${sr[ks[0]]}). Needs work: ${ks[ks.length - 1]} (${sr[ks[ks.length - 1]]}).`);
  const dev = f.devStatus(p);
  if (dev.active) out.push(dev.appliedActive >= 0.5 ? `The development plan is about ${dev.appliedActive.toFixed(1)} points in.` : `The development plan has just started.`);
  const same = f.roster().filter(x => x.pos === p.pos || (['LF', 'CF', 'RF', 'OF'].includes(x.pos) && ['LF', 'CF', 'RF', 'OF'].includes(p.pos)));
  const block = same.sort((a, b) => b.ovr - a.ovr)[0];
  if (block) out.push(block.ovr - p.ovr <= 3 ? `Close to pushing ${block.name} for playing time.` : `${block.name} is ahead at the position, so ${p.name} has time to develop.`);
  if (f.age(p) <= 20) out.push(`Very young for the level. The ceiling is the reason we like this player.`);
  return { body: out, memo: { playerId: p.id } };
};

/**
 * §122.9 the scouts look over the free agents: a few players a week (2–5, by the
 * director: scoutLooks), the ones they think are worth more than their ratings.
 * How sharp the eye is depends on the scouting director (§122.15: quality, and
 * the specialty that fits where the player comes from). An untested player: is he better than the
 * estimate? A proven one: does his role make him better than his rating? And
 * whether other clubs have caught on yet.
 */
W.sc_free_agents = (f, r, who) => {
  const st = f.state, level = st.leagueTalentOffset || 0;
  const week = f.pastReplies('sc_free_agents').filter(x => f.atMs - x.atMs < 7 * MS_DAY);
  const seenWeek = week.flatMap(x => x.memo?.playerIds || []);
  const looks = scoutLooks(st.userTeam?.coachingStaff);
  const left = looks - seenWeek.length;
  if (left <= 0) {
    const next = Math.min(...week.map(x => x.atMs)) + 7 * MS_DAY;
    const names = seenWeek.map(f.P).filter(p => p && p.group === 'freeAgent').map(p => p.name);
    return { body: [`We've already looked at our ${looks} this week${names.length ? ` (${list(names)}${names.length === 1 ? ' is' : ' are'} still out there)` : ''}. The next look is ${f.onWhen(next)}.`], memo: { playerIds: [] } };
  }
  const recent = new Set(f.pastReplies('sc_free_agents').filter(x => f.atMs - x.atMs < 30 * MS_DAY).flatMap(x => x.memo?.playerIds || []));
  const sigmaOf = (p) => 4 / scoutEye(f, p);
  const pool = (st.freeAgentPool || []).map(f.P).filter(p => p && p.group === 'freeAgent' && !p.isInjured && !recent.has(p.id));
  if (!pool.length) return { body: ['There\'s nobody new on the market worth the trip right now.'], memo: { playerIds: [] } };
  const seen = pool.map(p => ({ p, worth: worthOf(p) + gauss(r) * sigmaOf(p) }))
    .map(x => ({ ...x, edge: x.worth - (x.p.ovr || 0) }))
    .filter(x => x.worth - level >= 42)
    .sort((a, b) => (b.edge + 0.3 * (b.worth - level)) - (a.edge + 0.3 * (a.worth - level)))
    .slice(0, left);
  if (!seen.length) return { body: ['We looked. Nobody out there is better than the ratings say right now.'], memo: { playerIds: [] } };
  const out = [`We looked at ${list(seen.map(x => x.p.name))}.`];
  for (const { p, edge } of seen) {
    const ask = signingTerms(st, p);
    const sr = p.subRatings || {};
    const last = (p.seasonLog || []).filter(e => e?.stats).at(-1);
    const lines = [`${p.name} (${posLabel(p)}, ${f.age(p)}, OVR ${p.ovr}, asking ${ask.salary ? formatK(ask.salary) : 'the minimum'}${ask.bonus ? ` with a ${formatK(ask.bonus)} bonus` : ''}):`];
    if (p._ratingGap) {
      const read = readOfUntested(p, r, sigmaOf(p));
      lines.push(`${Cap(ORIGIN_WORDS[p.origin] || 'new to the league')}. ${read > 0 ? 'Our read: better than the reports — this could be a real find.' : read < 0 ? 'Our read: not as good as the reports.' : 'Our read: about what the reports say.'}`);
    } else if (p.pos === 'RP' && (sr.stamina ?? 99) <= 48 && edge >= 3) {
      lines.push(`The rating counts stamina (${sr.stamina}), and that's the weak spot. For an inning out of the bullpen, the stuff (${sr.stuff}) and control (${sr.control}) play better than the number.${last?.stats?.ip >= 20 ? ` Last year: a ${eraOf(last.stats.er, last.stats.ip).toFixed(2)} ERA in ${Math.round(last.stats.ip)} innings.` : ''}`);
    } else if (!['SP', 'RP'].includes(p.pos) && (sr.speed ?? 99) <= 48 && edge >= 3) {
      lines.push(`The rating is dragged down by the legs (speed ${sr.speed}). The bat is the real thing: contact ${sr.contact}, power ${sr.power}.${last?.stats?.ab >= 150 ? ` Last year: ${fmtAvg(avgOf(last.stats.h, last.stats.ab))} with ${plural(last.stats.hr || 0, 'homer')} in ${last.stats.ab} at-bats.` : ''}`);
    } else {
      lines.push(edge >= 3 ? 'Better than the rating — more useful than the number suggests.' : 'About what the rating says: a useful depth piece, not more.');
    }
    // Whether the rest of the league has caught on (the sharper our scouts, the surer we are).
    if (edge >= 4 && isDiamond(p, level)) {
      lines.push(Number.isFinite(p._buzzAt) && p._buzzAt > f.atMs
        ? `As far as we can tell, nobody else is on this one yet. I'd move before word gets around.`
        : `Other clubs have been asking about this one. If we want in, it has to be soon.`);
    }
    out.push(lines.join(' '));
  }
  return { body: out, memo: { playerIds: seen.map(x => x.p.id) } };
};

W.sc_opponent = (f, r, who) => {
  const ser = f.nextSeries();
  if (!ser?.opp) return { body: [offseasonNote(f) || 'No opponent on the board yet.'], memo: {} };
  const o = ser.opp;
  const out = [`${o.name} (${o.wins}-${o.losses}), ${ser.home ? 'here' : 'there'} ${f.when(ser.games[0].gameTime)} at ${f.clock(ser.games[0].gameTime)}${ser.games.length > 1 ? `, ${num(ser.games.length)} games` : ''}.`];
  const sps = theirStarters(f, o, ser.games.length);
  for (const p of sps.slice(0, 3)) {
    const sr = p.subRatings || {};
    const style = sr.stuff >= 75 ? 'power arm — gets swings and misses' : sr.control >= 75 ? 'lives on the edges and rarely walks anyone' : sr.stamina >= 75 ? 'pitches deep into games' : 'mixes pitches and changes speeds';
    out.push(`• ${p.name}: ${S(p)?.ip ? `${eraS(p).toFixed(2)} ERA in ${Math.round(S(p).ip)} IP` : 'no innings yet'}, ${style}.`);
  }
  const bats = theirBats(f, o).slice(0, 3);
  if (bats.length) out.push(`Lineup: ${list(bats.map(p => `${p.name} (${statLine(p)}${S(p)?.hr ? `, ${S(p).hr} HR` : ''})`))} do the damage. ${bats.reduce((a, p) => a + (S(p)?.sb || 0), 0) >= 25 ? 'They run, so our catchers need quick throws.' : 'They don\'t run much.'}`);
  const vs = vsRecord(f, o.id);
  if (vs.w + vs.l) out.push(`We're ${vs.w}-${vs.l} against them this year.`);
  if (o.streak >= 4) out.push(`They're hot — ${num(o.streak)} straight wins.`); else if (o.streak <= -4) out.push(`They've lost ${num(-o.streak)} straight — a club trying to get out of a hole.`);
  return { body: out, memo: { opp: o.id } };
};

// ── Media Relations ────────────────────────────────────────────

W.mr_narrative = (f, r, who) => {
  const out = [];
  const { w, l, streak } = f.record();
  const sd = f.standing();
  if (f.season === 'regular' || f.season === 'post') {
    if (streak >= 5) out.push(`The ${num(streak)}-game winning streak is the story. Every column this week is about it.`);
    else if (streak <= -5) out.push(`The ${num(-streak)}-game losing streak is the story, and the questions are getting sharper.`);
    else if (sd?.place === 1) out.push(`Being in first is the story. Coverage is positive, and the national writers are starting to call.`);
    else if (sd && sd.gb !== '-' && Number(sd.gb) >= 10) out.push(`At ${w}-${l}, ${sd.gb} games back, the coverage has turned to what comes next.`);
    else out.push(`At ${w}-${l}, the coverage is about whether this club is a contender. It could go either way.`);
  } else out.push(f.season === 'spring' ? `In camp, the stories are about the roster battles and who makes the club.` : `The offseason coverage is all about what we do next.`);
  const t = f.tradesSince(f.atMs - 21 * MS_DAY)[0];
  if (t) {
    const inn = (t.offer?.incomingIds || []).map(f.P).filter(Boolean).map(p => p.name);
    const outN = (t.offer?.outgoingIds || []).map(f.P).filter(Boolean).map(p => p.name);
    if (inn.length) out.push(`The ${list(inn)} trade is still getting coverage. ${outN.length ? `Some writers miss ${list(outN.slice(0, 2))}, but the reaction has been fair.` : ''}`.trim());
  }
  const hr = f.roster().filter(p => S(p)?.hr).sort((a, b) => S(b).hr - S(a).hr)[0];
  if (hr && S(hr).hr >= 10) out.push(`${hr.name} (${S(hr).hr} homers) is the player everyone wants to talk to.`);
  const big = f.gmLog().find(x => x.type === 'injury' && /season-ending/i.test(x.headline || '') && x.season === f.state.seasonNum && (f.state.currentGameIndex || 0) - (x.gameIdx || 0) <= 20);
  if (big) out.push(`Expect questions about how we replace ${big.headline.split(' — ')[0]}.`);
  const leak = (f.state.inbox || []).find(c => c.resolved && /leak|reporter|media|press/i.test(c.subject || '') && f.atMs - (c.resolvedAtMs || 0) < 30 * MS_DAY);
  if (leak) out.push(leak.choice === 'yes' ? `How we handled ${aboutOf(leak.subject)} earned us some good will with the beat writers.` : leak.choice === 'no' ? `The beat writers haven't forgotten ${aboutOf(leak.subject)}. I'd be careful there.` : `We never said anything about ${aboutOf(leak.subject)}, and the beat writers noticed. I'd be careful there.`);
  if ((f.u.ownerTrust ?? 60) < 40) out.push(`Some writers are asking about the owner's patience. We're not commenting.`);
  return { body: out, memo: {} };
};

// ── Community Affairs ──────────────────────────────────────────

W.ca_event = (f, r, who) => {
  const out = [];
  const COMM = /youth|charity|community|hospital|school|clinic|tournament|foundation|fundrais|little league|volunteer/i;
  const off = f.offDays(10);
  if (off.length) out.push(`We're holding the off day ${f.onWhen(off[0])} for the youth clinic at the ballpark. A few players would be great, but it's voluntary.`);
  else if (f.upcoming().length) out.push(`The schedule is packed for the next ten days, so we're keeping player appearances light. Mostly front-office events and a pregame ceremony.`);
  else out.push(`It's quiet on the schedule, which is when we do most of our community work.`);
  const dec = deskDecisions(f, { words: COMM, days: 90 });
  const yes = dec.find(d => d.choice === 'yes'), no = dec.find(d => d.choice === 'no');
  if (yes) out.push(`${Cap(aboutOf(yes.subject))} you approved was well received. People still mention it.`);
  if (no) out.push(`We sent our regrets on ${aboutOf(no.subject)}. They understood, but they'll ask again next year.`);
  const ign = deskIgnored(f, { words: COMM, days: 45 })[0];
  if (ign) out.push(`Nobody got back to them on ${aboutOf(ign.subject)}, so we handled it at our level.`);
  const homes = f.homeGamesWithin(10).length;
  if (homes >= 4) out.push(`With ${plural(homes, 'home game')} coming up, the pregame ceremonies are booked: first pitches and local honorees.`);
  return { body: out, memo: {} };
};

// ─────────────────────────────────────────────────────────────
// THE REPLY
// ─────────────────────────────────────────────────────────────

const TOPIC_LABELS = {
  gk_field: 'the field', gk_weather: 'the weather', mgr_lineup: 'the lineup', mgr_morale: 'the clubhouse',
  mgr_rotation: 'the rotation', mgr_matchup: 'the next series', pc_rotation: 'the rotation', pc_reliever: 'the bullpen',
  pc_prospect: 'our young pitchers', hc_slump: 'the slump', hc_development: 'our young hitters', hc_lineup: 'the batting order',
  bc_morale: 'our in-game decisions', bpc_health: 'the bullpen', fac_status: 'the ballpark', tix_attendance: 'attendance',
  tix_renewals: 'season-ticket renewals', sc_prospect: 'our young players', sc_opponent: 'the next opponent',
  sc_free_agents: 'the free agents', mgr_trade: 'the trade', sc_trade: 'the trade', sc_shop: 'shopping a player',
  mr_narrative: 'the coverage', ca_event: 'community commitments',
  hc_work: 'the work', pc_work: 'the work', bc_teach: 'the position work', sc_program: 'the program', mgr_rest: 'a day off', doc_health: 'that player',
};


// ─────────────────────────────────────────────────────────────
// r150 A TRADE ON THE TABLE
// ─────────────────────────────────────────────────────────────
// The GM picks the deal (an offer, a counter, a yes waiting on our answer);
// `arg` carries it: { key, label, instanceId }. Written as the reply comes
// back, from the deal as it stands then (TradeAdvice).

const SPOT_WORDS = { C: 'catcher', '1B': 'first base', '2B': 'second base', '3B': 'third base', SS: 'shortstop', OF: 'the outfield', DH: 'DH' };
const ovrOf = (p) => `OVR ${p.ovr}`;
const seasonWord = (f) => (f.season === 'spring' ? 'this spring' : f.season === 'off' ? 'last season' : 'this year');
const batLine = (f, p) => (S(p).ab >= 40 ? `hitting ${statLine(p)}${S(p).hr ? ` with ${plural(S(p).hr, 'homer')}` : ''} ${seasonWord(f)}` : '');
const armLine = (f, p) => (S(p).ip >= 15 ? `a ${eraS(p).toFixed(2)} ERA in ${Math.round(S(p).ip)} innings ${seasonWord(f)}` : '');

/** The deal in words: "we send Vega and get Ruiz and Ortiz, with $40K coming to us". */
function dealWords(st, o, team) {
  const N = (ids) => list((ids || []).map(id => st.players[id]?.name).filter(Boolean));
  const c = o.cashK || 0;
  let t = (o.outgoingIds || []).length
    ? `we send ${N(o.outgoingIds)} and get ${N(o.incomingIds) || 'nothing back but cash'}`
    : `we get ${N(o.incomingIds)}`;
  if (c > 0) t += `, with ${formatK(c)} coming to us`;
  if (c < 0) t += (o.outgoingIds || []).length ? `, and we send ${formatK(-c)}` : ` for ${formatK(-c)}`;
  for (const [id, share] of Object.entries(o.retain || {})) {
    const p = st.players[id];
    if (p) t += `; ${(o.incomingIds || []).includes(id) ? team : 'we'} keep paying ${Math.round(share * 100)}% of ${p.name}'s salary this season`;
  }
  return t;
}

/** What the GM asked about, as a phrase: "Gulfport's offer". */
const poss = (name) => (/s$/.test(name) ? `${name}'` : `${name}'s`);
const dealTopic = (d) => (d.kind === 'offer' ? `${poss(d.team)} offer` : d.kind === 'counter' ? `${poss(d.team)} counter` : `the deal ${d.team} agreed to`);

/** The deal is no longer waiting on us by the time the reply is written. */
function dealGone(f, arg) {
  const c = (f.state.inbox || []).find(x => x.instanceId === arg?.instanceId);
  const how = c?.resolved ? (c.choice === 'yes' ? 'you made the call and took it' : c.choice === 'no' ? 'you made the call and passed' : 'it ran out')
    : 'it\'s off the table';
  return { body: [`By the time I got to it, that deal was settled — ${how}. Nothing for me to add; ask again about the next one.`], memo: {}, topic: 'that deal' };
}

/** The payroll paragraph (the director's, from the Finance numbers). */
function payrollWords(f, o) {
  const st = f.state;
  const ev = evaluateTrade(o, st);
  const d = Math.round(ev.payrollDelta || 0), target = Math.round(seasonTarget(st.userTeam?.finances) || 0);
  const rem = remainingShare(st);
  const parts = [];
  if (d > 25) parts.push(`It adds ${formatK(d)} a year to the payroll${rem > 0.05 && rem < 0.95 ? ` — about ${formatK(Math.round(d * rem))} of it for the rest of this season` : ''}.`);
  else if (d < -25) parts.push(`It takes ${formatK(-d)} a year off the payroll${rem > 0.05 && rem < 0.95 ? ` — about ${formatK(Math.round(-d * rem))} of it for the rest of this season` : ''}.`);
  else parts.push('It barely moves the payroll.');
  if (target > 0) {
    const gap = Math.round(ev.newPayroll - target);
    parts.push(gap > 0 ? `That leaves us ${formatK(gap)} over ownership's target of ${formatK(target)}.`
                       : `We'd stay ${formatK(-gap)} under ownership's target of ${formatK(target)}.`);
  }
  const seasons = (y) => `${num(y)} more season${y === 1 ? '' : 's'}`;
  const signed = (ids) => (ids || []).map(id => st.players[id]).filter(p => p && (p.contractSalary || 0) > 0 && yearsAfterThis(p, st) > 0);
  const inL = signed(o.incomingIds), outL = signed(o.outgoingIds);
  if (inL.length) parts.push(`Beyond this season, ${list(inL.map(p => `${p.name} is signed for ${seasons(yearsAfterThis(p, st))} at ${formatK(p.contractSalary)}`))}.`);
  else if ((o.incomingIds || []).length) parts.push('Nobody coming in is signed past this season.');
  if (outL.length) parts.push(`${list(outL.map(p => `${poss(p.name)} ${formatK(p.contractSalary)} (${seasons(yearsAfterThis(p, st))})`))} ${outL.length === 1 ? 'comes' : 'come'} off our books.`);
  return parts.join(' ');
}

/** The coach who looks at a player coming in: pitchers to the pitching coach, hitters to the hitting coach. */
function coachLook(f, ps, key, role) {
  const c = f.state.userTeam?.coachingStaff?.[key];
  if (!ps.length || !c || c.vacant || !c.name) return '';
  const lines = ps.map(p => {
    const sr = p.subRatings || {}, age = f.age(p), n = p.name, bits = [];
    if (role === 'pitch') {
      if (p.pos === 'SP' && (sr.stamina ?? 60) <= 45) bits.push(`${n} doesn't go deep into games, so the bullpen would cover more innings on those days.`);
      else if (p.pos === 'SP' && (sr.stamina ?? 60) >= 65) bits.push(`${n} can go deep into games, which saves the bullpen.`);
      else if (p.pos === 'SP') bits.push(`${n} gives us about the usual length from a starter.`);
      else bits.push((sr.stuff ?? 0) >= (sr.control ?? 0) + 8 ? `${n} gets by on stuff more than control.` : (sr.control ?? 0) >= (sr.stuff ?? 0) + 8 ? `${n} throws strikes more than misses bats.` : `${n} has the stuff and the control in balance.`);
      const a = armLine(f, p); if (a) bits.push(`${Cap(a)}.`);
    } else {
      const d = (sr.power ?? 0) - (sr.contact ?? 0);
      bits.push(d >= 8 ? `${n} is a power bat: more homers, more strikeouts.` : d <= -8 ? `${n} is a contact hitter who puts the ball in play.` : `${n} is a balanced hitter.`);
      const b = batLine(f, p); if (b) bits.push(`${Cap(b)}.`);
    }
    if (age >= 32) bits.push(`At ${age}, ${n} carries more injury risk than a younger player.`);
    if (p._ratingGap) bits.push(`${n} is ${ORIGIN_WORDS[p.origin]?.split(',')[0] || 'new to the league'}, so the ratings are an estimate.`);
    return bits.join(' ');
  });
  return `I asked ${c.name} about ${list(ps.map(p => p.name))}. ${lines.join(' ')}`;
}

W.mgr_trade = (f, r, who, arg) => {
  const st = f.state;
  const deal = arg?.key ? dealByKey(st, arg.key, f.atMs) : null;
  if (!deal) return dealGone(f, arg);
  const { leaving, arriving, delta } = fieldRead(st, deal);
  const out = [];
  const coming = (q) => (deal.offer.incomingIds || []).includes(q.id);
  for (const l of leaving) {
    const { p, next } = l;
    const nextWords = (where) => (next ? (coming(next) ? `${next.name} (${ovrOf(next)}), coming back in the deal, would take over ${where}.` : `${next.name} (${ovrOf(next)}) would take over ${where}.`) : '');
    if (l.role === 'lineup') {
      const b = batLine(f, p);
      out.push(`${p.name} (${ovrOf(p)}) plays ${SPOT_WORDS[l.slot] || l.slot} every day for us${b ? `, ${b}` : ''}. ${nextWords(`at ${SPOT_WORDS[l.slot] || l.slot}`) || `Nobody else on the roster plays ${SPOT_WORDS[l.slot] || l.slot}, so we'd need to find someone.`}`);
    } else if (l.role === 'rotation') {
      const a = armLine(f, p);
      out.push(`${p.name} (${ovrOf(p)}) is in our rotation${a ? `, with ${a}` : ''}. ${nextWords('that turn') || 'We don\'t have a starter to take the turn, so we\'d need one.'}`);
    } else if (l.role === 'closer' || l.role === 'setup') {
      out.push(`${p.name} (${ovrOf(p)}) ${l.role === 'closer' ? 'closes games for us' : 'is one of our late-inning arms'}. ${next ? `${next.name} (${ovrOf(next)}) would move up.` : 'The bullpen gets thinner behind it.'}`);
    }
  }
  // The depth we'd send, together.
  const spare = leaving.filter(l => ['pen', 'bench', 'hurt'].includes(l.role)).map(l => l.p);
  if (spare.length) out.unshift(`${list(spare.map(p => p.name))} ${spare.length === 1 ? 'is depth' : 'are depth'} for us${spare.length === 1 ? ` (${spare[0].pos === 'RP' || spare[0].pos === 'SP' ? 'a reliever we don\'t lean on' : 'off the bench'})` : ''}. We won't miss much on the field.`);
  for (const a of arriving) {
    const q = a.p, pos = posLabel(q);
    if (a.fills) continue;
    if (a.role === 'lineup')        out.push(`${q.name} (${pos}, ${ovrOf(q)}) would play ${SPOT_WORDS[a.slot] || a.slot} over ${a.over.name} (${ovrOf(a.over)}).`);
    else if (a.role === 'rotation') out.push(`${q.name} (${ovrOf(q)}) would take ${a.over.name}'s spot in the rotation.`);
    else if (a.role === 'closer')   out.push(`${q.name} (${ovrOf(q)}) would close, and ${a.over.name} would move to setup.`);
    else if (a.role === 'setup')    out.push(`${q.name} (${ovrOf(q)}) would pitch the late innings, ahead of ${a.over.name}.`);
    else if (a.role === 'hurt')     out.push(`${q.name} is hurt right now, so nothing changes on the field until ${q.name} is back.`);
    else                            out.push(`${q.name} (${pos}, ${ovrOf(q)}) would be depth for us — not a regular today.`);
  }
  const ins = (deal.offer.incomingIds || []).map(f.P).filter(Boolean);
  out.push(coachLook(f, ins.filter(p => ['SP', 'RP'].includes(p.pos)), 'pitchingCoach', 'pitch'));
  out.push(coachLook(f, ins.filter(p => !['SP', 'RP'].includes(p.pos)), 'hittingCoach', 'hit'));
  const bottom = delta >= 4 ? 'On the field today, this makes us better.' : delta >= 1 ? 'On the field today, this makes us a little better.'
    : delta <= -4 ? 'On the field today, this makes us worse.' : delta <= -1 ? 'On the field today, this makes us a little worse.' : 'On the field today, it\'s about a wash.';
  const dir = st.userTeam?.coachingStaff?.scoutingDirector;
  out.push(`${bottom} What it means past this season — value, contracts, whether there's a better deal — is ${dir && !dir.vacant && dir.name ? `${dir.name}'s` : 'the scouts\''} department.`);
  return { body: out, memo: { playerIds: [...(deal.offer.incomingIds || []), ...(deal.offer.outgoingIds || [])] }, topic: dealTopic(deal) };
};

W.sc_trade = (f, r, who, arg) => {
  const st = f.state;
  const deal = arg?.key ? dealByKey(st, arg.key, f.atMs) : null;
  if (!deal) return dealGone(f, arg);
  const a = suggestCounter(st, deal, r, f.atMs);
  const team = deal.team;
  const out = [];
  const stand = a.ourNet >= 15 ? 'As it stands, this is a good deal for us.' : a.ourNet >= 0 ? 'As it stands, it\'s fair value for us.'
    : a.ourNet >= -15 ? 'As it stands, it\'s a little short for us.' : 'As it stands, we\'d be giving up more than we get.';
  const room = a.seen >= COUNTER_MARGIN + 8 ? `My read is that ${team} have room to do more.`
    : a.seen >= COUNTER_MARGIN + 1 ? `My read is that ${team} have a little room.`
    : a.seen >= 0 ? `My read is that this is close to the most ${team} will do.` : `My read is that ${team} are already at their limit.`;
  const grade = rapportGrade(rapportOf(st, deal.teamId));
  const rel = ['Cool', 'Strained'].includes(grade) ? ` Our relationship with their front office is ${grade.toLowerCase()}, which makes them harder to move.` : '';
  out.push(`${stand} ${room}${rel}`);

  const q = st.userTeam?.coachingStaff?.scoutingDirector?.quality ?? 50;
  if (a.noRounds) {
    out.push('These talks are out of rounds: we can take it or leave it, but there\'s no counter left to make.');
  } else if (a.counter) {
    const c = a.change, P = (id) => st.players[id];
    const was = deal.offer.cashK || 0, now = was + (c.k || 0);
    const ask = c.kind === 'cash' ? (was >= 0 ? `ask them to add ${formatK(c.k)}` : now <= 0 ? `pay ${formatK(c.k)} less` : `ask them to send ${formatK(now)} instead of us paying ${formatK(-was)}`)
      : c.kind === 'drop' ? `keep ${P(c.id).name} out of it`
      : c.kind === 'add'  ? `ask them to include ${P(c.id).name} (${posLabel(P(c.id))}, ${f.age(P(c.id))}, ${ovrOf(P(c.id))}${wouldStart(P(c.id), st, 'user') ? ', who would play for us' : ', a prospect'})`
      : `ask for ${P(c.id).name} (${ovrOf(P(c.id))}) instead of ${P(c.for).name} (${ovrOf(P(c.for))})`;
    const sure = q >= 75 ? 'I\'m confident they\'ll take it.' : q >= 55 ? 'I think they\'ll take it.' : 'I think they\'ll take it, though I could be wrong about how far they\'ll go.';
    out.push(`My counter: ${ask}. That makes the deal: ${dealWords(st, a.counter, team)}. ${sure} `
      + `If I've misread them, they'll come back with a counter of their own or turn it down — and sending this replaces their offer, so we can't go back and take it as it stands.`
      + (a.lastRound ? ' This would be the last round of talks: if they say no, the talks are over.' : ''));
  } else if (a.seen >= COUNTER_MARGIN + 1) {
    out.push(`There's a little room, but nothing worth asking for that I think they'd do. ${a.ourNet >= 0 ? 'I\'d take it as it stands.' : 'I\'d pass.'}`);
  } else {
    out.push(a.ourNet >= 0 ? 'I wouldn\'t counter. Pushing risks losing it — take it as it stands, or pass.' : 'I wouldn\'t counter, and I\'d pass on it as it stands.');
  }

  // Players in the deal whose ratings are an estimate: our read on them.
  const notes = [];
  for (const id of [...(deal.offer.incomingIds || []), ...(deal.offer.outgoingIds || [])]) {
    const p = st.players[id];
    if (!p?._ratingGap) continue;
    const read = readOfUntested(p, r, 4 / scoutEye(f, p));
    const ours = (deal.offer.outgoingIds || []).includes(id);
    if (read > 0) notes.push(ours ? `Careful with ${p.name}: our read is better than the rating, and they'd be getting that.` : `${p.name} is better than the reports say, by our read.`);
    else if (read < 0) notes.push(ours ? `${p.name} is not as good as the rating, by our read — good to move.` : `${p.name} is not as good as the reports, by our read.`);
    else notes.push(`${p.name}'s ratings are an estimate, and our read is about the same.`);
  }
  if (notes.length) out.push(notes.join(' '));

  out.push(`${a.counter ? 'On payroll, with the counter: ' : 'On payroll: '}${payrollWords(f, a.counter || deal.offer)}`);
  return {
    body: out,
    memo: { playerIds: [...new Set([...(deal.offer.incomingIds || []), ...(deal.offer.outgoingIds || []), ...(a.counter?.incomingIds || [])])], dealKey: deal.key },
    topic: dealTopic(deal),
    trade: a.counter ? { teamId: deal.teamId, offer: a.counter, round: deal.round, dealKey: deal.key, expiresAtMs: deal.expiresAtMs } : null,
  };
};

/** What a club needs, in words: "need a third baseman (Diaz is there now, OVR 52)". */
function needWords(st, need, p) {
  const inc = need?.incumbentId ? st.players[need.incumbentId] : null;
  const now = inc ? ` (${inc.name} is there now, ${ovrOf(inc)})` : '';
  if (!need) return `would play ${p.name} every day`;
  if (need.kind === 'sp') return `need a starter${inc ? ` (${inc.name} is the weak end of the rotation, ${ovrOf(inc)})` : ''}`;
  if (need.kind === 'rp') return `need bullpen help${now}`;
  const noun = { C: 'catcher', '1B': 'first baseman', '2B': 'second baseman', '3B': 'third baseman', SS: 'shortstop', OF: 'outfielder', DH: 'bat at DH' }[need.slot] || 'regular';
  return `need ${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}${now}`;
}
/** What a club would give: "Ruiz (SS, 26, OVR 61) and $50K". */
function bidWords(f, o, team) {
  const pieces = (o.incomingIds || []).map(f.P).filter(Boolean).map(q => `${q.name} (${posLabel(q)}, ${f.age(q)}, ${ovrOf(q)})`);
  const c = o.cashK || 0;
  if (c > 0) pieces.push(`${formatK(c)}`);
  let t = pieces.length ? list(pieces) : 'nothing';
  if (c < 0) t += `, with us adding ${formatK(-c)}`;
  for (const [id, share] of Object.entries(o.retain || {})) {
    const q = f.P(id);
    if (q) t += `, and ${(o.incomingIds || []).includes(id) ? team : 'we'} keep paying ${Math.round(share * 100)}% of ${poss(q.name)} salary this season`;
  }
  return t;
}

W.sc_shop = (f, r, who, arg) => {
  const st = f.state;
  const p = arg?.playerId ? st.players[arg.playerId] : null;
  if (!p || p.teamId !== 'user') return { body: [`${p?.name || 'That player'} isn't ours anymore, so there's nobody to shop.`], memo: {}, topic: 'that player' };
  const shop = shopPlayer(st, p.id, r, f.atMs);
  const out = [];
  const topic = `what we could get for ${p.name}`;
  if (!shop.called) {
    out.push(shop.interested === 0 && !f.state.leagueTeams?.length ? 'There\'s nobody to call right now.'
      : `I looked around the league, and nobody needs ${p.name} right now: no club has a hole that ${p.name} fills, and nobody would play ${p.name} over who they have.`);
    return { body: out, memo: { playerId: p.id, shopId: p.id }, topic };
  }
  out.push(`${shop.interested === 1 ? 'One club' : `${Cap(num(shop.interested))} clubs`} could use ${p.name}. I called ${shop.called === shop.interested ? (shop.called === 1 ? 'it' : `all ${num(shop.called)}`) : `the ${num(shop.called)} most likely to bite`}.`);
  if (!shop.bids.length) {
    out.push(shop.key
      ? `Nobody would come close to what ${p.name} is worth to us. On a call like this, clubs offer the players they can spare, and for a regular like ${p.name} that isn't enough — it would take one of their own regulars, and that's a deal to build ourselves in the trade composer (Compose → Other GMs).`
      : `Nobody would come close to what ${p.name} is worth to us right now. I'd keep ${p.name}, or ask again when a club's need gets worse.`);
  } else {
    for (const b of shop.bids.slice(0, 3)) {
      out.push(`${b.team} ${needWords(st, b.need, p)}. They'd give ${bidWords(f, b.offer, b.team)} — ${b.ourNet >= 10 ? 'more than fair for us' : b.ourNet >= 0 ? 'fair value for us' : `short of what ${p.name} is worth to us`}.`);
    }
    const b = shop.best;
    out.push(b.ourNet >= 0
      ? `If we're moving ${p.name}, ${poss(b.team)} offer is the one I'd take. I think they'd say yes to it as it stands; their GM answers on their own clock.`
      : `Nobody would give full value. If we want to move ${p.name} anyway, ${poss(b.team)} offer comes closest, and I think they'd say yes to it as it stands.`);
  }
  if (p._ratingGap) {
    const read = readOfUntested(p, r, 4 / scoutEye(f, p));
    if (read > 0) out.push(`Careful: our read on ${p.name} is better than the rating. The clubs are paying for the rating, so whoever gets ${p.name} gets a bargain.`);
    else if (read < 0) out.push(`Our read on ${p.name} is not as good as the rating, so the clubs are paying for more than they'd get — a good time to move ${p.name}.`);
  }
  if (shop.best) out.push(`On payroll, with ${poss(shop.best.team)} offer: ${payrollWords(f, shop.best.offer)}`);
  return {
    body: out,
    memo: { playerId: p.id, shopId: p.id, playerIds: [p.id, ...shop.bids.slice(0, 3).flatMap(b => b.offer.incomingIds || [])] },
    topic,
    trade: shop.best ? { teamId: shop.best.teamId, offer: shop.best.offer, round: null, dealKey: null, expiresAtMs: f.atMs + 2 * MS_DAY,
                         yesLabel: 'Make the Offer', yesMsg: `Offer sent to ${shop.best.team}. Their answer comes on their clock.` } : null,
  };
};

// ─────────────────────────────────────────────────────────────
// r159 §122.31 WORK WITH ONE PLAYER (the GM picks the player, and the skill)
// ─────────────────────────────────────────────────────────────
// `arg`: { playerId, skill? }. Written as the reply comes back, from the
// player and the schedule as they are then (PlayerWork's reads).

const ROOM_WORDS = {
  lots: "There's plenty of room there.", some: "There's room to get better.",
  'a little': "It's already good, so there isn't a lot left to find.", 'very little': "It's about as good as it gets; I'd expect very little.",
};
const ODDS_WORDS = {
  good: (age) => `At ${age}, I like the odds.`, fair: () => 'I think we can move it.',
  modest: () => "I'd keep expectations modest.", slim: (age) => `At ${age}, I wouldn't expect much.`,
};
/** "after tonight's game" / "after the game on June 12". */
const afterGame = (f, g) => { const w = f.when(g.gameTime); return /^[A-Z]/.test(w) ? `after the game on ${w}` : `after ${w}'s game`; };
const gamesWord = (n) => (n === 0 ? 'no games' : plural(n, 'game'));
/** The days away, against the schedule: what starting now costs, and the cheapest start within the offer. */
function windowWords(f, name, w) {
  const out = [];
  const n = w.now.games.length;
  out.push(n === 0 ? `If we start today, ${name} doesn't miss a game.` : `If we start today, ${name} misses ${gamesWord(n)}.`);
  if (w.best) out.push(`If you give me the go-ahead ${afterGame(f, w.best.after)}, it's ${gamesWord(w.best.games.length)}.`);
  return out.join(' ');
}
const busyWords = (f, plan, who) => {
  const p = f.P(plan.playerId), left = Math.max(...plan.steps.filter(x => !x.done).map(x => x.atMs), f.atMs) - f.atMs;
  const days = Math.max(1, Math.round(left / 86_400_000));
  return `${who} working with ${p?.name || 'another player'} on ${plan.keys.join(' and ')} right now, with about ${plural(days, 'day')} to go.`;
};

/** The hitting or pitching coach on working with one player on one skill. */
function coachWork(f, r, who, arg) {
  const st = f.state, read = arg?.playerId ? coachRead(st, arg.playerId, arg.skill, f.atMs) : null;
  const p = arg?.playerId ? st.players[arg.playerId] : null;
  if (!read) return { body: [`${p?.name || 'That player'} isn't with the club right now, so there's nothing to work on.`], memo: {}, topic: 'that player' };
  const { skill, value } = read, name = p.name;
  const topic = `${name}'s ${skill}`;
  if (p.isInjured) return { body: [`${name} is hurt. The work waits until ${name} is back.`], memo: { playerId: p.id }, topic };
  if (read.busy) {
    const mine = read.busy.playerId === p.id;
    return { body: [mine ? `I'm already working with ${name} on ${read.busy.keys.join(' and ')}. One thing at a time.`
                         : `${busyWords(f, read.busy, "I'm")} I take one player at a time, so I can start with ${name} once that's done.`],
             memo: { playerId: p.id }, topic };
  }
  if (read.already) return { body: [`${name} already has a plan on ${skill} running. Let it land first.`], memo: { playerId: p.id }, topic };
  const out = [`${name}'s ${skill} is ${value}. ${ROOM_WORDS[read.room]} ${ODDS_WORDS[read.odds](read.age)}`];
  const spot = isArm(p) ? (p.pos === 'SP' ? 'between starts' : 'in the bullpen sessions') : 'before games';
  if (read.kind === 'tweaks') {
    out.push(`This doesn't need time away. I'll fold it into the work we already do ${spot}: extra reps and a couple of adjustments. ${name} stays available, and it costs us nothing.`);
  } else {
    out.push(`This needs focused work: ${plural(read.days, 'day')} away from the club with me at the complex, about ${formatK(read.costK)} for the extra cage and staff time.`);
    out.push(windowWords(f, name, read.window));
    out.push(`The offer stands for ${plural(PLAYER_WORK.offerDays, 'day')}, so you can pick the day.`);
  }
  out.push('Some of this takes right away and some takes weeks, and sometimes it just doesn\'t take. I\'ll tell you how it went.');
  return {
    body: out, memo: { playerId: p.id }, topic,
    decision: {
      playerId: p.id, onYes: 'coach_work', yesLabel: read.kind === 'tweaks' ? 'Start the Work' : 'Start the Work Now', noLabel: 'Not Now',
      work: { skill, owner: read.coach, days: read.days, gain: read.gain, source: read.coach === 'hittingCoach' ? 'hc_work' : 'pc_work' },
      costK: read.costK || 0, expiresInMs: PLAYER_WORK.offerDays * 86_400_000,
      yesMsg: read.kind === 'tweaks' ? `I'll start with ${name} today.` : `${name} is with me for the next ${plural(read.days, 'day')}.`,
      noMsg: 'Understood. Another time.',
    },
  };
}
W.hc_work = coachWork;
W.pc_work = coachWork;

/** r166 §122.35 the Bench Coach on teaching one hitter a position. */
const POS_NAME = { C: 'catcher', '1B': 'first', '2B': 'second', '3B': 'third', SS: 'short', OF: 'the outfield' };
const POS_AT = (x) => POS_NAME[x] || x;
W.bc_teach = function benchTeach(f, r, who, arg) {
  const st = f.state, p = arg?.playerId ? st.players[arg.playerId] : null;
  const pos = arg?.skill;
  const read = p && pos ? teachRead(st, p.id, pos) : null;
  if (!read) return { body: [`${p?.name || 'That player'} isn't one I can work with at ${pos || 'that spot'} right now.`], memo: {}, topic: 'that player' };
  const name = p.name, at = POS_AT(pos), topic = `${name} at ${pos}`;
  if (read.busy) {
    const b = st.players[read.busy.playerId];
    return { body: [read.busy.playerId === p.id ? `I'm already working with ${name} at ${read.busy.pos}. One position at a time.`
                                                 : `I'm working with ${b?.name || 'someone'} at ${read.busy.pos} right now, and I take one player at a time. I can start with ${name} once that's done.`],
             memo: { playerId: p.id }, topic };
  }
  if (read.maxed) return { body: [`${name} has had all the reps at ${at} practice can give. From here it's games: ${read.starts ? `${read.starts} of ten starts so far` : 'ten starts there makes it official'}.`], memo: { playerId: p.id }, topic };
  const hard = { easy: `${at === 'first' || at === 'the outfield' ? `Moving to ${at}` : `Sliding over to ${at}`} is the easy direction for ${name}: the hands and the arm are already there.`,
                 hard: `${at[0].toUpperCase() + at.slice(1)} is a step up for ${name}: more range, a quicker first step, a stronger arm. It takes longer and it may not all take.`,
                 C: `Catching is its own job: the crouch, the blocks, the throws to second. Most players never get comfortable back there.` }[read.difficulty];
  const odds = { good: 'I like the odds.', fair: 'The odds are fair.', modest: 'The odds are modest.', slim: 'Honestly, the odds are slim.' }[read.oddsWord];
  const out = [hard, `I'd want ${plural(read.days, 'day')} of extra reps at ${at}, folded into the work we already do before games: ${name} stays available and it costs us nothing. ${odds}`];
  out.push(read.fam > 0 ? `${name} has some reps there already, so we're not starting from nothing.` : `${name} has never played ${at}, so we're starting from scratch.`);
  out.push(`Practice makes ${name} steadier there. Games make it official: ten starts at ${pos} this season.`);
  return {
    body: out, memo: { playerId: p.id }, topic,
    decision: {
      playerId: p.id, onYes: 'teach_position', yesLabel: 'Start Teaching', noLabel: 'Not Now',
      teach: { pos, odds: read.odds }, expiresInMs: 3 * 86_400_000,
      yesMsg: `I'll start with ${name} at ${at} tomorrow.`, noMsg: 'Understood. Another time.',
    },
  };
};

/** Scouting/Dev: an off-site development program for one player. */
W.sc_program = (f, r, who, arg) => {
  const st = f.state, read = arg?.playerId ? programRead(st, arg.playerId, arg.skill, f.atMs) : null;
  const p = arg?.playerId ? st.players[arg.playerId] : null;
  if (!read) return { body: [`${p?.name || 'That player'} isn't with the club right now.`], memo: {}, topic: 'the program' };
  const { skill, value } = read, name = p.name, topic = `a program for ${name}`;
  if (p.isInjured) return { body: [`${name} is hurt. A program can wait until ${name} is healthy.`], memo: { playerId: p.id }, topic };
  if (read.busy) return { body: [`${busyWords(f, read.busy, 'The program is')} It takes one player at a time, so ${name} would go next.`], memo: { playerId: p.id }, topic };
  if (read.already) return { body: [`${name} already has a plan on ${skill} running. Let it land first.`], memo: { playerId: p.id }, topic };
  const out = [
    `We can send ${name} to our development complex for ${plural(read.days, 'day')} of work on ${skill}, which is at ${value} now. It costs ${formatK(read.costK)}: the instructors, the facility and the travel.`,
    `${ROOM_WORDS[read.room]} ${ODDS_WORDS[read.odds](read.age)} This is the most we can do for a player in-season. It's also the most expensive, and some players come back with less than we hoped.`,
    windowWords(f, name, read.window),
  ];
  return {
    body: out, memo: { playerId: p.id }, topic,
    decision: {
      playerId: p.id, onYes: 'dev_program', yesLabel: 'Send Them Now', noLabel: 'Not Now',
      work: { skill, owner: 'program', days: read.days, gain: read.gain, source: 'sc_program' },
      costK: read.costK, expiresInMs: PLAYER_WORK.offerDays * 86_400_000,
      yesMsg: `${name} leaves for the complex today, back in ${plural(read.days, 'day')}.`, noMsg: 'Understood. The spot stays open.',
    },
  };
};

/** The manager: a day off for one hitter. */
W.mgr_rest = (f, r, who, arg) => {
  const st = f.state, read = arg?.playerId ? restRead(st, arg.playerId, f.atMs) : null;
  const p = arg?.playerId ? st.players[arg.playerId] : null;
  if (!read) return { body: [`${p?.name || 'That player'} isn't one of our hitters right now.`], memo: {}, topic: 'a day off' };
  const name = p.name, topic = `a day off for ${name}`;
  if (read.away || p.isInjured) return { body: [`${name} is already out, so ${name} is resting either way.`], memo: { playerId: p.id }, topic };
  if (!read.inLineup) return { body: [`${name} isn't in the lineup right now, so ${name} is getting the rest already.`], memo: { playerId: p.id }, topic };
  const n = read.straight, starts = n ? `${plural(n, 'straight start')}` : 'no recent starts';
  const out = [read.tired
    ? `${name} needs it: ${starts}, and the bat has slowed down. A day off clears it.`
    : read.level === 'tiring'
      ? `${name} is starting to wear down: ${starts}. A day off soon keeps it from getting to the bat.`
      : `${name} is holding up fine: ${starts}. A day off now won't hurt, though.`];
  if (read.next) out.push(`If you want it, ${name} sits ${f.onWhen(read.next.gameTime)} and the bench covers.`);
  return {
    body: out, memo: { playerId: p.id }, topic,
    decision: { playerId: p.id, onYes: 'day_off', yesLabel: `Give ${name} the Day Off`, noLabel: `Keep ${name} In`, expiresInMs: 86_400_000,
                yesMsg: `${name} sits the next game and comes back fresh.`, noMsg: `${name} stays in the lineup.` },
  };
};

/** The team physician on one player. */
W.doc_health = (f, r, who, arg) => {
  const st = f.state, read = arg?.playerId ? healthRead(st, arg.playerId, f.atMs) : null;
  const p = arg?.playerId ? st.players[arg.playerId] : null;
  if (!read) return { body: [`${p?.name || 'That player'} isn't one of ours anymore.`], memo: {}, topic: 'that player' };
  const name = p.name, out = [];
  if (read.now) {
    const back = read.now.returnAt ? ` I expect ${name} back ${f.onWhen(read.now.returnAt)}.` : read.now.status === 'evaluating' ? ' We\'re still evaluating it.' : '';
    out.push(`${name} is hurt: ${String(read.now.label || 'an injury').toLowerCase()}.${back}`);
  } else if (read.playingHurt) {
    out.push(`${name} is playing through something. It's costing a little ${read.playingHurt.subRating} for the next ${plural(read.playingHurt.gamesLeft, 'game')}.`);
  } else out.push(`${name} is healthy. Nothing is bothering ${name} right now.`);
  if (read.log.length) {
    const last = read.log[read.log.length - 1];
    out.push(`On file: ${plural(read.log.length, 'injury', 'injuries')} with us, the last a ${last.severity} ${String(last.label).toLowerCase()} ${f.onWhen(last.atMs)}.${read.recent.length >= 2 ? ' That many in a short span tells me to keep the workload in check.' : ''}`);
  } else out.push(`There's nothing in ${name}'s file with us.`);
  if (read.wear?.pitcher) {
    out.push(read.wear.tired ? `The arm is ${read.wear.worn ? 'worn down' : 'tired'}: the workload has piled up. Tired arms are the ones that get hurt. Rest would help.`
             : read.wear.level === 'tiring' ? 'The workload on the arm is building. A little extra rest soon would be smart.'
             : 'The arm is holding up fine.');
  } else if (read.wear) {
    const n = read.wear.straight, starts = n ? plural(n, 'straight start') : 'no recent starts';
    out.push(read.wear.tired ? `${name} is ${read.wear.worn ? 'worn down' : 'tired'}: ${starts}. That's when hitters get hurt. A day off would help.`
             : read.wear.level === 'tiring' ? `The workload is starting to show: ${starts}. A day off soon would be smart.`
             : `The workload is fine: ${starts}.`);
  }
  if (read.age >= 35) out.push(`At ${read.age}, the body takes longer to bounce back, and injuries come a little more often.`);
  else if (read.age >= 32) out.push(`At ${read.age}, the risk starts to creep up, but nothing unusual yet.`);
  if (read.away?.reason === 'training') out.push(`${name} is away for development work right now.`);
  return { body: out, memo: { playerId: p.id }, topic: `${name}'s health` };
};

/** Topics with a writer. */
export const COMPOSE_TOPICS = Object.freeze(Object.keys(W));

export function writeComposeReply(state, { topicId, channelId, atMs, subject = null, arg = null }) {
  const f = composeFacts(state, atMs);
  SPRING = f.season === 'spring';
  const who = _who(state, channelId);
  const r = _rng(`${topicId}|${atMs}|${state.weatherSeed || ''}`);
  const write = W[topicId];
  if (!write) return null;
  let res;
  try { res = write(f, r, who, arg); }
  catch (err) { console.warn('ComposeReplies:', topicId, err?.message); return null; }
  const paras = (res.body || []).filter(Boolean);
  if (!paras.length) return null;
  const open = _open(who.rel, r, res.topic || TOPIC_LABELS[topicId] || 'that');
  const body = [open, ...paras, _sign(who)].join('\n\n');
  return { sender: who.sender, subject: subject || `Re: ${Cap(TOPIC_LABELS[topicId] || 'your message')}`, body,
           preview: paras[0].split('\n')[0], memo: res.memo || {}, decision: res.decision || null, trade: res.trade || null,
           named: namedPlayers(state, paras.join('\n'), [...(res.memo?.playerIds || []), res.memo?.playerId, res.decision?.playerId]) };
}

/**
 * r146 the players a reply names: the ones its report is about, and any other
 * player whose name appears in it and is nobody else's (a name two players
 * share, or a staff member's, stays unlinked). The app links each to the
 * player's card; the harness checks each is really in the league.
 */
/**
 * Surnames that are also words the app's text uses capitalized ("Hall of Fame", "Park District",
 * "Banks"): linked only when the message is about that player, never from the text alone.
 */
export const NAME_SCAN_SKIP = Object.freeze(new Set(['Hall', 'Park', 'Banks', 'Booker', 'Brown', 'Porter', 'Turner', 'Walker', 'Carter']));

export function namedPlayers(state, text, known = []) {
  const out = new Set(known.filter(id => id && state.players?.[id]));
  const staff = new Set(Object.values(state.userTeam?.coachingStaff || {}).map(x => x?.name).filter(Boolean));
  const byName = new Map();
  for (const p of Object.values(state.players || {})) {
    if (!p?.name || staff.has(p.name) || NAME_SCAN_SKIP.has(p.name)) continue;
    byName.set(p.name, byName.has(p.name) ? null : p.id);
  }
  for (const id of out) byName.delete(state.players[id].name);
  for (const [name, id] of byName) {
    if (!id || !text.includes(name)) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\w'-])${esc}(?![\\w-])`).test(text)) out.add(id);
  }
  return [...out];
}
