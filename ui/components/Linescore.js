/**
 * ui/components/Linescore.js
 * Standalone linescore component (Section 8.2 — LOCKED).
 *
 * Renders a per-inning scoring table. Used in:
 *   - GameScreen (live game view — replaces inline _renderLinescore)
 *   - LeagueScreen (CPU game results)
 *   - ScheduleScreen (completed game tap — Phase 13)
 *
 * Rules (Section 8.2):
 *   Away team always top row, home team always bottom row.
 *   Active half-inning cell shows in-progress marker.
 *   R column reflects current cumulative total.
 *   Cells fill as half-innings complete.
 *   Extra innings extend columns dynamically.
 *   Future inning cells show · (middle dot).
 *
 * Usage:
 *   import { renderLinescore } from '../components/Linescore.js';
 *   container.innerHTML = renderLinescore(linescoreData);
 *
 * @param {Object} data
 *   data.awayAbbr      {String}   — away team abbreviation
 *   data.homeAbbr      {String}   — home team abbreviation
 *   data.awayRuns      {Number[]} — runs per inning (length = innings played)
 *   data.homeRuns      {Number[]} — same for home
 *   data.awayTotal     {Number}   — total runs
 *   data.homeTotal     {Number}
 *   data.currentInning {Number}   — 1-based, used to mark active cell
 *   data.currentHalf   {String}   — 'TOP'|'BOT'
 *   data.isFinal       {Boolean}  — if true, no active cell marker
 *   data.isUserHome    {Boolean}  — highlights home row if user is home team
 */

/**
 * renderLinescore(data)
 * Returns HTML string for the linescore table.
 *
 * @param {Object} data — see file header
 * @returns {String}
 */
