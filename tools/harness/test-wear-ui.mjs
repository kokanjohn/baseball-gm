// r160 §122.32 Wear on screen (r174 Team: a small bar only, between the name and OVR; the card: the full
// bar and the word near the top). Was: Team → the Wear column (a meter and the word, first after the name, no
// scrolling), the player card's Wear section ("Caught 7 straight."), and a staff rest message as the GM
// reads it — the backup named, "Sit … / Keep … In".
//   node tools/harness/test-wear-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';   // §122.69 the same moment and dice every run
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
await pinEnv(ctx);
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
    // r259 §122.138 two relievers: one pitched yesterday (light workload), one the last two days
    const pen = s.userTeam.rosterIds.map(id => s.players[id]).filter(p => p.group === 'bp' && !p.unavailable && !p.isInjured);
    const D = 86_400_000, now = Date.now();
    Object.assign(pen[0], { load: 2, loadAt: now - D, loadMult: 1, arm: [{ at: now - D, bf: 4, outs: 3, start: false }] });
    Object.assign(pen[1], { load: 4, loadAt: now - D, loadMult: 1, arm: [{ at: now - 2 * D, bf: 4, outs: 3, start: false }, { at: now - D, bf: 4, outs: 3, start: false }] });
    s._penTest = [pen[0].id, pen[1].id];
  });
  return { c, worn: others[0], cName: SM.get().players[c].name, sp: SM.get().userTeam.rotation.order[0], pen: SM.get()._penTest };
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
    id: r.dataset.player, word: (r.querySelector('.tr-wearc .tr-wear')?.getAttribute('aria-label') || '').replace(/^(Wear|Workload): /, '').replace(/ \(.*\)$/, ''),
    bar: r.querySelector('.tr-wearc .tr-wear-bar i')?.style.width, text: r.querySelector('.tr-wearc')?.textContent.trim(),
  }));
  // r174 a bar only, in the frozen part between the name and OVR, narrow
  const r0 = block.querySelector('.tr-row[data-player]');
  const name = r0.querySelector('.tr-fz .tr-name').getBoundingClientRect(), wear = r0.querySelector('.tr-fz .tr-wearc').getBoundingClientRect(), ovr = r0.querySelector('.tr-fz .tr-ovr').getBoundingClientRect();
  const barW = r0.querySelector('.tr-wear-bar').getBoundingClientRect().width;
  return { head, rows, between: name.right <= wear.left + 1 && wear.right <= ovr.left + 1, barW, inView: wear.right <= window.innerWidth };
});
check(`the Hitters table: the wear bar between the name and OVR, ${team.barW}px wide (no Wear column: ${team.head.slice(0, 2).join(', ')}…)`, team.between && team.barW <= 20 && !team.head.includes('Wear') && team.inView);
check('…the bar only, no word', team.rows.every(r => r.text === ''));
const word = (id) => team.rows.find(r => r.id === id)?.word;
check(`…the catcher "Tiring", the worn regular "Worn", the rest "Fresh" (its label: ${team.rows.map(r => r.word).join(' · ')})`,
      word(S.c) === 'Tiring' && word(S.worn) === 'Worn' && team.rows.filter(r => r.word === 'Fresh').length >= 6);
const fullW = parseInt(team.rows.find(r => r.word === 'Fresh').bar), wornW = parseInt(team.rows.find(r => r.id === S.worn).bar), tiringW = parseInt(team.rows.find(r => r.id === S.c).bar);
check(`…the bar full when fresh, shrinking toward the left with the wear (fresh ${fullW}%, tiring ${tiringW}%, worn ${wornW}%)`, fullW >= 90 && tiringW < fullW && wornW < tiringW);
// r161 the Pitchers table too
const arms = await page.evaluate((sp) => {
  const block = [...document.querySelectorAll('.tr-block')].find(b => b.querySelector('.tr-row[data-player]') && [...b.querySelectorAll('.tr-head .tr-td')].some(e => e.textContent.trim() === 'ERA'));
  if (!block) return null;
  const r = block.querySelector(`.tr-row[data-player="${sp}"]`);
  return { word: (r?.querySelector('.tr-wearc .tr-wear')?.getAttribute('aria-label') || ''), n: block.querySelectorAll('.tr-wearc .tr-wear').length };
}, S.sp);
check(`the Pitchers table: the bar too, the worked starter "${arms?.word}"`, /^Workload: Tired/.test(arms?.word || '') && arms.n >= 8);
// r259 §122.138 a reliever's bar reads today's arm, and no badge beside it
const pens = await page.evaluate((ids) => ids.map(id => { const r = document.querySelector(`.tr-row[data-player="${id}"]`);
  return { cls: r?.querySelector('.tr-wear')?.className || '', w: parseInt(r?.querySelector('.tr-wear-bar i')?.style.width || '0'), label: r?.querySelector('.tr-wear')?.getAttribute('aria-label') || '',
           badges: [...(r?.querySelectorAll('.tr-stat') || [])].map(b => b.textContent.trim()) }; }), S.pen);
check(`a reliever who pitched yesterday: the bar Tired, orange, half (${pens[0].label}, ${pens[0].w}%), no badge (${pens[0].badges.join(',') || 'none'})`,
  /tr-wear-tired/.test(pens[0].cls) && pens[0].w === 50 && !pens[0].badges.some(b => /Tired|Rest/.test(b)));
