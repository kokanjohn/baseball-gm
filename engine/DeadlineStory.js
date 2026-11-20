/**
 * engine/DeadlineStory.js
 * r215 §122.94 The trade deadline, as a story: from two weeks out to the morning after, each message written from the
 * club as it stands (the record, the race, the roster, the market) and from what the GM has already decided.
 *
 *   owner     (14 games out) the owner wants a direction: buy, sell, or stand pat — the stance shapes everything after
 *   market    (10)  the scouting director's read of the market; "get ahead of it" brings a shortlist (buy) or a call (sell)
 *   player    (7)   a regular on an expiring deal asks whether they're being traded: the truth, or a reassurance
 *   manager   (5)   what the clubhouse needs most: a bat, an arm, or nothing
 *   shortlist (4)   buy + ahead of it: a rental that fits, as an offer ready to make; sell: a buyer calls for our veteran
 *   rival     (3)   buy: another GM is after the same player — back off, or game on
 *   money     (2)   buy: the owner offers payroll room; sell: the owner wants salary moved
 *   final     (deadline day) the last hours: what's on the table
 *   after     (the morning after) the clubhouse, the owner, who came and who left, the paper's grade
 *
 * Moments: the day of the regular-season game that many games before the deadline game (TRADE_DEADLINE_CLOSE),
 * between 10am and 12:30 local (its own dice). State: s.deadline = { season, stance, done: {}, … }.
 *
 * PURE: no StateManager. Builders return card fields (CardEngine makes and delivers them).
 */
import { TRADE_DEADLINE_CLOSE, DEADLINE_STORY } from '../data/constants.js';
import { dice, diceSeed } from './Dice.js';
import { clubMode, rapportOf } from './TradeEngine.js';
import { rentalTarget, prospectToSend } from './MarketEngine.js';
import { contractIsUp } from './OffseasonEngine.js';
import { posLabel } from './Positions.js';
import { isAvailable } from './PlayerFactory.js';
import { cpuGmName } from './FirstDay.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const isP = (p) => p?.pos === 'SP' || p?.pos === 'RP';

/** Our regular-season games, in order. */
function _regular(state) { return (state.schedule || []).filter(g => g && !g.isSpring && !g.isPlayoff); }

function _dayAt(ms, h, m = 0) { const d = new Date(ms); d.setHours(h, m, 0, 0); return d.getTime(); }

/** This season's deadline: the day the window closes (the deadline game) and when its last game ends. */
export function deadlineOf(state) {
  const reg = _regular(state);
  const g = reg[TRADE_DEADLINE_CLOSE];
  return g ? { gameTime: g.gameTime, endsAt: g.gameTime + 4 * HOUR, after: reg[TRADE_DEADLINE_CLOSE + 1]?.gameTime ?? g.gameTime + DAY } : null;
}

/** The story's moments this season: [{ key, atMs }]. */
export function storyMoments(state) {
  const reg = _regular(state);
  const dl = deadlineOf(state);
  if (!dl) return [];
  const season = state.seasonNum || 1;
  const out = [];
  for (const [key, back] of Object.entries(DEADLINE_STORY.gamesOut)) {
    const g = reg[TRADE_DEADLINE_CLOSE - back];
    if (!g) continue;
    const r = dice(diceSeed(state), 'deadline', season, key);
    out.push({ key, atMs: _dayAt(g.gameTime, 10) + Math.floor(r() * 150) * MIN });
  }
  const r = dice(diceSeed(state), 'deadline', season, 'final');
  out.push({ key: 'final', atMs: _dayAt(dl.gameTime, 9) + Math.floor(r() * 90) * MIN });
  out.push({ key: 'after', atMs: _dayAt(dl.after, 9, 30) + Math.floor(r() * 120) * MIN });
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** The next moment due (not yet done), or null. */
export function nextStepAt(state, clockMs) {
  if (![...REGULAR_PHASES].includes(state.phase)) return null;
  const season = state.seasonNum || 1;
  const done = state.deadline?.season === season ? state.deadline.done || {} : {};
  const m = storyMoments(state).find(x => !done[x.key] && x.atMs <= clockMs);
  return m ? m : null;
}
const REGULAR_PHASES = new Set(['REGULAR_SEASON', 'ALL_STAR_BREAK', 'TRADE_DEADLINE']);

// ── What the story knows ──────────────────────────────────────

function _record(state, ctx) {
  const u = state.userTeam;
  const w = u.wins || 0, l = u.losses || 0;
  const gbN = ctx?.gamesBack === '-' ? 0 : parseFloat(ctx?.gamesBack);
  const race = gbN === 0 ? 'first in the division' : Number.isFinite(gbN) ? `${gbN} game${gbN === 1 ? '' : 's'} back` : '';
  return { w, l, line: `${w}–${l}${race ? `, ${race}` : ''}`, pct: w + l ? w / (w + l) : 0.5, gb: Number.isFinite(gbN) ? gbN : 99 };
}

/** Our trades in the window: who came, who left. */
export function windowTrades(state, fromMs, toMs) {
  const ins = [], outs = [];
  for (const tx of state.transactions || []) {
    if (tx?.reason !== 'trade' || !(tx.createdAt >= fromMs && tx.createdAt <= toMs)) continue;
    if (tx.teamId === 'user') ins.push(tx.playerId);
    else if (tx.fromTeamId === 'user') outs.push(tx.playerId);
  }
  return { ins, outs };
}

/** A regular of ours whose deal is up after the season (the best of them), or null. */
function _expiring(state) {
  const u = state.userTeam;
  const regs = new Set([...(u.lineupSlots || []).map(s => s.playerId), ...(u.rotation?.order || [])]);
  return (u.rosterIds || []).map(id => state.players[id])
    .filter(p => p && regs.has(p.id) && isAvailable(p) && contractIsUp(p, state.seasonNum || 1))
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0] || null;
}

