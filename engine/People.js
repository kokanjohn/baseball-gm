/**
 * engine/People.js — r281 §122.160 every named person in the league has an id: our staff (the manager, the coaches,
 * the scouting director) and our owner, every club's manager and GM, and the managers on the market. A person keeps
 * the id wherever they go (let go by one club, hired by another; our manager to the market). The name is what they're
 * called; the id is who they are — what the game compares (a storyline's coach, who left the chair).
 *
 *   state.people = { [id]: { id, name, aka, role, clubId, since, left } }
 *     aka: the names they went by before (r283 §122.162: a message that says one of them shows the name now)
 *     role: 'manager' | 'pitchingCoach' | 'hittingCoach' | 'benchCoach' | 'scoutingDirector' | 'owner' | 'gm'
 *     clubId: 'user' | a club's id | null (on the market); since / left: seasons (left: null while there)
 *   state._personSeq — the last id handed out (ids are 'pp1', 'pp2', … : no draw on any random stream)
 *
 * Everyone who ever worked for us stays in the record (clubId 'user', `left` set), so what they wrote can always be
 * traced to them. Pure: takes the state (or a draft to change).
 */

/** A new person id (on a draft). */
export function newPersonId(draft) {
  draft._personSeq = (draft._personSeq || 0) + 1;
  return `pp${draft._personSeq}`;
}

/** The person with this id (null: unknown). */
export function personOf(state, id) {
  return (id && state?.people?.[id]) || null;
}

/** What the person is called now ('' if unknown). */
export function nameOf(state, id) {
  return personOf(state, id)?.name || '';
}

/**
 * The person `who` ({ id?, name }) takes a job: an id if they have none yet (set on `who` itself), and the record
 * updated — the role, the club, since when. Returns the id.
 */
export function enroll(draft, who, { role, clubId, season }) {
  if (!who || !who.name) return null;
  const isNew = !who.id || !draft.people?.[who.id];
  if (!who.id) who.id = newPersonId(draft);
  const people = draft.people || (draft.people = {});
  const was = people[who.id];
  people[who.id] = { ...(was || {}), id: who.id, name: who.name, role, clubId: clubId ?? null, since: was && was.clubId === clubId && was.role === role ? was.since : (season ?? null), left: null };
  if (isNew) _linkMessages(draft, who.id, who.name);   // r284 §122.163 what was written about them before
  return who.id;
}

/** The person leaves their job (`left`: the season); they stay in the record. */
export function leave(draft, id, season) {
  const p = draft?.people?.[id];
  if (p && p.left == null) p.left = season ?? null;
}

/** The person goes to the managers' market (no club). */
export function toMarket(draft, id, season) {
  const p = draft?.people?.[id];
  if (!p) return;
  if (p.clubId === 'user' && p.left == null) p.left = season ?? null;
  p.clubId = null;
  p.role = 'manager';
}

/**
 * r283 §122.162 the person is called something else from now on: the record (the old name kept in `aka`) and every
 * place that holds them by name — our staff and owner, a club's manager or GM, the managers' market. Returns the
 * old name (null: unknown person or the same name).
 */
export function renamePerson(draft, id, name) {
  const p = draft?.people?.[id];
  const next = String(name || '').trim();
  if (!p || !next || p.name === next) return null;
  const old = p.name;
  p.aka = [...new Set([...(p.aka || []), old])].filter(n => n !== next);
  p.name = next;
  const u = draft.userTeam || {};
  for (const c of Object.values(u.coachingStaff || {})) if (c?.id === id) c.name = next;
  if (u.ownerId === id) u.ownerName = next;
  for (const t of draft.leagueTeams || []) { if (t.manager?.id === id) t.manager.name = next; if (t.gm?.id === id) t.gm.name = next; }
  for (const m of draft.managerPool || []) if (m?.id === id) m.name = next;
  return old;
}

// ── r284 §122.163 names everywhere ──────────────────────────────────────────────────────────────────────────────

const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const _wordRe = (alts, flags = 'u') => new RegExp(`(^|[^\\p{L}\\p{N}])(${alts})(?=$|[^\\p{L}\\p{N}])`, flags);

/** Every name anyone in the record goes by or has gone by (no one new may take one of them). */
export function namesInUse(state) {
  const out = new Set();
  for (const p of Object.values(state?.people || {})) { if (p.name) out.add(p.name); for (const a of p.aka || []) out.add(a); }
  return out;
}

/**
 * Text written before a rename (the activity feed, the league wire, anything kept as words), with each old name
 * reading as the person's name now. Only a name that was one person's alone and isn't anyone's now, nor a player's.
 */
export function liveText(state, text) {
  if (!text || !state?.people) return text;
  const owners = new Map(), current = new Set();
  for (const p of Object.values(state.people)) { current.add(p.name); for (const a of p.aka || []) owners.set(a, owners.has(a) ? null : p); }
  const map = new Map();
  let players = null;
  for (const [a, p] of owners) {
    if (!p || current.has(a)) continue;
    players ||= new Set(Object.values(state.players || {}).map(x => x?.name));
    if (!players.has(a)) map.set(a, p.name);
  }
  if (!map.size) return text;
  const re = _wordRe([...map.keys()].sort((x, y) => y.length - x.length).map(_esc).join('|'), 'gu');
  return String(text).replace(re, (m, pre, nm) => pre + map.get(nm));
}

/**
 * Messages that named someone before they had an id (a candidate, written about before they were hired): noted now,
 * so they read the person's name from here on (`_people`). A name another person in the record shares, or a player's,
 * is left alone.
 */
function _linkMessages(draft, id, name) {
  const others = Object.values(draft.people || {}).some(p => p.id !== id && (p.name === name || (p.aka || []).includes(name)));
  if (others || Object.values(draft.players || {}).some(x => x?.name === name)) return;
  const re = _wordRe(_esc(name));
  for (const c of draft.inbox || []) {
    if (c._people?.[id]) continue;
    const text = [c.sender, c.subject, c.preview, c.body, c.yesLabel, c.noLabel, c._autoLabel, c._summary, c._followUp?.text,
      ...(c._choices || []).flatMap(x => [x?.label, x?.sub])].filter(Boolean).join('\n');
    if (re.test(text)) c._people = { ...(c._people || {}), [id]: name };
  }
}

/** Is `a` the same person as `b` (by id; by name only for someone from before r281 with no id)? */
export function samePerson(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return !!a.name && a.name === b.name;
}
