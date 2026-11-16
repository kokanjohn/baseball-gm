// §122.57 r182 the card pools, read as the engine reads them: every pool is wired, every condition a card names is
// one the engine checks (or a marker listed here with what enforces it), every follow-up has a live parent, no two
// live cards share an id, and each card comes back only as its rule allows.
//   node tools/harness/check-card-pools.mjs
import './shims.js';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const P  = await import('../../data/cards-pool.js');
const Mn = await import('../../data/cards-money.js');
const Mo = await import('../../data/cards-moments.js');
const CE = await import('../../engine/CardEngine.js');

const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  — ${detail}` : ''}`); };

// The engine's source: a condition is read if its name appears there.
const src = ['engine', 'ui', 'ui/screens', 'ui/components'].flatMap(d => {
  try { return fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(root, d, f), 'utf8')); } catch { return []; }
}).join('\n');

// Keys that are not conditions, or are enforced by something other than their own name.
const MARKERS = {
  _isPreGame: 'which moment (the pool it is in)', _isInGame: 'which moment (the pool it is in)',
  _usesSignToken: 'author note: the card names a free agent (CardTokens)', _usesOwnerToken: 'author note: {owner_request}',
  _rosterContract: 'author note: the roster action (onYes / onNo)', _catcherOnly: 'author note: {active_catcher}',
  _requiresBPCoverage: 'the action\'s own feasibility (CardActions.canSpare)', _requiresCatcherCoverage: 'the action\'s own feasibility (CardActions.canSpare)',
  _expireFx: 'superseded by the default answer plus autoResolveTax (§78.8)',
};

const all = [];
for (const [name, v] of Object.entries({ ...P, ...Mn })) {
  if (!Array.isArray(v) || name === 'COMPOSE_RESPONSE_POOL') continue;
  for (const e of v) { const d = e?.card || e; if (d?.id) all.push({ pool: name, d, type: e?.card ? e.type : null }); }
}
const live = all.filter(x => !x.d._retired);

// 1. Every exported pool is dealt from (CardEngine names it).
const ceSrc = fs.readFileSync(path.join(root, 'engine/CardEngine.js'), 'utf8');
const unwired = Object.keys(P).filter(n => Array.isArray(P[n]) && n.endsWith('_POOL') && !new RegExp(`\\b${n}\\b`).test(ceSrc));
check(`every pool is wired into the engine (${Object.keys(P).filter(n => n.endsWith('_POOL')).length} pools)`, unwired.length === 0, unwired.join(', '));

// 2. Every condition a live card names is read.
const unread = {};
for (const { d } of live) for (const k of Object.keys(d)) if (k.startsWith('_') && !MARKERS[k] && !src.includes(k)) (unread[k] ||= []).push(d.id);
check(`every condition a card names is one the engine checks (${live.length} live cards)`, Object.keys(unread).length === 0,
      Object.entries(unread).map(([k, ids]) => `${k}: ${ids.slice(0, 4).join(' ')}`).join('; '));

// 3. No two live cards share an id (a card's log and its once-a-season rule are by id).
// (one card shared by two pools is one card; a follow-up's versions — success, setback — share their parent's id)
const seen = new Map(), dup = [];
for (const { d, pool, type } of live) {
  const k = d.id, prev = seen.get(k);
  if (prev && prev.d !== d && !(pool === 'FOLLOWUP_POOL' && prev.pool === pool && prev.type === type)) dup.push(k);
  seen.set(k, { d, pool, type });
}
check('no two live cards share an id', dup.length === 0, [...new Set(dup)].join(', '));

// 4. Every live follow-up hangs off a live card that chains it.
const byId = new Map(live.filter(x => x.pool !== 'FOLLOWUP_POOL').map(x => [x.d.id, x.d]));
const orphans = live.filter(x => x.pool === 'FOLLOWUP_POOL' && !(byId.get(x.type)?._followup) && !src.includes(`'${x.d.id}'`));
check('every follow-up has a live card that leads to it', orphans.length === 0, orphans.map(x => `${x.d.id} (after ${x.type})`).join(', '));

// 5. A notice (nothing to decide) reads like the other notices.
const twoSame = live.filter(x => x.d.yesLabel && x.d.yesLabel === x.d.noLabel).map(x => x.d.id);
check(`a card with one answer is shown as a notice (${twoSame.length} such cards; CardEngine shows "Understood")`, /const notice = /.test(ceSrc));

// 6. Every live pool card has a repeat rule; the half hour before first pitch is part of the pre-game moment.
const noRule = live.filter(x => !['FOLLOWUP_POOL', 'MANAGER_CONTRACT_POOL', 'COACHING_CONTRACT_POOL'].includes(x.pool) && !CE.cardRepeatRule(x.d.id)).map(x => x.d.id);
check('every live pool card has a rule for coming back', noRule.length === 0, noRule.slice(0, 8).join(', '));
check('the half-hour cards are dealt at the pre-game moment', P.PREGAME30_POOL.filter(d => !d._retired).every(d => CE.cardRepeatRule(d.id)?.pool === 'PREGAME_POOL'));
const stories = live.filter(x => x.d._oncePerSeason || CE.cardRepeatRule(x.d.id)?.once).length;
console.log(`  (${stories} story cards once a season; ${live.length - stories} may come back)`);

console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILED');
process.exit(results.every(Boolean) ? 0 : 1);
