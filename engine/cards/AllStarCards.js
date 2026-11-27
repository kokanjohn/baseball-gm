/**
 * engine/cards/AllStarCards.js
 * CardEngine, all-star game cards (§75).
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { tradeWindow, busyWithUs, wouldStart } from '../TradeEngine.js';
import { formatK } from '../CardTokens.js';
import * as LeagueTrades from '../LeagueTrades.js';
import { clockNow } from '../Clock.js';
import { eventRand } from '../Dice.js';
import { _deliverAt, _rosterCard, _withdraw } from './Delivery.js';
import { _who } from './OffseasonCards.js';
import { _deliverNotice, _managerName, _ourNews } from './RosterCards.js';
import { _offerCanGo, _pick, deliverTradeOffer } from './TradeOffers.js';

// ─────────────────────────────────────────────────────────────
// ALL-STAR GAME CARDS (§75)
// ─────────────────────────────────────────────────────────────

const _cityOf = (state, teamId) => (teamId === 'user'
  ? (state.userTeam.city || state.userTeam.name)
  : (state.leagueTeams.find(t => t.id === teamId)?.name || '').split(' ').slice(0, -1).join(' ') || 'their ballpark');

export const _list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);


/**
 * deliverAllStarHostCard({ hostId, status }, atMs)
 * The league names the host. Ours: the Commissioner's Office, with what it
 * brings (§17.3). Someone else's: the League Office's note — and, in words
 * rather than a number (§17.1), where our ballpark stood.
 */
export function deliverAllStarHostCard({ hostId, status }, atMs) {
  const state = StateManager.get();
  const season = state.allStar?.season;
  const key = `allstar:host:${state.seasonNum}`;
  if (hostId === 'user') {
    const n = state.allStar.hostedCount || 1;
    return _deliverNotice(key, {
      cardId: 'as_host', tag: 'OWNERSHIP', type: 'good', avatar: '🌟', _prominent: true,
      sender: "Commissioner's Office",
      subject: n === 1 ? `The All-Star Game is coming to ${_cityOf(state, 'user')}` : `The All-Star Game is coming back to ${_cityOf(state, 'user')}`,
      preview: `We're pleased to award this season's All-Star Game to ${_cityOf(state, 'user')}…`,
      body: `We're pleased to award this season's All-Star Game to ${_cityOf(state, 'user')}. `
          + (n === 1 ? "We've watched what your organization has built in the ballpark and in the stands, and we want the game there. "
                     : 'It is a rare thing for a club to host twice; your ballpark and your crowds made the decision easy. ')
          + `The host's share — ${formatK(season?.hostBonusK || 0)} — has been paid to your club. `
          + `Every club's GM will be in your building during the break. All-Star week is yours to run.`,
      yesLabel: "Let's get to work", expiresAtMs: atMs + 3 * 24 * 3600_000,
    }, atMs);
  }
  const city = _cityOf(state, hostId);
  const why = [];
  if (status?.reasons?.includes('recently')) why.push('the league rarely returns to a city so soon after a game');
  if (status?.reasons?.includes('prestige')) why.push('the league wants a host with a winning reputation — that has to be earned on the field');
  if (status?.reasons?.includes('atmosphere')) why.push('the league office cited the crowds — our atmosphere is not where a host\'s needs to be');
  if (status?.reasons?.includes('ballpark')) {
    const p = status.progress;
    why.push(p >= 0.85 ? 'our ballpark was a finalist — the facilities are nearly where the league wants them'
           : p >= 0.5  ? 'our ballpark was in the conversation, but the facilities still lag the league\'s best'
           :             'our ballpark is not on the league\'s list yet — facilities and fan experience are what move it');
  }
  // r135 news, not a decision: the Recent feed, with the league's main reason.
  _ourNews(`All-Star Game awarded to ${city}${why.length ? ` — ${why[0]}` : ''}`, atMs);
  return null;
}


/**
 * deliverAllStarLobbyCard(playerId, atMs, expiresAtMs)
 * The host's GM has the league's ear before the rosters are set: make the
 * public case for one of ours who is on the bubble, or stay out of it.
 */
