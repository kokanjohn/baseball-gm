/**
 * engine/Names.js
 * §82 Last names only. PURE — takes the players map, returns names.
 *
 * Nobody in the game has a first name. A player is known by a last name; a
 * player whose last name is already worn by someone in the league (anyone
 * not departed) gets a first initial — "E. Tejada" — the way a box score
 * tells two players apart. The name is fixed for the player's career, and no
 * two players in the league ever share one.
 */

import { PLAYER_SURNAMES } from '../data/player-names.js';
import { PLAYER_GROUP } from '../data/constants.js';

// Initials in rough proportion to how often they start a name.
const INITIALS = 'AAABBBCCCDDDEEFFGGHHJJJKKLLLMMMMNNOPPRRRSSSSTTVWWYZ';

const _isActive = (p) => p && p.group !== PLAYER_GROUP.DEPARTED;

/** Names in use (by anyone not departed). */
export function namesInUse(players) {
  const set = new Set();
  for (const p of Object.values(players || {})) if (_isActive(p) && p.name) set.add(p.name);
  return set;
}

/** The last name inside a display name ("E. Tejada" → "Tejada"). */
export function surnameOf(name) {
  return String(name || '').replace(/^[A-Z]\.\s+/, '');
}

/**
 * uniqueName(surname, used) — the surname alone when nobody wears it (or
 * any initialed form of it); otherwise the surname with a first initial no
 * one has. Adds the result to `used`.
 */
export function uniqueName(surname, used, rand = Math.random) {
  const clash = [...used].some(n => surnameOf(n) === surname);
  let name = surname;
  if (clash) {
    const letters = [...new Set(INITIALS)];
    const start = Math.floor(rand() * INITIALS.length);
    const order = [INITIALS[start], ...letters.sort(() => rand() - 0.5)];
    name = order.map(l => `${l}. ${surname}`).find(n => !used.has(n)) || `${surname} ${used.size}`;
  }
  used.add(name);
  return name;
}

/**
 * newPlayerName(players, rand) — a name for a new player: a last name no
 * one in the league wears when there is one left, else an initialed one.
 */
export function newPlayerName(players, rand = Math.random) {
  const used = namesInUse(players);
  const surnames = new Set([...used].map(surnameOf));
  const free = PLAYER_SURNAMES.filter(s => !surnames.has(s));
  const pool = free.length ? free : PLAYER_SURNAMES;
  return uniqueName(pool[Math.floor(rand() * pool.length)], used, rand);
}

/**
 * lastNameOnly(fullName) — §82 migration: "Gilberto De Paula" → "De Paula".
 * A name already without a first name (or an initialed one) is kept.
 */
export function lastNameOnly(fullName) {
  const n = String(fullName || '').trim();
  if (/^[A-Z]\.\s/.test(n) || !n.includes(' ')) return n;
  return n.slice(n.indexOf(' ') + 1);
}

/**
 * renameLeague(players) — §82 migration for a save made before last names:
 * every player becomes a last name, kept unique the same way new names are
 * (a club's own players are settled first, in id order, so it is stable).
 * Mutates the players. Returns the number renamed.
 */
export function renameLeague(players) {
  const used = new Set();
  let n = 0;
  const all = Object.values(players || {}).filter(p => p?.name)
    .sort((a, b) => (_isActive(b) - _isActive(a)) || String(a.id).localeCompare(String(b.id)));
  for (const p of all) {
    const next = uniqueName(lastNameOnly(p.name), used);
    if (next !== p.name) { p.name = next; n++; }
  }
  return n;
}
