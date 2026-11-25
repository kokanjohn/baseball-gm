// r229 §122.108 In the real app: our live game card has a "Live View" button; it opens the field — nine fielders by
// name (the pitcher on the mound), the runners on base, the batter, on deck, in the hole, the last play, R/H/E — each
// matching the game's plays; a new play draws the ball's path from the plate to its spot and moves the runners; a game
// from before r229 (no fielders saved) still shows all nine; Done closes it.
//   node tools/harness/test-live-view-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '/tmp/tfo-shots', theme = 'dark'] = process.argv.slice(2);
const MIN = 60_000;
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', timezoneId: 'America/New_York' });
await pinEnv(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.evaluate(async ({ theme, MIN }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const now = Date.now();
  SM.mutate(s => {
    s.settings.theme = theme;
    const g = s.schedule[s.currentGameIndex || 0];
    g.gameTime = now - 40 * MIN;
    const venueId = g.isHome ? 'user' : g.opponentId;
    g.wx = { v: 1, venueId, gameTime: g.gameTime, playMin: 180, outcome: 'played', calledBy: null, reason: null, decidedAt: null, startAt: g.gameTime, delays: [], endT: null, stopAtPlayMin: null };
  });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, { theme, MIN });
await page.waitForSelector('#live-game-wrap .lgv-view-btn', { timeout: 30000 });
check('our live game card has a "Live View" button', (await page.textContent('#live-game-wrap .lgv-view-btn')).trim() === 'Live View');
await page.screenshot({ path: `${out}/lv-card-${theme}.png` });

// The facts the view should show, from the game's plays (the same derivation, checked against the plays below).
const facts = async () => page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const LV = await import('/baseball-gm/ui/components/LiveView.js');
  const s = SM.get(), g = s.schedule[s.currentGameIndex || 0];
  const v = LV.liveViewState(g, s);
  const name = (id) => s.players[id]?.name || null;
  const idx = g.livePlayIndex || 0, plays = g.plays || [];
  // the truth: the next plate appearance's batter; the fielders saved on this half's first play
  const half = `${v.half}_${v.inning}`;
  const nextPA = plays.slice(idx).find(p => p.batterId && p._halfInning === half && p.type !== 'injury');
  const savedField = plays.find(p => p._halfInning === half && p._field)?._field || null;
  const pitcherSeen = plays.slice(0, idx).some(p => p.pitcherId === v.pitcher && p.half && (p.half === 'TOP' ? 'home' : 'away') === v.field);
  return { v, names: { atBat: name(v.atBat), onDeck: name(v.onDeck), inHole: name(v.inHole), pitcher: name(v.pitcher),
    fielders: Object.fromEntries(Object.entries(v.fielders).map(([k, id]) => [k, name(id)])),
    runners: ['first', 'second', 'third'].map(b => name(v.bases[b])).filter(Boolean) },
    truth: { nextBatter: nextPA?.batterId || null, savedField, idx, n: plays.length, pitcherSeen } };
});

