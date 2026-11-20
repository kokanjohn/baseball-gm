/**
 * engine/Arcs.js
 * r221 §122.100 Story arcs (release 8): short stories over two to six weeks, each step written from the GM's answer
 * to the one before and from what really happened since. At most ARC.maxActive running at once; each starts from a
 * real situation, never on a timer alone.
 *
 *   veteran     a player 35 or older in the last year of a deal: they tell the manager it's probably their last
 *               season — a farewell tour or quiet; how it's going; with the season ending, one more year (an
 *               extension) or let them go out on top (they retire)
 *   prospect    a young bench bat the scouts think is better than the rating: the scouts' word; a week in the lineup
 *               (a real lineup change); how it went, and whether the regular gets the job back
 *   neighbors   the neighbors and game nights: a shuttle, or not; the council steps in; how it ends
 *   coach       a good coach is asked to interview for another club's manager job: permission or not; they get it
 *               (they leave after the season, the chair empties) or they don't
 *   feud        a losing streak and two players at odds: sit them down, or let them work it out; it settles, or flares
 *
 *   ARCS                          the definitions: { key, trigger(st, atMs, rand) → who | null, doneKey(st, who),
 *                                 alive(st, arc), steps: [{ after: [min, max] days, when?(st, arc), within?, build(st, arc, rand) }] }
 *                                 (a step with `when` comes the first day it's true after `after`, or the arc ends `within` days on)
 *   pickArc(state, atMs, rand)    an arc to start now (or null)
 *
 * A step's build returns the card's fields, or null when the story is over. `arc.picks[i]` is the answer to step i
 * ('yes' | 'no'), read when the next step is due. State: s.arcs = { active: [...], done: { [doneKey]: atMs } }.
 * PURE: no StateManager.
 */
import { ARC, PHASE, PLAYER_GROUP, REGULAR_SEASON_GAME_COUNT } from '../data/constants.js';
import { computeAge, baseballYear } from './PlayerFactory.js';
import { contractIsUp } from './OffseasonEngine.js';
import { trueOVR } from './Diamonds.js';
import { eligibleSlotsFor } from './RosterEngine.js';
import { since, doing, good, bad, enough } from './Callbacks.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const isP = (p) => p?.pos === 'SP' || p?.pos === 'RP';
const ACTIVE = new Set([PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS, PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN]);
const ours = (st, id) => !!id && st.players?.[id]?.teamId === 'user' && (st.userTeam?.rosterIds || []).includes(id) && ACTIVE.has(st.players[id].group);
/** Still with the club (on the IL counts: an arc ends only when the player is gone). */
const still = (st, id) => !!id && st.players?.[id]?.teamId === 'user' && (st.userTeam?.rosterIds || []).includes(id);
const played = (st) => (st.schedule || []).filter(g => g._committed && !g.isSpring && !g.isPlayoff).length;
const mgr = (st) => { const m = st.userTeam?.coachingStaff?.manager; return m && !m.vacant && m.name ? `${m.name} (Manager)` : 'Manager'; };
const pay = (st, share, min) => Math.max(min, Math.round(((st.userTeam?.finances?.payrollTarget || 0) * share) / 5) * 5);
const fmt = (k) => (k >= 1000 ? `$${(k / 1000).toFixed(1).replace(/\.0$/, '')}M` : `$${k}K`);
const news = (o) => ({ yesLabel: 'Got It', noLabel: null, autoResolve: 'yes', _news: true, yesEffect: {}, ...o });
const pickOf = (arr, rand) => arr[Math.floor(rand() * arr.length)];
const ROLE_TITLE = { pitchingCoach: 'Pitching Coach', hittingCoach: 'Hitting Coach', benchCoach: 'Bench Coach' };

