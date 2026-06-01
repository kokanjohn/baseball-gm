/**
 * ui/components/RadarWidget.js
 * SVG weather radar visualization (Section 8.8 — LOCKED).
 *
 * Renders a stylized regional radar centered on the ballpark.
 * Storm cell moves relative to the ballpark across hourly frames.
 * Scrubber covers current → +12 hours (13 positions, 1-hour increments).
 * Three zoom levels: Regional / City (default) / Local.
 *
 * Section 1.11b — LOCKED: No premium gating in this component.
 * Free/premium scrubber range gating happens in ui/Premium.js (Phase 16).
 * This component always renders the full data it receives.
 *
 * Usage:
 *   import { renderRadarWidget } from '../components/RadarWidget.js';
 *   const html = renderRadarWidget(weatherBuffer, gameStatus);
 *   // Then: container.innerHTML = html; attachRadarListeners(container);
 *
 * Or use the mount/unmount API for auto-managed lifecycle:
 *   RadarWidget.mount(container, weatherBuffer, gameStatus);
 *   RadarWidget.unmount(container);
 */

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

// Zoom levels: viewBox shrinks as you zoom in (ballpark always centered)
const ZOOM_LEVELS = Object.freeze([
  { key: 'regional', label: 'Regional', viewBox: '0 0 200 200', scale: 1.0 },
  { key: 'city',     label: 'City',     viewBox: '40 40 120 120', scale: 1.5 },
  { key: 'local',    label: 'Local',    viewBox: '70 70 60 60', scale: 2.5 },
]);

// Storm cell color by intensity (0.0–1.0)
const INTENSITY_COLORS = [
  { threshold: 0,    color: '#4ade80' },  // green — light
  { threshold: 0.25, color: '#facc15' },  // yellow — moderate
  { threshold: 0.5,  color: '#f97316' },  // orange — heavy
  { threshold: 0.75, color: '#ef4444' },  // red — severe
];

const SCRUBBER_STEPS  = 13;  // current → +12 hours
const SVG_CENTER      = 100; // ballpark always at (100, 100)
const SVG_SIZE        = 200;

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT API
// ─────────────────────────────────────────────────────────────

const _instances = new WeakMap(); // container → { zoomIdx, frameIdx, buffer }

/**
 * mount(container, weatherBuffer, gameStatus)
 * Renders the radar widget into container and wires all interactions.
 *
 * @param {HTMLElement} container
 * @param {Object}      weatherBuffer  — state.weatherBuffer
 * @param {String}      gameStatus     — GAME_STATUS value
 */
export function mount(container, weatherBuffer, gameStatus) {
  if (!container) return;
  _injectCSS();

  const state = { zoomIdx: 1, frameIdx: 0, buffer: weatherBuffer, gameStatus };
  _instances.set(container, state);

  _render(container, state);
  _attachListeners(container, state);
}

/**
 * unmount(container)
 * Cleans up the widget instance.
 *
 * @param {HTMLElement} container
 */
export function unmount(container) {
  _instances.delete(container);
}

/**
 * renderRadarWidget(weatherBuffer, gameStatus)
 * Returns HTML string for inline embedding.
 * Use mount() for interactive version with zoom + scrubber.
 *
 * @param {Object} weatherBuffer
 * @param {String} gameStatus
 * @returns {String} HTML
 */
