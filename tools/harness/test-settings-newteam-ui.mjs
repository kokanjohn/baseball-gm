// §122.65 Settings after a new team on the same page: App.init() runs again (setup → init), and
// everything it wires is wired once — Edit, Team Colors and Theme open on a tap (a second handler
// used to close them in the same tap), the theme changes, and the EventBus has one of each listener.
//   node tools/harness/test-settings-newteam-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';   // §122.69 the same moment and dice every run
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '/tmp/tfo-shots', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
await pinEnv(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const newTeam = (city, theme, archetypeId) => page.evaluate(async ({ city, theme, archetypeId }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId, gmName: 'GM', city, nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, { city, theme, archetypeId });
const busCount = () => page.evaluate(async () => { const B = await import('/baseball-gm/ui/EventBus.js'); return ['game:committed', 'card:resolved', 'settings:themeChanged'].map(e => B.listenerCount(e)); });

await newTeam('Riverton', theme, 'contender');
await page.waitForTimeout(600);
const first = await busCount();
await newTeam('Lakeport', theme, 'ember');   // the GM's next team, same page (as setup does)
await page.waitForTimeout(800);
const second = await busCount();
check(`EventBus: the same listeners after a second team (${first.join('/')} → ${second.join('/')})`, first.join() === second.join());

await page.tap('#settings-btn'); await page.waitForTimeout(600);
const open = (id) => page.evaluate((id) => document.getElementById(id)?.style.display, id);
const tapIn = async (sel) => { await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), sel); await page.waitForTimeout(150); await page.tap(sel); await page.waitForTimeout(300); };
await tapIn('#settings-team-edit-btn');
check('Team Info: Edit opens the fields', await open('settings-team-edit-panel') === 'block');
const city = await page.evaluate(() => document.getElementById('settings-edit-city')?.value);
check(`the fields hold the new team (${city})`, city === 'Lakeport');
await tapIn('#settings-colors-row');
check('Team Colors opens the sliders', await open('settings-color-panel') === 'block');
await tapIn('#settings-theme-row');
check('Theme opens the choices', await open('settings-theme-panel') === 'block');
const other = theme === 'dark' ? 'light' : 'dark';
await tapIn(`.settings-theme-btn[data-theme="${other}"]`);
const now = await page.evaluate(async () => (await import('/baseball-gm/store/StateManager.js')).get().settings.theme);
check(`a tap on ${other} changes the theme (${now})`, now === other);
await page.screenshot({ path: `${out}/settings-newteam-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
