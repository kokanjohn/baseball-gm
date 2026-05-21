// player-names.js — bgm-v309
// All static name pools used by Baseball GM.
// Loaded before Baseball_GM.html game logic.

// ── Master player name pool ───────────────────────────────────────────────────
// 550 unique full names. At startGame the app shuffles and draws sequentially:
// first 28 → user team, next 252 → 9 league teams (28 each),
// next 136 → card/acquisition pool, remainder → mid-season reserve.
const PLAYER_NAME_POOL = [
  'Luciano Escobar', 'Logan Barton', 'Forrest Chapman', 'Chukwudi Akinola', 'Obinna Yeboah',
  'Wallace Hill', 'Brett Booth', 'Georgi Mejlgaard', 'Jesse Collins', 'Seun Ofori',
  'Mario Suarez', 'Solomon Sampson', 'Hugo Cedeno', 'Devon Jensen', 'Jason Price',
  'Gavin Bass', 'Edgardo Espinoza', 'Enrique Liriano', 'Dalton Smith', 'Oumar Opoku',
  'Lino Medina', 'Fyodor Grabow', 'Matthew Hart', 'Sam Dunn', 'Julian Wood',
  'Chan-Ho Kikuchi', 'Maxwell Thomas', 'Forrest Campbell', 'Wei-Chieh Yun', 'Riley Rowe',
  'Curtis Cunningham', 'Chris Turner', 'Agustin Tejada', 'Marcus Burgess', 'Angel Beltran',
  'Gavin Akers', 'Josue Valdez', 'Rufus Brown', 'Cesar Duarte', 'Edwin Cedeno',
  'Ruben Norman', 'Valentin Gunnarsson', 'Steven Roland', 'Xavier Briggs', 'Hector Oviedo',
  'Noel Thomas', 'Brady Pearson', 'Randall Lambert', 'Colin Ingram', 'Oumar Conde',
  'Rufus Bunn', 'Hunter Baird', 'Tanner Jackson', 'Grant Webster', 'Genaro Acosta',
  'Andres Pineda', 'Bryan Elliott', 'Brett Fleming', 'Jesse Forrest', 'Leroy Cisse',
  'Hiroshi Woo', 'Ji-Man Fujita', 'Lars Skov', 'Saul Grant', 'Eli Wagner',
  'Obiora Idris', 'Oscar Romo', 'Damien Dodge', 'Daichi Gil', 'Joaquin Rodriguez',
  'Ariel Graterol', 'Francisco Alvarez', 'Hyun-Jin Kang', 'Ralph Fields', 'Shingo Ito',
  'Sebastian Heredia', 'Russell Blackwell', 'Heath Stevens', 'Willis Douglas', 'Casey Forrest',
  'Lennox Curtis', 'Yen-Bin Im', 'Eugenio Navas', 'Sam Smith', 'Jameson Adamu',
  'Seiji Ji', 'Brian Borden', 'Maurice Nelson', 'Olisaemeka Akinola', 'Israel Tejada',
  'Isidro Reyna', 'Demba Asomah', 'Claudio Beltran', 'Victor Reid', 'Fernando Leblanc',
  'Kendall Hawkins', 'Nolan Hopkins', 'Vasily Eckhardt', 'Jorge Medina', 'Brett Knight',
  'Tae-In Cha', 'Lars Ohlsson', 'Kingsley Yeboah', 'Jaylen Porter', 'Ellis Young',
  'Ian Conner', 'Blas Jimenez', 'Dario Calvo', 'Evaristo Lozano', 'Trevor McDonald',
  'Thomas Buck', 'Claudio Dominguez', 'Malcolm Lambert', 'Ruben Garrett', 'Rodrigo Feliz',
  'Nolan Young', 'Reed Burdick', 'Jae-Won Hayashi', 'Elliot Decker', 'Russell Burns',
  'Hayes McKenzie', 'David Baxter', 'Danny Sharp', 'Nikolai Grondahl', 'Evaristo Calvo',
  'Kendall Bloom', 'Damien Watson', 'Agustin Quintana', 'Andres Ferrel', 'Vincent Sherman',
  'Chan-Ho Mori', 'Eric Baxter', 'Salvador Calvo', 'Zane Clark', 'Jasper Wallace',
  'Hyun-Jin Fujinami', 'Jacob Arnold', 'Eugenio Molina', 'David McCoy', 'Forrest Cook',
  'Bryan Burdick', 'Blake Pearson', 'Ramon Pena', 'Jerome Cooper', 'Nicolas Fuentes',
  'Damian Rodon', 'David Underwood', 'Vasily Bergstrom', 'Femi Dogo', 'Ralph Douglas',
  'Angel Corporan', 'Brian Campbell', 'Reese Holland', 'Blas Galvis', 'Sterling Barnett',
  'Corey Norman', 'Omar German', 'Edwin Feliciano', 'Chidi Conde', 'Tzu-Wei No',
  'Miguel Espinoza', 'Henrik Elmegaard', 'Leandro Cedeno', 'Kenechukwu Umar', 'Nikolai Haugen',
  'Rolando Beltre', 'Orlando Almonte', 'Sean Bowman', 'Valentin Ostergaard', 'Hector Camacho',
  'Emeka Kouyate', 'Martin Caceres', 'Fyodor Mejlgaard', 'Justin Baxter', 'Kendall Allen',
  'Thomas Henry', 'Seiji Kang', 'Kyle Swanson', 'Kuo-Hui Kwak', 'Sergio Burgos',
  'Andres Valdez', 'Joel Palmer', 'Terrance Stafford', 'Santiago Medina', 'Xavier Arnold',
  'Boubacar Boateng', 'Hyun-Jin Jin', 'Julian Sims', 'Javier Santana', 'Steven Roman',
  'Stephen Boyd', 'Taylor Summers', 'Robert Kemp', 'Elliot Newton', 'Genaro Olivares',
  'Ezequiel Barriera', 'Giovanni Borbon', 'Will Pearson', 'Kyle Underwood', 'Ulysses Armstrong',
  'Mikael Thorsen', 'Randall Becker', 'Thierno Dodoo', 'Shane West', 'Brendan Bean',
  'Tomoya Aoki', 'Pedro Graveman', 'Gilberto Pena', 'Seung-Hwan Chang', 'Ignacio Borbon',
  'Monty Best', 'Brady Newman', 'Randall Gardner', 'Julio Franco', 'Thierno Bah',
  'Jesus Molina', 'Cristian Mieses', 'Lotanna Ajibola', 'Obi Barry', 'Gavin Terry',
  'Fyodor Rasmussen', 'Rafael Arroyo', 'Ryusei Kondo', 'Omar Guillen', 'Tanner Bryant',
  'Raymond Broussard', 'Victor Nichols', 'Oscar Villanueva', 'Ryu Ro', 'Igor Thorvaldsen',
  'Vincent Singleton', 'Felix Krogh', 'Jeff Blair', 'Isaiah Holmes', 'Diego Polonia',
  'Liang-Wei Nakanishi', 'Jaylen Griffin', 'Dalton Fletcher', 'Kuo-Hui Suh', 'Emeka Gyamfi',
  'Andrew Lynch', 'Cheng-Min Ro', 'Elliot Lynch', 'Lennox Hansen', 'Jonas Graham',
  'Miles Newman', 'Brady Bright', 'Marcus Rhodes', 'Walter Stafford', 'Wesley Pearson',
  'Riley Brock', 'Ronaldo Beato', 'Julio Guerrero', 'Owen Roland', 'Rolando Ventura',
  'Claudio Galaragga', 'Dillon Ferguson', 'Shota Sasaki', 'Ulysses Carson', 'Nnamdi Ajayi',
  'Javier Tejada', 'Sheldon Price', 'Kuo-Lin Cheon', 'Marco Beltre', 'Casey Carroll',
  'Isaiah Griffin', 'Curtis Page', 'Andres Chavez', 'Miguel Guzman', 'Jacob Roland',
  'Ichiro Imai', 'Henrik Eskildsen', 'Santiago Montero', 'Pedro Cueto', 'Fidel Palacios',
  'Miles Wilkins', 'Florentino Paulino', 'Thomas Aldridge', 'Kyle Ford', 'Tae-In Han',
  'Eduardo Chavez', 'Arturo Velazquez', 'Moussa Kabiru', 'Luciano Polonia', 'Ronaldo Graveman',
  'Casey Thornton', 'Jonathan Glenn', 'Jorge Ynoa', 'Kelechi Eshun', 'Gustavo Fernandez',
  'Percy Blunt', 'Heath Hill', 'Ezequiel Franco', 'Gilberto De Paula', 'Aleksei Rasmussen',
  'Roosevelt Clayton', 'Chukwuebuka Soumah', 'Luke Blair', 'Nicholas Nelson', 'Ulysses Turner',
  'Obiora Kouyate', 'Grant Davidson', 'Travis Beal', 'Norman Bass', 'Salvador Ortega',
  'Sterling Lynch', 'Evaristo Colon', 'Ricardo Machado', 'Cristobal Suarez', 'Olisaemeka Conde',
  'Arturo Nunez', 'Tanner Bean', 'Wesley Greene', 'Graham Jenkins', 'Ricardo Rosario',
  'Tanner Norton', 'Theodore Matthews', 'Edgardo Galvis', 'Jiro Takahashi', 'Taylor Burns',
  'Nnamdi Goni', 'Dallas Watson', 'Reed Jordan', 'Corey Wheeler', 'Hudson Sims',
  'Wayne Glenn', 'Tomoya Pai', 'Chris Allen', 'Chisom Hassan', 'Ellis Thornton',
  'Vasily Grondahl', 'Robert Murray', 'Travis Swanson', 'Olusegun Maikudi', 'Alexis Valenzuela',
  'Blake Thornton', 'Xavier Fuentes', 'Dario Lopez', 'Chan-Ho Jang', 'Marco Decker',
  'Manuel Robles', 'Adam Bowman', 'Byung-Ho Ji', 'Scott Hopkins', 'Ivan Harper',
  'Ian Dodge', 'Jiro Chun', 'Fletcher Black', 'Seung-Hwan Munenori', 'Manuel Sanchez',
  'Salvador Arias', 'Cristobal Rosario', 'Ulysses Webb', 'Odum Barry', 'Russell Bray',
  'Miles Burgess', 'Ndubuisi Darko', 'Elliot Knight', 'Santiago Franco', 'Pedro Jimenez',
  'Seung-Hwan Yamaguchi', 'Tristan Bunn', 'Felix Robertson', 'Mauricio Molina', 'Emmett Burdick',
  'Winston Watson', 'Reynaldo Valenzuela', 'Solomon Harmon', 'Derek Mills', 'Percy Ford',
  'Ethan Butler', 'Jonathan Cohen', 'Masahiro Ohtani', 'Jamal Yeboah', 'Gerardo Mejia',
  'Jasper Fleming', 'Silas McCoy', 'Alonzo Baldwin', 'Pedro Salazar', 'Scott Bray',
  'Tobias Sawyer', 'Travis Cohen', 'Enrique Espinal', 'Sheldon Bryant', 'Ezequiel Villa',
  'Connor Chambers', 'Gbenga Camara', 'Eddie Akers', 'Orlando Quinones', 'Ethan Hart',
  'Genaro Segura', 'Zane Lewis', 'Antonio Nova', 'Justin White', 'Percy Turner',
  'Oscar Fleming', 'Seth Cook', 'Boris Elmegaard', 'Tobias Allen', 'Wei-Chieh Watanabe',
  'Julio Peraza', 'Magnus Levin', 'Randall Jensen', 'Jeff Armstrong', 'Porter Newman',
  'Jordan Britton', 'Festus Dogo', 'Miles Newton', 'Bryan Holland', 'Seun Kourouma',
  'Luke Stone', 'Terrance Bingham', 'Rufus Wallace', 'Seiji Watanabe', 'Aleksei Lindberg',
  'Cody Thomas', 'Oghenekaro Dzisi', 'Jasper Hansen', 'Tobias Jackson', 'Max Clayton',
  'Solomon Hughes', 'Yusuf Jibrin', 'Kwabena Nkemdirim', 'Marco Newton', 'Kingsley Kabiru',
  'Uwe Thorvaldsen', 'Josue Liriano', 'Garrett Hamilton', 'Haruki Shim', 'Tobi Ajibola',
  'Dmitry Magnusson', 'Shota Yom', 'Alvaro Tejada', 'Haruki Min', 'Vincent Burdick',
  'Maurice Roberts', 'Nolan Stephens', 'Fletcher Harrison', 'Roberto Hidalgo', 'Caleb Fleming',
  'Hayes Hall', 'Ronnie Foster', 'Jack Burke', 'Ryu Cho', 'Oscar Liriano',
  'Jorge Olivares', 'Riley Edwards', 'Danny Barton', 'Corey Green', 'Stefan Eckhardt',
  'Clayton Spencer', 'Eddie Kemp', 'Dominic Thomas', 'Santiago Luna', 'Hyun-Jin Yom',
  'Chukwudi Coulibaly', 'Nestor Arias', 'Santiago Tejada', 'Ricardo Barroso', 'Kenji Noh',
  'Evaristo Montero', 'Silvio Ortiz', 'Magnus Knudsen', 'Forrest Newman', 'Takeshi Cho',
  'Ronaldo Encarnacion', 'Ariel Bautista', 'Kelechi Akindele', 'Reynaldo Arias', 'Brady Brill',
  'Darren Burke', 'Maxim Munk', 'Ezequiel Hidalgo', 'Yi-Chou Yoshimoto', 'Mauricio Esmerling',
  'Walter McCarthy', 'Norman Arnold', 'Damien Barton', 'Zachary Vaughn', 'Cristian Corporan',
  'Caleb Meadows', 'Patrick Hall', 'Maxim Johansson', 'Roosevelt Blair', 'Blas Torrens',
  'Cristobal Polanco', 'Damien Myers', 'Miles Becker', 'Klaus Haugen', 'Obiora Tetteh',
  'Damian Blanco', 'Leroy Frimpong', 'Travis Adler', 'Boubacar Opoku', 'Warren Beal',
  'Morris Newman', 'Davis Roman', 'Habib Gyasi', 'Edwin Caceres', 'Robert Blaine',
  'Taylor Sherman', 'Ramon Mercado', 'Alonzo Sullivan', 'Dillon Green', 'Pedro Beltre',
  'Brady Rice', 'Zane Dunn', 'Eric Carroll', 'Gustavo Cabrera', 'Kevin Cook',
  'Reese Sawyer', 'Javier Quintana', 'Oghenekaro Coulibaly', 'Jonas Sherman', 'Austin Lynch',
  'Ichiro Watanabe', 'Felipe Alcantara', 'Riley Richardson', 'Lorenzo Galaragga', 'Jameson Coulibaly',
  'Riley White', 'Tae-In Jeon', 'Malcolm Bradley', 'Josue Campana', 'Daniel Blanco',
  'Oscar Jordan', 'Andrew Bray', 'Ernesto Hernandez', 'Josue Burgos', 'Ronnie Fleming',
  'Nicholas Webb', 'Leandro Escobar', 'Ebuka Conde', 'Daniel Cuevas', 'Yusei Shin',
  'Elliot Mitchell', 'Cody McDonald', 'Caleb Jenkins', 'Masahiro Nam', 'Cole Baxter',
  'Florentino Perdomo', 'Konstantin Grabow', 'Xavier Rondon', 'Nicolas Goris', 'Eugenio Rodriguez',
  'Jack Dunn', 'Ryan Greene', 'Rosario Guzman', 'Kyle Brill', 'Israel Beltre'
];

