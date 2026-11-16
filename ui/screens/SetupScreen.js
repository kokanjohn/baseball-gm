/**
 * ui/screens/SetupScreen.js
 * New game creation flow rendered into #setup-content.
 *
 * Flow (3 steps):
 *   Step 1 — Archetype selection (6 cards, grouped by difficulty)
 *   Step 2 — Region selection (4 cards)
 *   Step 3 — Name and Colors: a live preview of the club (tap it to name the club in a sheet that sits
 *            on the keyboard — r171) + primary/secondary hue sliders that color the preview
 *   → "Take the Job" → GameEngine.startNewGame() → App.init()
 *
 * Rules:
 *   - No direct state writes. Calls GameEngine.startNewGame() with config.
 *   - applyTeamColors() called live during color selection for instant preview.
 *   - Archetype descriptions match plan Section 16 exactly.
 *   - Region descriptions match plan Section 8.13 exactly.
 *   - One-team-per-archetype rule enforced at selection time (Section 16.3).
 *     _getUsedArchetypes() reads live slot list from StateManager.
 *   - primaryColor and secondaryColor stored as hex strings (e.g. '#F5D253'),
 *     not palette IDs. formatters.js applyTeamColors() accepts hex directly.
 *   - Classic mode is retired (Section 2.1). Always live mode.
 *   - No scrolling on any step. All content fits on screen at once.
 */

import * as App          from '../App.js';
import * as StateManager from '../../store/StateManager.js';
import { applyTeamColors, applyTheme } from '../formatters.js';
import { REGIONS, REGION_DEFAULT }     from '../../data/constants.js';

// ─────────────────────────────────────────────────────────────
// ARCHETYPE DEFINITIONS (display layer — plan Section 16)
// ─────────────────────────────────────────────────────────────

const ARCHETYPES = [
  { id: 'institution', name: 'Institution', premise: 'Tradition and stability',    roster: 4, patience: 4, budget: 4 },
  { id: 'empire',      name: 'Empire',      premise: 'Veterans, rings or bust',    roster: 5, patience: 1, budget: 5 },
  { id: 'contender',   name: 'Contender',   premise: 'Proven core, win now',       roster: 3, patience: 2, budget: 3 },
  { id: 'gambler',     name: 'Gambler',     premise: 'High risk, high reward',     roster: 3, patience: 1, budget: 2 },
  { id: 'lab',         name: 'The Lab',     premise: 'Find undervalued players',   roster: 2, patience: 4, budget: 1 },
  { id: 'ember',       name: 'Ember',       premise: 'Young talent, tight budget', roster: 1, patience: 5, budget: 2 },
];

// Difficulty groups: Easy / Normal / Hard (Section 1.9)
const DIFFICULTY_GROUPS = [
  { label: 'Easy',   ids: ['institution', 'empire']  },
  { label: 'Normal', ids: ['contender',   'gambler']  },
  { label: 'Hard',   ids: ['lab',         'ember']    },
];

// ─────────────────────────────────────────────────────────────
// COLOR DEFAULTS (hex — not palette IDs)
// ─────────────────────────────────────────────────────────────

const PRIMARY_DEFAULT   = '#F5D253';   // gold dark
const SECONDARY_DEFAULT = '#22C55E';   // green dark

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _step           = 1;
let _archetype      = null;
let _region         = REGION_DEFAULT;
let _teamCity       = '';
let _teamNick       = '';
let _primaryColor   = PRIMARY_DEFAULT;
let _secondaryColor = SECONDARY_DEFAULT;

// ─────────────────────────────────────────────────────────────
// MOUNT
// ─────────────────────────────────────────────────────────────

/**
 * mount()
 * Renders the setup screen into #setup-content.
 * Called by App.js when no save slot exists, or when the user
 * selects "New Team" from TeamSelectScreen.
 */
