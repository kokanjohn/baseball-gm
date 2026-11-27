// r293 §122.175 (foundation step 5) a player's save from before the parts, in a real browser: the database is version 1
// (no saveParts store) and the save is the whole state in one record. Opening the app upgrades the database, loads
// the save as it was, writes it in parts at its next save, and loads it back the same after a reload.
//   node tools/harness/test-save-upgrade-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '/tmp/tfo-shots', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
await pinEnv(ctx);
const errors = [];
const APP = 'http://localhost:8765/baseball-gm/';
const PLAIN = 'http://localhost:8765/baseball-gm/manifest.json';   // the same site, no app running

// 1. A club, made in the browser; its whole state, taken out.
let page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.message));
await page.goto(APP, { waitUntil: 'networkidle' });
const made = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => {
    s.settings.theme = theme;
    // some answered messages and notes, so Completed has something to carry
    s.inbox = [...s.inbox, ...[1, 2, 3].map(i => ({ instanceId: `old-${i}`, cardId: 'old_card', subject: `Answered ${i}`, body: 'b', resolved: true, choice: 'yes', resolvedAtMs: 1000 + i, arrivedAtMs: 900 + i }))];
    s.messageHistory = [{ _note: true, instanceId: 'note-1', cardId: 'older', resolved: true, _noteSeason: 1 }];
  });
  const st = JSON.parse(JSON.stringify(SM.get()));
  const DB = await import('/baseball-gm/store/DB.js');
  DB.close();
  return { slotId: SM.getActiveSlotId(), state: st, team: `${st.userTeam.city} ${st.userTeam.nickname}` };
}, theme);
await page.close();

// 2. The database as an old version left it: version 1, one store of whole saves.
page = await ctx.newPage();
await page.goto(PLAIN);
const planted = await page.evaluate(async ({ slotId, state, team }) => {
  await new Promise((res, rej) => { const r = indexedDB.deleteDatabase('BaseballGM'); r.onsuccess = res; r.onerror = rej; r.onblocked = () => rej(new Error('blocked')); });
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('BaseballGM', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('saveSlots', { keyPath: 'slotId' }); r.result.createObjectStore('appMeta'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction('saveSlots', 'readwrite');
    tx.objectStore('saveSlots').put({ slotId, teamName: team, archetype: state.archetype, seasonNum: state.seasonNum, lastPlayed: Date.now(), state });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  const stores = [...db.objectStoreNames];
  db.close();
  localStorage.setItem('bgm_activeSlotId', slotId);
  return { version: 1, stores };
}, made);
check(`the old database: version ${planted.version}, stores ${planted.stores.join(', ')}`, planted.stores.length === 2 && !planted.stores.includes('saveParts'));
await page.close();

// 3. The app opens it.
page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.message));
await page.goto(APP, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const opened = await page.evaluate(async (want) => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const st = SM.get();
  // (the app runs the world on opening — it catches up to now — so compare who and what, not every number)
  const same = [];
  const eq = (name, f) => { if (JSON.stringify(f(st)) === JSON.stringify(f(want.state))) same.push(name); };
  eq('the players', s => Object.keys(s.players || {}).sort());
  eq('the clubs', s => (s.leagueTeams || []).map(t => t.id));
  eq('our schedule', s => (s.schedule || []).map(g => [g.index, g.gameTime, g.opponentId]));
  eq("the league's", s => Object.entries(s.leagueSchedule?.dayMap || {}).map(([d, l]) => [d, l.map(g => g.id)]));
  eq('the notes', s => s.messageHistory);
  const ids = (l) => (l || []).map(c => c.instanceId).join();
  return { slot: SM.getActiveSlotId(), team: `${st.userTeam.city} ${st.userTeam.nickname}`, same, inbox: ids(st.inbox) === ids(want.state.inbox),
           shown: document.getElementById('app')?.offsetParent !== null || !!document.querySelector('.nav-item') };
}, made);
check(`the app opens the old save: the same club (${opened.team}), shown`, opened.slot === made.slotId && opened.team === made.team && opened.shown);
check(`…as it was (${opened.same.join(', ')}; Messages ${opened.inbox ? 'the same' : 'different'})`, opened.same.length === 5 && opened.inbox);
await page.screenshot({ path: `${out}/save-upgrade-${theme}.png` });

// 4. Its next save: in parts, in the upgraded database.
const saved = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  await SM.save();
  const db = await new Promise((res, rej) => { const r = indexedDB.open('BaseballGM'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const read = (store, q) => new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const r = q(tx.objectStore(store)); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const env = await read('saveSlots', s => s.get(SM.getActiveSlotId()));
  const keys = await read('saveParts', s => s.getAllKeys());
  const out = { version: db.version, stores: [...db.objectStoreNames], format: env.format, mainSchedule: env.state.schedule, parts: keys.map(k => k.split('|').slice(1).join('|')) };
  db.close();
  return out;
});
check(`the database is version ${saved.version} with ${saved.stores.join(', ')}`, saved.version === 2 && saved.stores.includes('saveParts'));
check(`the next save is in parts (format ${saved.format}: ${saved.parts.join(', ')})`, saved.format === 2 && saved.mainSchedule === null && saved.parts.includes('part|schedules') && saved.parts.includes('part|completed'));
const before = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); await SM.save(); const s = SM.get(); return JSON.stringify({ p: s.players, sc: s.schedule, ls: s.leagueSchedule, ib: s.inbox, mh: s.messageHistory, u: s.userTeam }); });

// 5. Reloaded: the same.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const after = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get(); return JSON.stringify({ p: s.players, sc: s.schedule, ls: s.leagueSchedule, ib: s.inbox, mh: s.messageHistory, u: s.userTeam }); });
const a = JSON.parse(before), b = JSON.parse(after);
const differs = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
check(`reloaded from the parts: the same (players, schedules, Messages, notes${differs.length ? `; differs: ${differs.join(', ')}` : ''})`, differs.length === 0 || (differs.length === 1 && differs[0] === 'u'));
check('no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
