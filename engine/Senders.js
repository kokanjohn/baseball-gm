/**
 * engine/Senders.js
 * r212 §122.90 Who a message is from, the same way everywhere: a person is "Name, Role" (Ferreira, Scouting
 * Director · Calloway, Owner · Morello, Gulfport Mullets GM); a department or an office stays as it is
 * (Pro Scouting, Ticket Office, Team Physician, a player's agent).
 *
 * The sender a card carries is left as written (the engine and its checks speak in names). What it is shown
 * as comes from here: the inbox, the reading pane, the Completed tab, the toast and the phone's push.
 * The role is stamped when a message arrives (`_senderRole`), so a manager who has since been let go still
 * reads "Hollandale, Manager" on the old messages.
 *
 * r235 §122.114 Scouting: every scouting message is written as from 'Scouting' (and saves from before carry 'Pro
 * Scouting', 'Scouting Dept.', 'Scout Dept.', 'International Scouting', 'Amateur Scouting'). It's shown as the
 * scouting director, "Ferreira, Scouting Director" — the director when it arrived (stamped), or the current one for a
 * message from before r235 — and as "Scouting" while the job is vacant.
 *
 * PURE: no StateManager.
 */

const STAFF_ROLES = Object.freeze([
  ['manager', 'Manager'], ['pitchingCoach', 'Pitching Coach'], ['hittingCoach', 'Hitting Coach'],
  ['benchCoach', 'Bench Coach'], ['scoutingDirector', 'Scouting Director'],
]);

const PAREN = /^(.+?) \(([^()]+)\)$/;

/** r235 §122.114 the scouting department's names, then and now. */
const SCOUTING = new Set(['Scouting', 'Pro Scouting', 'Scouting Dept.', 'Scout Dept.', 'International Scouting', 'Amateur Scouting']);
const _director = (state) => { const d = state?.userTeam?.coachingStaff?.scoutingDirector; return d && !d.vacant && d.name ? d.name : null; };

/** A message from the scouting department (by whatever name it was written), or from the scouting director. */
export function fromScouting(card, state) {
  const s = String(card?.sender || '').trim();
  if (SCOUTING.has(s)) return true;
  return (card?._senderRole || roleOf(s, state)) === 'Scouting Director' || /, Scouting Director$/.test(s);
}   // "Hollandale (Manager)", "Morello (Gulfport Mullets GM)"

/** The role of the person a sender names, from the club as it stands (null: not one of our people, or a department). */
export function roleOf(sender, state) {
  const s = String(sender || '').trim();
  if (!s || s.includes(',')) return null;
  const m = s.match(PAREN);
  if (m) return m[2];
  const ut = state?.userTeam;
  if (ut?.ownerName && s === ut.ownerName) return 'Owner';
  for (const [k, role] of STAFF_ROLES) if (ut?.coachingStaff?.[k]?.name === s) return role;
  return null;
}

// ── r283 §122.162 names as they are now ──────────────────────────────────────────────────────────────────────
// A message keeps the text it was written with. When it arrives, the people it names are noted (`_people`: { id:
// the name it says }); when it's shown, every name those people have gone by reads as the name they have now. A
// place that shows a message without this shows the name as it was written — never a code.

const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const _word = (name) => new RegExp(`(^|[^\\p{L}\\p{N}])${_esc(name)}(?=$|[^\\p{L}\\p{N}])`, 'u');

/** The text a message shows (all of it, for finding names in). */
function _allText(card) {
  return [card.sender, card.subject, card.preview, card.body, card.yesLabel, card.noLabel, card._autoLabel,
    card._summary, card._followUp?.text, ...(card._choices || []).flatMap(c => [c?.label, c?.sub])].filter(Boolean).join('\n');
}

/**
 * The people a message names: { id: the name as written }, from everyone in the record (any name they've gone by).
 * A name that's also a player's is left alone unless it's the sender (it may be the player's).
 */
export function peopleIn(card, state) {
  const text = _allText(card);
  if (!text || !state?.people) return {};
  // (each name to the people who've gone by it: a name two people share is the sender's if one is the sender,
  //  else nobody's — left as written)
  const byName = new Map();
  for (const p of Object.values(state.people)) for (const nm of new Set([p.name, ...(p.aka || [])])) if (nm) byName.set(nm, [...(byName.get(nm) || []), p.id]);
  let players = null;
  const out = {};
  for (const [nm, ids] of byName) {
    if (!_word(nm).test(text)) continue;
    const id = ids.includes(card._senderId) ? card._senderId : ids.length === 1 ? ids[0] : null;
    if (!id || out[id]) continue;
    if (id !== card._senderId) {
      players ||= new Set(Object.values(state.players || {}).map(x => x?.name));
      if (players.has(nm)) continue;
    }
    out[id] = nm;
  }
  // (r284 the sender always: a department's message shows its head — the scouting director — by name)
  const sid = card._senderId;
  if (sid && !out[sid] && state.people[sid]?.name) out[sid] = state.people[sid].name;
  return out;
}

