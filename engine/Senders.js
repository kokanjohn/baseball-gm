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

/** What the sender is shown as: "Name, Role" for a person, the department as it is. */
export function senderLabel(card, state) {
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

/** Stamp the role on a message as it arrives (the club as it stands then). */
export function stampSender(card, state) {
  if (!card || card._senderRole) return card;
  if (SCOUTING.has(String(card.sender || '').trim())) {   // r235 the director as it arrives ('' while the job is open)
    const who = _director(state);
    return { ...card, _senderName: who || '', ...(who ? { _senderRole: 'Scouting Director' } : {}) };
  }
  const role = roleOf(card.sender, state);
  return role ? { ...card, _senderRole: role } : card;
}
