/**
 * data/parties.js
 * r298 §122.185 Memory (the design: §122.184): the outside parties a save remembers, and how their names are drawn.
 * Each save draws its own names from these (the save's dice and the club's city); the city release adds its full cast.
 * Each club's GM is a party too (`club:<teamId>`), beside the trade rapport.
 *
 *   kind     sponsor | community | media | city    (how a memory message speaks to them: which department relays)
 *   names    the versions to draw from; {city} is the club's city
 */
export const PARTIES = Object.freeze([
  { id: 'presenting_sponsor', kind: 'sponsor', names: ['{city} Mutual Insurance', 'Keystone Auto Group', 'Northgate Health', 'Lakeshore Credit Union', 'Meridian Energy'] },
  { id: 'bank',        kind: 'sponsor',   names: ['{city} Savings Bank', 'First {city} Bank', '{city} Federal', 'Harborline Bank', 'Crossroads Bank'] },
  { id: 'brewery',     kind: 'sponsor',   names: ['Ironside Brewing', 'Copper Kettle Brewing', 'Riverbend Brewing', 'Old Mill Brewing', 'Tall Pines Brewing'] },
  { id: 'restaurants', kind: 'sponsor',   names: ['Marlowe\'s Kitchen', 'Benny\'s Grill', 'Rosa\'s Cantina', 'Hartley\'s Diners', 'The Corner Pit'] },
  { id: 'apparel',     kind: 'sponsor',   names: ['Northline Outfitters', 'Fieldstone Apparel', 'Highmark Athletic', 'Ridgeway Sportswear'] },
  { id: 'beverage',    kind: 'sponsor',   names: ['Summit Cola', 'BrightSpring', 'Fizzline', 'Glacier Pop'] },
  { id: 'broadcaster', kind: 'media',     names: ['Pinnacle Sports Network', 'Northstar Media', 'Regional Sports One'] },
  { id: 'radio',       kind: 'media',     names: ['{city} Sports Radio', 'The Fan 1050', 'Talk 97.1', 'ESR 880'] },
  { id: 'paper',       kind: 'media',     names: ['the {city} Herald', 'the {city} Ledger', 'the {city} Tribune', 'the {city} Gazette'] },
  { id: 'city',        kind: 'city',      names: ['the mayor\'s office'] },
  { id: 'schools',     kind: 'community', names: ['{city} Public Schools', 'the {city} school district'] },
  { id: 'university',  kind: 'community', names: ['{city} State', 'the University of {city}', '{city} College'] },
  { id: 'charity',     kind: 'community', names: ['the {city} Children\'s Fund', 'Hope Harbor', 'the {city} Food Bank', 'Second Wind'] },
  { id: 'boosters',    kind: 'community', names: ['the Booster Club'] },
  { id: 'neighbors',   kind: 'community', names: ['the Eastside Neighborhood Association', 'the Mill District Association', 'the Riverside Neighbors\' Council'] },
]);

/**
 * How an answer weighs with a party, by the kind of ask (a message tagged `party` may give `partyAsk`, or its own
 * `partyW`). An offer turned down isn't a slight; a request turned down is; left to its deadline is worse.
 */
export const PARTY_ASK = Object.freeze({
  offer:   Object.freeze({ yes: 1, no: 0, ignored: -0.5 }),
  request: Object.freeze({ yes: 1, no: -1, ignored: -1.5 }),
});

/**
 * The standing, from the record (never shown): warm at `warm`+, cool at `cool` or less, sour at `sour` or less.
 * Slights fade over `slightDays`, good turns over `goodDays` (about two and three seasons, the user's choice); a big
 * moment (`partyBig`) never fades.
 */
export const MEMORY = Object.freeze({
  warm: 1.75, cool: -0.75, sour: -2.25,
  slightDays: 730, goodDays: 1095,
  // the memory messages (a warm party's favor, a cool one pulling back): a party again after `partyGapDays`
  partyGapDays: 30,
});