/** Our weakest regular at the plate and on the mound (the manager's read). */
function _weakest(state) {
  const u = state.userTeam;
  const bat = (u.lineupSlots || []).map(s => state.players[s.playerId]).filter(Boolean).sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0] || null;
  const arm = (u.rotation?.order || []).map(id => state.players[id]).filter(Boolean).sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0] || null;
  return { bat, arm };
}

/** A rental that fits (an upgrade over our weakest at that side), and what we'd send. */
export function shortlistDeal(state, focus) {
  const { bat, arm } = _weakest(state);
  const side = focus === 'arm' ? 'pitcher' : focus === 'bat' ? 'hitter' : ((arm?.ovr ?? 99) < (bat?.ovr ?? 99) ? 'pitcher' : 'hitter');
  const floor = ((side === 'pitcher' ? arm : bat)?.ovr || 50) + 3;
  const t = rentalTarget(state, side, floor);
  if (!t || clubMode(state, t.team.id) === 'buyer') return null;
  const send = prospectToSend(state, (t.player.ovr || 50) - 6);
  if (!send) return null;
  return { side, player: t.player, team: t.team, send, offer: { incomingIds: [t.player.id], outgoingIds: [send.id], cashK: 0, retain: {} } };
}

// ── The messages ──────────────────────────────────────────────

const DUE = (atMs, h) => atMs + h * HOUR;

