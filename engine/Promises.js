/**
 * engine/Promises.js — r147: a decision whose words say something will happen
 * later makes it happen.
 *
 * A card declares `_promise: { yes?: {...}, no?: {...} }`. When the GM's choice
 * (or the card's default, if it goes unanswered) carries one, CardEngine
 * records it:
 *   - `afterDays: N`  — judged N days later;
 *   - `when: ...`     — judged at a moment of the year:
 *       'season_end'  the regular season's record is in (offseason day 1);
 *       'winter'      the staff day (offseason day 2) — bills that were put off;
 *       'fa_opens'    free agency opens with the new class (offseason day 5);
 *       'spring'      the next spring training opens.
 * Either way the promise becomes a placeholder message, scheduled for its
 * moment and written as it lands (like a staff reply), from the world as it is
 * then: kept or broken, paid or not. `resolvePromise` is that writing: it
 * returns the message (or null: nothing to say — the player was traded, the
 * luck held) and what lands with it (`land`: effects on the clubhouse, the
 * fans, ownership, the books; a player's dip or injury).
 *
 * Pure: never imports StateManager. Randomness comes from the promise's own
 * stream (dice on its id), so the look-ahead and the real clock agree.
 */

import { dice, diceSeed } from './Dice.js';
import { computeAge, baseballYear } from './PlayerFactory.js';
import { trueOVR } from './Diamonds.js';
import { formatK } from './CardTokens.js';
import { PLAYER_ORIGIN } from '../data/constants.js';

export const PROMISE_WHEN = Object.freeze(['season_end', 'winter', 'fa_opens', 'spring']);

/** A suite sponsor who walks: the season's lease ($K). */
export const SUITE_LEASE_K = 60;

const DAY = 86_400_000;
const mgrName  = (s) => s.userTeam?.coachingStaff?.manager?.name || 'The manager';
const ownName  = (s) => s.userTeam?.ownerName || 'Ownership';
const scoutSig = (s) => {
  const d = s.userTeam?.coachingStaff?.scoutingDirector;
  return d && !d.vacant && d.name ? `${d.name}, Scouting Director` : 'Scouting';
};
const rec2 = (w, l) => `${w}–${l}`;

/** The user's results in the schedule between two moments (spring and regular season). */
function resultsBetween(s, fromMs, toMs) {
  let w = 0, l = 0;
  for (const g of s.schedule || []) {
    if (g.gameTime < fromMs || g.gameTime > toMs) continue;
    if (g.result === 'win') w++; else if (g.result === 'loss') l++;
  }
  return { w, l };
}