check(`a reliever who pitched two days running: the bar red, a quarter (${pens[1].label}, ${pens[1].w}%), no badge`,
  /tr-wear-worn/.test(pens[1].cls) && pens[1].w === 25 && /Needs a day/.test(pens[1].label) && !pens[1].badges.some(b => /Tired|Rest/.test(b)));
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
const order = await page.evaluate(() => [...document.querySelectorAll('#player-card-sheet .pc-section-label')].map(e => e.textContent.trim()));
check(`…near the top, after the contract (${order.slice(0, 3).join(', ')}…)`, order[0] === 'Contract' && order[1] === 'Wear');
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
// r259 the relievers' cards say why
for (const [i, want] of [[0, /^Tired$/], [1, /^Needs a day$/]]) {
  await page.evaluate((id) => document.querySelector(`.tr-row[data-player="${id}"]`)?.scrollIntoView({ block: 'center' }), S.pen[i]);
  await tap(`.tr-row[data-player="${S.pen[i]}"] .tr-name`);
  const rc = await page.evaluate(() => { const sec = [...document.querySelectorAll('#player-card-sheet .pc-section')].find(s => s.querySelector('.pc-section-label')?.textContent.trim() === 'Wear');
    return sec ? { word: sec.querySelector('.pc-wear-word')?.textContent.trim(), note: sec.querySelector('.pc-ask-note')?.textContent.trim() } : null; });
  check(`reliever ${i + 1}'s card says why: "${rc?.word}", "${rc?.note}"`, want.test(rc?.word || '')
    && (i === 0 ? rc?.note === 'Today: Pitched yesterday. Available, but tires sooner.' : rc?.note === 'Today: Pitched 2 days in a row: never a third. Resting today: not available to pitch.'));
  if (i === 1) await page.screenshot({ path: `${out}/wear-reliever-card-${theme}.png` });
  await tap('#player-card-close');
}

// ── A rest message, as the GM reads it ──
const msg = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  // (between games, well before the next first pitch) §122.69 a game the weather leaves alone: a rest message is about
  // a game that's played (the ones before it out of the way, as if already played).
  const st = SM.get(), from = st.currentGameIndex;
  // (the staff writes in the season: the first regular-season game, spring out of the way — a spring game left on the
  // schedule with the phase moved on is called off by the clock)
  let k = st.schedule.findIndex((g, i) => i >= from && !g.isSpring);
  while (k < st.schedule.length - 1 && GE.weatherStoryOf(st.schedule[k]).some(e => ['ppd', 'calloff', 'calloff_ask', 'start_doubt', 'start_delayed', 'suspend'].includes(e.kind))) k++;
  SM.mutate(s => { for (let i = from; i < k; i++) Object.assign(s.schedule[i], { _committed: true, cancelled: true, result: 'postponed', status: 'postponed' }); s.currentGameIndex = k; });
  const g = SM.get().schedule[k];   // (our next game)
  return { g: g?.gameTime };
});
const t = msg.g - 3 * 3600_000 - 60 * 60_000;
await page.clock.setFixedTime(t);
const rest = await page.evaluate(async (t) => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  // (the staff writes in the season, not in spring: the regular season, for the test)
  SM.mutate(s => { s.phase = 'REGULAR_SEASON';
    // (r162 a new club's first roster suggestion holds rest messages back half a day: not this test's subject)
    s.inbox = (s.inbox || []).filter(c => c.cardId !== 'roster_advice'); s.scheduledCards = (s.scheduledCards || []).filter(c => c.cardId !== 'roster_advice'); });
  CE.syncRosterCards([], t);
  const c = (SM.get().scheduledCards || []).find(x => x.cardId === 'rest_ask');
  return c ? { id: c.instanceId, at: c.deliverAtMs } : null;
}, t);
check('the staff writes about the worn-down regular', !!rest);
if (rest) {
  await page.clock.setFixedTime(rest.at + 60_000);
  await page.evaluate(async () => { (await import('/baseball-gm/engine/CardEngine.js')).releaseDueCards(); });
  await tap('.nav-item[data-tab="decisions"]');
  // §122.69 opened by its id, not by where its row sits: the list can redraw (a tick, a new message on top)
  // between finding the row and the finger landing, and a tap by position then opens the row now under it.
  await page.waitForSelector(`[data-open="${rest.id}"]`);
  await page.evaluate((id) => document.querySelector(`[data-open="${id}"]`)?.click(), rest.id);
  await page.waitForTimeout(2600);
  if (process.env.DBG) console.log('dbg', JSON.stringify(await page.evaluate(async (id) => { const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get();
    return { inInbox: (s.inbox || []).filter(c => c.instanceId === id).map(c => ({ r: c.resolved, ch: c.choice, auto: c._autoLabel })), sched: (s.scheduledCards || []).some(c => c.instanceId === id),
             open: !!document.querySelector(`[data-open="${id}"]`), mr: !!document.querySelector('.mr-body'), now: Date.now() }; }, rest.id)));
  const read = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()),
                                            links: document.querySelectorAll('.mr-body .msg-player').length }));
  check(`…in the inbox: ${read.btn.join(' / ')}`, read.btn.some(x => /^Sit /.test(x)) && read.btn.some(x => /^Keep .+ In$/.test(x)));
  check('…the player and the backup are both tappable', read.links >= 2, String(read.links));
  await page.screenshot({ path: `${out}/wear-message-${theme}.png` });
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
