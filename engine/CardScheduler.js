/**
 * engine/CardScheduler.js
 * Picks real-world delivery times for inbox cards (§61).
 *
 * Cards produced after a game are not dropped into the inbox at once. Each one
 * gets its own random time between now and the next game's first pitch, inside
 * waking hours (outside the user's quiet hours). Times are drawn independently
 * and uniformly, so some cards land hours apart and others minutes apart — it
 * should feel like real messages arriving unannounced.
 *
 * PURE: no StateManager, no Date.now() — the caller passes nowMs.
 */

export const DELIVERY_MIN_LEAD_MS   = 4 * 60 * 1000;         // never sooner than 4 min
export const DELIVERY_DEFAULT_SPAN  = 18 * 60 * 60 * 1000;   // no next game → spread over 18h
export const DELIVERY_MAX_SPAN      = 30 * 60 * 60 * 1000;   // never plan further than 30h out
export const DELIVERY_MIN_WINDOW_MS = 45 * 60 * 1000;        // next game too close → use default span

/**
 * planDeliveryTimes(count, opts)
 * @param {Number} count
 * @param {Object} opts
 *   nowMs        — current time (ms)
 *   windowEndMs  — latest delivery time (normally the next game's first pitch)
 *   quietStart   — 'HH:MM' local, start of quiet hours (default '22:00')
 *   quietEnd     — 'HH:MM' local, end of quiet hours   (default '08:00')
 *   rand         — optional RNG () => [0,1) (defaults to Math.random)
 * @returns {Number[]} delivery times (ms), ascending
 */
export function planDeliveryTimes(count, opts = {}) {
  const rand  = opts.rand || Math.random;
  const now   = opts.nowMs;
  const start = now + DELIVERY_MIN_LEAD_MS;

  let end = Number.isFinite(opts.windowEndMs) ? opts.windowEndMs : NaN;
  if (!Number.isFinite(end) || end - start < DELIVERY_MIN_WINDOW_MS) end = now + DELIVERY_DEFAULT_SPAN;
  end = Math.min(end, now + DELIVERY_MAX_SPAN);

  const segments = awakeSegments(start, end, opts.quietStart || '22:00', opts.quietEnd || '08:00');
  const total    = segments.reduce((s, [a, b]) => s + (b - a), 0);

  const times = [];
  for (let i = 0; i < count; i++) {
    if (total <= 0) {
      // Whole window is inside quiet hours — deliver shortly after quiet hours end.
      const wake = nextWakeTime(start, opts.quietEnd || '08:00');
      times.push(wake + Math.floor(rand() * 90 * 60 * 1000));
      continue;
    }
    let r = rand() * total;
    for (const [a, b] of segments) {
      if (r <= b - a) { times.push(Math.floor(a + r)); break; }
      r -= (b - a);
    }
  }
  return times.sort((x, y) => x - y);
}

/**
 * awakeSegments(startMs, endMs, quietStart, quietEnd)
 * The parts of [startMs, endMs] that fall OUTSIDE quiet hours (local time).
 * Quiet hours may wrap midnight (e.g. 22:00 → 08:00).
 */
export function awakeSegments(startMs, endMs, quietStart, quietEnd) {
  if (!(endMs > startMs)) return [];
  const qs = _minutes(quietStart), qe = _minutes(quietEnd);
  const segs = [];
  const day = new Date(startMs); day.setHours(0, 0, 0, 0);
  for (let d = day.getTime() - 86400000; d <= endMs; d = _nextDay(d)) {
    // Awake interval for this local day: [quietEnd, quietStart] (wrapping case),
    // or two intervals [0, quietStart] and [quietEnd, 24h] when quiet is same-day.
    const intervals = qe <= qs
      ? [[qe, qs]]
      : [[0, qs], [qe, 24 * 60]];
    for (const [m0, m1] of intervals) {
      const a = Math.max(startMs, _at(d, m0));
      const b = Math.min(endMs,   _at(d, m1));
      if (b > a) segs.push([a, b]);
    }
  }
  return segs;
}

/** Is the given time inside quiet hours? */
export function inQuietHours(ms, quietStart = '22:00', quietEnd = '08:00') {
  const t = new Date(ms); const m = t.getHours() * 60 + t.getMinutes();
  const qs = _minutes(quietStart), qe = _minutes(quietEnd);
  return qs > qe ? (m >= qs || m < qe) : (m >= qs && m < qe);
}

function nextWakeTime(fromMs, quietEnd) {
  const d = new Date(fromMs); d.setHours(0, 0, 0, 0);
  let t = _at(d.getTime(), _minutes(quietEnd));
  if (t <= fromMs) t = _at(_nextDay(d.getTime()), _minutes(quietEnd));
  return t;
}

function _minutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
// Local midnight + minutes (DST-safe via setHours)
function _at(dayMs, minutes) {
  const d = new Date(dayMs);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d.getTime();
}
function _nextDay(dayMs) {
  const d = new Date(dayMs); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0);
  return d.getTime();
}
