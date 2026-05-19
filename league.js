// ── Baseball GM — League Data ─────────────────────────────────────────────────
// league.js — generated player name pool and league roster generation
// Loaded alongside Baseball_GM.html. Exposes:
//   PLAYER_NAME_POOL      — master shuffled array of 550 full names
//   buildLeagueRosters()  — generates 9 × 28 player objects at season start
//   _getOpponentLineup()  — returns active 9-man lineup for a given opponent
// ─────────────────────────────────────────────────────────────────────────────

// ── Master name pool ─────────────────────────────────────────────────────────
// 550 unique full names. At startGame, the app shuffles this array and
// draws names sequentially: first 28 → user team, next 252 → league teams,
// next 136 → card/acquisition pool, remainder → mid-season generation reserve.
// No name appears more than once in any active game state.
const PLAYER_NAME_POOL = [
  'Luciano Escobar', 'Logan Barton', 'Forrest Chapman', 'Chukwudi Akinola', 'Obinna Yeboah',
  'Wallace Hill', 'Brett Booth', 'Georgi Mejlgaard', 'Jesse Collins', 'Seun Ofori',
  'Mario Suárez', 'Solomon Sampson', 'Hugo Cedeno', 'Devon Jensen', 'Jason Price',
  'Gavin Bass', 'Edgardo Espinoza', 'Enrique Liriano', 'Dalton Smith', 'Oumar Opoku',
  'Lino Medina', 'Fyodor Grabow', 'Matthew Hart', 'Sam Dunn', 'Julian Wood',
  'Chan-Ho Kikuchi', 'Maxwell Thomas', 'Forrest Campbell', 'Wei-Chieh Yun', 'Riley Rowe',
  'Curtis Cunningham', 'Chris Turner', 'Agustín Tejada', 'Marcus Burgess', 'Angel Beltrán',
  'Gavin Akers', 'Josué Valdez', 'Rufus Brown', 'César Duarte', 'Edwin Cedeno',
  'Ruben Norman', 'Valentin Gunnarsson', 'Steven Roland', 'Xavier Briggs', 'Héctor Oviedo',
  'Noel Thomas', 'Brady Pearson', 'Randall Lambert', 'Colin Ingram', 'Oumar Conde',
  'Rufus Bunn', 'Hunter Baird', 'Tanner Jackson', 'Grant Webster', 'Genaro Acosta',
  'Andres Pineda', 'Bryan Elliott', 'Brett Fleming', 'Jesse Forrest', 'Leroy Cisse',
  'Hiroshi Woo', 'Ji-Man Fujita', 'Lars Skov', 'Saul Grant', 'Eli Wagner',
  'Obiora Idris', 'Oscar Romo', 'Damien Dodge', 'Daichi Gil', 'Joaquín Rodríguez',
  'Ariel Graterol', 'Francisco Álvarez', 'Hyun-Jin Kang', 'Ralph Fields', 'Shingo Ito',
  'Sebastián Heredia', 'Russell Blackwell', 'Heath Stevens', 'Willis Douglas', 'Casey Forrest',
  'Lennox Curtis', 'Yen-Bin Im', 'Eugenio Navas', 'Sam Smith', 'Jameson Adamu',
  'Seiji Ji', 'Brian Borden', 'Maurice Nelson', 'Olisaemeka Akinola', 'Israel Tejada',
  'Isidro Reyna', 'Demba Asomah', 'Claudio Beltrán', 'Victor Reid', 'Fernando Leblanc',
  'Kendall Hawkins', 'Nolan Hopkins', 'Vasily Eckhardt', 'Jorge Medina', 'Brett Knight',
  'Tae-In Cha', 'Lars Ohlsson', 'Kingsley Yeboah', 'Jaylen Porter', 'Ellis Young',
  'Ian Conner', 'Blas Jiménez', 'Dario Calvo', 'Evaristo Lozano', 'Trevor McDonald',
  'Thomas Buck', 'Claudio Dominguez', 'Malcolm Lambert', 'Ruben Garrett', 'Rodrigo Feliz',
  'Nolan Young', 'Reed Burdick', 'Jae-Won Hayashi', 'Elliot Decker', 'Russell Burns',
  'Hayes McKenzie', 'David Baxter', 'Danny Sharp', 'Nikolai Grondahl', 'Evaristo Calvo',
  'Kendall Bloom', 'Damien Watson', 'Agustín Quintana', 'Andres Ferrel', 'Vincent Sherman',
  'Chan-Ho Mori', 'Eric Baxter', 'Salvador Calvo', 'Zane Clark', 'Jasper Wallace',
  'Hyun-Jin Fujinami', 'Jacob Arnold', 'Eugenio Molina', 'David McCoy', 'Forrest Cook',
  'Bryan Burdick', 'Blake Pearson', 'Ramón Peña', 'Jerome Cooper', 'Nicolás Fuentes',
  'Damián Rodón', 'David Underwood', 'Vasily Bergstrom', 'Femi Dogo', 'Ralph Douglas',
  'Angel Corporan', 'Brian Campbell', 'Reese Holland', 'Blas Galvis', 'Sterling Barnett',
  'Corey Norman', 'Omar Germán', 'Edwin Feliciano', 'Chidi Conde', 'Tzu-Wei No',
  'Miguel Espinoza', 'Henrik Elmegaard', 'Leandro Cedeno', 'Kenechukwu Umar', 'Nikolai Haugen',
  'Rolando Beltre', 'Orlando Almonte', 'Sean Bowman', 'Valentin Ostergaard', 'Héctor Camacho',
  'Emeka Kouyate', 'Martín Caceres', 'Fyodor Mejlgaard', 'Justin Baxter', 'Kendall Allen',
  'Thomas Henry', 'Seiji Kang', 'Kyle Swanson', 'Kuo-Hui Kwak', 'Sergio Burgos',
  'Andres Valdez', 'Joel Palmer', 'Terrance Stafford', 'Santiago Medina', 'Xavier Arnold',
  'Boubacar Boateng', 'Hyun-Jin Jin', 'Julian Sims', 'Javier Santana', 'Steven Roman',
  'Stephen Boyd', 'Taylor Summers', 'Robert Kemp', 'Elliot Newton', 'Genaro Olivares',
  'Ezequiel Barriera', 'Giovanni Borbon', 'Will Pearson', 'Kyle Underwood', 'Ulysses Armstrong',
  'Mikael Thorsen', 'Randall Becker', 'Thierno Dodoo', 'Shane West', 'Brendan Bean',
  'Tomoya Aoki', 'Pedro Graveman', 'Gilberto Peña', 'Seung-Hwan Chang', 'Ignacio Borbon',
  'Monty Best', 'Brady Newman', 'Randall Gardner', 'Julio Franco', 'Thierno Bah',
  'Jesús Molina', 'Cristian Mieses', 'Lotanna Ajibola', 'Obi Barry', 'Gavin Terry',
  'Fyodor Rasmussen', 'Rafael Arroyo', 'Ryusei Kondo', 'Omar Guillen', 'Tanner Bryant',
  'Raymond Broussard', 'Victor Nichols', 'Oscar Villanueva', 'Ryu Ro', 'Igor Thorvaldsen',
  'Vincent Singleton', 'Felix Krogh', 'Jeff Blair', 'Isaiah Holmes', 'Diego Polonia',
  'Liang-Wei Nakanishi', 'Jaylen Griffin', 'Dalton Fletcher', 'Kuo-Hui Suh', 'Emeka Gyamfi',
  'Andrew Lynch', 'Cheng-Min Ro', 'Elliot Lynch', 'Lennox Hansen', 'Jonas Graham',
  'Miles Newman', 'Brady Bright', 'Marcus Rhodes', 'Walter Stafford', 'Wesley Pearson',
  'Riley Brock', 'Ronaldo Beato', 'Julio Guerrero', 'Owen Roland', 'Rolando Ventura',
  'Claudio Galaragga', 'Dillon Ferguson', 'Shota Sasaki', 'Ulysses Carson', 'Nnamdi Ajayi',
  'Javier Tejada', 'Sheldon Price', 'Kuo-Lin Cheon', 'Marco Beltre', 'Casey Carroll',
  'Isaiah Griffin', 'Curtis Page', 'Andres Chávez', 'Miguel Guzmán', 'Jacob Roland',
  'Ichiro Imai', 'Henrik Eskildsen', 'Santiago Montero', 'Pedro Cueto', 'Fidel Palacios',
  'Miles Wilkins', 'Florentino Paulino', 'Thomas Aldridge', 'Kyle Ford', 'Tae-In Han',
  'Eduardo Chávez', 'Arturo Velázquez', 'Moussa Kabiru', 'Luciano Polonia', 'Ronaldo Graveman',
  'Casey Thornton', 'Jonathan Glenn', 'Jorge Ynoa', 'Kelechi Eshun', 'Gustavo Fernandez',
  'Percy Blunt', 'Heath Hill', 'Ezequiel Franco', 'Gilberto De Paula', 'Aleksei Rasmussen',
  'Roosevelt Clayton', 'Chukwuebuka Soumah', 'Luke Blair', 'Nicholas Nelson', 'Ulysses Turner',
  'Obiora Kouyate', 'Grant Davidson', 'Travis Beal', 'Norman Bass', 'Salvador Ortega',
  'Sterling Lynch', 'Evaristo Colon', 'Ricardo Machado', 'Cristóbal Suárez', 'Olisaemeka Conde',
  'Arturo Nunez', 'Tanner Bean', 'Wesley Greene', 'Graham Jenkins', 'Ricardo Rosario',
  'Tanner Norton', 'Theodore Matthews', 'Edgardo Galvis', 'Jiro Takahashi', 'Taylor Burns',
  'Nnamdi Goni', 'Dallas Watson', 'Reed Jordan', 'Corey Wheeler', 'Hudson Sims',
  'Wayne Glenn', 'Tomoya Pai', 'Chris Allen', 'Chisom Hassan', 'Ellis Thornton',
  'Vasily Grondahl', 'Robert Murray', 'Travis Swanson', 'Olusegun Maikudi', 'Alexis Valenzuela',
  'Blake Thornton', 'Xavier Fuentes', 'Dario López', 'Chan-Ho Jang', 'Marco Decker',
  'Manuel Robles', 'Adam Bowman', 'Byung-Ho Ji', 'Scott Hopkins', 'Ivan Harper',
  'Ian Dodge', 'Jiro Chun', 'Fletcher Black', 'Seung-Hwan Munenori', 'Manuel Sánchez',
  'Salvador Arias', 'Cristóbal Rosario', 'Ulysses Webb', 'Odum Barry', 'Russell Bray',
  'Miles Burgess', 'Ndubuisi Darko', 'Elliot Knight', 'Santiago Franco', 'Pedro Jiménez',
  'Seung-Hwan Yamaguchi', 'Tristan Bunn', 'Felix Robertson', 'Mauricio Molina', 'Emmett Burdick',
  'Winston Watson', 'Reynaldo Valenzuela', 'Solomon Harmon', 'Derek Mills', 'Percy Ford',
  'Ethan Butler', 'Jonathan Cohen', 'Masahiro Ohtani', 'Jamal Yeboah', 'Gerardo Mejía',
  'Jasper Fleming', 'Silas McCoy', 'Alonzo Baldwin', 'Pedro Salazar', 'Scott Bray',
  'Tobias Sawyer', 'Travis Cohen', 'Enrique Espinal', 'Sheldon Bryant', 'Ezequiel Villa',
  'Connor Chambers', 'Gbenga Camara', 'Eddie Akers', 'Orlando Quiñones', 'Ethan Hart',
  'Genaro Segura', 'Zane Lewis', 'Antonio Nova', 'Justin White', 'Percy Turner',
  'Oscar Fleming', 'Seth Cook', 'Boris Elmegaard', 'Tobias Allen', 'Wei-Chieh Watanabe',
  'Julio Peraza', 'Magnus Levin', 'Randall Jensen', 'Jeff Armstrong', 'Porter Newman',
  'Jordan Britton', 'Festus Dogo', 'Miles Newton', 'Bryan Holland', 'Seun Kourouma',
  'Luke Stone', 'Terrance Bingham', 'Rufus Wallace', 'Seiji Watanabe', 'Aleksei Lindberg',
  'Cody Thomas', 'Oghenekaro Dzisi', 'Jasper Hansen', 'Tobias Jackson', 'Max Clayton',
  'Solomon Hughes', 'Yusuf Jibrin', 'Kwabena Nkemdirim', 'Marco Newton', 'Kingsley Kabiru',
  'Uwe Thorvaldsen', 'Josué Liriano', 'Garrett Hamilton', 'Haruki Shim', 'Tobi Ajibola',
  'Dmitry Magnusson', 'Shota Yom', 'Álvaro Tejada', 'Haruki Min', 'Vincent Burdick',
  'Maurice Roberts', 'Nolan Stephens', 'Fletcher Harrison', 'Roberto Hidalgo', 'Caleb Fleming',
  'Hayes Hall', 'Ronnie Foster', 'Jack Burke', 'Ryu Cho', 'Oscar Liriano',
  'Jorge Olivares', 'Riley Edwards', 'Danny Barton', 'Corey Green', 'Stefan Eckhardt',
  'Clayton Spencer', 'Eddie Kemp', 'Dominic Thomas', 'Santiago Luna', 'Hyun-Jin Yom',
  'Chukwudi Coulibaly', 'Néstor Arias', 'Santiago Tejada', 'Ricardo Barroso', 'Kenji Noh',
  'Evaristo Montero', 'Silvio Ortiz', 'Magnus Knudsen', 'Forrest Newman', 'Takeshi Cho',
  'Ronaldo Encarnación', 'Ariel Bautista', 'Kelechi Akindele', 'Reynaldo Arias', 'Brady Brill',
  'Darren Burke', 'Maxim Munk', 'Ezequiel Hidalgo', 'Yi-Chou Yoshimoto', 'Mauricio Esmerling',
  'Walter McCarthy', 'Norman Arnold', 'Damien Barton', 'Zachary Vaughn', 'Cristian Corporan',
  'Caleb Meadows', 'Patrick Hall', 'Maxim Johansson', 'Roosevelt Blair', 'Blas Torrens',
  'Cristóbal Polanco', 'Damien Myers', 'Miles Becker', 'Klaus Haugen', 'Obiora Tetteh',
  'Damián Blanco', 'Leroy Frimpong', 'Travis Adler', 'Boubacar Opoku', 'Warren Beal',
  'Morris Newman', 'Davis Roman', 'Habib Gyasi', 'Edwin Caceres', 'Robert Blaine',
  'Taylor Sherman', 'Ramón Mercado', 'Alonzo Sullivan', 'Dillon Green', 'Pedro Beltre',
  'Brady Rice', 'Zane Dunn', 'Eric Carroll', 'Gustavo Cabrera', 'Kevin Cook',
  'Reese Sawyer', 'Javier Quintana', 'Oghenekaro Coulibaly', 'Jonas Sherman', 'Austin Lynch',
  'Ichiro Watanabe', 'Felipe Alcántara', 'Riley Richardson', 'Lorenzo Galaragga', 'Jameson Coulibaly',
  'Riley White', 'Tae-In Jeon', 'Malcolm Bradley', 'Josué Campana', 'Daniel Blanco',
  'Oscar Jordan', 'Andrew Bray', 'Ernesto Hernández', 'Josué Burgos', 'Ronnie Fleming',
  'Nicholas Webb', 'Leandro Escobar', 'Ebuka Conde', 'Daniel Cuevas', 'Yusei Shin',
  'Elliot Mitchell', 'Cody McDonald', 'Caleb Jenkins', 'Masahiro Nam', 'Cole Baxter',
  'Florentino Perdomo', 'Konstantin Grabow', 'Xavier Rondón', 'Nicolás Goris', 'Eugenio Rodríguez',
  'Jack Dunn', 'Ryan Greene', 'Rosario Guzmán', 'Kyle Brill', 'Israel Beltre'
];

