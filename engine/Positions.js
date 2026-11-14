/**
 * engine/Positions.js
 * r163 §122.35 phase 1 — where a player can play, the one place every part of
 * the game asks.
 *
 * A hitter has a primary position, a list of positions he's eligible at, and
 * his familiarity with others (practice; phase 2+). DH is open to every hitter
 * and isn't a fielding position (a "DH" primary means a designated hitter who
 * fields nowhere). The outfield is one position, OF.
 *
 * A pitcher has designations (SP, RP; both = a swingman, SP/RP) and a
 * stretched-out level 0–3 (3 = a starter's length; phase 5).
 *
 *   player.positions = { primary: 'SS', elig: ['SS', '2B'], fam: { '3B': 0.4 } }      // hitters
 *   player.positions = { primary: 'SP', roles: ['SP', 'RP'], stretch: 3 }             // pitchers
 *
 * A player without `positions` (a save from before r163) is read from his old
 * label (`nativePos` / `pos`, e.g. "2B/SS", "DH/OF") — the same answers the
 * game gave before. Pure: no imports from the stores; no state.
 *
 * r164 phase 2 — earned in games: `starts` (this regular season, DH too), `touched`
 * (positions practiced or played this season), `lastStarts` (last season's).
 */
import { POSITION_RULES as R } from '../data/constants.js';

export const FIELD_POSITIONS = Object.freeze(['C', '1B', '2B', '3B', 'SS', 'OF']);
const OUTFIELD = /^(LF|CF|RF|OF)$/;
const norm = (x) => (OUTFIELD.test(x) ? 'OF' : x);

export const isPitcher = (p) => p?.pos === 'SP' || p?.pos === 'RP';

/** The old label, split: "2B/SS" → ['2B', 'SS'], "DH/OF" → ['DH', 'OF'], "CF" → ['OF']. */
function _legacy(p) {
  const label = String((p && (p.nativePos || p.pos)) || '');
  return [...new Set(label.split('/').filter(Boolean).map(norm))];
}

/** A player's positions, from his record (or his old label). */
export function positionsOf(p) {
  if (p?.positions) return p.positions;
  const parts = _legacy(p);
  if (isPitcher(p)) {
    const role = p.pos === 'SP' ? 'SP' : 'RP';
    return { primary: role, roles: [role], stretch: role === 'SP' ? 3 : 0 };
  }
  return { primary: parts[0] || 'DH', elig: parts.filter(x => x !== 'DH'), fam: {} };
}

/** A new player's record from his label (PlayerFactory, and a save from before r163 when it's next written). */
export function seedPositions(p) {
  const s = positionsOf({ ...p, positions: null });
  return isPitcher(p) ? { primary: s.primary, roles: [...s.roles], stretch: s.stretch }
                      : { primary: s.primary, elig: [...s.elig], fam: {} };
}

/** The fielding positions a hitter is eligible at (DH not included — it's everyone's). */
export function eligibleAt(p) {
  if (!p || isPitcher(p)) return [];
  return [...(positionsOf(p).elig || [])];
}

/** The lineup slots a hitter can fill: his eligible positions, and DH. */
export function eligibleSlots(p) {
  if (!p || isPitcher(p)) return [];
  return [...new Set([...eligibleAt(p), 'DH'])];
}

/** Can this hitter fill the slot? (DH: any hitter.) */
export function canPlay(p, slot) {
  if (!p || isPitcher(p)) return false;
  const s = norm(slot);
  return s === 'DH' || eligibleAt(p).includes(s);
}

/** A hitter's primary position ('DH' for a designated hitter); a pitcher's primary role. */
export function primaryPos(p) {
  if (!p) return null;
  return positionsOf(p).primary || (isPitcher(p) ? p.pos : 'DH');
}

/** Does `p` cover what `q` plays — the same pitching role, or q's primary position? */
export function coversRole(p, q) {
  if (!p || !q) return false;
  if (isPitcher(q)) return isPitcher(p) && pitchRoles(p).includes(primaryPos(q));
  return canPlay(p, primaryPos(q));
}

