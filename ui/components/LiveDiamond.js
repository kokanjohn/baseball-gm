/**
 * ui/components/LiveDiamond.js
 * Animated SVG baserunner diamond for the live game view.
 *
 * Renders a proper baseball diamond (rotated square) with:
 *   - Bases lit in accent color when occupied
 *   - Outs indicator (3 dots)
 *   - Animated baserunner movement when plays are revealed
 *   - Home plate, pitcher's mound, infield dirt
 *
 * Used in GameScreen to replace the inline bases indicator.
 *
 * Usage:
 *   import { renderDiamond, mountDiamond } from '../components/LiveDiamond.js';
 *   container.innerHTML = renderDiamond(game);
 *   // or
 *   mountDiamond(container, game);  // auto-updates on game:tick
 */

import * as EventBus from '../EventBus.js';

// ─────────────────────────────────────────────────────────────
// SVG GEOMETRY
// ─────────────────────────────────────────────────────────────

const D = Object.freeze({
  // SVG viewBox: 100×100 centered diamond
  viewBox:  '0 0 100 100',
  // Base positions (center of each base square, rotated 45°)
  home:   { x: 50,  y: 86 },
  first:  { x: 82,  y: 54 },
  second: { x: 50,  y: 22 },
  third:  { x: 18,  y: 54 },
  mound:  { x: 50,  y: 57 },  // pitcher's mound
  baseSize: 5,   // half-width of rotated base square
  moundR:   4,   // mound circle radius
});

// ─────────────────────────────────────────────────────────────
// RENDER (static HTML string)
// ─────────────────────────────────────────────────────────────

/**
 * renderDiamond(game)
 * Returns an HTML string containing the SVG diamond.
 * Can be embedded directly into innerHTML.
 *
 * @param {Object} game — live game object from state.schedule
 * @returns {String} HTML
 */
export function renderDiamond(game) {
  const bases = game?.bases || { first: null, second: null, third: null };
  const outs  = game?.outs  ?? 0;
  return `
    <div class="live-diamond-wrap" id="live-diamond">
      ${_buildSVG(bases)}
      ${_buildOuts(outs)}
    </div>
  `;
}

function _buildSVG(bases) {
  const on  = b => b !== null && b !== undefined && b !== false;
  const clr = b => on(b) ? 'var(--accent)' : 'var(--surface2)';

  return `
    <svg viewBox="${D.viewBox}" xmlns="http://www.w3.org/2000/svg"
      class="live-diamond-svg" width="96" height="96">

      <!-- Infield dirt (light circle) -->
      <circle cx="50" cy="54" r="30"
        fill="rgba(139,90,43,.18)" stroke="none"/>

      <!-- Baselines -->
      <line x1="${D.home.x}" y1="${D.home.y}"
            x2="${D.first.x}" y2="${D.first.y}"
            stroke="var(--border)" stroke-width="1"/>
      <line x1="${D.first.x}" y1="${D.first.y}"
            x2="${D.second.x}" y2="${D.second.y}"
            stroke="var(--border)" stroke-width="1"/>
      <line x1="${D.second.x}" y1="${D.second.y}"
            x2="${D.third.x}" y2="${D.third.y}"
            stroke="var(--border)" stroke-width="1"/>
      <line x1="${D.third.x}" y1="${D.third.y}"
            x2="${D.home.x}" y2="${D.home.y}"
            stroke="var(--border)" stroke-width="1"/>

      <!-- Pitcher's mound -->
      <circle cx="${D.mound.x}" cy="${D.mound.y}" r="${D.moundR}"
        fill="rgba(139,90,43,.35)"/>

      <!-- Second base -->
      <rect x="${D.second.x - D.baseSize}" y="${D.second.y - D.baseSize}"
        width="${D.baseSize * 2}" height="${D.baseSize * 2}"
        transform="rotate(45 ${D.second.x} ${D.second.y})"
        fill="${clr(bases.second)}" stroke="var(--border)" stroke-width="1"
        class="diamond-base ${on(bases.second) ? 'occupied' : ''}"/>

      <!-- Third base -->
      <rect x="${D.third.x - D.baseSize}" y="${D.third.y - D.baseSize}"
        width="${D.baseSize * 2}" height="${D.baseSize * 2}"
        transform="rotate(45 ${D.third.x} ${D.third.y})"
        fill="${clr(bases.third)}" stroke="var(--border)" stroke-width="1"
        class="diamond-base ${on(bases.third) ? 'occupied' : ''}"/>

      <!-- First base -->
      <rect x="${D.first.x - D.baseSize}" y="${D.first.y - D.baseSize}"
        width="${D.baseSize * 2}" height="${D.baseSize * 2}"
        transform="rotate(45 ${D.first.x} ${D.first.y})"
        fill="${clr(bases.first)}" stroke="var(--border)" stroke-width="1"
        class="diamond-base ${on(bases.first) ? 'occupied' : ''}"/>

      <!-- Home plate (pentagon approximation via path) -->
      <polygon points="${D.home.x},${D.home.y + 5} ${D.home.x - 4},${D.home.y + 1} ${D.home.x - 4},${D.home.y - 3} ${D.home.x + 4},${D.home.y - 3} ${D.home.x + 4},${D.home.y + 1}"
        fill="var(--surface2)" stroke="var(--border)" stroke-width="1"/>

    </svg>
  `;
}