export async function mount() {
  _step           = 1;
  _archetype      = null;
  _region         = REGION_DEFAULT;
  _teamCity       = '';
  _teamNick       = '';
  _primaryColor   = PRIMARY_DEFAULT;
  _secondaryColor = SECONDARY_DEFAULT;

  applyTheme('dark', _primaryColor, _secondaryColor);

  _injectCSS();
  await _render();
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

async function _render() {
  const container = document.getElementById('setup-content');
  if (!container) return;
  container.innerHTML = await _renderStep();
  _attachListeners();
}

async function _renderStep() {
  switch (_step) {
    case 1: return await _renderArchetypeStep();
    case 2: return _renderRegionStep();
    case 3: return _renderNameColorsStep();
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

function _renderArchCard(a, usedArchetypes) {
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
}

async function _renderArchetypeStep() {
  const usedArchetypes = await _getUsedArchetypes();

  const groupsHTML = DIFFICULTY_GROUPS.map(group => {
    const cards = group.ids.map(id => {
      const a = ARCHETYPES.find(x => x.id === id);
      return a ? _renderArchCard(a, usedArchetypes) : '';
    }).join('');
    return `
      <div class="arch-diff-group">
        <div class="arch-diff-label">${group.label}</div>
        <div class="arch-row-cards">${cards}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="arch-layout">
      <div class="step-header-block">
        <div class="step-label">Step 1 of 3</div>
        <div class="step-title">Team Type</div>
        <div class="step-sub">Decides roster strength, expectations, and budget</div>
      </div>
      <div class="arch-grid-wrap">
        ${groupsHTML}
      </div>
      <div class="step-footer">
        <button class="btn-primary arch-continue-btn" id="arch-next-btn" ${!_archetype ? 'disabled' : ''}>
          CONTINUE
        </button>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — REGION SELECTION
// ─────────────────────────────────────────────────────────────

function _renderRegionStep() {
  const regionEntries = Object.values(REGIONS);

  // Short but informative descriptions — no icons, fitting comfortably without scroll
  const REGION_SHORT = {
    north: 'Cold springs and late-season frost risk. Experienced grounds crews keep games on the field. Dense geography means shorter road trips.',
    south: 'Warm all season with no cold risk. Afternoon thunderstorms keep the grounds crew busy. Heat affects pitcher stamina late in the year.',
    east:  'Humid and unpredictable. Softer ground and higher rain risk than any other region. Travel distances are longer.',
    west:  'The driest region — lowest postponement risk. Wind and dust are the main weather factors. Altitude at some venues helps hitters.',
  };

  const cards = regionEntries.map(r => {
    const selected = _region === r.id;
    return `
      <div class="region-card${selected ? ' selected' : ''}" data-region="${r.id}">
        <div class="arch-name">${r.label}</div>
        <div class="region-desc">${REGION_SHORT[r.id] || r.description}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="step-layout">
      <div class="step-header-block">
        <div class="step-label">Step 2 of 3</div>
        <div class="step-title">Home Region</div>
        <div class="step-sub">Shapes your weather, travel, and ballpark character</div>
      </div>
      <div class="region-grid">${cards}</div>
      <div class="step-footer">
        <div style="display:flex;gap:10px;">
          <button class="btn-back" id="region-back-btn">Back</button>
          <button class="btn-primary" id="region-next-btn" style="flex:1;">CONTINUE</button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — NAME AND COLORS (merged)
// ─────────────────────────────────────────────────────────────

function _renderNameColorsStep() {
  // Convert stored hex to hue for slider initial position
  const primaryHue   = _hexToHue(_primaryColor);
  const secondaryHue = _hexToHue(_secondaryColor);
  const arch = ARCHETYPES.find(a => a.id === _archetype);
  const region = REGIONS[_region] || Object.values(REGIONS).find(r => r.id === _region);

  return `
    <div class="step-layout">
      <div class="step-header-block nc-header">
        <div class="step-label">Step 3 of 3</div>
        <div class="step-title">Name and Colors</div>
      </div>

      <div class="namecolors-body">

        <!-- r171 the club, as it'll look: tap to name it (the typing happens in a sheet above the keyboard) -->
        <button type="button" class="nc-preview" id="nc-preview" aria-label="Name your club">
          <div class="nc-band" id="nc-band">
            <div class="nc-ball">⚾</div>
            <div class="nc-names" id="nc-names">${_previewNames()}</div>
          </div>
          <div class="nc-stripe" id="nc-stripe"></div>
          <div class="nc-meta">
            <span>${_escape(arch?.name || '')}${region ? ` · ${_escape(region.label)}` : ''}</span>
            <span class="nc-edit">${_teamCity || _teamNick ? 'Edit name' : 'Tap to name'}</span>
          </div>
        </button>

        <!-- Primary color slider -->
        <div class="color-row">
          <div class="color-row-header">
            <span class="color-row-label">Primary</span>
            <div class="color-swatch-circle" id="primary-swatch"
              style="background:${_primaryColor};"></div>
          </div>
          <div class="hue-track-wrap">
            <div class="hue-track"></div>
            <input type="range" class="hue-slider" id="primary-hue"
              min="0" max="359" step="1" value="${primaryHue}" aria-label="Primary color">
          </div>
        </div>

        <!-- Secondary color slider -->
        <div class="color-row">
          <div class="color-row-header">
            <span class="color-row-label">Secondary</span>
            <div class="color-swatch-circle" id="secondary-swatch"
              style="background:${_secondaryColor};"></div>
          </div>
          <div class="hue-track-wrap">
            <div class="hue-track"></div>
            <input type="range" class="hue-slider" id="secondary-hue"
              min="0" max="359" step="1" value="${secondaryHue}" aria-label="Secondary color">
          </div>
        </div>

      </div><!-- /namecolors-body -->

      <div class="step-footer">
        <div style="display:flex;gap:10px;">
          <button class="btn-back" id="namecolors-back-btn">Back</button>
          <button id="start-btn" class="nc-start">${_named() ? 'TAKE THE JOB' : 'NAME YOUR CLUB'}</button>
        </div>
      </div>

      <!-- r171 the name sheet: sits on the keyboard -->
      <div class="nc-scrim" id="nc-scrim" hidden></div>
      <div class="nc-sheet" id="nc-sheet" role="dialog" aria-label="Name your club" hidden>
        <!-- (the name as it's typed: the big preview can sit behind the keyboard) -->
        <div class="nc-sheet-preview" id="nc-sheet-preview">${_sheetPreview()}</div>
        <div class="nc-sheet-row">
          <label for="team-city">City</label>
          <input type="text" id="team-city" placeholder="e.g. Riverton" maxlength="14"
            value="${_escape(_teamCity)}" autocomplete="off" autocapitalize="words" enterkeyhint="next">
        </div>
        <div class="nc-sheet-row">
          <label for="team-nick">Nickname</label>
          <input type="text" id="team-nick" placeholder="e.g. Rails" maxlength="12"
            value="${_escape(_teamNick)}" autocomplete="off" autocapitalize="words" enterkeyhint="done">
          <button type="button" class="nc-done" id="nc-done">Done</button>
        </div>
      </div>
    </div>
  `;
}

const _named = () => !!(_teamCity.trim() && _teamNick.trim());

/** The preview's two lines: the name as typed so far, or the invitation to name it. */
function _previewNames() {
  if (!_teamCity.trim() && !_teamNick.trim()) return `<div class="nc-city nc-empty">Your City</div><div class="nc-nick nc-empty">Your Club</div>`;
  return `<div class="nc-city">${_escape(_teamCity.trim() || 'Your City')}</div><div class="nc-nick">${_escape(_teamNick.trim() || 'Your Club')}</div>`;
}

/** The sheet's one-line preview. */
function _sheetPreview() {
  const c = _teamCity.trim(), n = _teamNick.trim();
  return c || n ? `${_escape(c || 'Your City')} <b>${_escape(n || 'Your Club')}</b>` : 'Your City <b>Your Club</b>';
}

/** The preview in the chosen colors: the band in the primary (its text dark or light to read), the stripe in the secondary. */
function _paintPreview() {
  const band = document.getElementById('nc-band'), stripe = document.getElementById('nc-stripe');
  if (band) { band.style.background = _primaryColor; band.style.color = _readableOn(_primaryColor); }
  if (stripe) stripe.style.background = _secondaryColor;
  const mini = document.getElementById('nc-sheet-preview');
  if (mini) { mini.style.background = _primaryColor; mini.style.color = _readableOn(_primaryColor); mini.style.borderBottomColor = _secondaryColor; }
}

function _readableOn(hex) {
  const c = (i) => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5);
  return L > 0.35 ? '#0F1117' : '#FFFFFF';
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners() {
  // ── Step 1: archetype cards ───────────────────────────────
  document.querySelectorAll('.archetype-card:not(.used)').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.archetype;
      if (!id) return;
      _archetype = id;
      document.querySelectorAll('.archetype-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const btn = document.getElementById('arch-next-btn');
      if (btn) btn.disabled = false;
    });
  });

  document.getElementById('arch-next-btn')?.addEventListener('click', () => {
    if (!_archetype) return;
    _step = 2;
    _render();
  });

  // ── Step 2: region cards ──────────────────────────────────
  document.querySelectorAll('.region-card').forEach(card => {
    card.addEventListener('click', () => {
      _region = card.dataset.region;
      document.querySelectorAll('.region-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });

  document.getElementById('region-next-btn')?.addEventListener('click', () => {
    _step = 3;
    _render();
  });

  document.getElementById('region-back-btn')?.addEventListener('click', () => {
    _step = 1;
    _render();
  });

  // ── Step 3: the name, in a sheet above the keyboard ───────
  const cityInput = document.getElementById('team-city');
  const nickInput = document.getElementById('team-nick');
  const startBtn  = document.getElementById('start-btn');
  if (cityInput) {
    _paintPreview();
    const refresh = () => {
      _teamCity = cityInput.value;
      _teamNick = nickInput.value;
      const names = document.getElementById('nc-names');
      if (names) names.innerHTML = _previewNames();
      const edit = document.querySelector('.nc-edit');
      if (edit) edit.textContent = _teamCity.trim() || _teamNick.trim() ? 'Edit name' : 'Tap to name';
      if (startBtn) startBtn.textContent = _named() ? 'TAKE THE JOB' : 'NAME YOUR CLUB';
      const mini = document.getElementById('nc-sheet-preview');
      if (mini) mini.innerHTML = _sheetPreview();
    };
    cityInput.addEventListener('input', refresh);
    nickInput.addEventListener('input', refresh);
    cityInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nickInput.focus(); } });
    nickInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _closeSheet(); } });
    document.getElementById('nc-preview')?.addEventListener('click', () => _openSheet(!_teamCity.trim() || _teamNick.trim() ? cityInput : nickInput));
    document.getElementById('nc-done')?.addEventListener('click', _closeSheet);
    document.getElementById('nc-scrim')?.addEventListener('click', _closeSheet);
  }

  // ── Step 3: hue sliders ───────────────────────────────────
  document.getElementById('primary-hue')?.addEventListener('input', (e) => {
    _primaryColor = _hueToHex(parseInt(e.target.value));
    const swatch = document.getElementById('primary-swatch');
    if (swatch) swatch.style.background = _primaryColor;
    applyTeamColors(_primaryColor, _secondaryColor);
    _paintPreview();
  });

  document.getElementById('secondary-hue')?.addEventListener('input', (e) => {
    _secondaryColor = _hueToHex(parseInt(e.target.value));
    const swatch = document.getElementById('secondary-swatch');
    if (swatch) swatch.style.background = _secondaryColor;
    applyTeamColors(_primaryColor, _secondaryColor);
    _paintPreview();
  });

  // ── Step 3: back + start ──────────────────────────────────
  document.getElementById('namecolors-back-btn')?.addEventListener('click', () => {
    _closeSheet();
    _step = 2;
    _render();
  });

  // (not named yet: the button opens the sheet)
  document.getElementById('start-btn')?.addEventListener('click', () => {
    if (_named()) _handleStart();
    else _openSheet(_teamCity.trim() ? nickInput : cityInput);
  });
}

// ─────────────────────────────────────────────────────────────
// r171 THE NAME SHEET — sits on top of the keyboard
// ─────────────────────────────────────────────────────────────

let _vvHandler = null;

/** Keep the sheet's bottom on the keyboard's top: the visual viewport shrinks when the keyboard opens. */
function _placeSheet() {
  const sheet = document.getElementById('nc-sheet'), vv = window.visualViewport;
  if (!sheet) return;
  const covered = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  sheet.style.bottom = `${covered}px`;
}

function _openSheet(focusEl) {
  const sheet = document.getElementById('nc-sheet'), scrim = document.getElementById('nc-scrim');
  if (!sheet) return;
  sheet.hidden = false; scrim.hidden = false;
  App.setTyping(true);   // §122.62 sideways: the sheet across the phone, on the keyboard (not under it)
  requestAnimationFrame(() => { sheet.classList.add('open'); scrim.classList.add('open'); });
  if (window.visualViewport && !_vvHandler) {
    _vvHandler = () => _placeSheet();
    window.visualViewport.addEventListener('resize', _vvHandler);
    window.visualViewport.addEventListener('scroll', _vvHandler);
  }
  _placeSheet();
  focusEl?.focus({ preventScroll: true });
}

function _closeSheet() {
  const sheet = document.getElementById('nc-sheet'), scrim = document.getElementById('nc-scrim');
  if (window.visualViewport && _vvHandler) {
    window.visualViewport.removeEventListener('resize', _vvHandler);
    window.visualViewport.removeEventListener('scroll', _vvHandler);
    _vvHandler = null;
  }
  App.setTyping(false);
  if (!sheet || sheet.hidden) return;
  document.activeElement?.blur?.();
  sheet.classList.remove('open'); scrim.classList.remove('open');
  sheet.hidden = true; scrim.hidden = true;
}

// ─────────────────────────────────────────────────────────────
// GAME CREATION
// ─────────────────────────────────────────────────────────────

async function _handleStart() {
  const btn = document.getElementById('start-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Building franchise…'; }

  // Capture final field values
  _teamCity = (document.getElementById('team-city')?.value || _teamCity).trim() || 'Springfield';
  _teamNick = (document.getElementById('team-nick')?.value || _teamNick).trim() || 'Bears';

  try {
    const { startNewGame } = await import('../../engine/GameEngine.js');

    await startNewGame({
      archetypeId:    _archetype,
      gmName:         'GM',          // GM name field removed from setup (Section 45 notes)
      city:           _teamCity,
      nickname:       _teamNick,
      icon:           '⚾',
      primaryColor:   _primaryColor,   // hex string, e.g. '#F5D253'
      secondaryColor: _secondaryColor, // hex string, e.g. '#22C55E'
      region:         _region,
      gameMode:       'live',          // Section 2.1 — always live mode
    });

    await App.init();

  } catch (err) {
    console.error('SetupScreen._handleStart:', err);
    if (btn) {
      btn.disabled    = false;
      btn.textContent = 'TAKE THE JOB';
      btn.style.opacity = '1';
    }
    App.showToast('Something went wrong starting the game. Please try again.', 'negative');
  }
}

// ─────────────────────────────────────────────────────────────
// USED ARCHETYPES — wired to live slot list (Section 16.3)
// ─────────────────────────────────────────────────────────────

/**
 * _getUsedArchetypes()
 * Returns array of archetype IDs that already have a save slot.
 * One archetype per slot is enforced by StateManager.createSlot().
 * This is the display-layer enforcement — used cards are dimmed at selection time.
 *
 * @returns {Promise<String[]>}
 */
async function _getUsedArchetypes() {
  try {
    const slots = await StateManager.listSlots();
    return slots
      .map(s => s.archetype)
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// COLOR HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * _hueToHex(hue)
 * Converts a 0–359 hue value to a hex color string.
 * Saturation and lightness are fixed at values that look good on
 * the dark app background while remaining distinct.
 *
 * Light range (yellow/lime 40–80): L=52 to avoid washing out.
 * Green range (100–160): L=45 for better visibility.
 * Default: S=78, L=55.
 *
 * @param {Number} hue
 * @returns {String} hex e.g. '#F5D253'
 */
function _hueToHex(hue) {
  const s = 78;
  let l;
  if (hue >= 40  && hue <= 80)  l = 52;   // yellow/lime — slightly darker
  else if (hue >= 100 && hue <= 160) l = 45; // green family
  else l = 55;
  return _hslToHex(hue, s, l);
}

/**
 * _hslToHex(h, s, l)
 * Standard HSL → hex conversion.
 *
 * @param {Number} h  — 0–360
 * @param {Number} s  — 0–100
 * @param {Number} l  — 0–100
 * @returns {String}
 */
function _hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k     = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * _hexToHue(hex)
 * Approximates the hue of a hex color for setting the slider initial position.
 * Not perfectly reversible — used only for the initial render position.
 *
 * @param {String} hex
 * @returns {Number} 0–359
 */
function _hexToHue(hex) {
  if (!hex || hex.length < 7) return 48; // default to gold hue
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d   = max - min;
  if (d === 0) return 0;
  let h;
  if      (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else                h = 60 * ((r - g) / d + 4);
  return Math.round((h + 360) % 360);
}

function _escape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

    /* ── Shared: full-height flex column, no overflow ── */
    .arch-layout,
    .step-layout {
      display: flex;
      flex-direction: column;
      height: calc(100 * var(--vh));
      max-height: calc(100 * var(--vh));
      overflow: hidden;
      padding: 0;
      box-sizing: border-box;
    }

    /* ── Shared: step header block ── */
    .step-header-block {
      padding: 36px 20px 12px;
      text-align: center;
      flex-shrink: 0;
    }
    .step-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .step-title {
      font-size: 20px;
      font-weight: 800;
      color: var(--text);
      line-height: 1.2;
    }
    .step-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
      line-height: 1.4;
    }

    /* ── Shared: footer with buttons, pinned to bottom ── */
    .step-footer {
      padding: 10px 20px max(16px, env(safe-area-inset-bottom));
      flex-shrink: 0;
    }

    /* ── Step 1: archetype grid ── */
    .arch-grid-wrap {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 0 16px;
      flex: 1;
      justify-content: center;
      min-height: 0;
    }
    .arch-diff-group {
      position: relative;
      border: 1.5px solid #2a2a3e;
      border-radius: 14px;
      padding: 16px 10px 12px;
      flex-shrink: 0;
    }
    .arch-diff-label {
      position: absolute;
      top: -1px;
      left: 50%;
      transform: translateX(-50%) translateY(-50%);
      padding: 0 8px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #3a3a4e;
      white-space: nowrap;
      background: none;
    }
    .arch-row-cards {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .archetype-card {
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: 12px;
      padding: 12px 8px 10px;
      cursor: pointer;
      transition: border-color .15s, background .15s;
      user-select: none;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .archetype-card:active  { opacity: .85; }
    .archetype-card.selected { border-color: var(--accent); background: var(--chip-accent-bg); }
    .archetype-card.used     { opacity: .45; cursor: default; }
    .arch-name {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 19px;
      letter-spacing: 1.5px;
      color: var(--text);
      text-align: center;
      margin-bottom: 2px;
      line-height: 1.1;
      white-space: nowrap;        /* Institution must never wrap */
    }
    .arch-premise {
      font-size: 9px;
      color: var(--muted);
      text-align: center;
      margin-bottom: 8px;
      line-height: 1.3;
    }
    .arch-used-badge {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: .5px;
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--surface2);
      color: var(--muted);
      border: 1px solid var(--border);
    }
    .arch-indicators {
      display: flex;
      flex-direction: column;
      gap: 3px;
      width: 100%;
    }
    .arch-ind-row {
      display: grid;
      grid-template-columns: 46px 1fr;
      align-items: center;
    }
    .arch-ind-label {
      font-size: 7px;
      font-weight: 700;
      letter-spacing: .8px;
      text-transform: uppercase;
      color: var(--muted);
    }
    .arch-ind-dots {
      display: flex;
      gap: 3px;
      align-items: center;
    }
    .arch-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--surface2);
      border: 1px solid #2a2a3e;
      flex-shrink: 0;
    }
    .arch-dot.filled {
      background: var(--accent);
      border-color: var(--accent);
    }
    .arch-continue-btn {
      letter-spacing: 2px;
    }

    /* ── Step 2: region cards ── */
    .region-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 0 20px;
      flex: 1;
      justify-content: center;
      min-height: 0;
    }
    .region-card {
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: 12px;
      padding: 14px 14px;
      cursor: pointer;
      transition: border-color .15s, background .15s;
      user-select: none;
      flex-shrink: 0;
    }
    .region-card:active  { opacity: .85; }
    .region-card.selected { border-color: var(--accent); background: var(--chip-accent-bg); }
    .region-desc {
      font-size: 11px;
      color: var(--muted);
      margin-top: 3px;
      line-height: 1.4;
    }

    /* ── Step 3: name + colors body ── */
    .nc-header { padding-bottom: 4px; }
    .namecolors-body {
      flex: 1;
      min-height: 0;
      padding: 8px 20px 0;
      display: flex;
      flex-direction: column;
      gap: 22px;
      justify-content: flex-start;
      padding-bottom: 8px;
    }

    /* r171 the club preview: fills the space the empty fields used to leave */
    .nc-preview {
      all: unset;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      width: 100%;
      flex: 1 1 auto;
      min-height: 0;
      max-height: 430px;
      border-radius: 18px;
      overflow: hidden;
      background: var(--surface);
      border: 1.5px solid var(--border);
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      transition: transform .12s;
    }
    .nc-preview:active { transform: scale(.985); }
    .nc-preview:focus-visible { outline: 2px solid #F5D253; outline-offset: 3px; }
    .nc-band {
      position: relative;
      flex: 1 1 auto;
      min-height: 120px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 18px 16px;
      transition: background .1s, color .1s;
    }
    .nc-ball { font-size: 30px; line-height: 1; margin-bottom: 10px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.25)); }
    .nc-names { text-align: center; }
    .nc-city {
      font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 800;
      letter-spacing: 4px; text-transform: uppercase; opacity: .85;
    }
    .nc-nick {
      font-family: 'Bebas Neue', sans-serif; font-size: clamp(40px, calc(13 * var(--vw)), 58px);
      letter-spacing: 2px; line-height: 1; margin-top: 2px;
      overflow-wrap: anywhere;
    }
    .nc-empty { opacity: .45; }
    .nc-stripe { height: 10px; transition: background .1s; }
    .nc-meta {
      display: flex; justify-content: space-between; align-items: center;
      padding: 11px 16px;
      font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600; color: var(--muted);
    }
    .nc-edit { color: var(--text); font-weight: 700; }
    .nc-edit::after { content: ' ›'; }

    .nc-start {
      flex: 1; letter-spacing: 2px; padding: 14px; border: none; border-radius: 10px;
      font-family: 'DM Sans', sans-serif; font-size: 15px; font-weight: 700; text-transform: uppercase;
      cursor: pointer; background: #F5D253; color: #0F1117;
    }

    /* r171 the name sheet, on top of the keyboard */
    .nc-scrim {
      position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 900;
      opacity: 0; transition: opacity .15s;
    }
    .nc-scrim.open { opacity: 1; }
    .nc-sheet {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 901;
      background: var(--surface);
      border-top: 1.5px solid var(--border);
      border-radius: 16px 16px 0 0;
      padding: 14px 16px 12px;
      display: flex; flex-direction: column; gap: 10px;
      box-shadow: 0 -8px 24px rgba(0,0,0,.35);
      transform: translateY(12px); opacity: 0; transition: transform .15s, opacity .15s;
    }
    .nc-sheet.open { transform: none; opacity: 1; }
    /* §122.62 typing on a sideways phone (body[data-typing]: the hold let go): one compact row across the phone,
       on the keyboard — the city, the nickname, Done; the name shows in the fields themselves */
    body[data-typing] .nc-sheet { flex-direction: row; align-items: center; gap: 12px; padding: 8px max(16px, env(safe-area-inset-right)) 8px max(16px, env(safe-area-inset-left)); border-radius: 12px 12px 0 0; }
    body[data-typing] .nc-sheet-preview { display: none; }
    body[data-typing] .nc-sheet-row { flex: 1; min-width: 0; }
    body[data-typing] .nc-sheet-row label { width: auto; }
    body[data-typing] .nc-sheet-row input { padding: 8px 10px; }
    .nc-sheet[hidden], .nc-scrim[hidden] { display: none; }
    .nc-sheet-row { display: flex; align-items: center; gap: 10px; }
    .nc-sheet-preview {
      margin: -14px -16px 2px; padding: 10px 16px;
      border-radius: 16px 16px 0 0; border-bottom: 4px solid transparent;
      font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .nc-sheet-preview b { font-family: 'Bebas Neue', sans-serif; font-size: 22px; letter-spacing: 1.5px; font-weight: 400; margin-left: 6px; text-transform: none; }
    .nc-sheet-row label {
      width: 70px; flex-shrink: 0;
      font-size: 10px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: var(--muted);
    }
    .nc-sheet-row input {
      flex: 1; min-width: 0;
      background: var(--bg, #0F1117); border: 2px solid var(--border); color: var(--text);
      font-family: 'DM Sans', sans-serif; font-size: 16px; padding: 10px 12px; border-radius: 10px; outline: none;
    }
    .nc-sheet-row input:focus { border-color: #F5D253; }
    .nc-done {
      flex-shrink: 0; padding: 11px 16px; border: none; border-radius: 10px;
      background: #F5D253; color: #0F1117; font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 800; cursor: pointer;
    }
    /* Color rows */
    .color-row {
      flex-shrink: 0;
    }
    .color-row-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .color-row-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--muted);
    }
    .color-swatch-circle {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,.15);
      flex-shrink: 0;
      transition: background .1s;
    }

    /* Hue slider */
    .hue-track-wrap {
      position: relative;
      height: 24px;
      display: flex;
      align-items: center;
    }
    .hue-track {
      position: absolute;
      left: 0; right: 0;
      height: 8px;
      border-radius: 4px;
      background: linear-gradient(to right,
        hsl(0,78%,55%),   hsl(30,78%,55%),  hsl(60,78%,52%),
        hsl(90,78%,52%),  hsl(120,78%,45%), hsl(150,78%,45%),
        hsl(180,78%,45%), hsl(210,78%,55%), hsl(240,78%,60%),
        hsl(270,78%,55%), hsl(300,78%,50%), hsl(330,78%,50%),
        hsl(359,78%,55%));
      pointer-events: none;
    }
    .hue-slider {
      position: relative;
      width: 100%;
      height: 8px;
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      cursor: pointer;
      outline: none;
      border: none;
    }
    .hue-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #fff;
      border: 2px solid rgba(0,0,0,.25);
      cursor: pointer;
      box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
    .hue-slider::-moz-range-thumb {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #fff;
      border: 2px solid rgba(0,0,0,.25);
      cursor: pointer;
      box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }

    /* Back button */
    .btn-back {
      padding: 14px 18px;
      background: transparent;
      border: 2px solid var(--border);
      border-radius: 10px;
      font-family: 'DM Sans', sans-serif;
      font-size: 14px;
      font-weight: 700;
      color: var(--muted);
      cursor: pointer;
      transition: border-color .15s, color .15s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .btn-back:active { border-color: var(--text); color: var(--text); }

    /* btn-primary disabled state */
    .btn-primary:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  `;
  document.head.appendChild(style);
}

// Inject CSS immediately on module load
_injectCSS();