/** A pitcher's designations: ['SP'], ['RP'] or ['SP', 'RP']. */
export function pitchRoles(p) {
  if (!isPitcher(p)) return [];
  return [...(positionsOf(p).roles || [p.pos])];
}

/** A pitcher's stretched-out level, 0–3. */
export function stretchOf(p) {
  if (!isPitcher(p)) return 0;
  return positionsOf(p).stretch ?? (p.pos === 'SP' ? 3 : 0);
}

/** A hitter's familiarity with a position he isn't eligible at, 0–1 (phase 2+). */
export function familiarity(p, pos) {
  if (!p || isPitcher(p)) return 0;
  return positionsOf(p).fam?.[norm(pos)] || 0;
}

/**
 * The label everyone reads: primary first, then the other positions
 * ("SS/2B", "DH/OF", "SP/RP"). The same text the old labels gave.
 */
export function posLabel(p) {
  if (!p) return '';
  const s = positionsOf(p);
  if (isPitcher(p)) {
    const roles = s.roles || [p.pos];
    return [s.primary, ...roles.filter(r => r !== s.primary)].join('/');
  }
  const rest = (s.elig || []).filter(x => x !== s.primary);
  return [s.primary, ...rest].join('/');
}

/**
 * A pitcher changes role (a staff card's swap): his label and his designations together.
 * (Phase 5 replaces this with earned designations; until then the role is the designation.)
 */
export function setPitchRole(p, role) {
  if (!isPitcher(p)) return;
  const s = positionsOf(p);
  p.pos = role;
  p.positions = { primary: role, roles: [role], stretch: role === 'SP' ? 3 : (s.stretch ?? 0) };
}

/** A slot a hitter is built for (a new lineup's first pass): his primary, or a position he's eligible at — DH only for a DH. */
export function naturalFor(p, slot) {
  if (!p || isPitcher(p)) return false;
  const s = norm(slot);
  return primaryPos(p) === s || eligibleAt(p).includes(s);
}

// ─────────────────────────────────────────────────────────────
// r164 §122.35 PHASE 2 — EARNED IN GAMES (called on a draft)
// ─────────────────────────────────────────────────────────────

/** The player's own record (made from his label if he has none yet), to change. */
function _own(p) {
  if (!p.positions) p.positions = seedPositions(p);
  const s = p.positions;
  if (!isPitcher(p)) { s.fam ||= {}; s.starts ||= {}; s.touched ||= {}; }
  return s;
}

/** Keep the old label fields in step with the record (anything still reading them reads the truth). */
function _sync(p) { p.pos = posLabel(p); p.nativePos = p.pos; }

/** How hard a position is for this player to pick up: 'easy' (down the spectrum, or 1B), 'hard' (up it), 'C'. */
export function difficulty(p, pos) {
  const x = norm(pos);
  if (x === 'C') return 'C';
  if (x === '1B') return 'easy';
  const s = positionsOf(p);
  const best = Math.max(R.spectrum[s.primary] ?? 0, ...(s.elig || []).map(e => R.spectrum[e] ?? 0));
  return (R.spectrum[x] ?? 0) <= best ? 'easy' : 'hard';
}

/** Regular-season starts at a position this season. */
export const startsAt = (p, pos) => positionsOf(p)?.starts?.[norm(pos)] || 0;

/** More familiarity with a position he isn't eligible at (one practice's or one game's worth). */
export function addFamiliarity(p, pos, steps = 1) {
  const x = norm(pos);
  if (isPitcher(p) || x === 'DH' || eligibleAt(p).includes(x)) return 0;
  const s = _own(p), d = difficulty(p, x);
  const before = s.fam[x] || 0;
  s.fam[x] = Math.min(R.famCap[d], Math.round((before + R.famStep[d] * steps) * 1000) / 1000);
  s.touched[x] = true;
  return s.fam[x] - before;
}

