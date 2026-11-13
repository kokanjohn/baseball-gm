// r160 §122.32 Wear on screen: Team → the Wear column (a meter and the word, first after the name, no
// scrolling), the player card's Wear section ("Caught 7 straight."), and a staff rest message as the GM
// reads it — the backup named, "Sit … / Keep … In".
//   node tools/harness/test-wear-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(Date.now());
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const S = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const slots = SM.get().userTeam.lineupSlots;
  const c = slots.find(s => s.slot === 'C').playerId;
  const others = slots.filter(s => s.slot !== 'C').map(s => s.playerId);
  SM.mutate(s => {
    s.settings.theme = theme;
    Object.assign(s.players[c], { wear: 10.5, straight: 7 });                 // Tiring
    Object.assign(s.players[others[0]], { wear: 19, straight: 19 });          // Worn down
    Object.assign(s.players[others[1]], { wear: 13, straight: 13 });          // Tired
    for (const id of others.slice(2)) Object.assign(s.players[id], { wear: 2, straight: 2 });   // Fresh
    // r161 an arm: the first starter tired (workload 14 as of now)
    const sp = s.userTeam.rotation.order[0];
    Object.assign(s.players[sp], { load: 14, loadAt: Date.now(), loadMult: 1 });
  });
  return { c, worn: others[0], cName: SM.get().players[c].name, sp: SM.get().userTeam.rotation.order[0] };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

// ── Team: the Wear column ──
await tap('.nav-item[data-tab="roster"]');
const team = await page.evaluate(() => {
  const block = document.querySelector('.tr-block');
  const head = [...block.querySelectorAll('.tr-head .tr-td')].map(e => e.textContent.trim());
  const rows = [...block.querySelectorAll('.tr-row[data-player]')].slice(0, 9).map(r => ({
    id: r.dataset.player, word: r.querySelector('.tr-c-wear .tr-wear-word')?.textContent.trim(),
    bar: r.querySelector('.tr-c-wear .tr-wear-bar i')?.style.width,
  }));
  const cell = block.querySelector('.tr-row[data-player] .tr-c-wear')?.getBoundingClientRect();
  return { head, rows, inView: cell ? cell.right <= window.innerWidth : false };
});
check(`the Hitters table: Wear is the first column after the name (${team.head.slice(0, 3).join(', ')})`, team.head[0] === 'Wear');
check('…on screen without scrolling', team.inView);
const word = (id) => team.rows.find(r => r.id === id)?.word;
check(`…the catcher "Tiring", the worn regular "Worn", the rest "Fresh" (${team.rows.map(r => r.word).join(' · ')})`,
      word(S.c) === 'Tiring' && word(S.worn) === 'Worn' && team.rows.filter(r => r.word === 'Fresh').length >= 6);
const fullW = parseInt(team.rows.find(r => r.word === 'Fresh').bar), wornW = parseInt(team.rows.find(r => r.id === S.worn).bar), tiringW = parseInt(team.rows.find(r => r.id === S.c).bar);
check(`…the bar full when fresh, shrinking toward the left with the wear (fresh ${fullW}%, tiring ${tiringW}%, worn ${wornW}%)`, fullW >= 90 && tiringW < fullW && wornW < tiringW);
// r161 the Pitchers table too
const arms = await page.evaluate((sp) => {
  const block = [...document.querySelectorAll('.tr-block')].find(b => b.querySelector('.tr-row[data-player]') && [...b.querySelectorAll('.tr-head .tr-td')].some(e => e.textContent.trim() === 'ERA'));
  if (!block) return null;
  const head = [...block.querySelectorAll('.tr-head .tr-td')].map(e => e.textContent.trim());
  const r = block.querySelector(`.tr-row[data-player="${sp}"]`);
  return { head: head.slice(0, 2), word: r?.querySelector('.tr-c-wear .tr-wear-word')?.textContent.trim(), n: block.querySelectorAll('.tr-c-wear .tr-wear-word').length };
}, S.sp);
check(`the Pitchers table: Wear first too (${arms?.head.join(', ')}), the worked starter "${arms?.word}"`, arms?.head[0] === 'Wear' && arms.word === 'Tired' && arms.n >= 8);
await page.screenshot({ path: `${out}/wear-team-${theme}.png` });

