/**
 * engine/MessageParts.js
 * r294 §122.177 (foundation step 6) — messages written in parts (the design: §122.176).
 *
 * A message in parts is a message definition whose text fields may be lists of versions, with named parts joined
 * in by `{@name}`:
 *
 *   { id: 'vb_parking_fair', from: 'city:visitors_bureau', sender: 'Visitors Bureau', tag: 'COMMUNITY', …,
 *     parts: {
 *       open:   ['Hope the homestand is treating you well.', { text: 'Us again.', when: { last: 'no' } }, …],
 *       ask:    [ … ], stakes: [ … ], close: [ … ],
 *     },
 *     subject: ['The fair needs a lot', 'Parking for the fair', …],
 *     body:    '{@open} {@ask} {@stakes} {@close}',
 *     yesLabel: ['Share the lot', …], noLabel: [ … ], yesMsg: [ … ], noMsg: [ … ], … }
 *
 * A version is a text, or { text, when } — `when` names the history with the sender it fits (CONDITIONS). Each send:
 *   - the versions that fit the history; if any of those names a condition, only those (the most fitting);
 *   - of them, one not yet used this round, drawn by the save's dice: shuffled rounds (the user's choice, §122.177):
 *     every fitting version is used once before any comes back, each piece in its own order each round, so the
 *     pieces don't fall into step and the whole message doesn't come round again; a new round never opens with the
 *     version that closed the last.
 * The result is an ordinary message definition (`_from`, `_parts` added), which goes on through _createInstance,
 * the tokens and Entry as any message does. A definition without parts or versions comes back as it was.
 *
 * `from`, whose history it is:
 *   'staff:manager' | 'staff:pitchingCoach' | 'staff:hittingCoach' | 'staff:benchCoach' | 'staff:scoutingDirector'
 *   | 'owner' | 'gm:<teamId>' — a person: the one in that job now, by id (Senders stamps `_senderId` on every message
 *   from them, so all their messages count, and someone new in the job starts afresh);
 *   any other key ('city:visitors_bureau', 'sponsor:…') — a party outside the club, by the key on its messages (`_from`).
 *
 * The history (historyWith) is read from the messages that came and how they were answered: the inbox and the
 * notes (§122.174). The memory step (§122.169) adds what came of them, behind the same function.
 * The versions used are remembered per save (state.partsUsed[id] = { n, [field]: { seen: [this round's], last },
 * season, sends: [this season's picks] }), recorded at Entry when a message reaches Messages; the sends keep the next
 * from reading alike an earlier one of the season (READ_ALIKE, r295 §122.178).
 *
 * PURE: no StateManager.
 */
import { dice, diceSeed } from './Dice.js';
import { withHistory } from './MessageHistory.js';

const DAY = 86_400_000;

/** The text fields that may be lists of versions (and may join parts in). */
export const TEXT_FIELDS = Object.freeze(['subject', 'preview', 'body', 'sender', 'yesLabel', 'noLabel', 'yesMsg', 'noMsg', '_expireMsg']);
/** The parts every new message has, each with at least MIN_VERSIONS versions (the user's choice). */
export const CORE_PARTS = Object.freeze(['open', 'ask', 'stakes', 'close']);
export const MIN_VERSIONS = 3;
/** What a version's `when` may name. */
export const CONDITIONS = Object.freeze({
  first:            'the first message from them (true), or not the first (false)',
  last:             "how the last one was answered: 'yes', 'no' or 'ignored' (left to its deadline)",
  mostly:           "'yes' or 'no': two of three answers or more, of at least two",
  timesAtLeast:     'messages from them before this one, at least',
  timesAtMost:      '…at most',
  seasonAtLeast:    'messages from them this season before this one, at least',
  seasonAtMost:     '…at most',
  daysSinceAtLeast: 'days since their last message, at least',
  daysSinceAtMost:  '…at most',
});
const STAFF = new Set(['manager', 'pitchingCoach', 'hittingCoach', 'benchCoach', 'scoutingDirector']);
const PART_REF = /\{@([a-zA-Z_][\w]*)\}/g;
const HAS_PART_REF = /\{@[a-zA-Z_]\w*\}/;   // (not global: .test keeps no place)