export function renderRadarWidget(weatherBuffer, gameStatus) {
  const state = { zoomIdx: 1, frameIdx: 0, buffer: weatherBuffer, gameStatus };
  return _buildHTML(state);
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

function _render(container, state) {
  container.innerHTML = _buildHTML(state);
}

function _buildHTML(state) {
  const zoom    = ZOOM_LEVELS[state.zoomIdx] || ZOOM_LEVELS[1];
  const frame   = _getFrame(state.buffer, state.frameIdx);
  const hours   = state.frameIdx;
  const timeLabel = hours === 0 ? 'Now' : `+${hours}h`;

  const clearingTime = _clearingEstimate(state.buffer, state.frameIdx);

  return `
    <div class="radar-widget" id="radar-widget">

      <!-- Header -->
      <div class="radar-header">
        <div class="radar-title">Weather Radar</div>
        <div class="radar-time-label">${timeLabel}</div>
      </div>

      <!-- SVG Radar -->
      <div class="radar-svg-wrap">
        <svg viewBox="${zoom.viewBox}" xmlns="http://www.w3.org/2000/svg"
          class="radar-svg" id="radar-svg">
          ${_renderSVGBackground(zoom)}
          ${_renderStormCell(frame, zoom)}
          ${_renderBallpark()}
          ${_renderRangeRings(zoom)}
        </svg>
        ${frame?.intensity > 0 ? `<div class="radar-condition-badge">${_conditionLabel(frame)}</div>` : ''}
      </div>

      <!-- Clearing estimate -->
      ${clearingTime ? `
        <div class="radar-clearing">
          Estimated clearing: ${clearingTime}
        </div>
      ` : ''}

      <!-- Zoom controls -->
      <div class="radar-zoom-bar">
        ${ZOOM_LEVELS.map((z, i) => `
          <button class="radar-zoom-btn ${state.zoomIdx === i ? 'active' : ''}"
            data-zoom="${i}">${z.label}</button>
        `).join('')}
      </div>

      <!-- Scrubber -->
      <div class="radar-scrubber-wrap">
        <div class="radar-scrubber-labels">
          <span>Now</span><span>+6h</span><span>+12h</span>
        </div>
        <input type="range" class="radar-scrubber" id="radar-scrubber"
          min="0" max="${SCRUBBER_STEPS - 1}" value="${state.frameIdx}"
          step="1">
        <div class="radar-intensity-bar">
          ${_renderIntensityBar(state.buffer)}
        </div>
      </div>

    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// SVG RENDERING
// ─────────────────────────────────────────────────────────────

function _renderSVGBackground(zoom) {
  return `
    <!-- Sky background -->
    <rect x="0" y="0" width="${SVG_SIZE}" height="${SVG_SIZE}"
      fill="#0a0e1a" rx="8"/>
    <!-- Grid lines -->
    ${[50,100,150].map(v => `
      <line x1="${v}" y1="0" x2="${v}" y2="${SVG_SIZE}" stroke="#1a2a3a" stroke-width=".5"/>
      <line x1="0" y1="${v}" x2="${SVG_SIZE}" y2="${v}" stroke="#1a2a3a" stroke-width=".5"/>
    `).join('')}
  `;
}

function _renderStormCell(frame, zoom) {
  if (!frame || !frame.radarCellPosition || frame.intensity <= 0) return '';

  const { x = SVG_CENTER, y = SVG_CENTER } = frame.radarCellPosition;
  const color   = _intensityColor(frame.intensity);
  const radius  = 18 + (frame.intensity * 22); // larger for stronger storms
  const opacity = 0.55 + (frame.intensity * 0.35);

  // Inner glow ring
  const innerRadius = radius * 0.55;
  const innerColor  = _intensityColor(Math.min(1, frame.intensity + 0.25));

  return `
    <!-- Storm cell outer -->
    <ellipse cx="${x}" cy="${y}" rx="${radius}" ry="${radius * 0.75}"
      fill="${color}" fill-opacity="${opacity}" filter="url(#blur)"/>
    <!-- Storm cell inner (brighter core) -->
    <ellipse cx="${x}" cy="${y}" rx="${innerRadius}" ry="${innerRadius * 0.75}"
      fill="${innerColor}" fill-opacity="${Math.min(1, opacity + 0.2)}"/>
    <!-- Blur filter -->
    <defs>
      <filter id="blur" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="4"/>
      </filter>
    </defs>
  `;
}

function _renderBallpark() {
  return `
    <!-- Ballpark marker -->
    <circle cx="${SVG_CENTER}" cy="${SVG_CENTER}" r="3"
      fill="#F5D253" stroke="#0F1117" stroke-width="1"/>
    <text x="${SVG_CENTER + 5}" y="${SVG_CENTER + 4}"
      font-size="8" fill="#F5D253" font-family="sans-serif">⚾</text>
  `;
}

function _renderRangeRings(zoom) {
  // Show range rings only at regional zoom
  if (zoom.key !== 'regional') return '';
  return `
    <circle cx="${SVG_CENTER}" cy="${SVG_CENTER}" r="30"
      fill="none" stroke="#1a3a5a" stroke-width=".5" stroke-dasharray="2 2"/>
    <circle cx="${SVG_CENTER}" cy="${SVG_CENTER}" r="60"
      fill="none" stroke="#1a3a5a" stroke-width=".5" stroke-dasharray="2 2"/>
  `;
}

function _renderIntensityBar(buffer) {
  if (!buffer?.hourlyFrames) return '';
  const frames = buffer.hourlyFrames.slice(0, SCRUBBER_STEPS);
  const total  = frames.length || 1;
  return frames.map((frame, i) => {
    const color = _intensityColor(frame?.intensity || 0);
    const pct   = (1 / total) * 100;
    return `<div class="rib-seg" style="background:${frame?.intensity > 0 ? color : 'transparent'};width:${pct}%;opacity:${0.4 + (frame?.intensity||0)*0.6};"></div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(container, state) {
  // Zoom buttons
  container.querySelectorAll('[data-zoom]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.zoomIdx = parseInt(btn.dataset.zoom);
      _render(container, state);
      _attachListeners(container, state);
    });
  });

  // Scrubber
  const scrubber = container.querySelector('#radar-scrubber');
  if (scrubber) {
    scrubber.addEventListener('input', () => {
      state.frameIdx = parseInt(scrubber.value);
      // Update only the SVG and time label — no full re-render (smooth scrubbing)
      _updateFrame(container, state);
    });
  }
}