function _buildOuts(outs) {
  const dots = [0, 1, 2].map(i => `
    <div class="diamond-out-dot ${i < outs ? 'active' : ''}"></div>
  `).join('');
  return `
    <div class="diamond-outs-row">
      <span class="diamond-outs-label">OUT</span>
      ${dots}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// MOUNT / UPDATE API
// ─────────────────────────────────────────────────────────────

const _instances = new WeakMap();

/**
 * mountDiamond(container, game)
 * Renders the diamond and subscribes to game:tick for live updates.
 *
 * @param {HTMLElement} container
 * @param {Object}      game
 */
export function mountDiamond(container, game) {
  if (!container) return;
  _injectCSS();

  container.innerHTML = renderDiamond(game);

  const handler = EventBus.on('game:tick', ({ game: updatedGame }) => {
    updateDiamond(container, updatedGame);
  });

  _instances.set(container, handler);
}

/**
 * unmountDiamond(container)
 * Removes EventBus listener.
 *
 * @param {HTMLElement} container
 */
export function unmountDiamond(container) {
  const handler = _instances.get(container);
  if (handler) EventBus.off('game:tick', handler);
  _instances.delete(container);
}

/**
 * updateDiamond(container, game)
 * Patches only the base colors and outs without re-rendering the full SVG.
 *
 * @param {HTMLElement} container
 * @param {Object}      game
 */
export function updateDiamond(container, game) {
  if (!container || !game) return;

  const bases = game.bases || { first: null, second: null, third: null };
  const outs  = game.outs  ?? 0;
  const on    = b => b !== null && b !== undefined && b !== false;

  // Update base colors via class toggle + fill attribute
  const basePairs = [
    ['first',  bases.first],
    ['second', bases.second],
    ['third',  bases.third],
  ];

  container.querySelectorAll('.diamond-base').forEach((el, i) => {
    const [, val] = basePairs[i] || [];
    const occupied = on(val);
    el.classList.toggle('occupied', occupied);
    el.setAttribute('fill', occupied ? 'var(--accent)' : 'var(--surface2)');
  });

  // Update outs
  container.querySelectorAll('.diamond-out-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i < outs);
  });
}

// ─────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────

let _cssInjected = false;
function _injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .live-diamond-wrap{display:flex;flex-direction:column;align-items:center;gap:4px;}
    .live-diamond-svg{display:block;flex-shrink:0;}
    .diamond-base{transition:fill .3s ease;}
    .diamond-base.occupied{filter:drop-shadow(0 0 4px var(--accent));}
    .diamond-outs-row{display:flex;align-items:center;gap:5px;}
    .diamond-outs-label{font-size:9px;font-weight:800;letter-spacing:1.5px;
      text-transform:uppercase;color:var(--muted);}
    .diamond-out-dot{width:9px;height:9px;border-radius:50%;
      border:2px solid var(--muted);background:transparent;transition:background .2s;}
    .diamond-out-dot.active{background:var(--danger);border-color:var(--danger);}
  `;
  document.head.appendChild(style);
}