await page.click('#live-game-wrap .lgv-view-btn');
await page.waitForSelector('#live-view.open', { timeout: 5000 });
await page.waitForTimeout(600);
let f = await facts();
const shown = await page.evaluate(() => ({
  fielders: [...document.querySelectorAll('#live-view .lv-fname')].map(t => t.textContent),
  batter: document.querySelector('#live-view .lv-batter')?.textContent || '',
  rows: [...document.querySelectorAll('#live-view .lv-row')].map(r => [...r.children].map(c => c.textContent.trim()).filter(Boolean).join(' ')),
  rhe: [...document.querySelectorAll('#live-view .lv-rhe tbody tr')].map(r => [...r.children].map(c => c.textContent.trim()).join(' ')),
  sit: document.querySelector('#live-view .lv-sit')?.textContent.replace(/\s+/g, ' ').trim(),
  last: document.querySelector('#live-view .lv-last')?.textContent || '',
}));
console.log(`    ${shown.sit} · ${shown.last}\n    fielders: ${shown.fielders.join(', ')}\n    ${shown.rows.join(' | ')}\n    ${shown.rhe.join(' | ')}`);
check(`nine fielders by name, the pitcher included (${shown.fielders.length})`, shown.fielders.length === 9 && shown.fielders.includes(f.names.pitcher));
check('the fielders are the ones the sim had in the field this half', !f.truth.savedField || Object.entries(f.truth.savedField).every(([k, id]) => f.v.fielders[k] === id));
check(`the batter at the plate is the next plate appearance's (${f.names.atBat})`, f.v.atBat === f.truth.nextBatter && shown.batter === f.names.atBat);
check(`on deck and in the hole follow in the order (${f.names.onDeck}, ${f.names.inHole})`, !!f.names.onDeck && !!f.names.inHole && shown.rows.some(r => r.startsWith('On deck') && r.includes(f.names.onDeck)) && shown.rows.some(r => r.startsWith('In the hole') && r.includes(f.names.inHole)));
check(`the pitcher is the fielding club's latest, with a line (${shown.rows.find(r => r.startsWith('Pitching'))})`, f.truth.pitcherSeen && shown.rows.some(r => r.startsWith('Pitching') && /IP, \d+ H, \d+ ER, \d+ BB, \d+ K, \d+ batters? faced/.test(r)));
check(`R/H/E for both teams (${shown.rhe.join(' | ')})`, shown.rhe.length === 2 && shown.rhe.every(r => /^\S+ \d+ \d+ \d+$/.test(r)));
await page.screenshot({ path: `${out}/lv-open-${theme}.png` });
// r234 §122.113 names only (no dots); the batter centred over the plate; the pitcher's line on one line of its own
const look = await page.evaluate(() => {
  const b = document.querySelector('#live-view .lv-batter'), plate = document.querySelector('#live-view .lv-plate');
  const br = b?.getBoundingClientRect(), pr = plate?.getBoundingClientRect();
  const line = document.querySelector('#live-view .lv-line2'), lr = line?.getBoundingClientRect();
  return { dots: document.querySelectorAll('#live-view .lv-fdot').length,
    centred: br && pr ? Math.abs((br.left + br.right) / 2 - (pr.left + pr.right) / 2) : 99, above: br && pr ? br.bottom <= pr.top + 2 : false,
    oneLine: lr ? lr.height < 22 : false };
});
check(`the fielders are names alone (${look.dots} dots)`, look.dots === 0);
check(`the batter's name is centred over the plate (off by ${look.centred.toFixed(1)}px)`, look.centred < 1.5 && look.above);
check('the pitcher\'s line fits on one line of its own', look.oneLine);
// a name opens the player card, on top of the Live View
await page.click('#live-view .lv-fname[data-pid]');
await page.waitForTimeout(500);
const onTop = await page.evaluate(() => {
  const o = document.getElementById('player-card-overlay');
  if (!o || getComputedStyle(o).display === 'none') return 'not open';
  const r = o.querySelector('.modal-sheet, .pc-sheet, .player-card')?.getBoundingClientRect() || o.getBoundingClientRect();
  const hit = document.elementFromPoint((r.left + r.right) / 2, Math.max(r.top + 40, 120));
  return o.contains(hit) ? 'on top' : `under ${hit?.closest('#live-view') ? 'the Live View' : hit?.tagName}`;
});
check(`tapping a name opens the player card on top (${onTop})`, onTop === 'on top');
await page.screenshot({ path: `${out}/lv-card-on-top-${theme}.png` });
await page.evaluate(async () => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); PC.closePlayerCard(); });
await page.waitForTimeout(400);

// Reveal plays until a ball in play; the path and the runners follow.
const step = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const EB = await import('/baseball-gm/ui/EventBus.js');
  const s = SM.get(), g = s.schedule[s.currentGameIndex || 0];
  const plays = g.plays, from = g.livePlayIndex || 0;
  let k = from;
  while (k < plays.length && !(plays[k]._ball && ['single', 'double', 'triple'].includes(plays[k].type) && plays[k].batterId)) k++;
  if (k >= plays.length) return null;
  SM.mutate(st => { st.schedule[st.currentGameIndex || 0].livePlayIndex = k + 1; });
  EB.emit('game:tick', { game: SM.get().schedule[SM.get().currentGameIndex || 0] });
  return { play: plays[k].description, ball: plays[k]._ball, batter: plays[k].batterId, after: plays[k]._basesAfter };
});
check('a hit with a spot is coming in this game', !!step, '');
if (step) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/lv-ball-flying-${theme}.png` });
  await page.waitForTimeout(1600);
  const drawn = await page.evaluate(() => {
    const l = document.querySelector('#live-view .lv-path'), land = document.querySelector('#live-view .lv-land');
    return { x2: +l?.getAttribute('x2'), y2: +l?.getAttribute('y2'), lx: +land?.getAttribute('cx'), ly: +land?.getAttribute('cy'),
      runners: [...document.querySelectorAll('#live-view .lv-runner .lv-rname')].map(t => t.textContent), last: document.querySelector('#live-view .lv-last').textContent };
  });
  f = await facts();
  check(`the last play in words ("${drawn.last}")`, drawn.last === step.play);
  check(`the ball's path ends at its spot (${step.ball.at}, ${step.ball.dist} ft)`, Math.abs(drawn.x2 - drawn.lx) < 0.6 && Math.abs(drawn.y2 - drawn.ly) < 0.6 && drawn.ly < 330);
  const want = ['first', 'second', 'third'].map(b => step.after?.[b]).filter(Boolean).map(id => f.names && null);
  check(`the runners on base by name (${drawn.runners.join(', ') || 'none'})`, drawn.runners.length === f.names.runners.length && f.names.runners.every(n => drawn.runners.includes(n)));
  await page.screenshot({ path: `${out}/lv-after-hit-${theme}.png` });
}

