/**
 * engine/WeatherMessages.js
 * §122.51 (phase 3) The grounds crew's messages about a home game's weather:
 * which moments of the game's weather story (GameWeatherStory) become a
 * message, and the words. Pure: the story's events and a few facts about the
 * game in, messages out. The clock (GameEngine) delivers them at their moments.
 *
 * What gets told: any change to the start is always told (the GM's rule), and
 * so is every delay, restart, call and crew problem. The rest (the tarp on and
 * off with the start unaffected, a change in the chance alone, a heads-up, a
 * late watch, "we're under way") is told most of the time, not always, so a
 * game day carries a believable number of messages and never a flood: each
 * moment once, at most two cover-ups told before the game.
 *
 * Words: plain and short, the crew's own voice; times are clock times (an
 * estimate is a time — the GM's call, §122.51); last names only; no explainer.
 */

import { hash01 } from './WeatherNoise.js';

const MUST = new Set(['outlook', 'start_delayed', 'start_estimate', 'start_on_time', 'start_doubt', 'crew_trouble',
                      'delay', 'resume_estimate', 'resumed', 'called', 'clearing',
                      'gap', 'calloff_ask']);   // (phase 3b: moments that are decisions at home)
const OPTIONAL_KEEP = 0.7;   // an optional moment is told this often
const URGENT_BEFORE_MIN = 120;   // from this long before first pitch, a message gets past quiet hours