/**
 * recordStart(p, slot, kind) — after a game he started in this slot. 'regular' starts count
 * (10 at a position makes him eligible); spring and postseason starts only build familiarity.
 * @returns {String|null} the position he just became eligible at
 */
export function recordStart(p, slot, kind = 'regular') {
  if (!p || isPitcher(p) || !slot) return null;
  const x = norm(slot), s = _own(p);
  const eligible = x === 'DH' || (s.elig || []).includes(x);
  if (eligible) s.touched[x] = true;
  else addFamiliarity(p, x);
  if (kind !== 'regular') return null;
  s.starts[x] = (s.starts[x] || 0) + 1;
  if (!eligible && s.starts[x] >= R.gainStarts) {
    s.elig = [...(s.elig || []), x];
    delete s.fam[x];
    _sync(p);
    return x;
  }
  return null;
}

/**
 * r168 §122.35 phase 6 — a position (or a pitcher's role) given outright: a club around the league
 * moving a player, a free agent working out somewhere new. The season's keep rules apply as usual.
 * @returns {Boolean} whether anything changed
 */
export function grantPosition(p, pos) {
  if (!p) return false;
  if (isPitcher(p)) {
    if (!['SP', 'RP'].includes(pos)) return false;
    const s = _ownP(p);
    if (s.roles.includes(pos)) return false;
    s.roles = [...s.roles, pos];
    if (pos === 'SP') s.stretch = 3;
    p.nativePos = posLabel(p);
    return true;
  }
  const x = norm(pos);
  if (!FIELD_POSITIONS.includes(x) || eligibleAt(p).includes(x)) return false;
  const s = _own(p);
  s.elig = [...(s.elig || []), x];
  delete s.fam[x];
  _sync(p);
  return true;
}

/** What keeping a position takes, from where he stands now: starts still needed (0 = safe). */
export function keepNeed(p, pos, startsSoFar = null) {
  const s = positionsOf(p), x = norm(pos);
  if (s.primary === x) return 0;
  const n = s.starts?.[x] || 0;
  const total = startsSoFar ?? Object.values(s.starts || {}).reduce((a, b) => a + b, 0);
  if (n >= R.keepStarts || (n >= R.keepMin && total > 0 && n / total >= R.keepShare)) return 0;
  // the fewest more starts there that would do it (each also adds to his total)
  for (let k = 1; k <= R.keepStarts; k++) {
    const m = n + k, t = total + k;
    if (m >= R.keepStarts || (m >= R.keepMin && m / t >= R.keepShare)) return k;
  }
  return R.keepStarts - n;
}

/**
 * seasonTurn(p) — the season is over: he keeps a position with 20 starts there or a quarter of his
 * starts (at least 5); his primary becomes where he started most (always kept); a player who never
 * started (hurt all season) keeps everything. Familiarity built this season carries at half; the
 * rest, and a lost position's, goes.
 * @returns {{ lost: String[], from: String, to: String }|null} what changed (null: nothing)
 */
export function seasonTurn(p) {
  if (!p || isPitcher(p)) return null;
  const s = _own(p);
  const starts = s.starts || {};
  const total = Object.values(starts).reduce((a, b) => a + b, 0);
  const from = s.primary, lost = [];
  if (total > 0) {
    // primary: where he started most (eligible there, or DH); a tie keeps the one he had
    const ranked = Object.entries(starts).filter(([x]) => x === 'DH' || (s.elig || []).includes(x))
      .sort((a, b) => (b[1] - a[1]) || ((b[0] === s.primary) - (a[0] === s.primary)));
    if (ranked.length && ranked[0][1] > (starts[s.primary] || 0)) s.primary = ranked[0][0];
    const keep = (x) => x === s.primary || (starts[x] || 0) >= R.keepStarts
      || ((starts[x] || 0) >= R.keepMin && (starts[x] || 0) / total >= R.keepShare);
    for (const x of s.elig || []) if (!keep(x)) lost.push(x);
    s.elig = (s.elig || []).filter(x => !lost.includes(x));
    if (s.primary !== 'DH' && !s.elig.includes(s.primary)) s.elig = [s.primary, ...s.elig];
  }
  const fam = {};
  for (const [x, v] of Object.entries(s.fam || {})) if (s.touched?.[x] && !lost.includes(x) && v > 0) fam[x] = Math.round(v * R.famCarry * 1000) / 1000;
  s.fam = fam;
  s.lastStarts = starts;
  s.starts = {};
  s.touched = {};
  _sync(p);
  return lost.length || from !== s.primary ? { lost, from, to: s.primary } : null;
}