// ── Position pools ───────────────────────────────────────────────────────────
const _LEAGUE_SP_HANDS  = ['R','R','R','L','R'];
const _LEAGUE_BP_HANDS  = ['R','R','L','R','R'];

const _HITTER_POSITIONS = ['C','1B','2B','3B','SS','OF','OF','OF','DH'];
const _BENCH_H_POSITIONS = ['C','1B','OF','2B/SS','1B/3B'];
const _SP_ROLES  = ['SP','SP','SP','SP','SP'];
const _BP_ROLES  = ['RP','RP','RP','RP','RP'];
const _PP_ROLES  = ['RP','RP','RP','RP'];

// ── Name registry ─────────────────────────────────────────────────────────────
// Called from startGame to initialise the pool and card reserve.
// Returns { userNames, leagueNames, cardPool, reservePool }
function _initNameRegistry() {
  // Shuffle a copy so original order is preserved for debugging
  const shuffled = [...PLAYER_NAME_POOL];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const userNames    = shuffled.slice(0, 28);      // user team
  const leagueNames  = shuffled.slice(28, 280);    // 9 teams × 28
  const cardPool     = shuffled.slice(280, 416);   // acquisition/card pool
  const reservePool  = shuffled.slice(416);        // mid-season generation
  return { userNames, leagueNames, cardPool, reservePool };
}