const RESOLVERS = {
  // mo_take_presser — "Promise a Winner" at the first press conference.
  presser_winner(s) {
    const { wins: w = 0, losses: l = 0 } = s.userTeam;
    const kept = w > l;
    return {
      card: {
        sender: 'Media Relations', avatar: '📰', tag: 'MEDIA', type: kept ? 'good' : 'normal',
        subject: kept ? 'The promise you made, kept' : 'The promise you made at the podium',
        body: kept
          ? `On your first day you stood at the podium and promised a winner. ${rec2(w, l)}. The fans remember the promise, and you kept it: season-ticket renewals are running ahead of last year.`
          : `On your first day you stood at the podium and promised a winner. ${rec2(w, l)}. The fans remember the promise, and the call-in shows and the season-ticket desk are letting us hear about it. Ownership noticed too.`,
      },
      land: { effects: kept ? { atmo: 4 } : { atmo: -5, ownerTrust: -2 } },
    };
  },

  // mon_profit_empire — "Bank It — Roster Is Set": ownership watches whether it pays off.
  discipline(s) {
    const w = s.userTeam.wins || 0, target = s.userTeam._ownerWinTarget || 75;
    const kept = w >= target;
    return {
      card: {
        sender: ownName(s), avatar: '🏛️', tag: 'OWNERSHIP', type: kept ? 'good' : 'normal',
        subject: kept ? 'The discipline paid off' : '"The roster is set," you said',
        body: kept
          ? `At midseason you banked the profit and told me the roster was set. ${w} wins against a target of ${target}. The discipline paid off.`
          : `At midseason you banked the profit and told me the roster was set. ${w} wins against a target of ${target}. I'll remember that the next time you tell me a roster is set.`,
      },
      land: { effects: { ownerTrust: kept ? 3 : -3 } },
    };
  },

  // sp12 — "Promise a Starting Role": two weeks on, is the player starting?
  starter_role(s, rec) {
    const p = s.players[rec.playerId];
    if (!p || p.teamId !== 'user' || p.isInjured) return null;   // traded, released or hurt: the promise is moot
    const starting = (s.userTeam.lineupSlots || []).some(sl => sl.playerId === p.id);
    return {
      card: {
        sender: mgrName(s), avatar: '📋', tag: 'CLUBHOUSE', type: starting ? 'good' : 'normal',
        subject: starting ? `${p.name}: a promise kept` : `${p.name}: "You told me I was a starter"`,
        body: starting
          ? `Two weeks ago you told ${p.name} it was a starting job, and ${p.name} has started. The room noticed you kept your word.`
          : `Two weeks ago you told ${p.name} it was a starting job. ${p.name} isn't in the lineup, and the whole room knows what was promised. That one is going to linger.`,
      },
      land: { effects: { morale: starting ? 2 : -4 } },
    };
  },

  // bg7 / mo_camp_flush / fn5_hi — work or a deal put off comes back, and it costs more.
  deferred_work(s, rec) {
    const P = rec.params;
    const was = rec.costK || P.baseK || 50;
    const now = Math.round(was * (P.markup || 1.2) / 5) * 5;
    return {
      card: {
        sender: P.sender, avatar: P.avatar || '🔧', tag: P.tag || 'OPERATIONS', type: 'normal',
        subject: P.subject,
        body: `${P.intro} Last season it was ${formatK(was)}; now it's ${formatK(now)}. ${P.yesText} ${P.noText}`,
        yesLabel: `${P.yesLabel} (${formatK(now)})`, noLabel: P.noLabel,
        yesEffect: P.yesEffect || {}, noEffect: P.noEffect || {},
        yesMsg: P.yesMsg, noMsg: P.noMsg,
        _budgetCost: now, autoResolve: 'no', _decision: true,
      },
      land: null,
    };
  },

  // mon_post_bonus — the staff remembers the bonus (or that there wasn't one).
  staff_remembers(s, rec) {
    const shared = rec.choice === 'yes';
    return {
      card: {
        sender: 'Clubhouse Manager', avatar: '🧺', tag: 'CLUBHOUSE', type: shared ? 'good' : 'normal',
        subject: shared ? 'The staff came back talking about last October' : 'A couple of the clubhouse staff didn’t come back',
        body: shared
          ? 'The attendants, the grounds crew and the trainers came back for spring still talking about the bonus pool from last October. The clubhouse runs better when they feel like part of it, and it shows.'
          : 'After last October’s playoff money stayed upstairs, a couple of the longtime attendants took jobs elsewhere over the winter. The new people will learn, but the players noticed who isn’t here.',
      },
      land: { effects: { morale: shared ? 2 : -1 } },
    };
  },

  // ig_suite_complaint — "Formal Apology + Credit": the sponsor remembers at renewal.
  suite_sponsor() {
    return {
      card: {
        sender: 'Guest Services', avatar: '🛎️', tag: 'REVENUE', type: 'normal',
        subject: 'A suite sponsor didn’t renew',
        body: `The corporate sponsor whose catering went wrong during a game — the one who got a formal apology and a credit instead of a fix on the spot — didn't renew the suite for next season. That's ${formatK(SUITE_LEASE_K)} a season we'll have to replace.`,
      },
      land: { fundsK: -SUITE_LEASE_K, fundsLabel: 'Suite lease not renewed' },
    };
  },

  // rv3 — "Scouts will be watching" the college game we hosted: a player from it joins the winter class.
  college_look(s, rec, atMs) {
    const next = (s.seasonNum || 1) + 1;
    const pool = (s.freeAgentPool || []).map(id => s.players[id])
      .filter(p => p && p._classOf === next && p.origin === PLAYER_ORIGIN.ROOKIE)
      .sort((a, b) => (trueOVR(b) - trueOVR(a)) || String(a.id).localeCompare(String(b.id)));
    if (!pool.length) return null;
    const r = dice(diceSeed(s), 'promise', rec.id);
    const p = pool[Math.floor(r() * Math.min(5, pool.length))];
    const better = trueOVR(p) - (p.ovr || 0) >= 3;
    const age = computeAge(p.dob, baseballYear(s) + 1);
    return {
      card: {
        sender: scoutSig(s), avatar: '🔎', tag: 'SCOUTING', type: 'good',
        subject: `${p.name} — we saw this one at our ballpark`,
        body: `Remember the college game we hosted? Our scouts were in the stands. ${p.name} (${p.nativePos || p.pos}, ${age}) played in it, and is in this winter's free-agent class. We've seen ${p.name} up close, so our read is better than anyone's: ${better ? 'better than the rating — the kind of player who gets signed late and makes everyone wonder why' : 'about what the rating says, with the tools to grow'}. ${p.name} is in League → Players under Free Agents.`,
      },
      land: { scouted: p.id, sharpen: p.id },
    };
  },

  // rv2_clubhouse_issue — "File the insurance claim": it pays out a few weeks later.
  insurance(s, rec) {
    const k = rec.costNoK || 8;
    return {
      card: {
        sender: 'Equipment Mgr.', avatar: '🧢', tag: 'OPERATIONS', type: 'good',
        subject: 'The insurance claim came through',
        body: `The claim against the tournament organizers for the missing gear and the damage came through: ${formatK(k)} back.`,
      },
      land: { fundsK: k, fundsLabel: 'Insurance claim paid' },
    };
  },

  // hr1 / hr3 — "Play Through It" / "No Days Off": the workload catches up (or the luck holds).
  worn_down(s, rec) {
    const p = s.players[rec.playerId];
    if (!p || p.teamId !== 'user' || p.isInjured) return null;
    const r = dice(diceSeed(s), 'promise', rec.id);
    if (r() >= 0.6) return null;   // the luck held — nothing to say
    return { card: null, land: { injure: p.id, feed: `${p.name} pulled up — the workload ${mgrName(s)} flagged caught up` } };
  },

  // ls1 — "Push through to the end": a regular is a step slow.
  tired_regular(s, rec) {
    const lineup = (s.userTeam.lineupSlots || []).map(sl => s.players[sl.playerId]).filter(p => p && !p.isInjured);
    if (!lineup.length) return null;
    const r = dice(diceSeed(s), 'promise', rec.id);
    const p = lineup[Math.floor(r() * lineup.length)];
    return {
      card: {
        sender: 'Team Physician', avatar: '🩺', tag: 'MEDICAL', type: 'normal',
        subject: `${p.name} is running on fumes`,
        body: `We pushed through, and the pace caught up with ${p.name}: a step slow for the next few games. The rest of the regulars are tired but holding.`,
      },
      land: { dip: p.id },
    };
  },

  // mo_camp_win_hangover — "Ride the Good Feeling": the manager is watching how camp goes.
  hangover(s, rec, atMs) {
    const { w, l } = resultsBetween(s, rec.madeAtMs, atMs);
    if (w + l < 5) return null;
    const bad = l > w;
    return {
      card: {
        sender: mgrName(s), avatar: '📋', tag: 'CLUBHOUSE', type: bad ? 'normal' : 'good',
        subject: bad ? '"I said a loose camp was a risk"' : 'The loose camp worked',
        body: bad
          ? `${rec2(w, l)} since camp opened. I said riding the good feeling was a risk, and it's showing — we're a step behind where a sharper start would have had us.`
          : `${rec2(w, l)} since camp opened. I had my doubts about riding the good feeling, but the room is loose and playing well. You read it right.`,
      },
      land: { effects: bad ? { manConf: -3 } : { morale: 1, manConf: 1 } },
    };
  },
};

/**
 * resolvePromise(state, rec, atMs) — the message a promise writes as it lands,
 * and what lands with it. Null: nothing to say (and nothing lands).
 */
export function resolvePromise(state, rec, atMs) {
  const fn = RESOLVERS[rec.kind];
  return fn ? fn(state, rec, atMs) : null;
}

export const PROMISE_KINDS = Object.freeze(Object.keys(RESOLVERS));
