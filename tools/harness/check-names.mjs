// §122.72 The name pools: no surname of a well-known real player unless it's a common name.
// REAL lists the ones taken out (r195) so none comes back. Also: every entry distinct, the three
// pools share nothing, ASCII only.
//   node tools/harness/check-names.mjs
import { PLAYER_SURNAMES, STAFF_NAMES, PERSON_NAMES } from '../../data/player-names.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const REAL = `Abreu Acuna Alcantara Almonte Altuve Andrus Andujar Arruebarrena Baez Batista Bautista Beckett
  Beltran Beltre Borbon Britton Brock Candelario Cedeno Cepeda Cespedes Corporan Cueto Despaigne Dombrowski
  Encarnacion Feliz Fujinami Galaragga Galarraga Galvis Garland Gourriel Grandal Graterol Graveman Guillen Infante
  Larkin Liriano Lowell Machado Marte Moncada Nolasco Ohtani Osuna Ozuna Pagan Paredes Paxton Peraza Perdomo
  Polanco Polonia Puig Reardon Rodon Romo Rondon Stanton Taveras Teheran Tejada Torrens Upton Urena Urias
  Urquidy Urshela Westbrook Ynoa Zambrano`.split(/\s+/).filter(Boolean);
const all = [...PLAYER_SURNAMES, ...STAFF_NAMES, ...PERSON_NAMES];
const real = all.filter(n => REAL.includes(n));
check(`no well-known real player's uncommon surname (${REAL.length} listed)`, real.length === 0, real.join(', '));
for (const [name, pool] of [['players', PLAYER_SURNAMES], ['staff', STAFF_NAMES], ['people', PERSON_NAMES]]) {
  const dup = pool.filter((n, i) => pool.indexOf(n) !== i);
  check(`${name}: every entry distinct (${pool.length})`, dup.length === 0, dup.join(', '));
}
const shared = all.filter((n, i) => all.indexOf(n) !== i);
check('the three pools share no name', shared.length === 0, shared.join(', '));
const odd = all.filter(n => !/^[A-Za-z][A-Za-z' -]*$/.test(n));
check('ASCII letters only', odd.length === 0, odd.join(', '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