// ─────────────────────────────────────────────────────────────
// r165 §122.35 PHASE 3 — PLAYING OUT OF POSITION
// ─────────────────────────────────────────────────────────────

/** How exposed a player is at a slot: 0 eligible (or DH), else 1 − familiarity (1 = never played it). */
export function exposure(p, slot) {
  if (!p || isPitcher(p) || norm(slot) === 'DH' || canPlay(p, slot)) return 0;
  return Math.max(0, 1 - familiarity(p, slot));
}

/**
 * defenseOf(lineupSlots, players) — a club's defense for a game: the ground-ball error multiplier
 * (each fielder out of position adds, by exposure) and the catcher's exposure (a non-catcher behind
 * the plate: steals and passed balls). `out` lists who's out of position, for the record.
 */
export function defenseOf(lineupSlots, players) {
  const O = R.oop;
  let errorMult = 1, catcher = 0;
  const out = [];
  for (const sl of lineupSlots || []) {
    const p = sl.playerId ? players[sl.playerId] : null;
    if (!p || sl.slot === 'DH') continue;
    const x = exposure(p, sl.slot);
    if (!x) continue;
    out.push({ id: p.id, slot: sl.slot, exposure: Math.round(x * 100) / 100 });
    errorMult += O.errorPer * x;
    if (sl.slot === 'C') catcher = x;
  }
  return { errorMult: Math.round(errorMult * 1000) / 1000, catcher, out };
}

// ─────────────────────────────────────────────────────────────
// r167 §122.35 PHASE 5 — PITCHERS' DESIGNATIONS (SP, RP; both = a swingman)
// ─────────────────────────────────────────────────────────────
//   positions = { primary: 'SP'|'RP', roles: [...], stretch: 0–3,
//                 relief: n, starts: n (this regular season), lastRelief, lastStarts }

const PR = () => R.pitch;

/** The short-stint boost for a starter working in relief, by age: { stuff, control }. */
export function reliefBoost(p, age) {
  if (!isPitcher(p) || !pitchRoles(p).includes('SP')) return { stuff: 0, control: 0 };
  const row = PR().boost.find(([upTo]) => (age ?? 28) <= upTo) || [0, 0, 0];
  return { stuff: row[1], control: row[2] };
}

/** Days a starter's next start waits after a relief outing (0 for a pitcher who isn't a starter). */
export function reliefPushDays(p) {
  const roles = pitchRoles(p);
  if (!roles.includes('SP')) return 0;
  return roles.includes('RP') ? PR().pushRP : PR().pushNoRP;
}

/** A relief outing's workload multiplier: a starter without RP takes it harder. */
export const reliefLoadMult = (p) => (pitchRoles(p).includes('SP') && !pitchRoles(p).includes('RP') ? PR().extraLoad : 1);

/**
 * recordOuting(p, { start, bf, kind }) — after an outing: regular-season starts and relief outings
 * count toward SP / RP; a start, a long outing, or any spring outing stretches him out a step.
 * @returns {String|null} the designation he just earned
 */
