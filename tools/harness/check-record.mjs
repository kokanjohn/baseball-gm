/**
 * tools/harness/check-record.mjs
 * DEV/TEST ONLY — §122.168 the record check: a fixed-dice run must produce exactly what the kept record says.
 *
 * Each run plays multi-season.mjs with RECORD (recorder.mjs) and compares the result with tools/harness/records/<name>.json:
 * every message (what, when, from whom, what it said, how it ended), every game ours and the league's (score and box),
 * the standings, every player and our club at each season's end.
 *
 *   node tools/harness/check-record.mjs [name …]            compare (all runs when none named)
 *   node tools/harness/check-record.mjs --update [name …]   write the kept record (only for a change meant to change it)
 *
 * A release meant to change nothing must pass unchanged. A release meant to change messages or games updates the record
 * in the same commit, and says what changed and why.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEPT = join(HERE, 'records');

// The runs: a contender over two seasons and the winter between, the GM answering everything; an ember club's
// season in the south, the GM answering roster and trade messages only (the rest run to their deadlines).
export const RUNS = {
  'contender-2': { args: ['2', '1'], env: { ARCH: 'contender', GM: 'all', REGION: 'north' } },
  'ember-1':     { args: ['1', '2'], env: { ARCH: 'ember', REGION: 'south' } },
};

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const names = argv.filter(a => !a.startsWith('--'));
const todo = names.length ? names : Object.keys(RUNS);
for (const n of todo) if (!RUNS[n]) { console.error(`unknown run: ${n} (${Object.keys(RUNS).join(', ')})`); process.exit(2); }

const tmp = mkdtempSync(join(tmpdir(), 'tfo-record-'));
function play(name) {
  const out = join(tmp, `${name}.json`);
  const { args, env } = RUNS[name];
  return new Promise((done) => {
    const p = spawn(process.execPath, [join(HERE, 'multi-season.mjs'), ...args], {
      env: { ...process.env, ...env, TZ: 'America/New_York', RECORD: out, VERBOSE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', d => { log += d; }); p.stderr.on('data', d => { log += d; });
    p.on('close', code => done({ name, code, out, log }));
  });
}

/** The differences between two records, as readable lines (at most `max`). */
export function differences(kept, now, max = 25) {
  const lines = [];
  const add = (s) => { if (lines.length < max) lines.push(s); else if (lines.length === max) lines.push('…'); };
  const km = new Map(kept.messages.map(m => [m.id, m])), nm = new Map(now.messages.map(m => [m.id, m]));
  if (kept.messages.length !== now.messages.length) add(`messages: ${kept.messages.length} kept, ${now.messages.length} now`);
  for (const [id, k] of km) {
    const n = nm.get(id);
    if (!n) { add(`message gone: ${k.card} “${k.subject}” (${id})`); continue; }
    const a = JSON.stringify(k), b = JSON.stringify(n);
    if (a !== b) {
      const keys = [...new Set([...Object.keys(k), ...Object.keys(n)])].filter(x => JSON.stringify(k[x]) !== JSON.stringify(n[x]));
      add(`message ${k.card} “${k.subject}”: ${keys.map(x => `${x} ${JSON.stringify(k[x])} → ${JSON.stringify(n[x])}`).join('; ')}`);
    }
  }
  for (const [id, n] of nm) if (!km.has(id)) add(`message new: ${n.card} “${n.subject}” (${id})`);
  if (kept.seasons.length !== now.seasons.length) add(`seasons: ${kept.seasons.length} kept, ${now.seasons.length} now`);
  kept.seasons.forEach((ks, i) => {
    const ns = now.seasons[i]; if (!ns) return;
    for (const part of ['ours', 'league']) {
      if (ks[part].length !== ns[part].length) add(`season ${ks.season} ${part} games: ${ks[part].length} kept, ${ns[part].length} now`);
      ks[part].forEach((g, j) => { const h = ns[part][j]; if (JSON.stringify(g) !== JSON.stringify(h)) add(`season ${ks.season} ${part} game ${g.id} (${g.date}): ${JSON.stringify(g)} → ${JSON.stringify(h)}`); });
    }
    if (JSON.stringify(ks.standings) !== JSON.stringify(ns.standings)) add(`season ${ks.season} standings differ`);
    if (ks.club !== ns.club) add(`season ${ks.season} our club differs`);
    const pk = Object.keys(ks.players).filter(id => ks.players[id] !== ns.players[id]);
    const pn = Object.keys(ns.players).filter(id => !(id in ks.players));
    if (pk.length || pn.length) add(`season ${ks.season} players differ: ${pk.length} changed or gone, ${pn.length} new (${[...pk, ...pn].slice(0, 5).join(', ')})`);
    if (ks.phase !== ns.phase) add(`season ${ks.season} ends in ${ks.phase} kept, ${ns.phase} now`);
  });
  return lines;
}

const results = await Promise.all(todo.map(play));
let bad = 0;
for (const r of results) {
  if (r.code !== 0 || !existsSync(r.out)) {
    bad++; console.log(`\x1b[31mFAIL\x1b[0m  ${r.name}: the run failed (exit ${r.code})\n${r.log.split('\n').filter(l => /FAIL|Error|at /.test(l)).slice(0, 12).join('\n')}`);
    continue;
  }
  const now = JSON.parse(readFileSync(r.out, 'utf8'));
  const keptPath = join(KEPT, `${r.name}.json`);
  if (update) {
    mkdirSync(KEPT, { recursive: true });
    writeFileSync(keptPath, JSON.stringify(now, null, 0).replace(/\},\{"id"/g, '},\n{"id"'));
    console.log(`kept: ${r.name} — ${now.messages.length} messages, ${now.seasons.map(s => s.ours.length + s.league.length).join('+')} games → ${keptPath}`);
    continue;
  }
  if (!existsSync(keptPath)) { bad++; console.log(`\x1b[31mFAIL\x1b[0m  ${r.name}: no kept record (run with --update)`); continue; }
  const kept = JSON.parse(readFileSync(keptPath, 'utf8'));
  const diff = differences(kept, now);
  if (diff.length) { bad++; console.log(`\x1b[31mFAIL\x1b[0m  ${r.name}: differs from the kept record\n  ${diff.join('\n  ')}`); }
  else console.log(`\x1b[32mPASS\x1b[0m  ${r.name}: the same as the kept record (${now.messages.length} messages, ${now.seasons.map(s => s.ours.length + s.league.length).join('+')} games)`);
}
console.log(`\n${results.length - bad}/${results.length} runs ${update ? 'kept' : 'match'}`);
process.exit(bad ? 1 : 0);