export function deliverAllStarLobbyCard(playerId, atMs, expiresAtMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p) return null;
  return _deliverAt(_rosterCard(state, {
    cardId: 'as_lobby', tag: 'MEDIA', type: 'normal', avatar: '🎙️', sender: 'Media Relations',
    _rosterKey: `allstar:lobby:${state.seasonNum}`, _targetPlayerId: playerId,
    subject: `${p.name} is on the All-Star bubble`,
    preview: `Rosters are set in a few days. As the host, we have a platform — use it?`,
    body: `${_who(p)} is right on the edge of making the All-Star team. Rosters are announced in a few days, and as the host club the league and the press are listening to us this week. `
        + `We can make the case publicly — it might be the push that\'s needed, and ${p.name} will know we went to bat — or stay out of it and let the vote speak.`,
    yesLabel: 'Make the case', noLabel: 'Stay out of it',
    yesEffect: { morale: 1 }, noEffect: {},
    autoResolve: 'no', expiresAtMs,
    _raw: { onYes: 'as_lobby_yes', onNo: 'as_lobby_no', onAuto: 'as_lobby_no' },
  }), atMs);
}


/** The manager names our All-Stars (one card for the club). */
export function deliverAllStarSelectionCard(selections, atMs) {
  const state = StateManager.get();
  if (!selections.length) return null;
  const desc = (x) => {
    const p = state.players[x.id];
    return `${p?.name} (${x.role === 'starter' ? `starting at ${x.slot === 'OF' ? 'outfield' : x.slot}` : x.role === 'pitcher' ? p?.pos : 'reserve'})`;
  };
  const host = state.allStar?.season?.hostId;
  return _deliverNotice(`allstar:selected:${state.seasonNum}`, {
    cardId: 'as_selected', tag: 'ROSTER', type: 'good', avatar: '⭐', sender: _managerName(state),
    subject: selections.length === 1 ? `${state.players[selections[0].id]?.name} is an All-Star`
                                     : `${selections.length} of ours are All-Stars`,
    preview: `The All-Star rosters are out.`,
    body: `The All-Star rosters are out, and we're sending ${_list(selections.map(desc))}. `
        + `${selections.length > 1 ? 'Every one of them earned it' : 'Earned, not given'} — the clubhouse is proud. `
        + `The game is the second night of the break${host === 'user' ? ', in our ballpark' : host ? ` in ${_cityOf(state, host)}` : ''}.`,
    expiresAtMs: atMs + 2 * 24 * 3600_000,
  }, atMs);
}


/** All-Star week in our ballpark — three decisions while the league is in town. */
export function scheduleAllStarWeekCards(dayStartMs, firstPitchMs) {
  const state = StateManager.get();
  const K = (lo, hi) => Math.round((lo + eventRand() * (hi - lo)) / 5) * 5;
  const sponsorK = K(500, 900), clinicK = K(120, 220);
  const cards = [
    { h: 9, key: 'sponsor', fields: {
      cardId: 'as_week_sponsor', tag: 'MARKETING', avatar: '💼', sender: 'Corporate Partnerships',
      subject: 'All-Star FanFest — title sponsor on the table',
      preview: `A regional bank wants its name on FanFest. ${formatK(sponsorK)}.`,
      body: `A regional bank wants to be the title sponsor of All-Star FanFest: ${formatK(sponsorK)}, with their branding across the concourse and the plaza all week. `
          + 'The money is real. Fans and the league will notice the ballpark looking like a bank lobby.',
      yesLabel: 'Sign the sponsor', noLabel: 'Keep FanFest ours',
      yesEffect: { atmosphere: -3 }, noEffect: { atmosphere: 2 }, _revenueK: sponsorK } },
    { h: 11, key: 'clinic', fields: {
      cardId: 'as_week_clinic', tag: 'MARKETING', avatar: '🧢', sender: 'Community Relations',
      subject: 'All-Stars want to run a youth clinic',
      preview: `A clinic with the All-Stars for local kids — ${formatK(clinicK)} to put on.`,
      body: `Several All-Stars have offered to run a clinic for local youth leagues on the field before the game. Putting it on costs ${formatK(clinicK)} (staff, gear, buses). `
          + 'It is the kind of morning the city remembers.',
      yesLabel: 'Put it on', noLabel: 'Not this year',
      yesEffect: { atmosphere: 4, ownerTrust: 1 }, noEffect: { atmosphere: -1 }, _budgetCost: clinicK } },
    { h: 15, key: 'media', fields: {
      cardId: 'as_week_media', tag: 'MEDIA', avatar: '📺', sender: 'Media Relations',
      subject: 'National media want the run of our clubhouse',
      preview: 'Open access all week — great exposure, and a distraction.',
      body: 'The national networks want open access to our clubhouse and players for All-Star week features. '
          + 'It would put the franchise in front of the whole country — and put cameras in our players\' faces for four days.',
      yesLabel: 'Open the doors', noLabel: 'Keep it to the usual',
      yesEffect: { atmosphere: 3, morale: -3 }, noEffect: { morale: 1, atmosphere: -1 } } },
  ];
  let n = 0;
  for (const c of cards) {
    const at = dayStartMs + c.h * 3600_000;
    if (_deliverAt(_rosterCard(state, {
      type: 'normal', autoResolve: 'no', expiresAtMs: firstPitchMs,
      _rosterKey: `allstar:week:${c.key}:${state.seasonNum}`, _raw: {},
      ...c.fields,
    }), at)) n++;
  }
  return n;
}


