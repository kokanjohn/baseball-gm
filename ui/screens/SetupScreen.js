/**
 * ui/screens/SetupScreen.js
 * New game creation flow rendered into #setup-content.
 *
 * Flow (Phase 13.5 — 4 steps):
 *   Step 1 — Archetype selection (6 cards)
 *   Step 2 — Region selection (4 cards) — added in Phase 13.5
 *   Step 3 — Team naming: GM name, city, nickname, team icon
 *   Step 4 — Team colors: primary + secondary pickers
 *   → "Take the Job" → GameEngine.startNewGame() → App.init()
 *
 * Note: Classic mode is retired (Section 2.1). Always live mode.
 *
 * Rules:
 *   - No direct state writes. Calls GameEngine.startNewGame() with config.
 *   - applyTeamColors() called live during color selection for instant preview.
 *   - Archetype descriptions match plan Section 16 exactly.
 *   - Region descriptions match plan Section 8.13 exactly.
 *   - One-team-per-archetype rule enforced at selection time.
 */

import * as App         from '../App.js';
import * as EventBus    from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { applyTeamColors, applyTheme, getColorHex } from '../formatters.js';
import { COLOR_PALETTE, COLOR_PRIMARY_DEFAULT, COLOR_SECONDARY_DEFAULT, REGIONS, REGION_DEFAULT } from '../../data/constants.js';

// ─────────────────────────────────────────────────────────────
// ARCHETYPE DEFINITIONS (display layer — plan Section 16)
// ─────────────────────────────────────────────────────────────

const ARCHETYPES = [
  { id:'ember',       name:'Ember',       premise:'Young talent, tight budget',    roster:1, patience:5, budget:2 },
  { id:'contender',   name:'Contender',   premise:'Proven core, win now',           roster:3, patience:2, budget:3 },
  { id:'empire',      name:'Empire',      premise:'Veterans, rings or bust',         roster:5, patience:1, budget:5 },
  { id:'gambler',     name:'Gambler',     premise:'High risk, high reward',          roster:3, patience:1, budget:2 },
  { id:'lab',         name:'The Lab',     premise:'Find undervalued players',        roster:2, patience:4, budget:1 },
  { id:'institution', name:'Institution', premise:'Tradition and stability',         roster:4, patience:4, budget:4 },
];

// ─────────────────────────────────────────────────────────────
// SETUP STATE
// ─────────────────────────────────────────────────────────────

let _step          = 1;   // 1=archetype, 2=region, 3=naming, 4=colors
let _archetype     = null;
let _region        = REGION_DEFAULT;  // 'north'|'south'|'east'|'west'
let _gmName        = '';
let _teamCity      = '';
let _teamNick      = '';
let _teamIcon      = '⚾';
let _primaryColor  = COLOR_PRIMARY_DEFAULT;
let _secondaryColor = COLOR_SECONDARY_DEFAULT;

// Icons available for team badge
const TEAM_ICONS = [
  '⚾','🦅','🐻','🦁','🦊','🐯','🐺','🦋','🐉','🦈',
  '🌊','⚡','🔥','❄️','🌙','⭐','🏔️','🌪️','🎯','🗡️',
  '🛡️','⚔️','🎪','🎭','🏹','🚀','🌵','🦅','🦝','🦌',
];

// ─────────────────────────────────────────────────────────────
// MOUNT
// ─────────────────────────────────────────────────────────────

/**
 * mount()
 * Renders the setup screen into #setup-content.
 * Called by App.js when no save slot exists.
 */
