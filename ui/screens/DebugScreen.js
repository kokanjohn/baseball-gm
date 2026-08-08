/**
 * ui/screens/DebugScreen.js
 * Developer debug panel — hidden overlay accessible via long-press on the
 * version string in Settings, or programmatically via openDebug().
 *
 * Ported from v1 renderDebugPanel() with v2 state field remapping.
 * Never shown to end users — the trigger is intentionally obscure.
 *
 * Sections:
 *   1. State snapshot       — key metrics at a glance
 *   2. Situation gates      — card eligibility status
 *   3. Postponed games      — pending reschedules
 *   4. Narrative flags      — recent flag log
 *   5. Franchise history    — last 3 seasons
 *   6. Playoffs             — bracket + series status
 *   7. All-Star hosting     — score breakdown
 *   8. Debug actions        — phase jumps, card injection, sim tools
 *
 * Rules:
 *   - No game logic here. Read state, call GameEngine functions.
 *   - All actions go through GameEngine or CardEngine — never direct state writes.
 *   - CSS injected once via _cssInjected guard.
 */

import * as StateManager from '../../store/StateManager.js';
import * as EventBus     from '../EventBus.js';

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * openDebug()
 * Opens the debug overlay.
 */
export function openDebug() {
  _injectCSS();

  let overlay = document.getElementById('debug-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'debug-overlay';
    overlay.className = 'debug-overlay';
    document.body.appendChild(overlay);
  }

  overlay.classList.add('open');
  _render(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
}

/**
 * closeDebug()
 */
export function closeDebug() {
  document.getElementById('debug-overlay')?.classList.remove('open');
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

function _render(overlay) {
  const state = StateManager.get();

  if (!state || !state.schedule) {
    overlay.innerHTML = `
      <div class="debug-panel">
        <div class="debug-panel-header">
          <span style="font-size:13px;color:#ccc;">Debug Panel</span>
          <button class="debug-close-btn" id="debug-close">✕</button>
        </div>
        <div style="padding:20px;color:var(--muted);font-size:13px;">No game state loaded.</div>
      </div>`;
    document.getElementById('debug-close')?.addEventListener('click', closeDebug);
    return;
  }

  const versionBanner = `
    <div class="debug-version-banner">
      <span class="debug-version-label">The Front Office — v2</span>
      <span style="font-size:10px;color:var(--muted);">Debug Panel</span>
    </div>`;

  overlay.innerHTML = `
    <div class="debug-panel">
      <div class="debug-panel-header">
        <span style="font-size:13px;color:#ccc;font-weight:700;">🔍 Debug Panel</span>
        <button class="debug-close-btn" id="debug-close">✕</button>
      </div>
      <div class="debug-body" id="debug-body">
        ${versionBanner}
        ${_renderStateSnapshot(state)}
        ${_renderSituationGates(state)}
        ${_renderPostponedGames(state)}
        ${_renderNarrativeFlags(state)}
        ${_renderPlayoffs(state)}
        ${_renderSeasonHistory(state)}
        ${_renderAllStarHosting(state)}
        ${_renderActions(state)}
      </div>
    </div>`;

  document.getElementById('debug-close')?.addEventListener('click', closeDebug);
  _wireActions(overlay, state);
}

// ─────────────────────────────────────────────────────────────
// SECTION 1 — STATE SNAPSHOT
// ─────────────────────────────────────────────────────────────

function _renderStateSnapshot(s) {
  const team    = s.userTeam || {};
  const gp      = (team.wins || 0) + (team.losses || 0);
  const wpct    = gp > 0 ? (team.wins / gp * 100).toFixed(1) + '%' : '—';
  const streak  = team.streak || 0;
  const streakStr = streak === 0 ? 'Even' : streak > 0 ? `+${streak} W` : `${Math.abs(streak)} L`;
  const inbox   = (s.inbox || []).filter(c => !c._resolved).length;
  const fmt$    = v => '$' + (Math.round((v || 0) / 100) / 10).toFixed(1) + 'M';

  const rows = [
    ['Season / Game',    `S${s.seasonNum || 1} · G${s.currentGameIndex || 0}`],
    ['Record',           `${team.wins || 0}–${team.losses || 0} · ${wpct}`],
    ['Phase',            s.phase || '—'],
    ['Streak',           streakStr],
    ['Morale',           team.morale || '—'],
    ['Atmosphere',       team.atmosphere || '—'],
    ['Region',           s.settings?.region || '—'],
    ['Prestige Score',   `${s.prestigeScore || 0} (Tier ${s.prestigeTier || 1})`],
    ['Budget',           fmt$(team.finances?.operatingBudget)],
    ['Payroll',          fmt$(team.finances?.payroll)],
    ['Inbox (unread)',   inbox],
    ['Narrative flags',  (s.narrativeFlags || []).length],
    ['History entries',  (s.history || []).length],
    ['Win target',       team._ownerWinTarget || '—'],
    ['Manager conf.',    team.managerConfidence || '—'],
    ['Owner trust',      team.ownerTrust || '—'],
  ];

  return _section('State Snapshot',
    `<div class="debug-stat-grid">${rows.map(([l, v]) =>
      `<div class="debug-stat">
        <div class="debug-stat-label">${l}</div>
        <div class="debug-stat-value">${v}</div>
      </div>`
    ).join('')}</div>`
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION 2 — SITUATION GATES
// ─────────────────────────────────────────────────────────────

function _renderSituationGates(s) {
  const team = s.userTeam || {};
  const gp   = (team.wins || 0) + (team.losses || 0);
  const wr   = gp > 0 ? team.wins / gp : 0.5;
  const gi   = s.currentGameIndex || 0;
  const isRegular = s.phase === 'REGULAR_SEASON';

  // Derive games back from standings
  const standings = s.standings?.all || [];
  const leader    = standings[0];
  const userEntry = standings.find(t => t.id === 'user');
  const gb        = leader && userEntry
    ? ((leader.wins - userEntry.wins) - (leader.losses - userEntry.losses)) / 2
    : 0;

  const gates = [
    { id: 'dl1',  label: 'dl1 — Buyer/Stand Pat',      eligible: isRegular && gi >= 65 && gi <= 68 },
    { id: 'dl2',  label: 'dl2 — Analytics/Seller',     eligible: isRegular && gi >= 67 && gi <= 71 && wr < 0.45 },
    { id: 'dl3',  label: 'dl3 — Last chance target',   eligible: isRegular && gi >= 70 && gi <= 72 },
    { id: 'dl4',  label: 'dl4 — Rental push',          eligible: isRegular && gi >= 71 && gi <= 72 },
    { id: 'sr1',  label: 'sr1 — Ownership push',       eligible: isRegular && gi >= 90 && gi <= 110 && gb <= 3 && wr > 0.5 },
    { id: 'sr2',  label: 'sr2 — Manager candor',       eligible: isRegular && gi >= 85 && gi <= 115 && (team.streak || 0) <= -4 && wr < 0.45 },
    { id: 'ms2',  label: 'ms2 — Losses piling up',     eligible: isRegular && gi >= 30 && gi <= 100 && ((team.losses || 0) - (team.wins || 0)) >= 10 },
    { id: 'ls1',  label: 'ls1 — Late fatigue',         eligible: isRegular && gi >= 105 && gi <= 125 },
  ];

  const seen = new Set((s.inbox || []).map(c => c.cardId || c.id));

  const rows = gates.map(g => {
    const done = seen.has(g.id);
    const cls  = done ? 'debug-gate-done' : g.eligible ? 'debug-gate-eligible' : 'debug-gate-blocked';
    const lbl  = done ? 'DONE' : g.eligible ? 'ELIGIBLE' : 'BLOCKED';
    return `<div class="debug-gate-row">
      <span class="debug-gate-label">${g.label}</span>
      <span class="${cls}">${lbl}</span>
    </div>`;
  }).join('');

  return _section(
    `Situation Gates · GB ${Math.max(0, gb).toFixed(1)} · Streak ${team.streak || 0}`,
    rows
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION 3 — POSTPONED GAMES
// ─────────────────────────────────────────────────────────────

function _renderPostponedGames(s) {
  const ppd = (s.schedule || []).filter(g => g.status === 'POSTPONED' || g.postponed);
  if (ppd.length === 0) {
    return _section('Postponed Games (0)', '<div class="debug-row-muted">None pending.</div>');
  }
  const rows = ppd.map(g =>
    `<div class="debug-ppd-row">${g.isHome ? 'Home' : 'Away'} vs ${g.opponent || g.opp || '?'} — originally game ${g.originalGameIdx ?? '?'}</div>`
  ).join('');
  return _section(`Postponed Games (${ppd.length})`, rows);
}

// ─────────────────────────────────────────────────────────────
// SECTION 4 — NARRATIVE FLAGS
// ─────────────────────────────────────────────────────────────

function _renderNarrativeFlags(s) {
  const flags = (s.narrativeFlags || []).slice(-20).reverse();
  if (flags.length === 0) {
    return _section('Narrative Flags (0)', '<div class="debug-row-muted">No flags recorded yet.</div>');
  }
  const rows = flags.map(f =>
    `<div class="debug-ppd-row">
      <span style="color:#555">S${f.season} G${f.gameIdx}</span>
      <span style="color:#f97316;margin:0 6px;">${f.key}</span>
      <span style="color:#888">${f.choice || '—'}${f.subject ? ' · ' + f.subject.slice(0, 8) + '…' : ''}</span>
    </div>`
  ).join('');
  return _section(`Narrative Flags (${(s.narrativeFlags || []).length} total, last 20)`, rows);
}

// ─────────────────────────────────────────────────────────────
// SECTION 5 — PLAYOFFS
// ─────────────────────────────────────────────────────────────

function _renderPlayoffs(s) {
  const po = s.playoffs;
  if (!po) {
    return _section('Playoffs', '<div class="debug-row-muted">Not in playoffs this season.</div>');
  }

  const rLabels = {
    WILD_CARD:            'Wild Card',
    DIVISION_SERIES:      'Division Series',
    CHAMPIONSHIP_SERIES:  'Championship Series',
    WORLD_SERIES:         'World Series',
  };

  const rows = [
    ['Seed',         `#${po.userSeed || '—'}`],
    ['Round',        rLabels[po.currentRound] || po.currentRound || '—'],
    ['Opponent',     po.currentOpponent ? `${po.currentOpponent.name} (${po.currentOpponent.wins}–${po.currentOpponent.losses})` : '—'],
    ['Series',       `User ${po.seriesWins || 0} – Opp ${po.seriesLosses || 0} (first to ${po.seriesTarget || 3})`],
    ['Status',       po.champion ? '🏆 Champions' : po.eliminated ? '❌ Eliminated' : '⚾ Active'],
  ].map(([l, v]) => `<div class="debug-asb-row"><span class="debug-asb-label">${l}</span><span class="debug-asb-val">${v}</span></div>`).join('');

  return _section('Playoffs', rows);
}

// ─────────────────────────────────────────────────────────────
// SECTION 6 — SEASON HISTORY
// ─────────────────────────────────────────────────────────────

function _renderSeasonHistory(s) {
  const hist = (s.seasonHistory || []).slice(-3).reverse();
  if (hist.length === 0) {
    return _section('Season History', '<div class="debug-row-muted">First season — no history yet.</div>');
  }

  const prMap = {
    champion:           '🏆 Champions',
    eliminated_final:   'Lost Championship',
    eliminated_semi:    'Lost Semifinal',
    eliminated_wildcard:'Lost Wildcard',
    missed:             'Missed Playoffs',
  };

  const rows = hist.map(h =>
    `<div class="debug-ppd-row">S${h.seasonNum}: ${h.wins}–${h.losses} · ${prMap[h.playoffResult] || h.playoffResult || 'Missed Playoffs'} · Tier ${h.tier || 1} · Prestige ${h.prestigeDelta >= 0 ? '+' : ''}${h.prestigeDelta || 0}</div>`
  ).join('');

  return _section(`Season History (${(s.seasonHistory || []).length} seasons, last 3)`, rows);
}

// ─────────────────────────────────────────────────────────────
// SECTION 7 — ALL-STAR HOSTING
// ─────────────────────────────────────────────────────────────

function _renderAllStarHosting(s) {
  const score       = s.allStarHostingScore   || 0;
  const hosted      = s.allStarHostedCount    || 0;
  const lastSeason  = s.allStarLastHostedSeason || 0;
  const tier        = s.prestigeTier          || 1;

  const rows = [
    ['Hosting score',   score],
    ['Times hosted',    hosted],
    ['Last hosted',     lastSeason > 0 ? `Season ${lastSeason}` : 'Never'],
    ['Current tier',    tier],
    ['Tier required',   hosted === 0 ? 2 : hosted === 1 ? 3 : 5],
    ['Atmosphere',      s.userTeam?.atmosphere || '—'],
  ].map(([l, v]) => `<div class="debug-asb-row"><span class="debug-asb-label">${l}</span><span class="debug-asb-val">${v}</span></div>`).join('');

  return _section('All-Star Hosting', rows);
}

// ─────────────────────────────────────────────────────────────
// SECTION 8 — DEBUG ACTIONS
// ─────────────────────────────────────────────────────────────

function _renderActions(s) {
  const btn = (id, emoji, label, color) =>
    `<button class="debug-action-btn" id="${id}" style="border-color:${color};color:${color};">${emoji} ${label}</button>`;

  return _section('Debug Actions', `
    <div class="debug-actions-grid">

      <div class="debug-actions-subhead">Phase Jumps</div>
      ${btn('dbg-jump-spring',  '🌱', 'Jump to Spring Training',    '#4ade80')}
      ${btn('dbg-jump-regular', '⚾', 'Jump to Regular Season',     '#60a5fa')}
      ${btn('dbg-jump-playoff', '🏟️', 'Jump to Playoffs',           '#f59e0b')}
      ${btn('dbg-jump-offseason','🗓️','Jump to Offseason',          '#a78bfa')}

      <div class="debug-actions-subhead">Card Tools</div>
      ${btn('dbg-card-prompt',  '📨', 'Deliver card by ID…',        '#f97316')}
      ${btn('dbg-flag-prompt',  '🚩', 'Force-fire narrative flag…', '#f97316')}

      <div class="debug-actions-subhead">Live Speed (Dev) — accelerates the live tick for watching games</div>
      ${btn('dbg-speed-1',   '🐢', 'Normal speed (1×)',   '#94a3b8')}
      ${btn('dbg-speed-10',  '⏩', 'Fast (10×)',           '#22d3ee')}
      ${btn('dbg-speed-60',  '⏩', 'Very fast (60×)',      '#22d3ee')}
      ${btn('dbg-speed-300', '⚡', 'Max (300×)',           '#f5d253')}

      <div class="debug-actions-subhead">Sim Tools</div>
      ${btn('dbg-sim-5',        '⏩', 'Simulate 5 games',           '#22d3ee')}
      ${btn('dbg-sim-10',       '⏩', 'Simulate 10 games',          '#22d3ee')}
      ${btn('dbg-sim-season',   '⏭️', 'Sim to end of season',       '#f87171')}
      ${btn('dbg-injure-one',   '🤕', 'Injure random player',       '#f87171')}

      <div class="debug-actions-subhead">Screen Previews</div>
      ${btn('dbg-preview-offseason','🗓️','Preview Offseason Screen','#a78bfa')}
      ${btn('dbg-preview-history',  '📖','Preview Franchise Story',  '#a78bfa')}

    </div>
  `);
}

function _wireActions(overlay, state) {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

  // ── Version banner + live-speed (dev) ────────────────────
  import('../App.js').then(App => {
    const vb = overlay.querySelector('.debug-version-label');
    if (vb) vb.textContent = `The Front Office — ${App.APP_VERSION}`;
    const cur = overlay.querySelector('#debug-current-speed');
    if (cur && App.getDevTimeScale) cur.textContent = `${App.getDevTimeScale()}×`;
  }).catch(() => {});

  const setSpeed = async (n) => {
    try {
      const App = await import('../App.js');
      App.setDevTimeScale(n);
      alert(`Live speed set to ${n}×. Open a live game to watch it play out faster. (1× = normal shipping speed.)`);
    } catch (e) { alert(`Could not set speed: ${e.message}`); }
  };
  on('dbg-speed-1',   () => setSpeed(1));
  on('dbg-speed-10',  () => setSpeed(10));
  on('dbg-speed-60',  () => setSpeed(60));
  on('dbg-speed-300', () => setSpeed(300));

  // ── Phase jumps ──────────────────────────────────────────
  on('dbg-jump-spring', async () => {
    const { advancePhase } = await import('../../engine/GameEngine.js');
    StateManager.mutate(s => { s.phase = 'SPRING_TRAINING'; });
    EventBus.emit('game:phaseChanged', { to: 'SPRING_TRAINING' });
    closeDebug();
    EventBus.emit('nav:switchTab', { tab: 'dashboard' });
  });

  on('dbg-jump-regular', async () => {
    StateManager.mutate(s => { s.phase = 'REGULAR_SEASON'; });
    EventBus.emit('game:phaseChanged', { to: 'REGULAR_SEASON' });
    closeDebug();
    EventBus.emit('nav:switchTab', { tab: 'dashboard' });
  });

  on('dbg-jump-playoff', async () => {
    StateManager.mutate(s => { s.phase = 'WILD_CARD'; });
    EventBus.emit('game:phaseChanged', { to: 'WILD_CARD' });
    closeDebug();
    EventBus.emit('nav:switchTab', { tab: 'schedule' });
  });

  on('dbg-jump-offseason', async () => {
    StateManager.mutate(s => { s.phase = 'OFFSEASON'; });
    EventBus.emit('game:phaseChanged', { to: 'OFFSEASON' });
    closeDebug();
    EventBus.emit('nav:switchTab', { tab: 'dashboard' });
  });

  // ── Card tools ───────────────────────────────────────────
  on('dbg-card-prompt', async () => {
    const cardId = prompt('Card ID to deliver (e.g. i4, t1, f1):');
    if (!cardId) return;
    try {
      const { deliverCardById } = await import('../../engine/CardEngine.js');
      deliverCardById(cardId.trim());
      closeDebug();
      EventBus.emit('nav:switchTab', { tab: 'decisions' });
    } catch (e) {
      alert(`Could not deliver card '${cardId}': ${e.message}`);
    }
  });

  on('dbg-flag-prompt', () => {
    const key = prompt('Narrative flag key to set (e.g. extension_declined):');
    if (!key) return;
    StateManager.mutate(s => {
      s.narrativeFlags = [...(s.narrativeFlags || []), {
        key:     key.trim(),
        subject: null,
        gameIdx: s.currentGameIndex || 0,
        season:  s.seasonNum || 1,
        choice:  'debug',
        context: { source: 'debug_panel' },
      }];
    });
    alert(`Flag '${key}' set.`);
    _render(overlay);
  });

  // ── Sim tools ────────────────────────────────────────────
  on('dbg-sim-5',  () => _simGames(5,  overlay));
  on('dbg-sim-10', () => _simGames(10, overlay));

  on('dbg-sim-season', async () => {
    if (!confirm('Simulate all remaining regular season games? This cannot be undone.')) return;
    const s       = StateManager.get();
    const gi      = s.currentGameIndex || 0;
    const total   = (s.schedule || []).length;
    const remaining = total - gi;
    await _simGames(remaining, overlay);
  });

  on('dbg-injure-one', async () => {
    const s        = StateManager.get();
    const active   = (s.userTeam?.rosterIds || [])
      .map(id => s.players[id])
      .filter(p => p && !p.isInjured && !p.isSuspended);
    if (active.length === 0) { alert('No active players to injure.'); return; }
    const target = active[Math.floor(Math.random() * active.length)];
    try {
      const { deliverInjuryAct1 } = await import('../../engine/CardEngine.js');
      deliverInjuryAct1(target.id);
      closeDebug();
      EventBus.emit('nav:switchTab', { tab: 'decisions' });
    } catch (e) {
      alert(`Could not injure ${target.name}: ${e.message}`);
    }
  });

  // ── Screen previews ──────────────────────────────────────
  on('dbg-preview-offseason', async () => {
    closeDebug();
    const { mount } = await import('./OffseasonScreen.js');
    mount();
  });

  on('dbg-preview-history', async () => {
    closeDebug();
    const { openHistory } = await import('./HistoryScreen.js');
    openHistory();
  });
}

// ─────────────────────────────────────────────────────────────
// SIM HELPER
// ─────────────────────────────────────────────────────────────

async function _simGames(count, overlay) {
  if (count <= 0) { alert('No games to simulate.'); return; }
  try {
    const { commitGame } = await import('../../engine/GameEngine.js');
    let done = 0;
    while (done < count) {
      const s = StateManager.get();
      if (s.phase !== 'REGULAR_SEASON') break;
      await commitGame();
      done++;
    }
    _render(overlay);
    EventBus.emit('game:committed', { simCount: done });
  } catch (e) {
    alert(`Sim error after ${0} games: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// RENDER HELPERS
// ─────────────────────────────────────────────────────────────

function _section(title, contentHtml) {
  return `
    <div class="debug-section">
      <div class="debug-section-title">${_escape(title)}</div>
      ${contentHtml}
    </div>`;
}

function _escape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    .debug-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 9100;
      background: rgba(0,0,0,.82);
      backdrop-filter: blur(3px);
      overflow: auto;
      padding: 12px 8px;
    }
    .debug-overlay.open { display: block; }

    .debug-panel {
      max-width: 620px;
      margin: 0 auto;
      background: #12121e;
      border: 1px solid #333;
      border-radius: 10px;
      overflow: hidden;
      width: 100%;
      box-sizing: border-box;
    }

    .debug-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid #2a2a3e;
      background: #0e0e1a;
    }
    .debug-close-btn {
      background: none;
      border: 1px solid #444;
      color: #aaa;
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 13px;
    }
    .debug-close-btn:active { background: #222; }

    .debug-body { overflow-x: hidden; }

    .debug-version-banner {
      background: var(--surface2, #1a1a2e);
      border-radius: 8px;
      padding: 8px 12px;
      margin: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .debug-version-label {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 18px;
      letter-spacing: 1.5px;
      color: var(--accent, #F5D253);
    }

    .debug-section { border-bottom: 1px solid #1e1e2e; }
    .debug-section-title {
      padding: 8px 16px 6px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: #555;
      background: #0a0a14;
      position: sticky;
      top: 0;
    }

    .debug-stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
    }
    .debug-stat {
      padding: 8px 16px;
      border-bottom: 1px solid #1a1a2e;
      border-right: 1px solid #1a1a2e;
    }
    .debug-stat-label { font-size: 10px; color: #555; margin-bottom: 2px; }
    .debug-stat-value { font-size: 13px; color: #ccc; font-weight: 600; }

    .debug-gate-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 16px;
      border-bottom: 1px solid #1a1a2e;
    }
    .debug-gate-label  { font-size: 11px; color: #888; }
    .debug-gate-eligible { font-size: 11px; font-weight: 700; color: #4ade80; }
    .debug-gate-blocked  { font-size: 11px; color: #444; }
    .debug-gate-done     { font-size: 11px; color: #555; text-decoration: line-through; }

    .debug-ppd-row {
      padding: 6px 16px;
      font-size: 11px;
      color: #888;
      border-bottom: 1px solid #1a1a2e;
    }
    .debug-row-muted { padding: 8px 16px; font-size: 12px; color: #4ade80; }

    .debug-asb-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 16px;
      border-bottom: 1px solid #1a1a2e;
    }
    .debug-asb-label { font-size: 11px; color: #888; }
    .debug-asb-val   { font-size: 12px; color: #ccc; font-weight: 600; }

    .debug-actions-grid {
      padding: 8px 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .debug-actions-subhead {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: #444;
      padding: 6px 0 2px;
    }
    .debug-action-btn {
      background: transparent;
      border: 1px solid;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
      text-align: left;
      font-family: 'DM Sans', sans-serif;
      transition: opacity .15s;
    }
    .debug-action-btn:active { opacity: 0.6; }
  `;
  document.head.appendChild(style);
}
