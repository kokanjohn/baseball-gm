// league.js — bgm-v308
// League roster generation and trade helpers.
// Included as a standalone file for GitHub Pages deployment alongside Baseball_GM.html.
// NOTE: This file is reference/documentation only — the live game logic lives in Baseball_GM.html.
//       Keep in sync manually when these functions change.

// ── Position pools ─────────────────────────────────────────────────────────────
const _HITTER_POSITIONS  = ['C','1B','2B','3B','SS','OF','OF','OF','DH'];
const _BENCH_H_POSITIONS = ['C','1B','OF','2B/SS','1B/3B'];
const _SP_ROLES          = ['SP','SP','SP','SP','SP'];
const _BP_ROLES          = ['RP','RP','RP','RP','RP'];
const _PP_ROLES          = ['RP','RP','RP','RP'];
const _LEAGUE_SP_HANDS  = ['R','R','R','L','R'];
const _LEAGUE_BP_HANDS  = ['R','R','L','R','R'];

// ── Name registry ──────────────────────────────────────────────────────────────
// Called from startGame to initialise the pool and card reserve.
// Returns { userNames, leagueNames, cardPool, reservePool }
function _initNameRegistry() {
  const shuffled = [...PLAYER_NAME_POOL];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const userNames   = shuffled.slice(0, 28);      // user team
  const leagueNames = shuffled.slice(28, 280);    // 9 teams × 28
  const cardPool    = shuffled.slice(280, 416);   // acquisition/card pool
  const reservePool = shuffled.slice(416);        // mid-season generation
  return { userNames, leagueNames, cardPool, reservePool };
}

// ── League team definitions ────────────────────────────────────────────────────
// 9 other teams. str is team strength for game simulation (~Normal around 0.52).
// Names must match OPPONENTS array exactly (same order).
// OPPONENTS[0-3] = Div A, OPPONENTS[4-8] = Div B
const LEAGUE_TEAMS = [
  // Div A
  { name: 'New York Empire',   abbr: 'NYE', str: 0.56, divA: true },
  { name: 'LA Palms',          abbr: 'LAP', str: 0.54, divA: true },
  { name: 'Houston Pilots',    abbr: 'HOU', str: 0.52, divA: true },
  { name: 'Chicago Rivermen',  abbr: 'CHI', str: 0.50, divA: true },
  // Div B
  { name: 'Boston Navigators', abbr: 'BOS', str: 0.57, divB: true },
  { name: 'Atlanta Pines',     abbr: 'ATL', str: 0.53, divB: true },
  { name: 'Seattle Tide',      abbr: 'SEA', str: 0.51, divB: true },
  { name: 'Miami Waves',       abbr: 'MIA', str: 0.48, divB: true },
  { name: 'Tampa Admirals',    abbr: 'TAM', str: 0.45, divB: true },
];

// ── Player generation helpers ──────────────────────────────────────────────────

function _leagueRng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function _leagueDob(minAge, maxAge) {
  const now = new Date();
  const ageYears  = _leagueRng(minAge, maxAge);
  const birthYear = now.getFullYear() - ageYears;
  const birthMonth = _leagueRng(1, 12);
  const birthDay   = _leagueRng(1, 28);
  return `${birthYear}-${String(birthMonth).padStart(2,'0')}-${String(birthDay).padStart(2,'0')}`;
}