export function mount() {
  _step           = 1;
  _archetype      = null;
  _region         = REGION_DEFAULT;
  _gmName         = '';
  _teamCity       = '';
  _teamNick       = '';
  _teamIcon       = '⚾';
  _primaryColor   = COLOR_PRIMARY_DEFAULT;
  _secondaryColor = COLOR_SECONDARY_DEFAULT;

  // Apply default theme and colors for setup screen
  applyTheme('dark', _primaryColor, _secondaryColor);

  render();
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

function render() {
  const container = document.getElementById('setup-content');
  if (!container) return;

  container.innerHTML = `
    <div class="intro-logo">
      <div class="diamond"><span>⚾</span></div>
      <div class="game-title">The Front<br>Office</div>
      <div class="game-sub">Baseball GM Simulator</div>
    </div>
    ${_renderStep()}
  `;

  _attachListeners();
}

function _renderStep() {
  switch (_step) {
    case 1: return _renderArchetypeStep();
    case 2: return _renderRegionStep();
    case 3: return _renderNamingStep();
    case 4: return _renderColorsStep();
    default: return '';
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — ARCHETYPE SELECTION
// ─────────────────────────────────────────────────────────────

function _renderDots(filled, total = 5) {
  let html = '';
  for (let i = 0; i < total; i++) {
    html += `<span class="arch-dot${i < filled ? ' filled' : ''}"></span>`;
  }
  return html;
}

function _renderArchetypeStep() {
  const usedArchetypes = _getUsedArchetypes();

  const cards = ARCHETYPES.map(a => {
    const used     = usedArchetypes.includes(a.id);
    const selected = _archetype === a.id;
    const cls      = `archetype-card${selected ? ' selected' : ''}${used ? ' used' : ''}`;

    return `
      <div class="${cls}" data-archetype="${a.id}" ${used ? 'aria-disabled="true"' : ''}>
        <div class="arch-name">${a.name}${used ? ' <span class="arch-used-badge">IN USE</span>' : ''}</div>
        <div class="arch-premise">${a.premise}</div>
        <div class="arch-indicators">
          <div class="arch-ind-row">
            <span class="arch-ind-label">Roster</span>
            <span class="arch-ind-dots">${_renderDots(a.roster)}</span>
          </div>
          <div class="arch-ind-row">
            <span class="arch-ind-label">Patience</span>
            <span class="arch-ind-dots">${_renderDots(a.patience)}</span>
          </div>
          <div class="arch-ind-row">
            <span class="arch-ind-label">Budget</span>
            <span class="arch-ind-dots">${_renderDots(a.budget)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="intro-form arch-layout">
      <div class="arch-header-block">
        <div class="arch-step-label">Step 1 of 4</div>
        <div class="arch-type-label">Team Type</div>
      </div>
      <div class="archetype-grid-2col">${cards}</div>
      <button class="btn-primary arch-continue-btn" id="arch-next-btn" ${!_archetype ? 'disabled' : ''}>
        CONTINUE
      </button>
    </div>
  `;
}

function _renderRegionStep() {
  const regionEntries = Object.values(REGIONS);

  // Climate icons — one per region, gives visual texture without naming real cities
  const REGION_ICONS = {
    north: '❄️',
    south: '☀️',
    east:  '🌊',
    west:  '🌵',
  };

  const cards = regionEntries.map(r => {
    const selected = _region === r.id;
    const icon     = REGION_ICONS[r.id] || '🏟️';
    return `
      <div class="region-card${selected ? ' selected' : ''}" data-region="${r.id}">
        <div class="arch-icon">${icon}</div>
        <div class="arch-name">${r.label}</div>
        <div class="arch-tagline">${r.tagline}</div>
        <div class="arch-desc">${r.description}</div>
      </div>
    `;
  }).join('');

  return `
    <div>
      <div style="text-align:center;margin-bottom:12px;">
        <div style="font-size:11px;color:var(--muted);font-weight:700;letter-spacing:2px;text-transform:uppercase;">
          Step 2 of 4
        </div>
        <div style="font-size:18px;font-weight:800;color:var(--text);margin-top:4px;">
          Where is your franchise?
        </div>
        <div style="font-size:13px;color:var(--soft);margin-top:4px;">
          Region shapes your weather, travel, and ballpark character.
        </div>
      </div>

      <div class="archetype-grid">${cards}</div>

      <div style="display:flex;gap:10px;margin-top:12px;">
        <button class="btn-back" id="region-back-btn">← Back</button>
        <button class="btn-primary" id="region-next-btn" style="flex:1">
          Name Your Team →
        </button>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — TEAM NAMING (was Step 2 before Phase 13.5)

function _renderNamingStep() {
  const arch = ARCHETYPES.find(a => a.id === _archetype);

  return `
    <div class="intro-form">
      <div style="text-align:center;margin-bottom:16px;">
        <div style="font-size:11px;color:var(--muted);font-weight:700;letter-spacing:2px;text-transform:uppercase;">
          Step 3 of 4
        </div>
        <div style="font-size:18px;font-weight:800;color:var(--text);margin-top:4px;">
          Name your franchise
        </div>
      </div>

      <div class="input-group">
        <label>Your Name (GM)</label>
        <input type="text" id="gm-name" placeholder="e.g. Alex Carter"
          maxlength="24" value="${_escape(_gmName)}" autocomplete="name">
      </div>
      <div class="input-group">
        <label>Team City</label>
        <input type="text" id="team-city" placeholder="e.g. Chicago"
          maxlength="14" value="${_escape(_teamCity)}" autocomplete="off">
      </div>
      <div class="input-group">
        <label>Team Nickname</label>
        <input type="text" id="team-nick" placeholder="e.g. Wolves"
          maxlength="12" value="${_escape(_teamNick)}" autocomplete="off">
      </div>

      <div style="display:flex;gap:10px;margin-top:8px;">
        <button class="btn-back" id="naming-back-btn">← Back</button>
        <button class="btn-primary" id="naming-next-btn" style="flex:1">
          Set Colors →
        </button>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// STEP 4 — TEAM COLORS (was Step 3 before Phase 13.5)
// ─────────────────────────────────────────────────────────────

function _renderColorsStep() {
  const theme = 'dark'; // setup screen always on dark

  return `
    <div class="intro-form">
      <div style="text-align:center;margin-bottom:4px;">
        <div class="badge-diamond" id="color-preview-badge" style="width:52px;height:52px;font-size:28px;margin:0 auto 8px;border-radius:12px;">
          ${_teamIcon}
        </div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:2px;color:var(--text);">
          ${_escape(_teamCity || 'Your City')} ${_escape(_teamNick || 'Team')}
        </div>
      </div>

      <div class="color-picker-section">
        <div class="color-picker-label">Primary Color</div>
        <div class="color-swatch-grid" id="primary-swatch-grid">
          ${_renderSwatches('primary', theme)}
        </div>
      </div>

      <div class="color-picker-section">
        <div class="color-picker-label">Secondary Color</div>
        <div class="color-swatch-grid" id="secondary-swatch-grid">
          ${_renderSwatches('secondary', theme)}
        </div>
      </div>

      <div style="display:flex;gap:10px;">
        <button class="btn-back" id="colors-back-btn">← Back</button>
        <button class="btn-primary" id="start-btn" style="flex:1">
          Take the Job →
        </button>
      </div>
    </div>
  `;
}

function _renderSwatches(which, theme) {
  const current = which === 'primary' ? _primaryColor : _secondaryColor;
  return COLOR_PALETTE.map(c => {
    const hex     = c[theme] || c.dark;
    const sel     = c.id === current;
    // White text checkmark for dark swatches, dark for light
    const [r,g,b] = _hexToRGB(hex);
    const lum     = 0.299*r + 0.587*g + 0.114*b;
    const checkColor = lum > 140 ? '#0F1117' : '#FFFFFF';
    return `
      <div class="color-swatch${sel ? ' selected' : ''}"
        data-color="${c.id}" data-which="${which}"
        style="background:${hex};${sel ? `--check-color:${checkColor}` : ''};"
        title="${c.name}">
      </div>
    `;
  }).join('');
}


// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners() {
  // Step 1 — archetype cards
  document.querySelectorAll('.archetype-card:not(.used)').forEach(card => {
    card.addEventListener('click', () => {
      const archetypeId = card.dataset.archetype;
      if (!archetypeId) return;  // guard — region cards also use similar classes
      _archetype = archetypeId;
      document.querySelectorAll('.archetype-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const nextBtn = document.getElementById('arch-next-btn');
      if (nextBtn) nextBtn.disabled = false;
    });
  });

  const archNext = document.getElementById('arch-next-btn');
  if (archNext) archNext.addEventListener('click', () => {
    if (!_archetype) return;
    _step = 2;  // → Region selection
    render();
  });

  // Step 2 — region selection
  document.querySelectorAll('.region-card').forEach(card => {
    card.addEventListener('click', () => {
      _region = card.dataset.region;
      document.querySelectorAll('.region-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });

  const regionNext = document.getElementById('region-next-btn');
  if (regionNext) regionNext.addEventListener('click', () => {
    _step = 3;  // → Naming
    render();
  });

  const regionBack = document.getElementById('region-back-btn');
  if (regionBack) regionBack.addEventListener('click', () => { _step = 1; render(); });

  // Step 3 — naming
  const namingNext = document.getElementById('naming-next-btn');
  if (namingNext) namingNext.addEventListener('click', () => {
    _gmName    = document.getElementById('gm-name')?.value.trim()  || 'Anonymous GM';
    _teamCity  = document.getElementById('team-city')?.value.trim()|| 'Springfield';
    _teamNick  = document.getElementById('team-nick')?.value.trim() || 'Bears';
    _step = 4;  // → Colors
    render();
  });

  const namingBack = document.getElementById('naming-back-btn');
  if (namingBack) namingBack.addEventListener('click', () => { _step = 2; render(); });

  // Step 4 — colors
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      const colorId = swatch.dataset.color;
      const which   = swatch.dataset.which;

      if (which === 'primary') {
        _primaryColor = colorId;
        document.querySelectorAll('[data-which="primary"]').forEach(s =>
          s.classList.toggle('selected', s.dataset.color === colorId)
        );
      } else {
        _secondaryColor = colorId;
        document.querySelectorAll('[data-which="secondary"]').forEach(s =>
          s.classList.toggle('selected', s.dataset.color === colorId)
        );
      }

      // Live preview — apply colors immediately
      applyTeamColors(_primaryColor, _secondaryColor, 'dark');

      // Update preview badge background
      const badge = document.getElementById('color-preview-badge');
      if (badge) {
        badge.style.background = getColorHex(_primaryColor, 'dark');
      }
    });
  });

  // Classic mode retired — Section 2.1. No mode selector step needed.

  const colorsBack = document.getElementById('colors-back-btn');
  if (colorsBack) colorsBack.addEventListener('click', () => { _step = 3; render(); });

  // Step 3 finalizes — start button is in colors step
  const startBtn = document.getElementById('start-btn');
  if (startBtn) startBtn.addEventListener('click', _handleStart);
}

// ─────────────────────────────────────────────────────────────
// GAME CREATION
// ─────────────────────────────────────────────────────────────

async function _handleStart() {
  const btn = document.getElementById('start-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Building franchise…'; }

  try {
    // Lazy import GameEngine to avoid circular deps at module load time
    const { startNewGame } = await import('../../engine/GameEngine.js');

    await startNewGame({
      archetypeId:   _archetype,
      gmName:        _gmName || 'Anonymous GM',
      city:          _teamCity || 'Springfield',
      nickname:      _teamNick || 'Bears',
      icon:          _teamIcon,
      primaryColor:  _primaryColor,
      secondaryColor: _secondaryColor,
      region:        _region,
      gameMode:      'live',   // Section 2.1 — always live mode
    });

    // Reload full app with new state
    await App.init();

  } catch (err) {
    console.error('SetupScreen._handleStart:', err);
    if (btn) { btn.disabled = false; btn.textContent = 'Take the Job →'; }
    App.showToast('Something went wrong starting the game. Please try again.', 'negative');
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _getUsedArchetypes() {
  // Check IndexedDB/StateManager for existing save slots
  // Returns list of archetype IDs already in use
  // For now returns empty — multi-slot logic added in Phase 14
  return [];
}

function _escape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _hexToRGB(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

// ─────────────────────────────────────────────────────────────
// CSS (injected once on first mount)
// ─────────────────────────────────────────────────────────────

let _cssInjected = false;

function _injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    /* ── Archetype step layout ── */
    .arch-layout{display:flex;flex-direction:column;height:100dvh;padding:0;}
    .arch-header-block{padding:32px 16px 12px;text-align:center;flex-shrink:0;}
    .arch-step-label{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:4px;}
    .arch-type-label{font-size:13px;font-weight:600;color:var(--soft);}

    /* ── 2-column card grid ── */
    .archetype-grid-2col{
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
      padding:0 12px;
      flex:1;
      align-content:start;
    }

    /* ── Card ── */
    .archetype-card{
      background:var(--surface);
      border:2px solid var(--border);
      border-radius:14px;
      padding:14px 12px 14px;
      cursor:pointer;
      transition:border-color .15s,background .15s;
      user-select:none;
      display:flex;
      flex-direction:column;
      align-items:center;
    }
    .region-card{background:var(--surface);border:2px solid var(--border);border-radius:14px;padding:14px;cursor:pointer;transition:border-color .15s,background .15s;user-select:none;}
    .archetype-card:active{opacity:.85;}
    .archetype-card.selected{border-color:var(--accent);background:var(--chip-accent-bg);}
    .archetype-card.used{opacity:.45;cursor:default;}
    .region-card:active{opacity:.85;}
    .region-card.selected{border-color:var(--accent);background:var(--chip-accent-bg);}

    /* ── Card content ── */
    .arch-name{
      font-family:'Bebas Neue',sans-serif;
      font-size:17px;
      letter-spacing:1.5px;
      color:var(--text);
      text-align:center;
      margin-bottom:4px;
      line-height:1.1;
    }
    .arch-premise{
      font-size:10px;
      color:var(--muted);
      text-align:center;
      margin-bottom:12px;
      line-height:1.3;
      min-height:26px;
    }
    .arch-used-badge{font-size:9px;font-weight:700;letter-spacing:.5px;padding:2px 6px;border-radius:4px;
      background:var(--surface2);color:var(--muted);border:1px solid var(--border);}

    /* ── Dot indicators ── */
    .arch-indicators{
      display:flex;
      flex-direction:column;
      gap:5px;
      width:100%;
    }
    .arch-ind-row{
      display:grid;
      grid-template-columns:52px 1fr;
      align-items:center;
      gap:0;
    }
    .arch-ind-label{
      font-size:8px;
      font-weight:700;
      letter-spacing:.8px;
      text-transform:uppercase;
      color:var(--muted);
    }
    .arch-ind-dots{
      display:flex;
      gap:4px;
      align-items:center;
    }
    .arch-dot{
      width:6px;
      height:6px;
      border-radius:50%;
      background:var(--surface2);
      border:1px solid var(--border);
      flex-shrink:0;
    }
    .arch-dot.filled{
      background:var(--accent);
      border-color:var(--accent);
    }

    /* ── Continue button ── */
    .arch-continue-btn{
      margin:12px 12px max(16px,env(safe-area-inset-bottom));
      flex-shrink:0;
      letter-spacing:2px;
    }

    /* ── Old single-col grid (kept for region step) ── */
    .archetype-grid{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;}

    /* Back button */
    .btn-back{padding:14px 18px;background:transparent;border:2px solid var(--border);
      border-radius:10px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;
      color:var(--muted);cursor:pointer;transition:border-color .15s,color .15s;white-space:nowrap;}
    .btn-back:active{border-color:var(--text);color:var(--text);}

    /* Color swatch checkmark */
    .color-swatch.selected::after{color:var(--check-color,#fff);}
  `;
  document.head.appendChild(style);
}

// Inject CSS and mount
_injectCSS();