const _t = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const _what = (wx) => (wx === 'storms' ? 'storms' : wx === 'snow' ? 'snow' : wx === 'mix' ? 'sleet and snow' : 'rain');
const _cap = (s) => s[0].toUpperCase() + s.slice(1);
const _mins = (n) => (n >= 60 ? `${Math.floor(n / 60)} hr${n % 60 ? ` ${n % 60} min` : ''}` : `${n} min`);
const _ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const _pick = (seed, id, opts) => opts[Math.floor(hash01(seed, 7501, _h(id)) * opts.length)];
function _h(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

/**
 * pickTold(events, seed) — the story's moments that become messages (home game).
 * The postponement is the schedule's own message (GameEngine._postponeGame), not the story's.
 */
export function pickTold(events, seed) {
  let tarps = 0;
  return events.filter(e => {
    if (e.kind === 'postponed') return false;
    if (MUST.has(e.kind)) return true;
    if ((e.kind === 'tarp_on' || e.kind === 'tarp_off') && !e.inGame) {
      if (e.estStart != null) return true;   // (the start rides on it)
      if (e.kind === 'tarp_on' && ++tarps > 2) return false;
    }
    if (e.kind === 'tarp_on' && e.inGame) return false;   // (the delay message says it)
    if (e.kind === 'tarp_off' && e.inGame && e.estResume != null) return true;
    if (e.kind === 'update' && e.proj !== e.prevProj) return true;
    return hash01(seed, 7502, _h(e.id)) < OPTIONAL_KEEP;
  });
}

/**
 * crewMessage(e, game) → { subject, preview, body, urgent } — the words for one moment.
 * game: { gameTime, opp (club name), seed, delays? (the sim's, for the inning: [{ startT, inning, half }]),
 *         ruling? (the sim's: { outcome: 'final'|'suspended', innings }) }
 */
export function crewMessage(e, game) {
  const g = game, est = e.estStart ?? e.estResume;
  const at = (ms) => _t(ms);
  const urgent = e.at >= g.gameTime - URGENT_BEFORE_MIN * 60_000;
  const vs = g.opp ? ` against the ${g.opp}` : '';
  const pick = (opts) => _pick(g.seed, e.id, opts);
  const inningOf = () => {
    const d = (g.delays || []).find(x => x.startT === e.at);
    return d?.inning ? `${d.half === 'TOP' ? 'the top of' : d.half === 'BOT' ? 'the bottom of' : ''} the ${_ord(d.inning)}`.replace(/^ /, '') : null;
  };
  let subject, body;
  switch (e.kind) {
    case 'outlook': {
      const w = _what(e.wx);
      const start = e.proj === 'doubt' ? "As it looks now, we may not get this one in."
        : e.proj === 'delayed' && e.estStart ? `As it looks now, first pitch could slip to about ${at(e.estStart)}.`
        : 'As it looks now, we start on time.';
      if (e.field) {
        subject = e.field === 'snow' ? 'Snow on the field' : 'A soaked field';
        body = `${e.field === 'snow' ? 'Snow is covering the field' : 'The field took a lot of rain'} ahead of today's game${vs}. ${start}`;
        break;
      }
      subject = pick([`${_cap(w)} in the forecast today`, `Keeping an eye on the ${w}`, `${_cap(w)} on the radar`]);
      body = `The radar has ${w} reaching us around ${at(e.rainAt)}`
           + `${e.chance != null ? `, with a ${e.chance}% chance during the game${vs}` : ''}. ${start}`;
      break;
    }
    case 'update': {
      const worse = (e.proj === 'doubt') || (e.proj === 'delayed' && e.prevProj === 'ontime') || (e.chance ?? 0) > (e.prevChance ?? 0);
      subject = worse ? 'The forecast is getting worse' : 'The forecast is improving';
      const start = e.proj === 'doubt' ? 'Right now I don\'t see a window to get this one in.'
        : e.proj === 'delayed' && e.estStart ? `It could push first pitch to about ${at(e.estStart)}.`
        : 'We should start on time.';
      body = `${e.chance != null ? `Now a ${e.chance}% chance of rain during the game (was ${e.prevChance}%). ` : ''}${e.rainAt ? `The radar has it here around ${at(e.rainAt)}. ` : ''}${start}`;
      break;
    }
    case 'clearing':
      subject = pick(['The rain is missing us', 'Looks dry for the game']);
      body = `The rain on the radar is sliding past.${e.chance != null ? ` Down to a ${e.chance}% chance during the game.` : ''} We should be fine.`;
      break;
    case 'tarp_on':
      subject = 'The tarp is on';
      body = `${e.reason === 'lightning' ? 'Lightning in the area' : 'Rain is here'}, so the tarp is on the field.`
           + `${e.estStart ? ` We're looking at about ${at(e.estStart)} for first pitch.` : ''}`;
      break;
    case 'tarp_off':
      if (e.inGame) { subject = 'The tarp is coming off'; body = `The rain has moved through. We'll have the field ready${est ? ` and play going by about ${at(est)}` : ' soon'}.`; break; }
      subject = 'The tarp is coming off';
      body = e.estStart ? `The rain has moved through. The field will be ready for a first pitch around ${at(e.estStart)}.`
                        : 'The rain has moved through. The field will be ready for first pitch.';
      break;
    case 'crew_trouble':
      subject = 'The field is taking longer';
      body = `${pick(['There was more water under the tarp than we figured.', 'We\'re having trouble with the tarp.', 'The infield needs more work than we planned.'])}`
           + ` Another ${e.mins} minutes or so.${est ? ` ${e.inGame ? 'Play' : 'First pitch'} now about ${at(est)}.` : ''}`;
      break;
    case 'start_delayed':
      subject = `First pitch delayed: about ${at(e.estStart)}`;
      body = `We won't start on time${vs}. Estimated first pitch: ${at(e.estStart)}.`;
      break;
    case 'start_estimate': {
      const later = e.estStart > e.prevEst;
      subject = `New estimate: first pitch ${at(e.estStart)}`;
      body = later ? `It's taking longer than we figured. Now looking at ${at(e.estStart)} (was ${at(e.prevEst)}).`
                   : `Better than we figured. Now looking at ${at(e.estStart)} (was ${at(e.prevEst)}).`;
      break;
    }
    case 'start_on_time':
      subject = 'Back on schedule';
      body = `We'll start on time after all${vs}.`;
      break;
    case 'start_doubt':
      subject = 'This one is in doubt';
      body = 'The radar doesn\'t show a window. We may not get this game in.';
      break;
    case 'first_pitch':
      subject = 'We\'re under way';
      body = `First pitch went at ${at(e.at)}, ${_mins(e.lateMin)} late.`;
      break;
    case 'heads_up':
      subject = pick(['Rain on the way', 'Weather coming in']);
      body = `${pick(['Rain is', 'The weather is'])} about ${Math.max(5, Math.round((e.eta - e.at) / 60_000))} minutes out. Expect the tarp.`;
      break;
    case 'delay': {
      const inn = inningOf();
      subject = e.reason === 'lightning' ? 'Lightning delay' : e.reason === 'snow' ? 'Snow delay' : 'Rain delay';
      body = `Play is stopped${inn ? ` in ${inn}` : ''} and the tarp is on.${e.estResume ? ` We're estimating play resumes around ${at(e.estResume)}.` : ' No window on the radar yet.'}`;
      break;
    }
    case 'resume_estimate': {
      const later = e.prevEst == null || e.estResume > e.prevEst;
      subject = `Delay update: about ${at(e.estResume)}`;
      body = later ? `It's lasting longer than we figured. Play now about ${at(e.estResume)}${e.prevEst ? ` (was ${at(e.prevEst)})` : ''}.`
                   : `Better than we figured. Play now about ${at(e.estResume)} (was ${at(e.prevEst)}).`;
      break;
    }
    case 'resumed':
      subject = 'Play resumes';
      body = `Back on the field after ${_mins(e.mins)}.`;
      break;
    case 'called': {
      const r = g.ruling;
      subject = r?.outcome === 'suspended' ? 'The game is suspended' : 'The game has been called';
      body = r?.outcome === 'suspended' ? 'There\'s no window to finish tonight. It will be completed later.'
           : `There's no window to finish.${r?.innings ? ` It goes in the books after ${r.innings} innings.` : ''}`;
      break;
    }
    case 'late_watch':
      subject = 'More rain late';
      body = `More rain is on the radar for around ${at(e.eta)}. If this one runs long, we may see the tarp again.`;
      break;
    default:
      return null;
  }
  return { subject, preview: body.length > 140 ? `${body.slice(0, 137)}…` : body, body, urgent };
}

/** The postponement, in the crew's words: why, and where the game went. */
export function postponedMessage({ reason, calledBy, makeup, spring, cancelled }) {
  const why = reason === 'lightning' ? 'storms' : reason === 'snow' ? 'snow' : reason === 'wet field' ? 'a soaked field' : 'rain';
  const how = calledBy === 'forecast' ? `With ${why} coming, today's game is off.`
    : calledBy === 'field' ? `The field can't be played on: ${why}.` : `We couldn't get the game in: ${why}.`;
  const then = spring || cancelled ? 'It won\'t be made up.' : makeup ? `It's made up ${makeup}.` : '';
  return { subject: 'Today\'s game is postponed', body: `${how} ${then}`.trim(), urgent: true };
}

/**
 * §122.51 (phase 3b) decisionWords(kind, e, game) — the words for a decision that stands in for a moment:
 *   bp      — the morning look, with rain due during batting practice (e: the outlook)
 *   calloff — the forecast shows no game (e: { chance })
 *   comps   — the crowd during a long wait: free food and drink, the stands open, or closed (e: { waitMin, inGame }, game.costK)
 *   sth     — a season-ticket holder wants a credit after the delay (game.costK)
 *   raincheck — a game called official before nine: rain checks for the crowd? (e: { innings }, game.costK)
 *   booth   — the TV booth wants a player during a delay (e: { player }, game.revenueK)
 *   antics  — the manager asks the GM's blessing: players entertaining the crowd (game.manager)
 *   hands   — the field running long (e: the crew_trouble moment, game.costK)
 *   rain    — a held start that could go ahead in light rain (e: the gap moment)
 * → { subject, body, yesLabel, noLabel, yesMsg, noMsg, sender? }
 */
export function decisionWords(kind, e, game) {
  const g = game, at = _t;
  const k = (n) => `$${n}K`;
  switch (kind) {
    case 'bp': {
      const o = crewMessage(e, game);
      return { subject: 'Rain before the game: batting practice?',
        body: `${o.body} The rain is due during batting practice. In the cages, I cover the field at the first drop. On the field, it stays open until batting practice is done, and any rain on it is more work before first pitch.`,
        yesLabel: 'Batting Practice in the Cages', noLabel: 'Batting Practice on the Field',
        yesMsg: 'Batting practice moves to the cages.', noMsg: 'Batting practice stays on the field.' };
    }
    case 'calloff':
      return { subject: 'Call off today\'s game?',
        body: `The radar shows no window for this one${e.chance != null ? `: a ${e.chance}% chance of rain during the game` : ''}. Call it now and it's made up later. Wait it out and the fans come in; if we still lose it, that's crew overtime and an unhappy crowd.`,
        yesLabel: 'Call It Off', noLabel: 'Wait It Out',
        yesMsg: 'The game is called off.', noMsg: 'We wait it out.' };
    case 'comps': {
      // §122.56 one card for the crowd: free food and drink, the stands open and selling, or closed.
      const what = e.inGame ? 'play resumes' : 'first pitch';
      return { sender: 'Stadium Ops', subject: 'The crowd during the delay',
        body: `We're looking at about ${e.waitMin} minutes before ${what}. We can put out free food and drink (about ${k(g.costK)}), keep the stands open and selling (staff overtime, but the sales cover it), or close the stands until ${what}.`,
        choices: [{ key: 'free', label: `Free Food and Drink (${k(g.costK)})` }, { key: 'sell', label: 'Keep the Stands Open' }],
        yesLabel: `Free Food and Drink (${k(g.costK)})`, noLabel: 'Close the Stands',
        yesMsg: 'Done.', noMsg: 'The stands close until play starts.' };
    }
    case 'sth':
      return { sender: 'Guest Services', subject: 'A season-ticket holder wants a credit',
        body: `A season-ticket holder is at guest services after sitting through the delay${g.opp ? ` against the ${g.opp}` : ''} and wants a credit toward a future game. A credit is about ${k(g.costK)}. If we say no, they won't keep quiet about it.`,
        yesLabel: `Give the Credit (${k(g.costK)})`, noLabel: 'Decline',
        yesMsg: 'The credit is on their account.', noMsg: 'Guest Services will let them know.' };
    case 'raincheck':
      return { sender: 'Ticket Office', subject: 'Rain checks for today\'s crowd?',
        body: `The game went in the books after ${e.innings} innings. We don't owe rain checks for an official game, but the crowd only saw part of it. Honoring today's tickets at a future game would cost about ${k(g.costK)}.`,
        yesLabel: `Honor the Tickets (${k(g.costK)})`, noLabel: 'No Rain Checks',
        yesMsg: 'Today\'s tickets are good for a future game.', noMsg: 'No rain checks.' };
    case 'booth':
      return { sender: 'Media Relations', subject: 'The TV booth wants a guest',
        body: `The broadcast has a long delay to fill and wants ${e.player} in the booth for a few minutes. The sponsor pays ${k(g.revenueK)} for the segment. Players don't always love it in the middle of a game.`,
        yesLabel: `Send ${e.player} Up`, noLabel: 'Not Today',
        yesMsg: `${e.player} is headed up.`, noMsg: 'The booth will manage.' };
    case 'antics':
      return { sender: g.manager || 'The Manager', subject: 'The players want to entertain the crowd',
        body: 'A few of the players want to go out during the delay: a slide on the tarp, signing along the rail. The crowd would love it. There\'s a small risk somebody tweaks something. Your call.',
        yesLabel: 'Let Them Go Out', noLabel: 'Keep Them Inside',
        yesMsg: 'They\'re heading out.', noMsg: 'They stay inside.' };
    case 'hands': {
      const o = crewMessage(e, game);
      return { subject: 'The field is taking longer: extra hands?',
        body: `${o.body} For ${k(g.costK)} I can bring in extra hands and cut the extra time about in half.`,
        yesLabel: `Extra Hands (${k(g.costK)})`, noLabel: "We'll Wait",
        yesMsg: 'Extra hands are on the way.', noMsg: "We'll wait it out." };
    }
    case 'rain':
      return { subject: 'Start in the light rain?',
        body: `It's down to a light rain, but it's hanging around. We can pull the tarp and go at about ${at(e.gapStart)} and play through it, or wait for it to stop: about ${at(e.estStart)}. Playing in it means a slick ball and a soft field, and if it picks up, we stop again.`,
        yesLabel: `Start at ${at(e.gapStart)}`, noLabel: 'Wait for It to Stop',
        yesMsg: 'We go in the rain.', noMsg: 'We wait for it to stop.' };
    default:
      return null;
  }
}