export function recordOuting(p, { start = false, bf = 0, kind = 'regular' } = {}) {
  if (!isPitcher(p)) return null;
  const s = _ownP(p);
  if (start || bf >= PR().longBF || kind === 'spring') s.stretch = Math.min(3, (s.stretch ?? 0) + 1);
  if (kind !== 'regular') return null;
  if (start) s.starts = (s.starts || 0) + 1; else s.relief = (s.relief || 0) + 1;
  const want = start ? 'SP' : 'RP', need = start ? PR().gainStarts : PR().gainRelief;
  if (!s.roles.includes(want) && (start ? s.starts : s.relief) >= need) {
    s.roles = [...s.roles, want];
    if (want === 'SP') s.stretch = 3;
    p.nativePos = posLabel(p);
    return want;
  }
  return null;
}

/** A sim game (the pitching coach's): one step longer. */
export function addStretch(p, steps = 1) {
  if (!isPitcher(p)) return 0;
  const s = _ownP(p), before = s.stretch ?? 0;
  s.stretch = Math.min(3, before + steps);
  return s.stretch - before;
}

function _ownP(p) {
  if (!p.positions) p.positions = seedPositions(p);
  const s = p.positions;
  s.roles ||= [p.pos === 'SP' ? 'SP' : 'RP'];
  s.stretch ??= (s.roles.includes('SP') ? 3 : 0);
  return s;
}

/**
 * pitcherSeasonTurn(p) — SP kept with keepStarts starts last season, RP with keepRelief relief
 * outings; the primary is the one he did more (always kept). A pitcher who never pitched keeps
 * everything. A starter who loses SP keeps a head start (stretched out to keepHead); a reliever's
 * stretch goes back to 0.
 * @returns {{ lost: String[], from, to }|null}
 */
export function pitcherSeasonTurn(p) {
  if (!isPitcher(p)) return null;
  const s = _ownP(p), P = PR();
  const st = s.starts || 0, rl = s.relief || 0, from = s.primary, lost = [];
  if (st + rl > 0) {
    const to = st > rl ? 'SP' : rl > st ? 'RP' : s.primary;
    const keep = (r) => r === to || (r === 'SP' ? st >= P.keepStarts : rl >= P.keepRelief);
    for (const r of s.roles) if (!keep(r)) lost.push(r);
    s.roles = s.roles.filter(r => !lost.includes(r));
    if (!s.roles.includes(to)) s.roles = [to, ...s.roles];
    s.primary = to;
    if (lost.includes('SP')) s.stretch = from === 'SP' ? P.keepHead : 0;
    else if (s.roles.includes('SP')) s.stretch = 3;
    else s.stretch = 0;
  }
  s.lastStarts = st; s.lastRelief = rl; s.starts = 0; s.relief = 0;
  p.pos = s.primary; p.nativePos = posLabel(p);
  return lost.length || from !== s.primary ? { lost, from, to: s.primary } : null;
}

/**
 * r167 §122.35 a new club's swingman: about half of new clubs (by archetype) have a starter on the
 * pitcher bench who has relieved too — SP/RP. The best-stamina one; stretched out already.
 */
const SWING_ODDS = { lab: 0.7, gambler: 0.7, ember: 0.5, contender: 0.5, empire: 0.3, institution: 0.3 };
export function seedSwingman(draft, archetypeId, rand = Math.random) {
  const u = draft.userTeam;
  if (!u || rand() >= (SWING_ODDS[archetypeId] ?? 0.5)) return null;
  const order = new Set(u.rotation?.order || []);
  const p = (u.rosterIds || []).map(id => draft.players[id])
    .filter(x => x && isPitcher(x) && !order.has(x.id) && pitchRoles(x).length === 1 && pitchRoles(x)[0] === 'SP')
    .sort((a, b) => (b.subRatings?.stamina ?? 0) - (a.subRatings?.stamina ?? 0))[0];
  if (!p) return null;
  const rec = (p.positions ||= seedPositions(p));
  rec.roles = ['SP', 'RP'];
  p.nativePos = posLabel(p);   // (p.pos stays the primary role: SP)
  return p.id;
}
