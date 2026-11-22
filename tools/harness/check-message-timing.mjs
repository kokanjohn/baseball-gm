/**
 * tools/harness/check-message-timing.mjs — r254 §122.133 messages fit the time they arrive in.
 *   - A message that can arrive an hour or two before the thing it's about (the first day before the first game,
 *     the hours before a game, during one, the takeover, camp opening, the spring opener, Opening Day) never asks
 *     for something that takes days or weeks: ordering caps or scarves, booking a flyover, a billboard up today.
 *   - The flyover and the Opening Day scarves are winter messages now; the banner is already made.
 *   - The manager never calls the lineup "mine" (the GM picks the nine and the order's approach).
 *   - Work that's scheduled reads as scheduled: no "done" the moment it's approved.
 *   - Every decision says what happens either way.
 */
import { FIRST_DAY_CORE, FIRST_DAY_SECONDARY } from '../../data/cards-first-day.js';
import { MOMENT_CARDS } from '../../data/cards-moments.js';
import { MONEY_PREGAME, MONEY_BETWEEN } from '../../data/cards-money.js';
import * as POOL from '../../data/cards-pool.js';
import { WINTER_POOL } from '../../data/cards-winter.js';
import { OFFDAY_POOL, ROAD_POOL } from '../../data/cards-away.js';
import { EMERGENCIES } from '../../data/cards-emergency.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const all = (x) => (Array.isArray(x) ? x.flatMap(all) : x && typeof x === 'object' ? (x.id && (x.body || x.subject) ? [x] : Object.values(x).flatMap(all)) : []);
const text = (c) => [c.subject, c.preview, c.body, c.yesLabel, c.noLabel, c.yesMsg, c.noMsg].filter(Boolean).join(' ');
const live = (cs) => cs.filter(c => !c._retired);

// Messages that can land an hour or two before what they're about.
const soon = live([
  ...all(FIRST_DAY_CORE).filter(c => c._beforeFirstGame), ...all(FIRST_DAY_SECONDARY).filter(c => c._beforeFirstGame),
  ...all(MOMENT_CARDS.takeover), ...all(MOMENT_CARDS.camp_open), ...all(MOMENT_CARDS.spring_opener), ...all(MOMENT_CARDS.opening_day),
  ...all(MONEY_PREGAME), ...all(POOL.PREGAME_POOL), ...all(POOL.PREGAME30_POOL || []), ...all(POOL.INGAME_POOL),
]);
const LEAD = [
  [/\border(ed)? (the |new )?(caps|scarves|towels|bobbleheads|shirts|jerseys)\b|\b(caps|scarves|towels) (are |were )?ordered\b/i, 'orders giveaway items'],
  [/\bflyover\b/i, 'a flyover (weeks of approval)'],
  [/\bbillboard\b.*\bit'?s up\b|\bit'?s up\b.*\bbillboard\b/i, 'a billboard up the same day'],
  [/\brush(ed)?\b[^.]*\bbefore first pitch\b/i, 'a rush order before first pitch'],
  [/\bfinished in a day\b/i, 'construction done in a day'],
];
const bad = soon.flatMap(c => LEAD.filter(([re]) => re.test(text(c))).map(([, why]) => `${c.id}: ${why}`));
check(`${soon.length} messages that can come an hour or two ahead ask for nothing that takes days`, soon.length > 40 && bad.length === 0, bad.join('; '));

{
  const od = all(MOMENT_CARDS.opening_day).map(c => c.id);
  const w = Object.fromEntries(WINTER_POOL.map(c => [c.id, c]));
  check('the flyover and the scarves left Opening Day for the winter', !od.includes('mo_od_flyover') && !od.includes('mo_od_after_losing') && w.wt_flyover?._winter === 'winter' && w.wt_scarves?._winter === 'winter');
  check('Opening Day still has a version for every club (one with no conditions)', all(MOMENT_CARDS.opening_day).some(c => !c._when));
  const banner = all(MOMENT_CARDS.opening_day).find(c => c.id === 'mo_od_after_winning');
  check('the banner is already made', /came back from the printer/.test(banner?.body || ''));
  const gk = all(FIRST_DAY_CORE).find(c => c.id === 'fd_tickets_giveaway');
  check('the first game\'s caps are in the warehouse, not ordered', /in the warehouse/.test(gk?.body || '') && !/Order/.test(gk?.yesLabel || ''));
  const rival = all(MONEY_PREGAME).find(c => c.id === 'mon_pg_rival');
  check('the rivalry night\'s towels come from storage', /storage/.test(rival?.body || ''));
  const sit = readFileSync(new URL('../../engine/Situations.js', import.meta.url), 'utf8');
  check('the milestone night and the rivalry weekend use what we have (no giveaway ordered that day)', !/giveaway at the gates|Towels are ordered/.test(sit) && /from storage/.test(sit));
}

{
  const every = live([...all(FIRST_DAY_CORE), ...all(FIRST_DAY_SECONDARY), ...all(MOMENT_CARDS), ...all(MONEY_PREGAME), ...all(MONEY_BETWEEN),
    ...all(Object.values(POOL)), ...WINTER_POOL, ...OFFDAY_POOL, ...ROAD_POOL, ...EMERGENCIES]);
  const mine = every.filter(c => /\blineup\b[^.]{0,30}\b(mine|my call)\b|\b(mine|my call)\b[^.]{0,20}\blineup\b/i.test(text(c)));
  check('no manager calls the lineup theirs', mine.length === 0, mine.map(c => c.id).join(', '));
  const mgr = all(FIRST_DAY_CORE).find(c => c.id === 'fd_mgr_order');
  check('the batting-order message: the GM picks the nine and the approach; "Hear Them Out" promises no move', /You pick the nine/.test(mgr?.body || '') && mgr?.noLabel === 'Hear Them Out' && !/move .* up/.test(mgr?.noMsg || ''));

  const sched = { f1: /next long road trip/, f2: /next road trip/, f4: /next road trip/, fr1: /calendar/, fr3: /set for/, m1: /set for/, x1: /next off day/, sp2: /before Opening Day/, mon_flush_clubhouse: /next homestand/ };
  const off = Object.entries(sched).filter(([id, re]) => !re.test(every.find(c => c.id === id)?.yesMsg || ''));
  check('work that\'s scheduled reads as scheduled when approved', off.length === 0, off.map(([id]) => `${id}: ${every.find(c => c.id === id)?.yesMsg}`).join('; '));

  const silent = every.filter(c => !c._toastOnly && !/^compose_/.test(c.id) && c.noLabel && c.noLabel !== c.yesLabel && (!c.yesMsg || !c.noMsg));
  check(`every decision says what happens either way (${every.length} messages)`, silent.length === 0, silent.map(c => c.id).join(', '));
}

console.log(fail ? `\n${fail} FAILED — ${pass} passed` : `\nALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