function _updateFrame(container, state) {
  const zoom     = ZOOM_LEVELS[state.zoomIdx] || ZOOM_LEVELS[1];
  const frame    = _getFrame(state.buffer, state.frameIdx);
  const hours    = state.frameIdx;
  const timeLabel = hours === 0 ? 'Now' : `+${hours}h`;

  // Update time label
  const timeLabelEl = container.querySelector('.radar-time-label');
  if (timeLabelEl) timeLabelEl.textContent = timeLabel;

  // Update SVG content
  const svg = container.querySelector('#radar-svg');
  if (svg) {
    svg.innerHTML = `
      ${_renderSVGBackground(zoom)}
      ${_renderStormCell(frame, zoom)}
      ${_renderBallpark()}
      ${_renderRangeRings(zoom)}
    `;
  }

  // Update clearing estimate
  const clearing = container.querySelector('.radar-clearing');
  const est = _clearingEstimate(state.buffer, state.frameIdx);
  if (clearing) {
    clearing.textContent = est ? `Estimated clearing: ${est}` : '';
    clearing.style.display = est ? 'block' : 'none';
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _getFrame(buffer, frameIdx) {
  if (!buffer?.hourlyFrames) return null;
  return buffer.hourlyFrames[frameIdx] || null;
}

function _intensityColor(intensity) {
  let color = INTENSITY_COLORS[0].color;
  for (const { threshold, color: c } of INTENSITY_COLORS) {
    if (intensity >= threshold) color = c;
  }
  return color;
}

function _conditionLabel(frame) {
  if (!frame) return '';
  const intensity = frame.intensity || 0;
  if (intensity >= 0.75) return '⛈️ Severe';
  if (intensity >= 0.5)  return '🌧️ Heavy Rain';
  if (intensity >= 0.25) return '🌦️ Moderate Rain';
  if (intensity > 0)     return '🌂 Light Rain';
  return '';
}

function _clearingEstimate(buffer, currentFrameIdx) {
  if (!buffer?.hourlyFrames) return null;
  // Find first frame after current with intensity = 0
  for (let i = currentFrameIdx + 1; i < SCRUBBER_STEPS; i++) {
    const frame = buffer.hourlyFrames[i];
    if (!frame || (frame.intensity || 0) === 0) {
      const hours = i - currentFrameIdx;
      return hours === 1 ? 'about 1 hour' : `about ${hours} hours`;
    }
  }
  return null; // No clearing in window
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
    .radar-widget{background:var(--surface);border:1px solid var(--border);
      border-radius:14px;overflow:hidden;margin:8px 0;}
    .radar-header{display:flex;align-items:center;justify-content:space-between;
      padding:10px 14px 6px;}
    .radar-title{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
      color:var(--muted);}
    .radar-time-label{font-size:12px;font-weight:700;color:var(--accent);
      font-family:'DM Mono',monospace;}
    .radar-svg-wrap{position:relative;width:100%;aspect-ratio:1;max-height:180px;}
    .radar-svg{width:100%;height:100%;display:block;}
    .radar-condition-badge{position:absolute;top:8px;left:8px;font-size:11px;
      font-weight:700;background:rgba(0,0,0,.6);color:#fff;padding:3px 8px;
      border-radius:6px;backdrop-filter:blur(4px);}
    .radar-clearing{font-size:11px;color:var(--accent2);text-align:center;
      padding:4px 14px;background:var(--chip-green-bg);}
    .radar-zoom-bar{display:flex;border-top:1px solid var(--border);}
    .radar-zoom-btn{flex:1;padding:8px 4px;font-size:11px;font-weight:700;
      color:var(--muted);background:none;border:none;border-right:1px solid var(--border);
      cursor:pointer;font-family:'DM Sans',sans-serif;transition:color .15s,background .15s;}
    .radar-zoom-btn:last-child{border-right:none;}
    .radar-zoom-btn.active{color:var(--accent);background:var(--chip-accent-bg);}
    .radar-zoom-btn:active{opacity:.8;}
    .radar-scrubber-wrap{padding:10px 14px 12px;}
    .radar-scrubber-labels{display:flex;justify-content:space-between;
      font-size:9px;color:var(--muted);font-weight:600;margin-bottom:4px;}
    .radar-scrubber{width:100%;accent-color:var(--accent);cursor:pointer;height:4px;}
    .radar-intensity-bar{display:flex;height:4px;border-radius:2px;overflow:hidden;
      margin-top:4px;background:var(--surface2);}
    .rib-seg{flex-shrink:0;height:100%;}
  `;
  document.head.appendChild(style);
}
