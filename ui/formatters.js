/**
 * ui/formatters.js
 * Display formatting utilities and team color application.
 *
 * This is the first UI file loaded. All other UI modules import from here.
 * No game logic — pure display transformation and DOM styling.
 *
 * Rules:
 *   - No state imports. All functions accept plain values, return strings or void.
 *   - applyTeamColors() is the single place CSS variables are set. Nothing else
 *     calls setProperty for team colors.
 *   - formatMoney() is the canonical money display function. Every dollar value
 *     in the UI goes through here — never format money inline.
 *   - All functions are exported individually — no default export.
 *
 * Color system:
 *   primaryColor  → --accent, --accent-bar, --chip-accent-bg, --accent-txt
 *   secondaryColor → --accent2, --accent2-txt
 *   Both stored as COLOR_PALETTE id strings in state.settings.
 *   applyTeamColors() looks up the correct hex for the active theme automatically.
 */

import { COLOR_PALETTE, COLOR_PRIMARY_DEFAULT, COLOR_SECONDARY_DEFAULT } from '../data/constants.js';

// ─────────────────────────────────────────────────────────────
// MONEY FORMATTING
// ─────────────────────────────────────────────────────────────

/**
 * formatMoney(amountK)
 * Canonical money display. All values stored in $K internally.
 *   < 1000K  → "$XXK"    e.g. $350K
 *   >= 1000K → "$X.XM"   e.g. $1.2M, $12M, $35M
 *
 * @param {Number} amountK  — value in thousands
 * @returns {String}
 */
export function formatMoney(amountK) {
  if (amountK === null || amountK === undefined) return '—';
  if (amountK < 0) return `-${formatMoney(Math.abs(amountK))}`;
  if (amountK >= 1000) {
    const millions = amountK / 1000;
    // Show one decimal only if needed (e.g. $1.2M but $12M not $12.0M)
    const formatted = millions % 1 === 0
      ? millions.toFixed(0)
      : millions.toFixed(1);
    return `$${formatted}M`;
  }
  return `$${Math.round(amountK)}K`;
}

/**
 * formatMoneySigned(amountK)
 * Like formatMoney but prefixes + for positive values.
 * Used for payroll delta displays (e.g. "+$1.2M" or "-$350K").
 *
 * @param {Number} amountK
 * @returns {String}
 */
export function formatMoneySigned(amountK) {
  if (!amountK) return '$0K';
  return amountK > 0 ? `+${formatMoney(amountK)}` : formatMoney(amountK);
}

// ─────────────────────────────────────────────────────────────
// PLAYER / GAME FORMATTING
// ─────────────────────────────────────────────────────────────

/**
 * formatOVR(ovr)
 * Formats an OVR number for display. Returns em-dash for null/undefined.
 *
 * @param {Number|null} ovr
 * @returns {String}
 */
export function formatOVR(ovr) {
  if (ovr === null || ovr === undefined) return '—';
  return String(Math.round(ovr));
}

/**
 * formatRecord(wins, losses)
 * Formats a win-loss record. Returns "0–0" for nulls.
 *
 * @param {Number} wins
 * @param {Number} losses
 * @returns {String}
 */
export function formatRecord(wins, losses) {
  return `${wins ?? 0}–${losses ?? 0}`;
}

/**
 * formatGB(gb)
 * Formats a games-behind value.
 * '-' for the leader, 'X.0' or 'X.5' for others.
 *
 * @param {String|Number} gb
 * @returns {String}
 */
export function formatGB(gb) {
  if (gb === '-' || gb === null || gb === undefined) return '—';
  const n = parseFloat(gb);
  if (isNaN(n)) return String(gb);
  return n % 1 === 0 ? `${n}.0` : String(n);
}

/**
 * formatSalary(amountK, yearsLeft?)
 * Compact salary display for roster rows.
 *   formatSalary(350)        → "$350K"
 *   formatSalary(1200, 2)    → "$1.2M / 2yr"
 *   formatSalary(350, 1)     → "$350K / expiring"
 *
 * @param {Number} amountK
 * @param {Number} [yearsLeft]
 * @returns {String}
 */
