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
 */

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