/** Is this a message written in parts (versions, parts or a `from`)? */
export function isParts(def) {
  return !!def && (!!def.parts || def.from != null || TEXT_FIELDS.some(f => Array.isArray(def[f])));
}

/** The person `from` names now (an id), or null for a party outside the club. */
export function personOf(state, from) {
  const f = String(from || '');
  const ut = state?.userTeam;
  if (f.startsWith('staff:')) { const role = f.slice(6); if (!STAFF.has(role)) return null; const c = ut?.coachingStaff?.[role]; return c && !c.vacant ? c.id || null : null; }
  if (f === 'owner') return ut?.ownerId || null;
  if (f.startsWith('gm:')) return (state?.leagueTeams || []).find(t => t.id === f.slice(3))?.gm?.id || null;
  return null;
}

const _answer = (c) => {
  if (!c.resolved) return null;
  if (c.choice === 'auto' || c.choice === 'skip' || c.choice === 'expired') return 'ignored';
  if (c.choice === 'no') return 'no';
  return 'yes';   // yes, or a choice made
};

/** The club's history with `from` at `atMs`: what came from them, and how it was answered. */
export function historyWith(state, from, atMs) {
  const id = personOf(state, from);
  const season = state?.seasonNum || 1;
  const theirs = withHistory(state)
    .filter(c => (c._from === from || (id && c._senderId === id)) && Number.isFinite(c.arrivedAtMs) && c.arrivedAtMs <= atMs)
    .sort((a, b) => a.arrivedAtMs - b.arrivedAtMs);
  const answers = theirs.map(_answer).filter(Boolean);
  const yes = answers.filter(a => a === 'yes').length, no = answers.filter(a => a === 'no').length;
  const last = theirs[theirs.length - 1] || null;
  return {
    times: theirs.length,
    season: theirs.filter(c => (c._season ?? season) === season).length,
    last: last ? _answer(last) : null,
    yes, no, ignored: answers.filter(a => a === 'ignored').length,
    mostly: yes + no >= 2 ? (yes * 3 >= (yes + no) * 2 ? 'yes' : no * 3 >= (yes + no) * 2 ? 'no' : null) : null,
    daysSince: last ? (atMs - last.arrivedAtMs) / DAY : null,
  };
}

/** Does `when` hold for history `h`? An unknown condition throws (partsProblems finds it first). */
export function holds(when, h) {
  for (const [k, v] of Object.entries(when || {})) {
    switch (k) {
      case 'first': if ((h.times === 0) !== !!v) return false; break;
      case 'last': if (h.last !== v) return false; break;
      case 'mostly': if (h.mostly !== v) return false; break;
      case 'timesAtLeast': if (h.times < v) return false; break;
      case 'timesAtMost': if (h.times > v) return false; break;
      case 'seasonAtLeast': if (h.season < v) return false; break;
      case 'seasonAtMost': if (h.season > v) return false; break;
      case 'daysSinceAtLeast': if (h.daysSince != null && h.daysSince < v) return false; break;
      case 'daysSinceAtMost': if (h.daysSince == null || h.daysSince > v) return false; break;
      default: throw new Error(`MessageParts: unknown condition '${k}'`);
    }
  }
  return true;
}

const _versions = (x) => (Array.isArray(x) ? x : [x]).map(v => (typeof v === 'string' ? { text: v } : v));

/**
 * Pick one of `list` (versions) for this history: the most fitting; of them, one not used this round, by the dice.
 * → { text, i, fresh } (fresh: it opens a new round), or null when none fits.
 */