export function formatSalary(amountK, yearsLeft) {
  const base = formatMoney(amountK);
  if (yearsLeft === undefined || yearsLeft === null) return base;
  if (yearsLeft <= 1) return `${base} / expiring`;
  return `${base} / ${yearsLeft}yr`;
}

/**
 * formatAge(dob)
 * Calculates and formats player age from date-of-birth string.
 *
 * @param {String} dob  — 'YYYY-MM-DD'
 * @returns {String}
 */
export function formatAge(dob) {
  if (!dob) return '—';
  const birth    = new Date(dob);
  const today    = new Date();
  let age        = today.getFullYear() - birth.getFullYear();
  const monthOff = today.getMonth() - birth.getMonth();
  if (monthOff < 0 || (monthOff === 0 && today.getDate() < birth.getDate())) age--;
  return String(age);
}

/**
 * formatIP(ip)
 * Formats innings pitched to standard baseball notation.
 *   3.999 → "4.0"
 *   7.333 → "7.1"
 *   7.666 → "7.2"
 *
 * @param {Number} ip  — stored as fractional (0.333 per out)
 * @returns {String}
 */
export function formatIP(ip) {
  if (ip === null || ip === undefined) return '—';
  const full  = Math.floor(ip);
  const frac  = ip - full;
  const outs  = Math.round(frac * 3);
  return `${full}.${outs > 2 ? 0 : outs}`;
}

/**
 * formatERA(er, ip)
 * Calculates and formats ERA from raw components.
 *
 * @param {Number} er
 * @param {Number} ip
 * @returns {String}
 */
export function formatERA(er, ip) {
  if (!ip || ip < 0.1) return '—';
  return ((er / ip) * 9).toFixed(2);
}

/**
 * formatWHIP(h, bb, ip)
 * Calculates and formats WHIP.
 *
 * @param {Number} h
 * @param {Number} bb
 * @param {Number} ip
 * @returns {String}
 */
export function formatWHIP(h, bb, ip) {
  if (!ip || ip < 0.1) return '—';
  return ((h + bb) / ip).toFixed(2);
}

/**
 * formatAVG(h, ab)
 * Calculates and formats batting average.
 *
 * @param {Number} h
 * @param {Number} ab
 * @returns {String}
 */
export function formatAVG(h, ab) {
  if (!ab) return '.000';
  return (h / ab).toFixed(3).replace(/^0/, '');
}

/**
 * formatOPS(h, doubles, hr, bb, ab)
 * Calculates and formats OPS (OBP + SLG).
 *
 * @param {Number} h
 * @param {Number} doubles
 * @param {Number} hr
 * @param {Number} bb
 * @param {Number} ab
 * @returns {String}
 */
export function formatOPS(h, doubles, hr, bb, ab) {
  if (!ab) return '.000';
  const pa  = ab + bb;
  const obp = (h + bb) / pa;
  // Total bases: singles=1, doubles=2, triples=3 (approx: total h - doubles - hr = singles+triples)
  const singles = h - doubles - hr;
  const tb  = singles + (doubles * 2) + hr * 4;
  const slg = tb / ab;
  return (obp + slg).toFixed(3).replace(/^0/, '');
}

/**
 * formatIMP(impScore)
 * Formats an IMP value for display.
 *   null → "—"
 *   positive → "+2.45"
 *   negative → "-1.20"
 *   zero → "0.00"
 *
 * @param {Number|null} impScore
 * @returns {String}
 */
export function formatIMP(impScore) {
  if (impScore === null || impScore === undefined) return '—';
  const fixed = Math.abs(impScore).toFixed(2);
  if (impScore > 0)  return `+${fixed}`;
  if (impScore < 0)  return `-${fixed}`;
  return fixed;
}

// ─────────────────────────────────────────────────────────────
// DATE / TIME FORMATTING
// ─────────────────────────────────────────────────────────────

/**
 * formatDate(isoDate)
 * Formats an ISO date string for schedule/inbox display.
 *   '2025-04-15' → 'Apr 15'
 *
 * @param {String} isoDate  — 'YYYY-MM-DD'
 * @returns {String}
 */