// ── Acquisition pools — abbreviated names used in inbox card text ─────────────
const ACQ_PITCHER_NAMES = [
  'K. Yamamoto','L. Ferreira','B. Nwosu','T. Lindqvist','R. Castillo','O. Mensah','S. Brody','H. Nakamura',
  'M. Santos','R. Okafor','C. Watts','A. Petrov','M. Delgado','J. Osei','D. Kwon','F. Estrada',
  'T. Okonkwo','N. Vasquez','P. Lundqvist','E. Mbeki','G. Hoffmann','C. Ibarra','W. Tremblay','A. Nkosi'
];
const ACQ_PITCHER_HAND  = [
  'R','L','R','R','R','L','R','R',
  'R','R','R','R','R','L','R','L',
  'R','L','R','R','L','R','L','R'
];
const ACQ_PITCHER_ROLES = [
  'SP','SP','SP','SP','SP','SP','SP','SP',
  'RP','RP','RP','RP','RP','RP','RP','RP',
  'RP','RP','RP','RP','RP','RP','RP','RP'
];
const ACQ_HITTER_NAMES  = [
  'R. Hollins','V. Castillo','T. Malone','B. Osei',
  'T. Abebe','N. Bauer','W. Garza','P. Fontaine',
  'E. Ruiz','D. Pena','K. Adesanya','L. Nkrumah','S. Volkov',
  'A. Kim','C. Vargas','J. Oduya','T. Eriksson',
  'L. Okafor','F. Ibanez','O. Achebe',
  'T. Osei','J. Moreau','M. Tran','R. Kwame','P. Adeyemi','D. Sousa','A. Wolfe',
  'S. Baptiste','V. Rios','M. Reinholt'
];
const ACQ_HITTER_POS    = [
  'C','C','C','C',
  '1B','1B','1B','1B',
  '2B/SS','2B/SS','2B/SS','2B/SS','2B/SS',
  '1B/3B','1B/3B','1B/3B','1B/3B',
  'SS','SS','SS',
  'OF','OF','OF','OF','OF','OF','OF',
  'DH','DH','DH'
];

// ── Farm system name pools ────────────────────────────────────────────────────
const FARM_H_NAMES = [
  'D. Lara','T. Onwu','S. Kato','R. Baptiste','A. Solis',
  'J. Mensah','C. Holloway','B. Quinto','O. Strand','N. Eze',
  'L. Perkins','T. Diallo','R. Makinde','S. Reinholt','A. Bonilla','K. Osei'
];
const FARM_H_POS   = [
  'OF','2B/SS','OF','1B','1B/3B',
  'OF','OF','1B','SS','2B/SS',
  'C','OF','1B/3B','3B','OF','2B/SS'
];
const FARM_P_NAMES = [
  'F. Marte','O. Dahl','C. Eze','J. Strom','P. Quinto','L. Bauer','T. Rashid',
  'N. Kalu','B. Svensson','R. Flores','M. Okeke','T. Yamada',
  'D. Holmberg','C. Nwosu','A. Mbaye','S. Hoang'
];
const FARM_P_HAND  = [
  'R','L','R','R','L','R','R',
  'R','L','R','R','R',
  'L','R','L','R'
];