// ── The player card ──
await tap(`.tr-row[data-player="${S.c}"] .tr-name`);
await page.waitForTimeout(400);
const card = await page.evaluate(() => {
  const sheet = document.getElementById('player-card-sheet');
  const sec = [...sheet.querySelectorAll('.pc-section')].find(s => s.querySelector('.pc-section-label')?.textContent.trim() === 'Wear');
  return sec ? { word: sec.querySelector('.pc-wear-word')?.textContent.trim(), note: sec.querySelector('.pc-ask-note')?.textContent.trim() } : null;
});
check(`the player card: a Wear section — "${card?.word}", "${card?.note}"`, card?.word === 'Tiring' && /^Caught 7 straight\./.test(card?.note || ''));
await page.screenshot({ path: `${out}/wear-card-${theme}.png` });
await tap('#player-card-close');
// r161 a pitcher's card: the Wear section, today's arm
await page.evaluate((sp) => document.querySelector(`.tr-row[data-player="${sp}"]`)?.scrollIntoView({ block: 'center' }), S.sp);
await tap(`.tr-row[data-player="${S.sp}"] .tr-name`);
await page.waitForTimeout(400);
const pcard = await page.evaluate(() => {
  const sheet = document.getElementById('player-card-sheet');
  const sec = [...sheet.querySelectorAll('.pc-section')].find(s => s.querySelector('.pc-section-label')?.textContent.trim() === 'Wear');
  return sec ? { word: sec.querySelector('.pc-wear-word')?.textContent.trim(), note: sec.querySelector('.pc-ask-note')?.textContent.trim() } : null;
});
check(`a pitcher's card: Wear — "${pcard?.word}", "${pcard?.note}"`, pcard?.word === 'Tired' && /^Today: /.test(pcard?.note || '') && /stuff and control/.test(pcard?.note || ''));
await page.screenshot({ path: `${out}/wear-pitcher-card-${theme}.png` });
await tap('#player-card-close');

// ── A rest message, as the GM reads it ──
const msg = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  // (between games, well before the next first pitch)
  const g = SM.get().schedule[SM.get().currentGameIndex];   // (our next game)
  return { g: g?.gameTime };
});
const t = msg.g - 3 * 3600_000 - 60 * 60_000;
await page.clock.setFixedTime(t);
const rest = await page.evaluate(async (t) => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  // (the staff writes in the season, not in spring: the regular season, for the test)
  SM.mutate(s => { s.phase = 'REGULAR_SEASON'; });
  CE.syncRosterCards([], t);
  const c = (SM.get().scheduledCards || []).find(x => x.cardId === 'rest_ask');
  return c ? { id: c.instanceId, at: c.deliverAtMs } : null;
}, t);
check('the staff writes about the worn-down regular', !!rest);
if (rest) {
  await page.clock.setFixedTime(rest.at + 60_000);
  await page.evaluate(async () => { (await import('/baseball-gm/engine/CardEngine.js')).releaseDueCards(); });
  await tap('.nav-item[data-tab="decisions"]');
  await tap(`[data-open="${rest.id}"]`);
  await page.waitForTimeout(2600);
  const read = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()),
                                            links: document.querySelectorAll('.mr-body .msg-player').length }));
  check(`…in the inbox: ${read.btn.join(' / ')}`, read.btn.some(x => /^Sit /.test(x)) && read.btn.some(x => /^Keep .+ In$/.test(x)));
  check('…the player and the backup are both tappable', read.links >= 2, String(read.links));
  await page.screenshot({ path: `${out}/wear-message-${theme}.png` });
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