function _pick(list, h, used, rand, relax = false) {
  const vs = _versions(list).map((v, i) => ({ ...v, i }));
  const fit = vs.filter(v => holds(v.when, h));
  if (!fit.length) return null;
  const named = fit.filter(v => v.when && Object.keys(v.when).length);
  const pool = named.length ? named : fit;
  const seen = new Set(relax ? [] : used?.seen || []);   // (relaxed: any but the last, to keep from reading alike)
  let fresh = false, open = relax ? (pool.length > 1 ? pool.filter(v => v.i !== used?.last) : pool) : pool.filter(v => !seen.has(v.i));
  if (!open.length) {   // the round is done: a new one, not opening with the version that closed the last
    fresh = true;
    open = pool.length > 1 ? pool.filter(v => v.i !== used?.last) : pool;
  }
  const v = open[Math.floor(rand() * open.length)];
  return { text: v.text, i: v.i, fresh: fresh && !relax };
}

/** r295 §122.178 reading alike: the three-word runs of a text, and the share two texts have in common (0–1). */
export const READ_ALIKE = 0.6;
export function wordRuns(text) {
  const w = String(text || '').toLowerCase().replace(/[^a-z0-9$' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}
export function alike(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  const [x, y] = a.size < b.size ? [a, b] : [b, a];
  for (const r of x) if (y.has(r)) n++;
  return n / (a.size + b.size - n);
}
/** How many draws compose tries for one that doesn't read alike an earlier send of the season. */
const TRIES = 12;
/** The sends of a season kept for that (a message in parts comes a few times a season). */
const SENDS_KEPT = 40;

/** The subject and body a set of picks gives (before the tokens): what reading alike is judged on. */
function _words(def, picks) {
  const parts = {};
  for (const [name, list] of Object.entries(def.parts || {})) { const v = _versions(list)[picks[`@${name}`]]; if (v) parts[name] = v.text; }
  const field = (f) => { const t = Array.isArray(def[f]) ? _versions(def[f])[picks[f]]?.text : def[f]; return String(t || '').replace(PART_REF, (_, k) => parts[k] ?? ''); };
  return `${field('subject')} ${field('body')}`;
}

/**
 * compose(def, state, atMs) → an ordinary message definition, or null (warned) when it can't be put together
 * (no version fits a part, or a part it joins in isn't there). A definition not in parts comes back as it is.
 * r295 §122.178 the per-save memory keeps two from reading alike (§122.169): of up to TRIES draws (each by the round
 * rules), the first that reads alike no earlier send of the season (READ_ALIKE). If none can (late in a round every
 * piece may have one version left), one piece may take a version used earlier in its round (never its last) — the
 * piece that keeps them apart; failing that, the least alike.
 */
export function compose(def, state, atMs) {
  if (!isParts(def)) return def;
  const h = def.from != null ? historyWith(state, def.from, atMs) : historyWith(state, `msg:${def.id}`, atMs);
  const memo = state?.partsUsed?.[def.id] || {};
  const n = memo.n || 0;
  const season = state?.seasonNum || 1;
  const before = (memo.season === season ? memo.sends || [] : []).map(p => wordRuns(_words(def, p)));
  const draw = (k, relax = null) => {
    const picks = {}, fresh = [];
    const choose = (field, list) => {
      const v = _pick(list, h, memo[field], dice(diceSeed(state), 'parts', def.id, field, n, ...(k ? [k] : []), ...(relax ? ['relax'] : [])), field === relax);
      if (!v) throw new Error(`no version of '${field}' fits`);
      picks[field] = v.i;
      if (v.fresh) fresh.push(field);
      return v.text;
    };
    const parts = {};
    for (const [name, list] of Object.entries(def.parts || {})) parts[name] = choose(`@${name}`, list);
    const join = (text, field) => String(text).replace(PART_REF, (_, name) => {
      if (!(name in parts)) throw new Error(`'${field}' joins in {@${name}}, which isn't a part`);
      return parts[name];
    });
    const out = { ...def };
    delete out.parts; delete out.from;
    for (const f of TEXT_FIELDS) {
      if (def[f] == null) continue;
      const text = Array.isArray(def[f]) ? choose(f, def[f]) : def[f];
      out[f] = join(text, f);
    }
    out._from = def.from != null ? def.from : null;
    out._parts = picks;
    if (fresh.length) out._partsRound = fresh;   // (the fields a new round opens on)
    if (relax) out._partsRelaxed = relax;        // (the piece bent to keep it from reading alike)
    const mine = wordRuns(_words(def, picks));
    return { out, score: before.reduce((m, r) => Math.max(m, alike(mine, r)), 0) };
  };
  try {
    let best = null;
    for (let k = 0; k < TRIES; k++) {
      const d = draw(k);
      if (!best || d.score < best.score) best = d;
      if (d.score < READ_ALIKE) return d.out;
    }
    // Every draw by the rounds reads alike an earlier send (late in a round, each piece has one version left):
    // one piece may take a version used earlier in its round (never its last), the one that keeps them apart.
    const fields = [...Object.keys(def.parts || {}).map(k => `@${k}`), ...TEXT_FIELDS.filter(f => Array.isArray(def[f]))];
    for (const f of fields) for (let k = 0; k < TRIES; k++) {
      const d = draw(k, f);
      if (d.score < best.score) best = d;
      if (d.score < READ_ALIKE) return d.out;
    }
    return best.out;
  } catch (e) {
    console.warn(`[MessageParts] '${def.id}' not put together: ${e.message}`);
    return null;
  }
}

/** Remember the versions a message used (inside a mutate; at Entry, when it reaches Messages). */
export function recordUse(draft, card) {
  if (!card?._parts || !card.cardId) return;
  const all = (draft.partsUsed ||= {});
  const m = (all[card.cardId] ||= { n: 0 });
  const fresh = new Set(card._partsRound || []);
  for (const [field, i] of Object.entries(card._parts)) {
    const f = (m[field] ||= { seen: [], last: null });
    f.seen = fresh.has(field) ? [i] : [...f.seen, i];
    f.last = i;
  }
  // r295 §122.178 this season's sends (their picks), so the next doesn't read alike any of them
  const season = draft.seasonNum || 1;
  if (m.season !== season) { m.season = season; m.sends = []; }
  m.sends = [...m.sends, card._parts].slice(-SENDS_KEPT);
  m.n++;
}

/**
 * What's wrong with a message in parts (a list; empty when it's right): a field or part with no versions, a version
 * without text, an unknown condition, a {@part} that isn't one, a core part with fewer than MIN_VERSIONS versions,
 * or a `from` that names no one.
 */
export function partsProblems(def) {
  const out = [];
  const id = def?.id || '?';
  const parts = def?.parts || {};
  const checkList = (where, list) => {
    const vs = Array.isArray(list) ? list : [list];
    if (!vs.length) out.push(`${id}.${where}: no versions`);
    vs.forEach((v, i) => {
      const t = typeof v === 'string' ? v : v?.text;
      if (typeof t !== 'string' || !t.trim()) out.push(`${id}.${where}[${i}]: no text`);
      for (const k of Object.keys((typeof v === 'object' && v?.when) || {})) if (!(k in CONDITIONS)) out.push(`${id}.${where}[${i}]: unknown condition '${k}'`);
      for (const [, name] of String(t || '').matchAll(PART_REF)) if (!(name in parts)) out.push(`${id}.${where}[${i}]: {@${name}} isn't a part`);
    });
  };
  for (const [name, list] of Object.entries(parts)) {
    checkList(`parts.${name}`, list);
    if (_versions(list).some(v => HAS_PART_REF.test(v?.text || ''))) out.push(`${id}.parts.${name}: a part can't join in another`);
  }
  for (const f of TEXT_FIELDS) if (def?.[f] != null) checkList(f, def[f]);
  for (const name of CORE_PARTS) {
    const n = Array.isArray(parts[name]) ? parts[name].length : parts[name] != null ? 1 : 0;
    if (n < MIN_VERSIONS) out.push(`${id}.parts.${name}: ${n} version${n === 1 ? '' : 's'} (at least ${MIN_VERSIONS})`);
  }
  const f = def?.from;
  if (f == null) out.push(`${id}: no \`from\` (whose history it is)`);
  else if (typeof f !== 'string' || !f.trim()) out.push(`${id}: \`from\` isn't a key`);
  else if (f.startsWith('staff:') && !STAFF.has(f.slice(6))) out.push(`${id}: \`from\` names no staff job ('${f}')`);
  return out;
}