/** The game's MVP is one of ours. */
export function deliverAllStarMvpCard(playerId, atMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p) return null;
  const r = state.allStar?.season?.result;
  // r135 news: the Recent feed.
  _ourNews(`${p.name} is the All-Star Game MVP${r ? ` (${r.homeScore}–${r.awayScore} final)` : ''}`, atMs);
  return null;
}


/**
 * A player who spent All-Star week in our ballpark wants in (§17.3, §91): an
 * All-Star from another club who would start for us, offered by that club at
 * its asking price. Nothing comes if no such deal can be made.
 */
export function deliverAllStarTradeOffer(context) {
  const st = StateManager.get();
  const atMs = clockNow();
  if (!tradeWindow(st).open) return false;
  const season = st.seasonNum || 1;
  const cands = [];
  for (const t of st.leagueTeams || []) {
    if (busyWithUs(st, t.id, atMs)) continue;
    for (const id of t.rosterIds || []) {
      const p = st.players[id];
      if ((p?.allStarSeasons || []).includes(season) && LeagueTrades.movable(p, atMs, st) && wouldStart(p, st, 'user')) cands.push({ t, p });
    }
  }
  for (const { t, p } of cands.sort((x, y) => (y.p.ovr || 0) - (x.p.ovr || 0)).slice(0, 6)) {
    const a = LeagueTrades.askingOffer(st, t.id, p.id, atMs);
    if (!a) continue;
    const offer = LeagueTrades.userOffer(a.deal);
    if (!_offerCanGo(st, offer, t.id, atMs)) continue;
    return !!deliverTradeOffer(offer, t.id, {
      kind: 'sell', room: a.room, subject: `${p.name} wants a move here`,
      intro: _pick([
        (who) => `${who} spent All-Star week in our ballpark and has let ${t.name} know a move here would be welcome. ${t.name} are willing to listen.`,
        (who) => `After a week in our ballpark at the All-Star Game, ${who} asked ${t.name} about a move here — and they called us.`,
      ]),
      atMs: atMs + (30 + eventRand() * 150) * 60_000,
    });
  }
  return false;
}


/** Withdraw the lobbying card once the rosters are set. */
export function withdrawAllStarLobbyCard() {
  const st = StateManager.get();
  return _withdraw(c => c._rosterKey === `allstar:lobby:${st.seasonNum}`);
}


/** All-Star card decisions (inside _applyRosterAction). */
export function _applyAllStarAction(action, instance) {
  StateManager.mutate(s => {
    const season = s.allStar?.season;
    if (!season?.influence) return;
    season.influence.choice = action === 'as_lobby_yes' ? 'yes' : 'no';
  });
}