// ── League team definitions ───────────────────────────────────────────────────
// 9 other teams in the league. _str is team strength used for game simulation.
// Distributed ~Normal around 52 (range 45–65 as agreed).
// LEAGUE_TEAMS — names must match OPPONENTS array in Baseball_GM.html
const LEAGUE_TEAMS = [
  { name: 'New York Empire',   abbr: 'NYE', str: 0.56, divA: true  },
  { name: 'LA Palms',          abbr: 'LAP', str: 0.54, divA: true  },
  { name: 'Houston Pilots',    abbr: 'HOU', str: 0.52, divA: true  },
  { name: 'Chicago Rivermen',  abbr: 'CHI', str: 0.50, divA: true  },
  { name: 'Boston Navigators', abbr: 'BOS', str: 0.57, divB: true  },
  { name: 'Atlanta Pines',     abbr: 'ATL', str: 0.53, divB: true  },
  { name: 'Seattle Tide',      abbr: 'SEA', str: 0.51, divB: true  },
  { name: 'Miami Waves',       abbr: 'MIA', str: 0.48, divB: true  },
  { name: 'Tampa Admirals',    abbr: 'TAM', str: 0.45, divB: true  },
];

// ── Player generation helpers ─────────────────────────────────────────────────

function _leagueRng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function _leagueDob(minAge, maxAge) {
  // Generate a ISO date string for a player aged minAge–maxAge
  // Use a fixed "season start" of March 1 of the current year as reference
  const now = new Date();
  const seasonYear = now.getFullYear();
  const ageYears = _leagueRng(minAge, maxAge);
  const birthYear = seasonYear - ageYears;
  const birthMonth = _leagueRng(1, 12);
  const birthDay   = _leagueRng(1, 28); // safe for all months
  return `${birthYear}-${String(birthMonth).padStart(2,'0')}-${String(birthDay).padStart(2,'0')}`;
}

