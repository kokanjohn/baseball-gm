/**
 * ui/Upright.js — r177 §122.50
 *
 * While a sideways phone holds the upright layout (body[data-turn], App._applyOrientation),
 * the body is turned a quarter against the rotation, so a touch's clientX/clientY are on
 * the sideways screen while the layout is upright. Gesture code (a sheet pulled down, a
 * finger along a chart) reads points and boxes through here, in the layout's own upright
 * terms. With nothing turned these are the plain values.
 */

/** A screen point (clientX, clientY) in upright layout terms. */
export function uprightPoint(x, y) {
  const t = document.body?.dataset.turn;
  if (!t) return { x, y };
  const b = document.body;
  const sx = x - window.innerWidth / 2, sy = y - window.innerHeight / 2;
  const w = b.offsetWidth / 2, h = b.offsetHeight / 2;
  // ccw (rotate -90°): screen (sx, sy) = (cy, -cx); cw (rotate 90°): (sx, sy) = (-cy, cx).
  return t === 'ccw' ? { x: w - sy, y: h + sx } : { x: w + sy, y: h - sx };
}

/** An element's box in upright layout terms ({left, top, width, height}). */
export function uprightRect(el) {
  const r = el.getBoundingClientRect();
  if (!document.body?.dataset.turn) return r;
  const a = uprightPoint(r.left, r.top), c = uprightPoint(r.right, r.bottom);
  const left = Math.min(a.x, c.x), top = Math.min(a.y, c.y);
  return { left, top, width: Math.abs(c.x - a.x), height: Math.abs(c.y - a.y) };
}