export function formatDate(isoDate) {
  if (!isoDate) return '—';
  const [, month, day] = isoDate.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(month) - 1]} ${parseInt(day)}`;
}

/**
 * formatGameTime(unixMs)
 * Formats a Unix ms game time to a short local time string.
 *   → '1:05 PM'
 *
 * @param {Number} unixMs
 * @returns {String}
 */
export function formatGameTime(unixMs) {
  if (!unixMs) return '—';
  const d     = new Date(unixMs);
  let hours   = d.getHours();
  const mins  = d.getMinutes().toString().padStart(2, '0');
  const ampm  = hours >= 12 ? 'PM' : 'AM';
  hours       = hours % 12 || 12;
  return `${hours}:${mins} ${ampm}`;
}

/**
 * formatGameLabel(game)
 * Returns a short label for a game in the schedule list.
 *   Home: 'vs NYE'
 *   Away: '@ BOS'
 *
 * @param {Object} game
 * @returns {String}
 */
export function formatGameLabel(game) {
  if (!game) return '—';
  const prefix = game.isHome ? 'vs' : '@';
  return `${prefix} ${game.opponent || '?'}`;
}

// ─────────────────────────────────────────────────────────────
// STREAK FORMATTING
// ─────────────────────────────────────────────────────────────

/**
 * formatStreak(streak)
 * Formats a win/loss streak number.
 *   3 → 'W3'    -4 → 'L4'    0 → '—'
 *
 * @param {Number} streak  — positive = wins, negative = losses
 * @returns {String}
 */
export function formatStreak(streak) {
  if (!streak) return '—';
  return streak > 0 ? `W${streak}` : `L${Math.abs(streak)}`;
}

// ─────────────────────────────────────────────────────────────
// PHASE / STATUS FORMATTING
// ─────────────────────────────────────────────────────────────

/**
 * formatPhaseLabel(phase)
 * Returns a human-readable phase label for the header.
 *
 * @param {String} phase
 * @returns {String}
 */
export function formatPhaseLabel(phase) {
  const labels = {
    SETUP:                 'Setup',
    SPRING_TRAINING:       'Spring Training',
    REGULAR_SEASON:        'Regular Season',
    ALL_STAR_BREAK:        'All-Star Break',
    TRADE_DEADLINE:        'Trade Deadline',
    PLAYOFF_BRACKET_BUILD: 'Playoffs',
    WILD_CARD:             'Wild Card',
    FIRST_ROUND:           'First Round',
    DIVISION_SERIES:       'Division Series',
    WORLD_SERIES:          'World Series',
    SEASON_SUMMARY:        'Season Complete',
    OFFSEASON:             'Offseason',
  };
  return labels[phase] || phase || '—';
}

/**
 * formatGameStatus(status)
 * Returns a display pill label for game status.
 *
 * @param {String} status
 * @returns {String}
 */
export function formatGameStatus(status) {
  const labels = {
    scheduled:  'PRE-GAME',
    live:       'LIVE',
    final:      'FINAL',
    delayed:    'DELAYED',
    postponed:  'POSTPONED',
    suspended:  'SUSPENDED',
    makeup:     'MAKEUP',
  };
  return labels[status?.toLowerCase()] || (status?.toUpperCase() ?? '—');
}

// ─────────────────────────────────────────────────────────────
// TEAM COLOR APPLICATION
// ─────────────────────────────────────────────────────────────

/**
 * applyTeamColors(primaryId, secondaryId, theme?)
 * Sets all team color CSS variables on document.documentElement.
 * This is the single place CSS variables are set for team colors.
 *
 * primaryId   → --accent, --accent-bar, --chip-accent-bg, --accent-txt
 * secondaryId → --accent2, --accent2-txt
 *
 * Theme-aware: uses the dark or light hex variant based on current theme.
 * Falls back to defaults if palette ID not found.
 *
 * @param {String} primaryId    — COLOR_PALETTE id (e.g. 'gold')
 * @param {String} secondaryId  — COLOR_PALETTE id (e.g. 'green')
 * @param {String} [theme]      — 'dark'|'light'|'auto' (defaults to current html data-theme)
 */
export function applyTeamColors(primaryId, secondaryId, theme) {
  const activeTheme = theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : (theme || document.documentElement.getAttribute('data-theme') || 'dark');

  // Accept either a raw hex string (e.g. '#F5D253') or a palette ID (e.g. 'gold').
  // New saves store hex directly; legacy saves store palette IDs — both are supported.
  const primaryHex   = _resolveColor(primaryId,   activeTheme, COLOR_PRIMARY_DEFAULT);
  const secondaryHex = _resolveColor(secondaryId, activeTheme, COLOR_SECONDARY_DEFAULT);

  const root = document.documentElement;

  // Primary color variables
  const [pr, pg, pb] = _hexToRGB(primaryHex);
  root.style.setProperty('--accent',          primaryHex);
  root.style.setProperty('--accent-bar',      primaryHex);
  root.style.setProperty('--chip-accent-bg',  `rgba(${pr},${pg},${pb},.14)`);
  root.style.setProperty('--accent-rgb',      `${pr},${pg},${pb}`);
  // Auto-pick black or white text on accent background based on luminance
  const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb;
  root.style.setProperty('--accent-txt',      lum > 140 ? '#0F1117' : '#FFFFFF');

  // Secondary color variables
  const [sr, sg, sb] = _hexToRGB(secondaryHex);
  root.style.setProperty('--accent2',         secondaryHex);
  root.style.setProperty('--chip-green-bg',   `rgba(${sr},${sg},${sb},.14)`);
  const lum2 = 0.299 * sr + 0.587 * sg + 0.114 * sb;
  root.style.setProperty('--accent2-txt',     lum2 > 140 ? '#0F1117' : '#FFFFFF');

  // Dynamic favicon — update browser tab color to match team primary (Phase 14)
  // Draws a small colored circle on a canvas and sets it as the favicon.
  // Falls back silently if canvas is unavailable.
  _updateFavicon(primaryHex);
}

/**
 * applyTheme(theme)
 * Sets the data-theme attribute on <html> and re-applies team colors
 * so the correct light/dark hex variants are used.
 *
 * @param {String}  theme         — 'dark'|'light'|'auto'
 * @param {String}  primaryId
 * @param {String}  secondaryId
 */
export function applyTheme(theme, primaryId, secondaryId) {
  const resolved = theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;

  document.documentElement.setAttribute('data-theme', resolved);
  applyTeamColors(primaryId, secondaryId, theme);
}

/**
 * getColorHex(colorId, theme?)
 * Returns the hex value for a palette color in the current theme.
 * Used by components that need the raw hex (e.g. canvas favicon rendering).
 *
 * @param {String} colorId
 * @param {String} [theme]  — defaults to current html data-theme
 * @returns {String} hex
 */
export function getColorHex(colorId, theme) {
  const activeTheme = theme
    || document.documentElement.getAttribute('data-theme')
    || 'dark';
  return _resolveColor(colorId, activeTheme, COLOR_PRIMARY_DEFAULT);
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * _updateFavicon(primaryHex)
 * Draws a 32×32 colored circle favicon using Canvas API and
 * updates the <link id="app-favicon"> element.
 * Silent no-op if canvas is unavailable (e.g. in tests).
 *
 * @param {String} primaryHex  — e.g. '#F5D253'
 */
function _updateFavicon(primaryHex) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width  = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Dark background circle
    ctx.beginPath();
    ctx.arc(16, 16, 16, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1a2e';
    ctx.fill();

    // Team color inner circle
    ctx.beginPath();
    ctx.arc(16, 16, 11, 0, Math.PI * 2);
    ctx.fillStyle = primaryHex;
    ctx.fill();

    const faviconEl = document.getElementById('app-favicon');
    if (faviconEl) faviconEl.href = canvas.toDataURL('image/png');
  } catch {
    // Canvas unavailable or CSP blocked — silent fail
  }
}

function _findColor(id) {
  return COLOR_PALETTE.find(c => c.id === id)
    || COLOR_PALETTE.find(c => c.id === COLOR_PRIMARY_DEFAULT)
    || COLOR_PALETTE[0];
}

function _resolveColor(value, theme, fallbackId) {
  if (value && value.startsWith('#')) return value;
  const entry = _findColor(value || fallbackId);
  return entry[theme] || entry.dark;
}

function _hexToRGB(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
