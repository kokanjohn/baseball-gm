// r171 the new club's name and colors (setup step 3): a live preview of the club fills the screen;
// tapping it (or "Name Your Club") opens a sheet with the city and nickname that sits on the keyboard;
// the name and the colors show on the preview as they change; nothing scrolls; "Take the Job" starts
// the club with that name and those colors.
//   node tools/harness/test-setup-name-ui.mjs outDir
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
for (const [w, h] of [[390, 844], [375, 667]]) {
  console.log(`${w}×${h}`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.tap('.archetype-card[data-archetype="lab"]'); await page.tap('#arch-next-btn'); await page.waitForTimeout(250);
  await page.tap('.region-card[data-region="south"]'); await page.tap('#region-next-btn'); await page.waitForTimeout(250);
  const s0 = await page.evaluate(() => ({
    btn: document.getElementById('start-btn').textContent.trim(), sheet: document.getElementById('nc-sheet').hidden,
    meta: document.querySelector('.nc-meta').innerText.replace(/\s+/g, ' '), names: document.getElementById('nc-names').innerText.replace(/\s+/g, ' '),
    inputs: [...document.querySelectorAll('input[type=text]')].filter(i => i.offsetParent).length,
    scroll: document.documentElement.scrollHeight > innerHeight + 1,
    card: document.getElementById('nc-preview').getBoundingClientRect().height,
  }));
  check(`not named yet: "${s0.names}", "${s0.btn}", no text field on screen, the preview ${Math.round(s0.card)}px tall`, s0.btn === 'NAME YOUR CLUB' && s0.sheet && s0.inputs === 0 && s0.card >= 200 && /Your Club/.test(s0.names));
  check(`…the type and region on the preview (${s0.meta})`, /The Lab · South/.test(s0.meta));
  check('…nothing scrolls', !s0.scroll);
  await page.tap('#start-btn'); await page.waitForTimeout(250);
  const s1 = await page.evaluate(() => ({ sheet: !document.getElementById('nc-sheet').hidden, focus: document.activeElement?.id, bottom: getComputedStyle(document.getElementById('nc-sheet')).bottom }));
  check(`"Name Your Club" opens the sheet at the bottom, the city field ready (${s1.focus}, bottom ${s1.bottom})`, s1.sheet && s1.focus === 'team-city' && s1.bottom === '0px');
  await page.keyboard.type('Harbor City');
  await page.keyboard.press('Enter');
  const f2 = await page.evaluate(() => document.activeElement?.id);
  await page.keyboard.type('Nighthawks');
  const s2 = await page.evaluate(() => ({ names: document.getElementById('nc-names').innerText.replace(/\s+/g, ' '), mini: document.getElementById('nc-sheet-preview').innerText.replace(/\s+/g, ' '), btn: document.getElementById('start-btn').textContent.trim() }));
  check(`Enter moves to the nickname (${f2}); the name shows as it's typed (${s2.mini})`, f2 === 'team-nick' && /HARBOR CITY/i.test(s2.names) && /Nighthawks/.test(s2.names) && /Nighthawks/.test(s2.mini));
  await page.screenshot({ path: `${out}/setup-sheet-${w}.png` });
  await page.keyboard.press('Enter'); await page.waitForTimeout(250);
  const s3 = await page.evaluate(() => ({ sheet: document.getElementById('nc-sheet').hidden, btn: document.getElementById('start-btn').textContent.trim(), edit: document.querySelector('.nc-edit').textContent }));
  check(`Enter on the nickname closes the sheet; "${s3.btn}", "${s3.edit}"`, s3.sheet && s3.btn === 'TAKE THE JOB' && s3.edit === 'Edit name');
  await page.tap('#nc-preview'); await page.waitForTimeout(200);
  await page.tap('#nc-scrim', { position: { x: 20, y: 20 } }); await page.waitForTimeout(200);
  check('tapping the preview reopens it; tapping outside closes it', await page.evaluate(() => document.getElementById('nc-sheet').hidden));
  const bg0 = await page.evaluate(() => getComputedStyle(document.getElementById('nc-band')).backgroundColor);
  const box = await page.$eval('#primary-hue', el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
  await page.mouse.click(box.x + box.w * 0.62, box.y); await page.waitForTimeout(150);
  const s4 = await page.evaluate(() => ({ bg: getComputedStyle(document.getElementById('nc-band')).backgroundColor, ink: getComputedStyle(document.getElementById('nc-band')).color }));
  check(`the primary slider colors the preview (${bg0} → ${s4.bg}), its text readable (${s4.ink})`, s4.bg !== bg0 && /255, 255, 255/.test(s4.ink));
  await page.screenshot({ path: `${out}/setup-named-${w}.png` });
  await page.tap('#start-btn');
  await page.waitForFunction(() => !!document.querySelector('.nav-item[data-tab="dashboard"]') && document.querySelector('#app')?.offsetParent !== null, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const club = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); const st = SM.get(), u = st?.userTeam; return u ? { city: u.city, nick: u.nickname, color: st.settings?.primaryColor, region: u.region } : null; });
  check(`"Take the Job": the club is the Harbor City Nighthawks, in the chosen color (${JSON.stringify(club)})`, club?.city === 'Harbor City' && club?.nick === 'Nighthawks' && /^#/.test(club?.color || '') && club.color.toUpperCase() !== '#F5D253');
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(ok ? 0 : 1);