export const ARCS = [
  // ── A veteran's last season ───────────────────────────────────
  { key: 'veteran',
    trigger(st, atMs, rand) {
      const n = played(st);
      if (n < 15 || n > 70) return null;
      const yr = baseballYear(st);
      const list = (st.userTeam?.rosterIds || []).map(id => st.players[id])
        .filter(p => p && ours(st, p.id) && computeAge(p.dob, yr) >= 35 && contractIsUp(p, st.seasonNum || 1) && !p.pendingContract);
      return list.length ? { p: pickOf(list, rand).id } : null;
    },
    doneKey: (st, who) => `veteran:${who.p}`,
    alive: (st, arc) => still(st, arc.who.p),
    steps: [
      { build(st, arc) {
        const p = st.players[arc.who.p];
        return { sender: mgr(st), avatar: '📋', tag: 'CULTURE', _targetPlayerId: p.id, _tokenPlayers: { pl_player: p.id },
          subject: `${p.name}'s last season`, preview: `${p.name} told me something in confidence…`,
          body: `${p.name} told me in confidence: this is probably their last season. They'd rather not make a fuss. We could make it a farewell tour anyway — a moment in every park, the fans saying goodbye — or keep it quiet and let them play it out their way.`,
          yesLabel: 'Make It a Farewell Tour', noLabel: 'Keep It Quiet', yesEffect: { atmo: 3 }, noEffect: {},
          yesMsg: 'I\'ll tell them. They\'ll pretend to hate it.', noMsg: 'Quiet it is. They\'ll appreciate that.',
          autoResolve: 'no', _raw: { _relYes: { pl_nm: 1 }, _relNo: { pl_nm: 2 } } };
      } },
      { after: [24, 34], build(st, arc) {
        const p = st.players[arc.who.p], x = p.stats || {};
        const lastAway = (st.schedule || []).filter(g => g._committed && !g.isHome && !g.isSpring).at(-1);
        const city = lastAway ? lastAway.opponent.split(' ').slice(0, -1).join(' ') : null;
        if (arc.picks[0] === 'yes') return news({ sender: 'PR Dept.', avatar: '👏', tag: 'MARKETING', _targetPlayerId: p.id, yesEffect: { atmo: 2 },
          subject: `The farewell tour`, preview: `${p.name}'s farewell tour has been something…`,
          body: `${p.name}'s farewell tour has been something.${city ? ` In ${city}, the fans stood for a full minute when they came up the first time.` : ''} The clubs on the road have been generous, and the players love it more than they let on.` });
        return news({ sender: mgr(st), avatar: '📋', tag: 'CULTURE', _targetPlayerId: p.id,
          subject: `${p.name}, quietly`, preview: `${p.name} is playing like it isn't the last one…`,
          body: `Nobody outside the clubhouse knows, and ${p.name} likes it that way.${enough(p, x) ? ` ${p.name} ${doing(p, x)} this season.` : ''} Playing like it isn't the last one.` });
      } },
      { after: [7, 7], within: 150, when: (st) => REGULAR_SEASON_GAME_COUNT - played(st) <= ARC.veteranGamesLeft, build(st, arc) {
        const p = st.players[arc.who.p];
        return { sender: mgr(st), avatar: '📋', tag: 'ROSTER', _targetPlayerId: p.id, _tokenPlayers: { pl_player: p.id },
          subject: `One more year for ${p.name}?`, preview: `With the season almost over, ${p.name} asked…`,
          body: `With the season almost over, ${p.name} asked me straight: is there one more year here? We can offer one — a one-year deal at what the market says they're worth. Or we let them go out on top, and they retire when the season ends. Either way, they want to hear it from the club.`,
          yesLabel: 'Offer One More Year', noLabel: 'Let Them Go Out on Top', yesEffect: { morale: 1 }, noEffect: { atmo: 2 },
          yesMsg: 'They took it. One more year.', noMsg: 'They took it well. They\'ll go out on top.',
          autoResolve: 'skip', _raw: { onYes: isP(p) ? 'retain_active_pitcher' : 'retain_active_hitter', onNo: 'arc_retire', _relYes: { pl_nm: 2 } },
          _fallback: { sender: mgr(st), avatar: '📋', tag: 'ROSTER', _targetPlayerId: p.id,
            subject: `${p.name}'s last weeks`, preview: `${p.name} knows there isn't another year here…`,
            body: `${p.name} knows we can't make room for another year, and made peace with it before I said a word. They'll retire when the season ends. The last weeks are theirs.`,
            yesLabel: 'Got It', noLabel: null, autoResolve: 'yes', _news: true, yesEffect: {}, _raw: { onYes: 'arc_retire' } } };
      } },
    ] },

  // ── A prospect's rise ─────────────────────────────────────────
  { key: 'prospect',
    trigger(st, atMs, rand) {
      const n = played(st);
      if (n < 20 || n > 100) return null;
      const yr = baseballYear(st);
      const slots = st.userTeam?.lineupSlots || [];
      const starting = new Set(slots.map(x => x?.playerId).filter(Boolean));   // (the lineup is who starts: lineupSlots)
      const list = (st.userTeam?.rosterIds || []).map(id => st.players[id]).filter(p => p && ours(st, p.id) && !isP(p) && !starting.has(p.id)
        && computeAge(p.dob, yr) <= ARC.prospectAge && trueOVR(p) - (p.ovr || 0) >= ARC.prospectUpside)
        .map(p => {
          const ok = eligibleSlotsFor(p);
          const s = slots.filter(x => x?.playerId && ok.includes(x.slot)).map(x => st.players[x.playerId]).filter(Boolean)
            .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0];
          return s ? { p: p.id, starter: s.id } : null;
        }).filter(Boolean);
      return list.length ? pickOf(list, rand) : null;
    },
    doneKey: (st, who) => `prospect:${who.p}`,
    alive: (st, arc) => still(st, arc.who.p) && still(st, arc.who.starter),
    steps: [
      { build(st, arc) {
        const p = st.players[arc.who.p];
        return news({ sender: 'Scouting Dept.', avatar: '🔭', tag: 'SCOUTING', _targetPlayerId: p.id,
          subject: `About ${p.name}`, preview: `We think ${p.name} is better than they've shown…`,
          body: `We think ${p.name} is better than they've shown. The bat speed in batting practice is real, and the at-bats off the bench have been better than the results. It's a small sample. We wanted it on the record.` });
      } },
      { after: [5, 9], build(st, arc) {
        const p = st.players[arc.who.p], s = st.players[arc.who.starter];
        return { sender: mgr(st), avatar: '📋', tag: 'ROSTER', _targetPlayerId: s.id, _tokenPlayers: { audition_hitter: p.id, pl_player: p.id },
          subject: `A week for ${p.name}?`, preview: `I'd like to give ${p.name} a real look…`,
          body: `The scouts like ${p.name}, and so do I. I'd like to give them a real look — a week in the lineup in place of ${s.name}. ${s.name} won't love it. Or we keep the lineup as it is and let ${p.name} keep earning it off the bench.`,
          yesLabel: `Start ${p.name}`, noLabel: 'Keep the Lineup', yesEffect: {}, noEffect: {},
          yesMsg: `${p.name} is in tonight.`, noMsg: 'Lineup stays as it is.',
          autoResolve: 'no', _raw: { onYes: 'audition_promote', _relYes: { pl_nm: 1 } } };
      } },
      { after: [7, 10], build(st, arc) {
        const p = st.players[arc.who.p], s = st.players[arc.who.starter];
        if (arc.picks[1] !== 'yes') return news({ sender: mgr(st), avatar: '📋', tag: 'ROSTER', _targetPlayerId: p.id, _tokenPlayers: { pl_player: p.id },
          subject: `${p.name} asked what it takes`, preview: `${p.name} came by to ask what they need to do to play…`,
          body: `${p.name} came by to ask what they need to do to play. I told them to keep doing what they're doing. They took it like a pro, but they wanted the chance.`, _raw: { _relYes: { pl_nm: -1 } } });
        const x = since(p, arc.at[1]);
        if (!enough(p, x) || !bad(p, x)) return news({ sender: mgr(st), avatar: '📋', tag: 'ROSTER', _targetPlayerId: p.id,
          subject: `${p.name}'s week`, preview: `${p.name} made the most of it…`,
          body: `${p.name} made the most of the week.${enough(p, x) ? ` Since we put them in, ${p.name} ${doing(p, x)}.` : ''} They're staying in the lineup; ${s.name} understands.`, yesEffect: { morale: 1 } });
        return { sender: mgr(st), avatar: '📋', tag: 'ROSTER', _targetPlayerId: p.id, _tokenPlayers: { audition_hitter: s.id },
          subject: `${p.name}'s week`, preview: `It didn't go the way we hoped for ${p.name}…`,
          body: `It didn't go the way we hoped: ${p.name} ${doing(p, x)} since we put them in. I'd put ${s.name} back in and let ${p.name} learn from it. Or we give them another week; sometimes it takes a while.`,
          yesLabel: `Put ${s.name} Back`, noLabel: 'Another Week', yesEffect: {}, noEffect: { morale: -1 },
          yesMsg: `${s.name} is back in tonight.`, noMsg: 'Another week, then.', autoResolve: 'yes', _raw: { onYes: 'audition_promote' } };
      } },
    ] },

  // ── The neighbors ─────────────────────────────────────────────
  { key: 'neighbors',
    trigger(st) {
      const n = played(st);
      const next = (st.schedule || []).find(g => !g._committed && !g.cancelled);
      return n >= 25 && n <= 100 && next?.isHome ? {} : null;
    },
    doneKey: (st) => `neighbors:${st.seasonNum || 1}`,
    alive: () => true,
    steps: [
      { build(st) {
        const k = pay(st, ARC.shuttleShare, 15);
        return { sender: 'Community Relations', avatar: '🏘️', tag: 'MARKETING', _budgetCost: k,
          subject: 'The neighbors and game nights', preview: 'The neighborhood association called again…',
          body: `The neighborhood association called again: cars on their lawns, horns at eleven o'clock, trash on the sidewalks after night games. We could run shuttles from the downtown lots on game nights for the rest of the season — ${fmt(k)} — and get the cars out of their streets. Or we tell them, politely, that it comes with living near a ballpark.`,
          yesLabel: 'Run the Shuttles', noLabel: 'It Comes With the Ballpark', yesEffect: { atmo: 1 }, noEffect: { atmo: -1 },
          yesMsg: 'Shuttles start this homestand.', noMsg: 'We told them. They weren\'t happy.', autoResolve: 'no' };
      } },
      { after: [14, 21], build(st, arc) {
        if (arc.picks[0] === 'yes') return news({ sender: 'Community Relations', avatar: '🏘️', tag: 'MARKETING', yesEffect: { atmo: 2 },
          subject: 'A thank-you from the neighbors', preview: 'The neighborhood association sent a thank-you…',
          body: 'The shuttles are full most nights, and the neighborhood association sent a thank-you. One of them asked whether we could do it again next year. We said we\'d see.' });
        const k = pay(st, ARC.meetShare, 10);
        return { sender: 'Community Relations', avatar: '🏘️', tag: 'MARKETING', _budgetCost: k,
          subject: 'The council is involved now', preview: 'A council member wants a parking fee on game nights…',
          body: `The neighbors took it to the city council, and a council member wants a parking fee on game nights — the kind that keeps walk-up fans away. We could meet with the neighbors ourselves and pay for street cleanup after every game (${fmt(k)}), which would take the air out of it. Or we let the council decide.`,
          yesLabel: 'Meet With the Neighbors', noLabel: 'Let the Council Decide', yesEffect: { atmo: 2 }, noEffect: {},
          yesMsg: 'The meeting is Thursday. We\'ll bring coffee.', noMsg: 'It\'s with the council.', autoResolve: 'no' };
      } },
      { after: [10, 16], build(st, arc) {
        if (arc.picks[0] === 'yes') return null;
        if (arc.picks[1] === 'yes') return news({ sender: 'Community Relations', avatar: '🏘️', tag: 'MARKETING', yesEffect: { atmo: 1 },
          subject: 'The council dropped it', preview: 'The parking fee is off the table…',
          body: 'The parking fee is off the table. The council member said the club had done more than anyone asked. The street cleanup crews have been noticed.' });
        return news({ sender: 'Community Relations', avatar: '🏘️', tag: 'MARKETING', yesEffect: { atmo: -3 },
          subject: 'A parking fee on game nights', preview: 'The council passed the parking fee…',
          body: 'The council passed the parking fee on game nights. The walk-up crowd has already thinned, and the neighbors are still not happy with us.' });
      } },
    ] },

  // ── A coach another club wants ────────────────────────────────
  { key: 'coach',
    trigger(st, atMs, rand) {
      const n = played(st);
      if (n < 60 || n > 120) return null;
      const staff = st.userTeam?.coachingStaff || {};
      const list = Object.keys(ROLE_TITLE).filter(r => staff[r] && !staff[r].vacant && staff[r].name && (staff[r].quality || 0) >= ARC.coachQuality);
      if (!list.length || !(st.leagueTeams || []).length) return null;
      const role = pickOf(list, rand);
      return { role, club: pickOf(st.leagueTeams, rand).id, name: staff[role].name };
    },
    doneKey: (st) => `coach:${st.seasonNum || 1}`,
    alive: (st, arc) => { const c = st.userTeam?.coachingStaff?.[arc.who.role]; return !!c && !c.vacant && c.name === arc.who.name; },
    steps: [
      { build(st, arc) {
        const c = st.userTeam.coachingStaff[arc.who.role], club = st.leagueTeams.find(t => t.id === arc.who.club);
        return { sender: `${c.name} (${ROLE_TITLE[arc.who.role]})`, avatar: '💬', tag: 'STAFF',
          subject: 'Permission to interview', preview: `The ${club.name} asked about me…`,
          body: `The ${club.name} asked for permission to interview me for their manager job after the season. I wanted you to hear it from me first. I'm happy here — but it's the job I've wanted my whole career. It's your call whether I can talk to them.`,
          yesLabel: 'Give Permission', noLabel: 'Ask Them to Wait', yesEffect: {}, noEffect: {},
          yesMsg: 'Thank you. That means a lot.', noMsg: 'Understood. I\'ll tell them.', autoResolve: 'no', _raw: { _relYes: { [{ pitchingCoach: 'pc_nm', hittingCoach: 'hc_nm', benchCoach: 'bc_nm' }[arc.who.role]]: 2 }, _relNo: { [{ pitchingCoach: 'pc_nm', hittingCoach: 'hc_nm', benchCoach: 'bc_nm' }[arc.who.role]]: -3 } } };
      } },
      { after: [10, 18], build(st, arc, rand) {
        const c = st.userTeam.coachingStaff[arc.who.role], club = st.leagueTeams.find(t => t.id === arc.who.club);
        const sender = `${c.name} (${ROLE_TITLE[arc.who.role]})`;
        if (arc.picks[0] !== 'yes') return news({ sender, avatar: '💬', tag: 'STAFF',
          subject: 'About the interview', preview: 'I told them it would have to wait…',
          body: `I told the ${club.name} it would have to wait. I understand why. I'll be honest — it stung — but I'm here, and the work hasn't changed.` });
        if (rand() < ARC.coachGetsJob) return news({ sender, avatar: '💬', tag: 'STAFF', _arcCoachLeaves: true,
          subject: 'The job', preview: `The ${club.name} offered me the job…`,
          body: `The ${club.name} offered me the job, and I've said yes. I'll finish the season with you — every day of it — and I'll leave after the last game. You gave me the chance to try. I won't forget it.` });
        return news({ sender, avatar: '💬', tag: 'STAFF',
          subject: 'The job', preview: `The ${club.name} went another way…`,
          body: `The ${club.name} went another way. Thank you for letting me try; most clubs wouldn't have. I'm all yours.` });
      } },
    ] },

  // ── A clubhouse feud ──────────────────────────────────────────
  { key: 'feud',
    trigger(st, atMs, rand) {
      const n = played(st);
      if (n < 20 || n > 120 || (st.userTeam?.streak || 0) > -ARC.feudStreak) return null;
      // (two of the regular hitters: the one who starts it can be sat a game)
      const list = (st.userTeam?.lineupSlots || []).map(x => x?.playerId).filter(id => ours(st, id));
      if (list.length < 2) return null;
      const a = pickOf(list, rand), b = pickOf(list.filter(x => x !== a), rand);
      return { a, b };
    },
    doneKey: (st) => `feud:${st.seasonNum || 1}`,
    alive: (st, arc) => still(st, arc.who.a) && still(st, arc.who.b),
    steps: [
      { build(st, arc) {
        const a = st.players[arc.who.a], b = st.players[arc.who.b];
        return { sender: mgr(st), avatar: '📋', tag: 'CULTURE',
          subject: `${a.name} and ${b.name}`, preview: `${a.name} and ${b.name} got into it in the clubhouse…`,
          body: `${a.name} and ${b.name} got into it in the clubhouse after the game — words, nothing more, but loud enough that everyone heard. Losing does this. I can sit them down together tomorrow and clear it, or let them work it out themselves, which is how most of these end.`,
          yesLabel: 'Sit Them Down Together', noLabel: 'Let Them Work It Out', yesEffect: { morale: 1 }, noEffect: {},
          yesMsg: 'Tomorrow, before BP.', noMsg: 'I\'ll keep an eye on it.', autoResolve: 'no' };
      } },
      { after: [5, 9], build(st, arc, rand) {
        const a = st.players[arc.who.a], b = st.players[arc.who.b];
        if (arc.picks[0] === 'yes') return news({ sender: mgr(st), avatar: '📋', tag: 'CULTURE', yesEffect: { morale: 2 },
          subject: `${a.name} and ${b.name}, since`, preview: 'The talk worked…',
          body: `The talk worked. ${a.name} and ${b.name} shook on it in front of everyone, and they've been fine since — they were laughing together on the bus yesterday.` });
        if (rand() < ARC.feudFlares) return { sender: mgr(st), avatar: '📋', tag: 'DISCIPLINE', _targetPlayerId: b.id,
          subject: `${a.name} and ${b.name}, again`, preview: 'It flared up again…',
          body: `It flared up again — in the dugout this time, where the cameras could see it. ${b.name} started it. I'd sit ${b.name} for a game to make the point. Or I fine them both and keep everyone on the field.`,
          yesLabel: `Sit ${b.name} a Game`, noLabel: 'Fine Them Both', yesEffect: { morale: 1 }, noEffect: { morale: -1 },
          yesMsg: `${b.name} sits tonight. The message is sent.`, noMsg: 'Fines are in. They\'re both angry at me now, which helps.',
          autoResolve: 'no', _raw: { onYes: 'day_off' } };
        return news({ sender: mgr(st), avatar: '📋', tag: 'CULTURE', yesEffect: { morale: 1 },
          subject: `${a.name} and ${b.name}, since`, preview: 'It blew over…',
          body: `It blew over. ${a.name} and ${b.name} won't be having dinner together, but they're professional about it, and the clubhouse has moved on.` });
      } },
    ] },
];

/** An arc to start now: one whose situation is real, not done before, not already running (or null). */
export function pickArc(state, atMs, rand) {
  const done = state.arcs?.done || {};
  const running = new Set((state.arcs?.active || []).map(a => a.key));
  const ok = [];
  for (const def of ARCS) {
    if (running.has(def.key)) continue;
    const who = def.trigger(state, atMs, rand);
    if (!who) continue;
    if (done[def.doneKey(state, who)] != null) continue;
    ok.push({ def, who });
  }
  return ok.length ? ok[Math.floor(rand() * ok.length)] : null;
}
