/**
 * engine/NameRules.js — r284 §122.163 what a person can be renamed to.
 *
 *   nameProblem(state, id, name)  → null (fine) or the reason, in words
 *   cleanName(name)               the name as it would be kept (spaces trimmed and single)
 *
 * A name is 2–24 characters: letters, with spaces, hyphens, apostrophes or periods between them; it starts with a
 * capital. It can't be one anyone in the league goes by or has gone by (the staff, owners, managers, GMs, the
 * managers' market), a player's, or a club's (city, nickname or name). And a one-word name can't be a word the
 * game's messages use ("Rain", "Sunday"): names show as they are now wherever they were written, by the word.
 */
import { namesInUse } from './People.js';
import * as Pool from '../data/cards-pool.js';
import * as Moments from '../data/cards-moments.js';
import * as Money from '../data/cards-money.js';
import * as Away from '../data/cards-away.js';
import * as Winter from '../data/cards-winter.js';
import * as FirstDay from '../data/cards-first-day.js';
import * as Emergency from '../data/cards-emergency.js';
import * as Profile from '../data/cards-profile.js';

let _vocab = null;
/** Every word the game's written messages use (lower case). */
function _words() {
  if (_vocab) return _vocab;
  _vocab = new Set();
  const seen = new Set();
  const walk = (x) => {
    if (typeof x === 'string') { for (const w of x.toLowerCase().match(/\p{L}+/gu) || []) _vocab.add(w); return; }
    if (!x || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    for (const v of Array.isArray(x) ? x : Object.values(x)) walk(v);
  };
  for (const m of [Pool, Moments, Money, Away, Winter, FirstDay, Emergency, Profile]) walk(Object.values(m));
  for (const w of ['today', 'tonight', 'tomorrow', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'manager', 'coach', 'owner', 'scouting', 'director', 'front', 'office', 'rain', 'delay', 'game', 'final', 'win', 'loss']) _vocab.add(w);
  return _vocab;
}

/** The name as it would be kept. */
export function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim();
}

/** Why `name` can't be person `id`'s new name (null: it can). */
export function nameProblem(state, id, name) {
  const n = cleanName(name);
  const p = state?.people?.[id];
  if (!p) return 'Nobody to rename.';
  if (!n) return 'Enter a name.';
  if (n === p.name) return 'That\'s the name already.';
  if (n.length < 2 || n.length > 24) return 'Use 2 to 24 characters.';
  if (!/^\p{Lu}[\p{L}'’. -]*\p{L}\.?$/u.test(n) || /[ '’.-]{2}/u.test(n)) return 'Use letters, starting with a capital (spaces, hyphens and apostrophes between them).';
  const lower = n.toLowerCase();
  const others = [...namesInUse(state)].filter(x => x !== p.name && !(p.aka || []).includes(x));
  if (others.some(x => x.toLowerCase() === lower)) return 'Someone in the league already goes by that name.';
  if (Object.values(state.players || {}).some(x => String(x?.name || '').toLowerCase() === lower)) return 'A player goes by that name.';
  const clubs = [state.userTeam, ...(state.leagueTeams || [])].filter(Boolean).flatMap(t => [t.name, t.city, t.nickname, t.abbr]).filter(Boolean).map(x => String(x).toLowerCase());
  if (clubs.includes(lower)) return 'A club goes by that name.';
  if (!/\s/.test(n) && _words().has(lower)) return 'That\'s a word the game uses. Pick a name that isn\'t.';
  return null;
}
