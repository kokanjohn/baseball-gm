/**
 * engine/Memory.js
 * r298 §122.185 Memory (the design: §122.184): the club's history with each outside party. What was asked, the
 * answer, what came of it, the moments shared. Never shown as a number: felt through the messages' tone, what a
 * party asks and what it offers.
 *
 *   The cast: each save's own names for the parties in data/parties.js (the save's dice, the club's city), and each
 *     club's GM (`club:<teamId>`, beside the trade rapport). Drawn, not stored: the same save, the same names.
 *   The record: the messages that involve a party, from the history (notes kept three seasons; a big moment kept
 *     always, `_keep`). A message names its party with `party` (or is about a club's GM: `_gmTeamId`, a trade offer's
 *     `_proposingTeamId`); Entry stamps it (`partyTags`) with how each answer weighs (`partyAsk` / `partyW`), whether
 *     it's a big moment (`partyBig`: true, or the answer that makes it one) and the moment's words (`partyMoment`).
 *   The standing: the weighed answers, slights fading over about two seasons and good turns over about three; a big
 *     moment never fades (the user's choice). Warm, neutral, cool or sour.
 *   The staff's answers in Important only aren't the GM's: they don't count (no penalty, §122.180).
 *
 *   castOf(state)                       { id: { id, kind, name } }
 *   partyName(state, party)             the party's name now ('Ironside Brewing', 'the Hartford Mariners')
 *   partyTags(c)                        the fields Entry stamps on a message that involves a party
 *   recordOf(state, party, atMs)        [{ atMs, answer, w, big, moment }] oldest first
 *   standingOf(state, party, atMs)      { score, standing, moment }   (moment: the words of the latest that fits it)
 *   memoryOf(state, party, atMs)        { standing, recall, partyKind }   (what `when` reads, MessageParts)
 *
 * PURE: no StateManager.
 */
import { PARTIES, PARTY_ASK, MEMORY } from '../data/parties.js';
import { withHistory } from './MessageHistory.js';
import { dice, diceSeed } from './Dice.js';

const DAY = 86_400_000;
export const PARTY_KINDS = Object.freeze(Object.fromEntries(PARTIES.map(p => [p.id, p.kind])));
export const STANDINGS = Object.freeze(['warm', 'neutral', 'cool', 'sour']);
const isClub = (party) => typeof party === 'string' && party.startsWith('club:');

let _cast = null, _castKey = null;
/** Each save's names for the parties. */
export function castOf(state) {
  const city = state?.userTeam?.city || 'the city';
  const key = `${diceSeed(state)}|${city}`;
  if (_castKey === key) return _cast;
  const out = {};
  for (const p of PARTIES) {
    const rand = dice(diceSeed(state), 'cast', p.id);
    const name = p.names[Math.floor(rand() * p.names.length)].replace(/\{city\}/g, city);
    out[p.id] = Object.freeze({ id: p.id, kind: p.kind, name });
  }
  _cast = Object.freeze(out); _castKey = key;
  return _cast;
}

/** The party's name now. */
export function partyName(state, party) {
  if (isClub(party)) {
    const t = (state?.leagueTeams || []).find(x => x.id === party.slice(5));
    return t ? `the ${t.name}` : 'another club';
  }
  return castOf(state)[party]?.name || null;
}

/** The kind of party ('sponsor', 'community', 'media', 'city', 'club'). */
export const kindOf = (party) => (isClub(party) ? 'club' : PARTY_KINDS[party] || null);

/**
 * The fields Entry stamps on a message that involves a party (nothing for one that doesn't):
 * { _party, _partyW, _partyBig?, _partyMoment? }.
 */
export function partyTags(c) {
  if (!c || c._party) return null;
  const raw = c._raw || {};
  const party = raw.party || (c._gmTeamId ? `club:${c._gmTeamId}` : null) || (c._proposingTeamId ? `club:${c._proposingTeamId}` : null);
  if (!party) return null;
  const ask = raw.partyAsk || (c._proposingTeamId ? 'offer' : 'request');
  const out = { _party: party, _partyW: { ...(raw.partyW || PARTY_ASK[ask] || PARTY_ASK.request) } };
  if (raw.partyBig != null) out._partyBig = raw.partyBig;
  if (raw.partyMoment) out._partyMoment = { ...raw.partyMoment };
  return out;
}

/** How a message was answered: 'yes', 'no', 'ignored', or null (unanswered, or the staff's). */
function answerOf(c) {
  if (!c?.resolved || c._staffHandled || c._staffHandle) return null;   // (the staff's answer isn't the GM's, §122.180)
  if (c.choice === 'auto' || c.choice === 'skip' || c.choice === 'expired') return 'ignored';
  return c.choice === 'no' ? 'no' : 'yes';
}

/** Is the message a big moment, given its answer? */
export const isBig = (c, answer = answerOf(c)) => c?._partyBig === true || (!!answer && c?._partyBig === answer);

/** The record with a party: [{ atMs, answer, w, big, moment }], oldest first. */
export function recordOf(state, party, atMs = Infinity) {
  const out = [];
  for (const c of withHistory(state)) {
    if (c?._party !== party || !Number.isFinite(c.arrivedAtMs) || c.arrivedAtMs > atMs) continue;
    const answer = answerOf(c);
    if (!answer) continue;
    const w = Number(c._partyW?.[answer]) || 0;
    const moment = c._partyMoment?.[answer] || c._partyMoment?.any || null;
    out.push({ atMs: c.arrivedAtMs, answer, w, big: isBig(c, answer), moment });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** The standing with a party: { score, standing, moment }. */
export function standingOf(state, party, atMs) {
  let score = 0, moment = null;
  const rec = recordOf(state, party, atMs);
  for (const e of rec) {
    const age = Math.max(0, (atMs - e.atMs) / DAY);
    const fade = e.big ? 1 : Math.max(0, 1 - age / (e.w < 0 ? MEMORY.slightDays : MEMORY.goodDays));
    score += e.w * fade;
  }
  const standing = score >= MEMORY.warm ? 'warm' : score <= MEMORY.sour ? 'sour' : score <= MEMORY.cool ? 'cool' : 'neutral';
  // the latest moment that fits the standing: a good one for a warm party, a slight for a cool one
  const sign = standing === 'warm' ? 1 : standing === 'cool' || standing === 'sour' ? -1 : 0;
  for (let i = rec.length - 1; i >= 0 && sign; i--) {
    const e = rec[i];
    const live = e.big || (atMs - e.atMs) / DAY < (e.w < 0 ? MEMORY.slightDays : MEMORY.goodDays);
    if (e.moment && live && Math.sign(e.w) === sign) { moment = e.moment; break; }
  }
  return { score: Math.round(score * 100) / 100, standing, moment };
}

/** What a message's `when` reads of a party. */
export function memoryOf(state, party, atMs) {
  const s = standingOf(state, party, atMs);
  return { standing: s.standing, recall: !!s.moment, partyKind: kindOf(party), moment: s.moment };
}

/** The parties with a record, for the memory messages: [party]. */
export function partiesWithRecord(state) {
  const seen = new Set();
  for (const c of withHistory(state)) if (c?._party) seen.add(c._party);
  return [...seen];
}
