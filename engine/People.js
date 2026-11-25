/**
 * engine/People.js — r281 §122.160 every named person in the league has an id: our staff (the manager, the coaches,
 * the scouting director) and our owner, every club's manager and GM, and the managers on the market. A person keeps
 * the id wherever they go (let go by one club, hired by another; our manager to the market). The name is what they're
 * called; the id is who they are — what the game compares (a storyline's coach, who left the chair).
 *
 *   state.people = { [id]: { id, name, role, clubId, since, left } }
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
  if (!who.id) who.id = newPersonId(draft);
  const people = draft.people || (draft.people = {});
  const was = people[who.id];
  people[who.id] = { id: who.id, name: who.name, role, clubId: clubId ?? null, since: was && was.clubId === clubId && was.role === role ? was.since : (season ?? null), left: null };
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

/** Is `a` the same person as `b` (by id; by name only for someone from before r281 with no id)? */
export function samePerson(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return !!a.name && a.name === b.name;
}