function _leagueAge(dob) {
  // Returns age as of current date
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
  // Annual salary in $K based on rating tier
  if (rating >= 80) return _leagueRng(250, 400);
  if (rating >= 70) return _leagueRng(150, 250);
  if (rating >= 60) return _leagueRng(75,  150);
  if (rating >= 50) return _leagueRng(35,   75);
  return _leagueRng(20, 35);
}

function _makeLeaguePlayer(name, pos, group, hand, teamStr, seasonNum) {
  // Rating distributed around team strength (45–65 range overall)
  const baseOvr = Math.round(teamStr * 100);
  const rating  = Math.min(99, Math.max(40,
    baseOvr + _leagueRng(-12, 14)
  ));

  // Age by role
  const ageMin = group === 'pp' ? 21 : group === 'bh' ? 22 : 23;
  const ageMax = group === 'sp' ? 35 : group === 'bp' ? 34 : 32;
  const dob    = _leagueDob(ageMin, ageMax);
  const age    = _leagueAge(dob);

  // Contract
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
    trait:          _leagueTrait(age, rating),
    contractExpiry: (seasonNum || 1) + contractLen,
    contractSalary: _leagueSalary(rating),
    contractYears:  contractLen,
    contractExtended: false,
    stats: group === 'sp' || group === 'bp' || group === 'pp'
      ? { ip:0, er:0, k:0, bb:0, w:0, l:0, sv:0 }
      : { ab:0, h:0, hr:0, rbi:0, bb:0, k:0, r:0, sb:0 },
    careerStats: group === 'sp' || group === 'bp' || group === 'pp'
      ? { ip:0, er:0, k:0, bb:0, w:0, l:0, sv:0, seasons:0, peakRating:rating, peakSeason:seasonNum||1 }
      : { ab:0, h:0, hr:0, rbi:0, bb:0, k:0, r:0, sb:0, seasons:0, peakRating:rating, peakSeason:seasonNum||1 },
    // League runtime state — randomly toggled pre-game
    _leagueResting:    false,
    _leagueSuspended:  false,
    _leagueIL:         false,
  };
}