export function buildStep(key, state, ctx, atMs) {
  const u = state.userTeam;
  const dl = state.deadline || {};
  const stance = dl.stance || 'hold';
  const owner = u.ownerName || 'Ownership';
  const mgr = u.coachingStaff?.manager?.name || 'The manager';
  const rec = _record(state, ctx);
  const base = { cardId: `deadline_${key}`, tag: 'TRADE', type: 'normal', _deadlineStory: key, _rosterKey: `deadline:${state.seasonNum || 1}:${key}` };

  if (key === 'owner') {
    const lean = rec.pct >= 0.54 || rec.gb <= 3 ? 'The way we\'re playing, I\'d understand buying.' : rec.pct <= 0.46 ? 'Honestly, this doesn\'t look like our year, and I\'d understand selling.' : 'We could go either way from here.';
    return { ...base, sender: owner, avatar: '💼',
      subject: 'The deadline: buying, selling, or standing pat?',
      preview: `The deadline is two weeks out, and I want a direction…`,
      body: `The deadline is two weeks out. We're ${rec.line}. ${lean} I want to know where we stand before the phones start ringing: are we buying, selling, or standing pat? Whatever you decide, I'll hold you to it.`,
      _choices: [{ key: 'buy', label: 'We\'re Buying', sub: 'Go get help for the stretch' }, { key: 'sell', label: 'We\'re Selling', sub: 'Move veterans for the future' }],
      _noRec: true, yesLabel: 'We\'re Buying', noLabel: 'We Stand Pat',
      yesMsg: 'Understood. I\'ll be watching.', noMsg: 'Standing pat. I hope this group is enough.',
      autoResolve: 'no', expiresAtMs: DUE(atMs, 48), _raw: { onYes: 'dl_stance', onNo: 'dl_hold' } };
  }

  if (key === 'market') {
    const modes = (state.leagueTeams || []).map(t => clubMode(state, t.id));
    const sellers = modes.filter(m => m === 'seller').length, buyers = modes.filter(m => m === 'buyer').length;
    const sellerClubs = (state.leagueTeams || []).filter(t => clubMode(state, t.id) === 'seller');
    const names = sellerClubs.flatMap(t => (t.rosterIds || []).map(id => state.players[id]).filter(p => p && isAvailable(p) && contractIsUp(p, state.seasonNum || 1)).map(p => ({ p, t })))
      .sort((a, b) => (b.p.ovr || 0) - (a.p.ovr || 0)).slice(0, 2);
    const who = names.length ? ` The best of what's out there: ${names.map(({ p, t }) => `${p.name} (${posLabel(p)}, OVR ${p.ovr}, ${t.name})`).join(' and ')}.` : '';
    const price = buyers > sellers ? 'More clubs are buying than selling, so prices will climb as the deadline gets closer.' : buyers < sellers ? 'More clubs are selling than buying, so prices should come down late.' : 'Buyers and sellers are about even.';
    const what = stance === 'sell' ? 'start calling the buyers about our veterans now, before they spend elsewhere' : stance === 'buy' ? 'get our scouts on the rentals now and have a deal ready before the rush' : 'keep our scouts on the market so we know what\'s there';
    return { ...base, sender: u.coachingStaff?.scoutingDirector?.vacant ? 'Pro Scouting' : (u.coachingStaff?.scoutingDirector?.name || 'Pro Scouting'), avatar: '🔭', tag: 'SCOUTING',
      subject: 'The deadline market',
      preview: `${sellers} clubs selling, ${buyers} buying…`,
      body: `Here's the market ten days out: ${sellers} club${sellers === 1 ? '' : 's'} selling, ${buyers} buying.${who} ${price} I'd like to ${what}. It costs us extra scouting time.`,
      yesLabel: 'Get Ahead of It', noLabel: 'Wait It Out', _budgetCost: DEADLINE_STORY.aheadK,
      yesMsg: 'On it. You\'ll hear from me before the deadline.', noMsg: 'We\'ll wait and see where prices go.',
      autoResolve: 'no', expiresAtMs: DUE(atMs, 36), _raw: { onYes: 'dl_ahead', onNo: null } };
  }

  if (key === 'player') {
    const p = _expiring(state);
    if (!p) return null;
    const truth = stance === 'sell' ? 'we\'re listening on our veterans, and that includes them' : 'nothing is planned, but nobody is untouchable';
    return { ...base, sender: mgr, relay: p.name, avatar: '📋', tag: 'CULTURE', _targetPlayerId: p.id,
      subject: `${p.name} asked if they're being traded`,
      preview: `${p.name} came to my office with a straight question…`,
      body: `${p.name} came to my office with a straight question: are they being traded? Their contract is up after the season, and they've seen the rumors. I can tell ${p.name} the truth, that ${truth}. Or I can tell them they're staying, and we'd better mean it.`,
      yesLabel: 'Tell Them the Truth', noLabel: 'Tell Them They\'re Staying',
      yesEffect: { morale: stance === 'sell' ? -1 : 1 }, noEffect: { morale: 2 },
      yesMsg: `${p.name} appreciated the honesty.`, noMsg: `${p.name} is relieved. Let's make sure it holds.`,
      autoResolve: 'no', expiresAtMs: DUE(atMs, 30), _raw: { onYes: null, onNo: 'dl_reassure' } };
  }

  if (key === 'manager') {
    const { bat, arm } = _weakest(state);
    const armFirst = (arm?.ovr ?? 99) < (bat?.ovr ?? 99);
    const why = armFirst && arm ? `${arm.name} (OVR ${arm.ovr}) is the soft spot in the rotation` : bat ? `${bat.name} (OVR ${bat.ovr}) is the soft spot in the lineup` : 'we have a soft spot or two';
    const choices = [{ key: 'bat', label: 'A Bat', sub: bat ? `Over ${bat.name} in the lineup` : 'For the lineup' }, { key: 'arm', label: 'An Arm', sub: arm ? `Over ${arm.name} in the rotation` : 'For the staff' }];
    if (armFirst) choices.reverse();
    return { ...base, sender: mgr, avatar: '📋', tag: 'ROSTER',
      subject: 'What we need most',
      preview: `If we add one piece, here's where I'd put it…`,
      body: `If we add one piece before the deadline, here's where I'd put it: ${why}. Tell me what you want the scouts chasing, and I'll make room for it. If you think this group is enough, I'll sell that to the room too.`,
      _choices: choices, yesLabel: choices[0].label, noLabel: 'This Group Is Enough',
      yesEffect: { manConf: 1 }, noEffect: { morale: 1 },
      yesMsg: 'Good. I\'ll tell the scouts.', noMsg: 'This group it is.',
      autoResolve: 'no', expiresAtMs: DUE(atMs, 30), _raw: { onYes: 'dl_focus', onNo: 'dl_focus_none' } };
  }

  if (key === 'shortlist') {
    if (!dl.ahead) return null;
    if (stance === 'buy') {
      const d = shortlistDeal(state, dl.focus);
      if (!d) return null;
      const dir = u.coachingStaff?.scoutingDirector;
      return { ...base, sender: dir && !dir.vacant ? dir.name : 'Pro Scouting', avatar: '🔭', _targetPlayerId: d.player.id,
        subject: `The shortlist: ${d.player.name}`,
        preview: `We got ahead of it, and here's the one I'd go after…`,
        body: `We got ahead of the market, and here's the one I'd go after: ${d.player.name} (${posLabel(d.player)}, OVR ${d.player.ovr}) of the ${d.team.name}, on a deal that ends this season. The ${d.team.name} are out of it. I think ${d.send.name} (${posLabel(d.send)}, OVR ${d.send.ovr}) gets it done. We can make the offer now, before the rush.`,
        yesLabel: 'Make the Offer', noLabel: 'Not Now',
        yesMsg: 'Offer sent. Their answer comes on their clock.', noMsg: 'Holding off.',
        autoResolve: 'no', expiresAtMs: DUE(atMs, 48),
        _ideaTeamId: d.team.id, _ideaOffer: d.offer, _ideaRound: null,
        _reviseOffer: { teamId: d.team.id, offer: d.offer, round: null }, _reviseLabel: 'Adjust It First', _dlTeamId: d.team.id,
        _raw: { onYes: 'lt_offer_send', onNo: 'lt_pass', onAuto: 'lt_pass' } };
    }
    return null;   // (selling: CardEngine places a buyer's call instead)
  }

  if (key === 'rival') {
    if (stance !== 'buy') return null;
    const target = shortlistDeal(state, dl.focus);
    const rivals = (state.leagueTeams || []).filter(t => clubMode(state, t.id) === 'buyer' && t.id !== target?.team?.id);
    if (!target || !rivals.length) return null;
    const r = dice(diceSeed(state), 'deadline-rival', state.seasonNum || 1);
    const t = rivals[Math.floor(r() * rivals.length)];
    const gm = cpuGmName(state, t.id);
    return { ...base, sender: `${gm} (${t.name} GM)`, avatar: '📞', _dlTeamId: t.id, _targetPlayerId: target.player.id,
      subject: `We're both after ${target.player.name}`,
      preview: `I'll be straight with you: we're chasing the same player…`,
      body: `I run the ${t.name}, and I'll be straight with you: we're both chasing ${target.player.name}, and all a bidding war does is make the ${target.team.name} rich. Back off this one, and I'll remember it when you need something from us. Or we both keep bidding and see who blinks.`,
      yesLabel: 'Back Off', noLabel: 'Game On',
      yesMsg: 'Appreciated. I won\'t forget it.', noMsg: 'Then may the better offer win.',
      autoResolve: 'no', expiresAtMs: DUE(atMs, 30), _raw: { onYes: 'dl_rival_back', onNo: 'dl_rival_on' } };
  }

  if (key === 'money') {
    const payroll = u.finances?.payroll || u.finances?.payrollTarget || 0;
    if (stance === 'buy') {
      const k = Math.max(DEADLINE_STORY.roomMinK, Math.round(payroll * DEADLINE_STORY.roomShare / 10) * 10);
      return { ...base, sender: owner, avatar: '💼', tag: 'OWNERSHIP', _dlMoneyK: k,
        subject: 'Some room for the deadline',
        preview: 'You said we\'re buying. Here\'s what I can do…',
        body: `You said we're buying, so here's what I can do: another ${_fmtK(k)} of payroll room this season, for the right player. I'll expect to see it on the field. If you can do it with what you have, even better.`,
        yesLabel: 'Take the Room', noLabel: 'We\'ll Make It Work',
        noEffect: { ownerTrust: 1 },
        yesMsg: 'The room is yours. Use it well.', noMsg: 'I like hearing that.',
        autoResolve: 'no', expiresAtMs: DUE(atMs, 30), _raw: { onYes: 'dl_room', onNo: null } };
    }
    if (stance === 'sell') {
      return { ...base, sender: owner, avatar: '💼', tag: 'OWNERSHIP',
        subject: 'If we\'re selling, move salary',
        preview: 'You said we\'re selling. Then I want the payroll lighter…',
        body: `You said we're selling. Then I want the payroll lighter when the deadline passes, not just younger. Can I count on that?`,
        yesLabel: 'We\'ll Move Salary', noLabel: 'I Can\'t Promise That',
        noEffect: { ownerTrust: -1 },
        yesMsg: 'Good. I\'ll check the books after the deadline.', noMsg: 'Noted.',
        autoResolve: 'no', expiresAtMs: DUE(atMs, 30), _raw: { onYes: 'dl_shed', onNo: null } };
    }
    return null;
  }

  if (key === 'final') {
    const deals = ctx?.dealsOnTable || [];
    const body = deals.length
      ? `The deadline is today, and the phones won't stop. On the table right now: ${deals.map(d => d.label).join('; ')}. Anything we want done has to be done before today's game ends.`
      : `The deadline is today, and the phones are quiet for us. If there's a move you want to make, it has to be done before today's game ends.`;
    return { ...base, sender: 'Pro Scouting', avatar: '⏱', type: 'urgent',
      subject: 'Deadline day', preview: deals.length ? `${deals.length} deal${deals.length === 1 ? '' : 's'} on the table…` : 'The phones are quiet…', body,
      yesLabel: 'Got It', noLabel: null, autoResolve: 'yes', expiresAtMs: DUE(atMs, 14), _news: true, _raw: {} };
  }
  return null;
}

