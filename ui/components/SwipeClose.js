/**
 * ui/components/SwipeClose.js
 * r154 Every bottom sheet closes with a swipe down.
 *
 * One delegated touch handler for the whole app (installed once by App.js),
 * so a sheet built anywhere — now or later — gets it for free:
 *   - a drag that starts on an open sheet and moves down, with whatever it
 *     started on scrolled to the top, pulls the sheet with the finger;
 *   - let go past a quarter of the sheet (or a quick flick) and it closes the
 *     way the sheet's own backdrop tap does (each sheet's close — its clean-up,
 *     timers, state — runs as usual); otherwise it springs back.
 * Sideways drags (the stat tables, sliders) and scrolling content are left
 * alone. The full-screen radar is a map, not a sheet: it is not included.
 */

const SHEETS = [
  { overlay: '.modal-overlay',   sheet: '.modal-sheet' },
  { overlay: '.history-overlay', sheet: '.history-sheet' },
  { overlay: '.ts-overlay',      sheet: '.ts-confirm-sheet' },
];
const SHEET_SEL = SHEETS.map(x => x.sheet).join(',');
const START_PX  = 8;      // movement before we decide: a pull, a scroll or sideways
const CLOSE_SHARE = 0.25; // pulled past this share of the sheet's height: close
const CLOSE_MIN_PX = 90;
const FLICK_PX_PER_MS = 0.6;
const SKIP = 'input[type="range"], select, textarea, canvas, [data-no-swipe]';

let _installed = false;
let _t = null;   // the touch being followed

/** The overlay a sheet belongs to (its parent, by construction). */
function _overlayOf(sheet) {
  const pair = SHEETS.find(x => sheet.matches(x.sheet));
  const ov = pair ? sheet.closest(pair.overlay) : null;
  return ov && ov.classList.contains('open') ? ov : null;
}

/** True when something between the touch and the sheet is scrolled down. */
function _scrolledAbove(target, sheet) {
  for (let el = target; el && el !== sheet.parentElement; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
    if (el === sheet) break;
  }
  return false;
}

function _onStart(e) {
  _t = null;
  if (e.touches.length !== 1) return;
  const target = e.target instanceof Element ? e.target : null;
  const sheet = target?.closest(SHEET_SEL);
  if (!sheet || target.closest(SKIP)) return;
  const overlay = _overlayOf(sheet);
  if (!overlay) return;
  const p = e.touches[0];
  _t = { sheet, overlay, target, x0: p.clientX, y0: p.clientY, yStart: p.clientY, t0: performance.now(), dy: 0, state: 'wait', lastY: p.clientY, lastT: performance.now(), v: 0 };
}

function _onMove(e) {
  if (!_t) return;
  const p = e.touches[0];
  const dx = p.clientX - _t.x0, dy = p.clientY - _t.y0;
  if (_t.state === 'wait') {
    if (Math.abs(dx) < START_PX && Math.abs(dy) < START_PX) return;
    // Down, more down than sideways, and nothing scrolled: a pull. Else let it be.
    if (dy > 0 && Math.abs(dy) > Math.abs(dx) && !_scrolledAbove(_t.target, _t.sheet)) {
      _t.state = 'pull';
      _t.y0 = p.clientY;                       // the sheet follows from here: no jump
      _t.sheet.style.transition = 'none';
    } else { _t = null; return; }
  }
  if (_t.state !== 'pull') return;
  e.preventDefault();                          // the content doesn't scroll / bounce
  const now = performance.now();
  _t.v = (p.clientY - _t.lastY) / Math.max(1, now - _t.lastT);
  _t.lastY = p.clientY; _t.lastT = now;
  _t.dy = Math.max(0, p.clientY - _t.y0);
  _t.sheet.style.transform = `translateY(${_t.dy}px)`;
}

function _onEnd() {
  const t = _t; _t = null;
  if (!t || t.state !== 'pull') return;
  const h = t.sheet.getBoundingClientRect().height || 1;
  // A flick: fast at the end, or fast over the whole pull (the finger's whole travel).
  const travel = t.lastY - t.yStart;
  const avg = travel / Math.max(1, t.lastT - t.t0);
  const close = t.dy > Math.max(CLOSE_MIN_PX, h * CLOSE_SHARE)
             || ((t.v > FLICK_PX_PER_MS || avg > FLICK_PX_PER_MS) && travel > START_PX * 4);
  t.sheet.style.transition = 'transform .22s cubic-bezier(.32,.72,0,1)';
  if (!close) {
    t.sheet.style.transform = '';
    setTimeout(() => { t.sheet.style.transition = ''; }, 240);
    return;
  }
  t.sheet.style.transform = `translateY(${h + 40}px)`;
  setTimeout(() => {
    // The sheet's own backdrop tap: its close runs, with its clean-up.
    t.overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // A sheet that is hidden rather than removed opens fresh next time.
    t.sheet.style.transition = ''; t.sheet.style.transform = '';
  }, 200);
}

export function installSwipeClose(doc = document) {
  if (_installed) return;
  _installed = true;
  doc.addEventListener('touchstart', _onStart, { passive: true });
  doc.addEventListener('touchmove', _onMove, { passive: false });
  doc.addEventListener('touchend', _onEnd, { passive: true });
  doc.addEventListener('touchcancel', _onEnd, { passive: true });
}