// ── Build all 9 league rosters ────────────────────────────────────────────────
function buildLeagueRosters(leagueNames, seasonNum) {
  // leagueNames: 252-name slice drawn from the shuffled master pool
  // Returns array of 9 team objects, each with .roster array of 28 players
  const rosters = [];
  let nameIdx = 0;

  LEAGUE_TEAMS.forEach((team, ti) => {
    const teamNames = leagueNames.slice(nameIdx, nameIdx + 28);
    nameIdx += 28;
    const str = team.str;
    const players = [];
    let ni = 0;

    // 9 starting hitters
    _HITTER_POSITIONS.forEach(pos => {
      players.push(_makeLeaguePlayer(teamNames[ni++], pos, 'sh', null, str, seasonNum));
    });
    // 5 bench hitters
    _BENCH_H_POSITIONS.forEach(pos => {
      players.push(_makeLeaguePlayer(teamNames[ni++], pos, 'bh', null, str, seasonNum));
    });
    // 5 starting pitchers
    _SP_ROLES.forEach((pos, i) => {
      players.push(_makeLeaguePlayer(teamNames[ni++], pos, 'sp', _LEAGUE_SP_HANDS[i], str, seasonNum));
    });
    // 5 bullpen pitchers
    _BP_ROLES.forEach((pos, i) => {
      players.push(_makeLeaguePlayer(teamNames[ni++], pos, 'bp', _LEAGUE_BP_HANDS[i], str, seasonNum));
    });
    // 4 bench pitchers
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

// ── Get active opponent lineup ────────────────────────────────────────────────
// Returns 9 hitters + starting pitcher for the opponent's game today.
// Excludes players flagged as resting/suspended/IL.
// Used by simulateGame to generate opponent at-bat sequences.
function _getOpponentLineup(teamName) {
  if (!window.state || !state.leagueRosters) return null;
  const team = state.leagueRosters.find(t => t.teamName === teamName);
  if (!team) return null;

  const active = team.roster.filter(p =>
    !p._leagueResting && !p._leagueSuspended && !p._leagueIL
  );

  const hitters  = active.filter(p => p.group === 'sh' || p.group === 'bh')
    .sort((a,b) => b.rating - a.rating)
    .slice(0, 9);
  const starter  = active.filter(p => p.group === 'sp')
    .sort((a,b) => b.rating - a.rating)[0];

  return { hitters, starter };
}

// ── Pre-game availability randomisation ──────────────────────────────────────
// Called by _pregenerateGame before opponent lineup is locked in.
// Randomly marks some league players as resting/suspended/IL for realism.
function _randomiseLeagueAvailability() {
  if (!window.state || !state.leagueRosters) return;
  state.leagueRosters.forEach(team => {
    team.roster.forEach(p => {
      // Reset first
      p._leagueResting    = false;
      p._leagueSuspended  = false;
      p._leagueIL         = false;
      // Re-roll
      const r = Math.random();
      if      (r < 0.08) p._leagueIL         = true;  // 8% on IL
      else if (r < 0.12) p._leagueResting     = true;  // 4% rest day
      else if (r < 0.14) p._leagueSuspended   = true;  // 2% suspended
    });
  });
}