// r234 the half's last out: the play and its path stay a few seconds, then clear (the other side is up).
// r280 §122.159 the whole field holds at the last out (9 s: 3 outs, that half's pitcher and batter), the words and
// path clear, and only then (a second later) the next half comes up.
const endHalf = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const EB = await import('/baseball-gm/ui/EventBus.js');
  const s = SM.get(), g = s.schedule[s.currentGameIndex || 0];
  const plays = g.plays, from = g.livePlayIndex || 0;
  let k = from;
  while (k < plays.length && !(plays[k].outsAfter === 3 && plays[k].batterId && plays[k]._ball)) k++;
  if (k >= plays.length) return null;
  SM.mutate(st => { st.schedule[st.currentGameIndex || 0].livePlayIndex = k + 1; });
  EB.emit('game:tick', { game: SM.get().schedule[SM.get().currentGameIndex || 0] });
  const p = plays[k];
  const pitcherName = s.players[p.pitcherId]?.name, batterName = s.players[p.batterId]?.name;
  return { text: p.description, inn: `${p.half === 'TOP' ? 'Top' : 'Bottom'} ${p.inning}`, pitcherName, batterName };
});
if (endHalf) {
  const look = () => page.evaluate(() => {
    const row = (k) => [...document.querySelectorAll('#live-view .lv-row')].find(r => r.querySelector('.lv-k')?.textContent === k)?.querySelector('.lv-v')?.textContent.trim() || '';
    return { last: document.querySelector('#live-view .lv-last').textContent, path: !!document.querySelector('#live-view .lv-path'),
             inn: document.querySelector('#live-view .lv-inn')?.textContent || '', outs: document.querySelector('#live-view .lv-sit')?.textContent.match(/(\d) outs?/)?.[1],
             pitching: row('Pitching'), atBat: row('At bat') };
  });
  await page.waitForTimeout(1500);
  const during = await look();
  await page.waitForTimeout(6000);
  const late = await look();
  await page.waitForTimeout(2000);   // (9.5 s: cleared, the next half not up yet)
  const cleared = await look();
  await page.waitForTimeout(1500);   // (11 s: the next half)
  const next = await look();
  check(`the last out holds the field: “${during.last}”, ${during.inn}, ${during.outs} outs, ${during.pitching} pitching, ${during.atBat} at bat`,
    during.last === endHalf.text && during.path && during.inn === endHalf.inn && during.outs === '3' && during.pitching === endHalf.pitcherName && during.atBat === endHalf.batterName);
  check('…still held at 7.5 s', late.last === endHalf.text && late.inn === endHalf.inn && late.outs === '3');
  check('…then the words and the ball\'s path clear, the half still the one that ended', cleared.last === '' && !cleared.path && cleared.inn === endHalf.inn && cleared.outs === '3');
  check(`…and only then the next half: ${next.inn}, ${next.outs} outs, ${next.pitching} pitching, ${next.atBat} at bat`,
    next.inn !== endHalf.inn && next.outs === '0' && next.last === '' && !next.path && next.pitching !== endHalf.pitcherName && next.atBat && next.atBat !== '—');
}

// A game from before r229 (no fielders saved on its plays): still nine, from the lineups.
const legacy = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const LV = await import('/baseball-gm/ui/components/LiveView.js');
  const s = SM.get(), g = JSON.parse(JSON.stringify(s.schedule[s.currentGameIndex || 0]));
  for (const p of g.plays) { delete p._field; delete p._for; }
  const v = LV.liveViewState(g, s);
  return Object.keys(v.fielders).length + (v.pitcher ? 1 : 0);
});
check(`a game from before r229: still nine in the field (${legacy})`, legacy === 9);
await page.click('#live-view .lv-done');
await page.waitForTimeout(400);
check('Done closes it', !(await page.$('#live-view')));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