/** The morning after: the messages that close the story (each card's fields), in order. */
export function buildAfter(state, ctx, atMs) {
  const u = state.userTeam;
  const dl = state.deadline || {};
  const stance = dl.stance || 'hold';
  const owner = u.ownerName || 'Ownership';
  const mgr = u.coachingStaff?.manager?.name || 'The manager';
  const rec = _record(state, ctx);
  const m = storyMoments(state);
  const from = m.find(x => x.key === 'owner')?.atMs ?? atMs - 16 * DAY;
  const { ins, outs } = windowTrades(state, from, atMs);
  const P = (id) => state.players[id];
  const season = state.seasonNum || 1;
  const base = (k) => ({ cardId: `deadline_after_${k}`, tag: 'TRADE', type: 'normal', _deadlineStory: `after:${k}`, _rosterKey: `deadline:${season}:after:${k}` });
  const out = [];
  const broke = dl.reassured && outs.includes(dl.reassured) ? P(dl.reassured) : null;
  const moved = ins.length || outs.length;

  // The clubhouse (a decision: talk to them, or let it be).
  const room = broke ? `And everyone knows we told ${broke.name} they were staying. That one hurt.`
    : ins.length && !outs.length ? 'The room took it as a vote of confidence.'
    : outs.length && !ins.length ? 'The room took it as the front office giving up on this season.'
    : moved ? 'The room is still sorting out who\'s who.'
    : rec.pct >= 0.5 ? 'The room took standing pat as belief in them.' : 'The room took standing pat as a shrug.';
  const did = moved ? `${ins.length ? `${ins.map(id => P(id)?.name).filter(Boolean).join(' and ')} in` : ''}${ins.length && outs.length ? ', ' : ''}${outs.length ? `${outs.map(id => P(id)?.name).filter(Boolean).join(' and ')} out` : ''}` : 'no moves';
  out.push({ ...base('room'), sender: mgr, avatar: '📋', tag: 'CULTURE',
    subject: 'The clubhouse, the morning after',
    preview: `The deadline's over: ${did}…`,
    body: `The deadline's over: ${did}. ${room} I can bring them together before the game and say what this team is playing for now, or let the games do the talking.`,
    yesLabel: 'Talk to the Team', noLabel: 'Let the Games Talk',
    yesEffect: { morale: broke ? -1 : 2 }, noEffect: broke ? { morale: -3 } : {},
    yesMsg: 'Good talk. They needed it.', noMsg: 'We\'ll let the games talk.',
    autoResolve: 'no', expiresAtMs: atMs + 8 * HOUR, _raw: {} });

  // The owner (news): did we do what we said?
  const kept = stance === 'buy' ? (ins.length ? 2 : dl.room ? -3 : -2) : stance === 'sell' ? (outs.length ? 1 : -1) + (dl.shed && !outs.length ? -2 : 0) : (moved ? -1 : 1);
  const said = { buy: 'You said we were buying', sell: 'You said we were selling', hold: 'You said we\'d stand pat' }[stance];
  const verdict = kept > 0 ? 'and you did. That\'s what I want from this job.' : kept < 0 ? `and ${stance === 'hold' ? 'then you didn\'t' : 'I didn\'t see it'}. We'll talk about that at the end of the year.` : 'and we\'re about even on that.';
  out.push({ ...base('owner'), sender: owner, avatar: '💼', tag: 'OWNERSHIP',
    subject: 'About the deadline', preview: `${said}…`,
    body: `${said}, ${verdict}`,
    yesLabel: 'Got It', noLabel: null, yesEffect: { ownerTrust: kept }, autoResolve: 'yes', expiresAtMs: atMs + 12 * HOUR, _news: true, _raw: {} });

  // Who came (one hello), who left (one goodbye).
  const newbie = ins.map(P).filter(Boolean).sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
  if (newbie) out.push({ ...base('hello'), sender: `${newbie.name} (${posLabel(newbie)})`, avatar: '👋', tag: 'CULTURE', _targetPlayerId: newbie.id,
    subject: 'Glad to be here', preview: 'Just wanted to say thanks for bringing me in…',
    body: `Just wanted to say thanks for bringing me in. I know why I'm here, and I'm ready to help this team win now.`,
    yesLabel: 'Got It', noLabel: null, yesEffect: { morale: 1 }, autoResolve: 'yes', expiresAtMs: atMs + 12 * HOUR, _news: true, _raw: {} });
  const gone = outs.map(P).filter(Boolean).sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
  if (gone) {
    const club = (state.leagueTeams || []).find(t => t.id === gone.teamId)?.name;
    out.push({ ...base('goodbye'), sender: `${gone.name}${club ? ` (${club})` : ''}`, avatar: '👋', tag: 'CULTURE',
      subject: 'Thanks for everything', preview: 'Didn\'t want to leave without saying it…',
      body: broke && broke.id === gone.id
        ? 'I was told I was staying. I understand the business, but I won\'t pretend that didn\'t sting. Good luck to everyone in that room.'
        : 'Didn\'t want to leave without saying thanks. I gave that club everything I had, and I hope it shows. Good luck the rest of the way.',
      yesLabel: 'Got It', noLabel: null, autoResolve: 'yes', expiresAtMs: atMs + 12 * HOUR, _news: true, _raw: {} });
  }

  // The paper's grade (a decision: answer it, or no comment).
  const grade = stance === 'buy' ? (ins.length ? 'B+' : 'D') : stance === 'sell' ? (outs.length ? 'B' : 'D+') : (rec.pct >= 0.5 ? 'C+' : 'C-');
  const good = /^[AB]/.test(grade);
  out.push({ ...base('grade'), sender: 'Media Relations', avatar: '📰', tag: 'MARKETING',
    subject: `The paper gave our deadline a ${grade}`,
    preview: `The local paper graded every club's deadline. Ours: ${grade}…`,
    body: `The local paper graded every club's deadline. Ours: ${grade}. ${good ? 'They liked that we did what we said we would.' : 'They say we talked about a plan and didn\'t follow it.'} The beat writer wants a comment from you for tomorrow's paper.`,
    yesLabel: 'Give Them a Quote', noLabel: 'No Comment',
    yesEffect: { atmo: good ? 2 : 1 }, noEffect: { atmo: good ? 0 : -1 },
    yesMsg: 'Quote sent. It\'ll run tomorrow.', noMsg: 'No comment. They\'ll run it anyway.',
    autoResolve: 'no', expiresAtMs: atMs + 10 * HOUR, _raw: {} });
  return out;
}

function _fmtK(k) { return k >= 1000 ? `$${(k / 1000).toFixed(1).replace(/\.0$/, '')}M` : `$${k}K`; }