export function renderLinescore(data) {
  _injectCSS();

  const {
    awayAbbr      = 'AWY',
    homeAbbr      = 'HME',
    awayRuns      = [],
    homeRuns      = [],
    awayTotal     = 0,
    homeTotal     = 0,
    currentInning = 1,
    currentHalf   = 'TOP',
    isFinal       = false,
    isUserHome    = false,
  } = data;

  // Determine how many inning columns to show
  // Always show at least 9; extend for extras
  const completedInnings = Math.max(awayRuns.length, homeRuns.length);
  const maxInning        = Math.max(9, isFinal ? completedInnings : currentInning);
  const innings          = Array.from({ length: maxInning }, (_, i) => i + 1);

  const activeInning = isFinal ? -1 : currentInning;
  const activeHalf   = isFinal ? '' : currentHalf;

  // Build column headers
  const headers = innings.map(inn => {
    const isActive = inn === activeInning;
    return `<th class="ls-inn-head ${isActive ? 'ls-active-head' : ''}">${inn}</th>`;
  }).join('');

  // Build away row cells
  const awayCells = innings.map((inn, idx) => {
    const val       = awayRuns[idx] ?? null;
    const isActive  = inn === activeInning && activeHalf === 'TOP';
    const isPending = val === null && (!isActive) && (inn > completedInnings || (inn === currentInning && activeHalf === 'BOT'));
    const isCurrent = val === null && inn === currentInning && activeHalf === 'TOP';

    let display;
    if (isPending)    display = '·';
    else if (isCurrent) display = '—';
    else if (val !== null) display = String(val);
    else display = '·';

    const cls = [
      'ls-cell',
      isActive ? 'ls-active-cell' : '',
      val > 0 ? 'ls-scoring' : '',
    ].filter(Boolean).join(' ');

    return `<td class="${cls}">${display}</td>`;
  }).join('');

  // Build home row cells
  const homeCells = innings.map((inn, idx) => {
    const val       = homeRuns[idx] ?? null;
    const isActive  = inn === activeInning && activeHalf === 'BOT';
    const isPending = val === null && inn > currentInning;
    const isCurrent = val === null && inn === currentInning && activeHalf === 'BOT';
    const isWalkOff = isFinal && inn === completedInnings && homeTotal > awayTotal;

    let display;
    if (isPending)    display = '·';
    else if (isCurrent) display = '—';
    else if (val !== null) display = String(val);
    else display = '·';

    const cls = [
      'ls-cell',
      isActive ? 'ls-active-cell' : '',
      val > 0 ? 'ls-scoring' : '',
      isWalkOff ? 'ls-walkoff' : '',
    ].filter(Boolean).join(' ');

    return `<td class="${cls}">${display}</td>`;
  }).join('');

  const awayUserCls = !isUserHome ? 'ls-team-user' : '';
  const homeUserCls = isUserHome  ? 'ls-team-user' : '';

  return `
    <div class="linescore-component">
      <div class="linescore-live">
        <table>
          <thead>
            <tr>
              <th class="ls-team-head"></th>
              ${headers}
              <th class="ls-total-head">R</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="ls-team ${awayUserCls}">${_escape(awayAbbr)}</td>
              ${awayCells}
              <td class="ls-total ${awayTotal > homeTotal && isFinal ? 'ls-winner' : ''}">${awayTotal}</td>
            </tr>
            <tr>
              <td class="ls-team ${homeUserCls}">${_escape(homeAbbr)}</td>
              ${homeCells}
              <td class="ls-total ${homeTotal > awayTotal && isFinal ? 'ls-winner' : ''}">${homeTotal}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * linescoreFromGame(game, state)
 * Convenience: builds linescore data object from a live game object and state.
 *
 * @param {Object} game   — from state.schedule[idx]
 * @param {Object} state  — full game state
 * @returns {Object}      — linescore data ready for renderLinescore()
 */
export function linescoreFromGame(game, state) {
  if (!game) return {};

  const userIsHome = game.isHome;
  const plays      = (game.plays || []).slice(0, game.livePlayIndex || 0);

  // Aggregate runs per half-inning from plays
  const awayByInning = {};
  const homeByInning = {};

  for (const play of plays) {
    if (!play._halfInning) continue;
    const [half, innStr] = play._halfInning.split('_');
    const inn = parseInt(innStr);
    if (!inn) continue;

    if (half === 'TOP') {
      // Away team bats in TOP
      if (userIsHome) {
        awayByInning[inn] = play.cumTheirScore ?? awayByInning[inn] ?? 0;
      } else {
        awayByInning[inn] = play.cumOurScore   ?? awayByInning[inn] ?? 0;
      }
    } else {
      // Home team bats in BOT
      if (userIsHome) {
        homeByInning[inn] = play.cumOurScore   ?? homeByInning[inn] ?? 0;
      } else {
        homeByInning[inn] = play.cumTheirScore ?? homeByInning[inn] ?? 0;
      }
    }
  }

  // Convert to arrays (1-indexed, convert to 0-indexed arrays)
  const maxInn   = Math.max(9, game.currentInning || 1);
  const awayRuns = Array.from({ length: maxInn }, (_, i) => awayByInning[i + 1] ?? null);
  const homeRuns = Array.from({ length: maxInn }, (_, i) => homeByInning[i + 1] ?? null);

  return {
    awayAbbr:      userIsHome ? (game.opponent || game.opp || 'AWY') : (state.userTeam?.abbr || 'US'),
    homeAbbr:      userIsHome ? (state.userTeam?.abbr || 'US')        : (game.opponent || game.opp || 'HME'),
    awayRuns:      awayRuns.filter(v => v !== null),
    homeRuns:      homeRuns.filter(v => v !== null),
    awayTotal:     userIsHome ? (game.theirScore ?? 0) : (game.ourScore ?? 0),
    homeTotal:     userIsHome ? (game.ourScore   ?? 0) : (game.theirScore ?? 0),
    currentInning: game.currentInning || 1,
    currentHalf:   game.currentHalf   || 'TOP',
    isFinal:       game.status === 'final' || game._committed,
    isUserHome:    userIsHome,
  };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _escape(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
    .linescore-component{overflow-x:auto;}
    .ls-inn-head{color:var(--muted);font-weight:600;text-align:center;
      min-width:18px;font-size:10px;padding:2px 3px;}
    .ls-inn-head.ls-active-head{color:var(--accent);}
    .ls-team-head{min-width:28px;}
    .ls-total-head{border-left:1px solid var(--border);color:var(--muted);
      font-size:10px;font-weight:700;text-align:center;padding:2px 4px;}
    .ls-team{font-size:11px;font-weight:700;color:var(--text);
      padding-right:6px;white-space:nowrap;}
    .ls-team.ls-team-user{color:var(--accent);}
    .ls-cell{text-align:center;font-size:11px;color:var(--muted);padding:2px 3px;}
    .ls-cell.ls-scoring{color:var(--text);font-weight:700;}
    .ls-cell.ls-active-cell{color:var(--accent);font-weight:700;}
    .ls-cell.ls-walkoff{color:var(--accent2);}
    .ls-total{border-left:1px solid var(--border);text-align:center;
      font-size:12px;font-weight:700;color:var(--text);padding:2px 4px;}
    .ls-total.ls-winner{color:var(--accent2);}
  `;
  document.head.appendChild(style);
}
