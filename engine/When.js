/**
 * engine/When.js — r149: every moment the app shows is relative.
 *
 * The game has two calendars: the real one (when things happen — a message
 * arrives, a payday, a player reports) and the season's (the Schedule's game
 * dates). A real calendar date next to the Schedule reads as a contradiction,
 * so real moments are never shown as dates: "Today at 8:40 PM", "Yesterday",
 * "3 days ago", "tomorrow", "Saturday", "in 9 days". (Game dates on the
 * Schedule, and a makeup date from the weather, are the season's calendar
 * and stay as they are.)
 *
 * Every function takes the moment it is relative to (`fromMs`): the UI passes
 * now; the engine passes the moment its text is written (a card's delivery),
 * so the words are right when they arrive. Pure: no clock of its own.
 */

const DAY = 86_400_000;
const _midnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Calendar days from `fromMs` to `ms` (local days; negative = in the past). */
export function dayDiff(ms, fromMs) {
  return Math.round((_midnight(ms) - _midnight(fromMs)) / DAY);
}

/** "8:40 PM" */
export function clockText(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** How long ago, as a day: "Today", "Yesterday", "3 days ago", "1 week ago", "2 weeks ago", "1 month ago", "2 months ago", "1 year ago". */
export function agoDay(ms, fromMs) {
  const days = -dayDiff(ms, fromMs);
  if (days <= 0)  return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)   return `${days} days ago`;
  if (days < 14)  return '1 week ago';
  if (days < 30)  return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60)  return '1 month ago';
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const y = Math.floor(days / 365);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

/** A list's stamp: the time today, else the day ("Yesterday", "3 days ago"). */
export function agoShort(ms, fromMs) {
  return dayDiff(ms, fromMs) >= 0 ? clockText(ms) : agoDay(ms, fromMs);
}

/** In full: "Today at 8:40 PM", "Yesterday at 8:40 PM", "3 days ago at 8:40 PM", then "2 weeks ago". */
export function agoFull(ms, fromMs) {
  const days = -dayDiff(ms, fromMs);
  if (days >= 7) return agoDay(ms, fromMs);
  return `${agoDay(ms, fromMs)} at ${clockText(ms)}`;
}

/** A day ahead: "today", "tomorrow", "Saturday" (this week), "in 9 days", "in 3 weeks". Past: "already". */
export function untilDay(ms, fromMs) {
  const days = dayDiff(ms, fromMs);
  if (days < 0)   return 'already';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7)   return WEEKDAYS[new Date(ms).getDay()];
  if (days < 21)  return `in ${days} days`;
  if (days < 60)  return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

/** A moment ahead, with the time when it is within the week: "tonight at 7:05 PM", "tomorrow at 7:05 PM", "Saturday at 7:05 PM", "in 9 days". */
export function untilFull(ms, fromMs) {
  const days = dayDiff(ms, fromMs);
  if (days < 0) return agoFull(ms, fromMs);
  if (days >= 7) return untilDay(ms, fromMs);
  const day = days === 0 ? (new Date(ms).getHours() >= 17 ? 'tonight' : 'today') : untilDay(ms, fromMs);
  return `${day} at ${clockText(ms)}`;
}

/** Either way, as a day (a list's date heading): "Today", "Yesterday", "3 days ago", "Tomorrow", "Saturday", "In 9 days". */
export function relDay(ms, fromMs) {
  const days = dayDiff(ms, fromMs);
  if (days <= 0) return agoDay(ms, fromMs);
  const u = untilDay(ms, fromMs);
  return u[0].toUpperCase() + u.slice(1);
}

/** A span of time: "3 days", "2 weeks", "4 months", "1 year". */
export function spanText(ms) {
  const days = Math.max(0, Math.round(ms / DAY));
  if (days < 14)  return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 60)  return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  const y = Math.round(days / 365);
  return `${y} year${y === 1 ? '' : 's'}`;
}