function _leagueAge(dob) {
  if (!dob) return 27;
  const birth = new Date(dob);
  const now   = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

function _leagueTrait(age, rating) {
  if (Math.random() > 0.40) return null;
  if (age >= 30) return 'veteran';
  if (age <= 23) return 'youngGun';
  const r = Math.random();
  if (rating >= 68 && r < 0.28) return 'clubhouseLeader';
  if (r < 0.18)  return 'volatile';
  if (age >= 25 && r < 0.40) return 'consistent';
  return null;
}

function _leagueSalary(rating) {
  if (rating >= 80) return _leagueRng(250, 400);
  if (rating >= 70) return _leagueRng(150, 250);
  if (rating >= 60) return _leagueRng(75,  150);
  if (rating >= 50) return _leagueRng(35,   75);
  return _leagueRng(20, 35);
}

function _makeLeaguePlayer(name, pos, group, hand, teamStr, seasonNum) {
  const baseOvr = Math.round(teamStr * 100);
  const rating  = Math.min(99, Math.max(40, baseOvr + _leagueRng(-12, 14)));

  const ageMin = group === 'pp' ? 21 : group === 'bh' ? 22 : 23;
  const ageMax = group === 'sp' ? 35 : group === 'bp' ? 34 : 32;
  const dob    = _leagueDob(ageMin, ageMax);
  const age    = _leagueAge(dob);

  const contractRoll = Math.random();
  const contractLen  = rating >= 75
    ? (contractRoll < 0.15 ? 1 : contractRoll < 0.55 ? 2 : 3)
    : rating >= 60
    ? (contractRoll < 0.28 ? 1 : contractRoll < 0.72 ? 2 : 3)
    : (contractRoll < 0.45 ? 1 : contractRoll < 0.85 ? 2 : 3);

  return {
    name,
    pos,
    nativePos:  pos,
    group,
    hand,
    dob,
    rating,
    trait:            _leagueTrait(age, rating),
    contractExpiry:   (seasonNum || 1) + contractLen,
    contractSalary:   _leagueSalary(rating),
    contractYears:    contractLen,
    contractExtended: false,
    stats: ['sp','bp','pp'].includes(group)
      ? { ip:0, er:0, k:0, bb:0, w:0, l:0, sv:0 }
      : { ab:0, h:0, hr:0, rbi:0, bb:0, k:0, r:0, sb:0 },
    careerStats: ['sp','bp','pp'].includes(group)
      ? { ip:0, er:0, k:0, bb:0, w:0, l:0, sv:0, seasons:0, peakRating:rating, peakSeason:seasonNum||1 }
      : { ab:0, h:0, hr:0, rbi:0, bb:0, k:0, r:0, sb:0, seasons:0, peakRating:rating, peakSeason:seasonNum||1 },
    _leagueResting:   false,
    _leagueSuspended: false,
    _leagueIL:        false,
  };
}

// ── Build all 9 league rosters ─────────────────────────────────────────────────
function buildLeagueRosters(leagueNames, seasonNum) {
  const rosters = [];
  let nameIdx = 0;

  LEAGUE_TEAMS.forEach((team) => {
    const teamNames = leagueNames.slice(nameIdx, nameIdx + 28);
    nameIdx += 28;
    const str = team.str;
    const players = [];
    let ni = 0;

    _HITTER_POSITIONS.forEach(pos => {
      players.push(_makeLeaguePlayer(teamNames[ni++], pos, 'sh', null, str, seasonNum));
    });
    _BENCH_H_POSITIONS.forEach(pos => {
      players.push(_makeLeaguePlayer(teamNames[ni++], pos, 'bh', null, str, seasonNum));
    });
    _SP_ROLES.forEach((pos, i) => {
      players.push(_makeLeaguePlayer(teamNames[ni++], pos, 'sp', _LEAGUE_SP_HANDS[i], str, seasonNum));
    });
    _BP_ROLES.forEach((pos, i) => {
      players.push(_makeLeaguePlayer(teamNames[ni++], pos, 'bp', _LEAGUE_BP_HANDS[i], str, seasonNum));
    });
    _PP_ROLES.forEach(pos => {
      players.push(_makeLeaguePlayer(teamNames[ni++], pos, 'pp', 'R', str, seasonNum));
    });

    rosters.push({
      teamName: team.name,
      abbr:     team.abbr,
      str:      team.str,
      wins:     0,
      losses:   0,
      _streak:  0,
      roster:   players,
    });
  });

  return rosters;
}

// ── Trade helpers ──────────────────────────────────────────────────────────────

// Pick a final-contract-year player only (for rental trade cards like t4)
function _pickLeagueTradePlayerRental(team, wantPitcher) {
  if (!team || !team.roster) return null;
  const _sn = (state && state.seasonNum) || 1;
  const _pool = team.roster.filter(p => {
    const _pit = ['sp','bp','pp'].includes(p.group);
    if (wantPitcher !== _pit) return false;
    if (p._leagueIL || p._leagueSuspended) return false;
    return p.contractExpiry === _sn;
  });
  if (!_pool.length) return _pickLeagueTradePlayer(team, wantPitcher); // fallback
  _pool.sort((a, b) => b.rating - a.rating);
  return _pool[Math.floor(Math.random() * Math.min(3, _pool.length))];
}

// Pick any tradeable player (bench, final-year, or random 15% chance)
function _pickLeagueTradePlayer(team, wantPitcher) {
  if (!team || !team.roster) return null;
  const _sn = (state && state.seasonNum) || 1;
  const _pool = team.roster.filter(p => {
    const _pit = ['sp','bp','pp'].includes(p.group);
    if (wantPitcher !== _pit) return false;
    if (p._leagueIL || p._leagueSuspended) return false;
    const _bench  = ['bh','pp','bp'].includes(p.group);
    const _finalYr = p.contractExpiry === _sn;
    return _bench || _finalYr || Math.random() < 0.15;
  });
  if (!_pool.length) return null;
  _pool.sort((a, b) => b.rating - a.rating);
  return _pool[Math.floor(Math.random() * Math.min(3, _pool.length))];
}

// Verify the trading team can still field a viable roster after moving this player
function _tradeTeamHasCoverage(team, player) {
  if (!team || !player) return false;
  const _pit = ['sp','bp','pp'].includes(player.group);
  if (_pit) {
    const _same = team.roster.filter(p =>
      p !== player && ['sp','bp','pp'].includes(p.group) &&
      !p._leagueIL && !p._leagueSuspended &&
      (player.group === 'sp' ? p.group === 'sp' : ['bp','pp'].includes(p.group))
    );
    return _same.length >= (player.group === 'sp' ? 3 : 2);
  }
  const _fam = {
    C:['C'], '1B':['1B','1B/3B'], '2B':['2B','2B/SS'], '3B':['3B','1B/3B'],
    SS:['SS','2B/SS'], OF:['OF','DH/OF'], '2B/SS':['2B','SS','2B/SS'],
    '1B/3B':['1B','3B','1B/3B'], DH:['DH','OF','DH/OF'],
  };
  const _pos    = player.nativePos || player.pos;
  const _compat = _fam[_pos] || [_pos];
  const _cover  = team.roster.filter(p =>
    p !== player && ['sh','bh'].includes(p.group) &&
    !p._leagueIL && !p._leagueSuspended &&
    _compat.includes(p.nativePos || p.pos)
  );
  return _cover.length >= 1;
}

// Execute a roster swap between the user and a league team
function _executeLeagueTradeSwap(incoming, outgoing, teamName) {
  if (!state || !state.leagueRosters || !teamName) return;
  const _team = state.leagueRosters.find(t => t.teamName === teamName);
  if (!_team) return;
  const _inIdx = _team.roster.indexOf(incoming);
  if (_inIdx >= 0) _team.roster.splice(_inIdx, 1);
  if (outgoing) {
    const _out = Object.assign({}, outgoing, {
      _pendingDeparture: false,
      _leagueResting: false,
      _leagueSuspended: false,
      _leagueIL: false,
      group: incoming.group,
    });
    _team.roster.push(_out);
  }
  _gmRelAdjust(teamName, 1);
}