/** `text` with every name the message's people have gone by reading as the name they have now. */
export function liveNames(text, card, state) {
  const ids = Object.keys(card?._people || {});
  if (!text || !ids.length || !state?.people) return text;
  const map = new Map();
  for (const id of ids) {
    const p = state.people[id];
    if (!p?.name) continue;
    for (const old of [card._people[id], ...(p.aka || [])]) if (old && old !== p.name && !map.has(old)) map.set(old, p.name);
  }
  if (!map.size) return text;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${[...map.keys()].sort((a, b) => b.length - a.length).map(_esc).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'gu');
  return String(text).replace(re, (m, pre, nm) => pre + map.get(nm));
}

/** The people a message names, its sender always among them (r284: a message stamped before r284 too). */
function _named(card) {
  const sid = card?._senderId;
  if (!sid || card._people?.[sid]) return card?._people || null;
  const written = card._senderName || String(card.sender || '').match(PAREN)?.[1] || String(card.sender || '').split(', ')[0];
  return { ...(card._people || {}), [sid]: written };
}

/** The message as it's shown now: its words with today's names (the same object when nothing changed). */
export function viewOf(card, state) {
  const named = _named(card);
  if (!named || !Object.keys(named).length) return card;
  card = named === card._people ? card : { ...card, _people: named };
  const L = (s) => (typeof s === 'string' ? liveNames(s, card, state) : s);
  const out = { ...card };
  for (const k of ['sender', 'subject', 'preview', 'body', 'yesLabel', 'noLabel', '_autoLabel', 'yesMsg', 'noMsg', '_summary', '_senderName']) if (typeof card[k] === 'string') out[k] = L(card[k]);
  if (Array.isArray(card._choices)) out._choices = card._choices.map(c => (c ? { ...c, label: L(c.label), sub: L(c.sub) } : c));
  if (card._followUp?.text) out._followUp = { ...card._followUp, text: L(card._followUp.text) };
  if (Array.isArray(card._impact)) out._impact = card._impact.map(r => (r && typeof r.label === 'string' ? { ...r, label: L(r.label) } : r));   // r284 "What changed"
  return out;
}

/** What the sender is shown as: "Name, Role" for a person, the department as it is. */
export function senderLabel(card, state) {
  if (card?._people || card?._senderId) card = viewOf(card, state);   // r283 today's names
  const s = String(card?.sender || '').trim();
  if (!s) return '';
  if (SCOUTING.has(s)) {   // r235 the director (when it arrived, else now), or the department while the job is open
    const who = card._senderName !== undefined ? card._senderName : _director(state);
    return who ? `${who}, Scouting Director` : 'Scouting';
  }
  if (s.includes(',')) return s;
  const m = s.match(PAREN);
  if (m) return `${m[1]}, ${m[2]}`;
  const role = card._senderRole || roleOf(s, state);
  return role ? `${s}, ${role}` : s;
}

/** The person's name alone (for the initials on the avatar): the part before the role. */
export function senderName(card, state) {
  return senderLabel(card, state).split(', ')[0];
}

/**
 * r281 §122.160 the person a sender names (their id), from who holds the jobs now: one of ours (by name, or the
 * scouting director for the department), the owner, another club's manager or GM. Null: a department, an office,
 * someone outside the league.
 */
export function senderIdOf(card, state) {
  const s = String(card?.sender || '').trim();
  if (!s) return null;
  if (SCOUTING.has(s)) { const d = state?.userTeam?.coachingStaff?.scoutingDirector; return d && !d.vacant ? d.id || null : null; }
  const name = (s.match(PAREN)?.[1] || s.split(', ')[0]).trim();
  const ut = state?.userTeam;
  for (const c of Object.values(ut?.coachingStaff || {})) if (c && !c.vacant && c.name === name) return c.id || null;
  if (ut?.ownerName === name) return ut.ownerId || null;
  for (const t of state?.leagueTeams || []) {
    if (t.gm?.name === name) return t.gm.id || null;
    if (t.manager?.name === name) return t.manager.id || null;
  }
  return null;
}

/** Stamp the role on a message as it arrives (the club as it stands then). r281 and who it's from (`_senderId`). */
export function stampSender(card, state) {
  if (!card || card._senderRole) return card;
  const id = senderIdOf(card, state);
  const withId0 = id ? { ...card, _senderId: id } : card;
  const people = peopleIn(withId0, state);   // r283 §122.162 who it names
  const withId = Object.keys(people).length ? { ...withId0, _people: people } : withId0;
  if (SCOUTING.has(String(card.sender || '').trim())) {   // r235 the director as it arrives ('' while the job is open)
    const who = _director(state);
    return { ...withId, _senderName: who || '', ...(who ? { _senderRole: 'Scouting Director' } : {}) };
  }
  const role = roleOf(card.sender, state);
  return role ? { ...withId, _senderRole: role } : withId;
}
