/**
 * tools/harness/check-refs.mjs
 * Static guard for code the season harness cannot execute (screens need a DOM).
 *
 * Fails when a module CALLS a function that is neither defined in that module
 * nor imported into it — the class of bug where InboxScreen's Yes/No buttons
 * called a non-existent `_resolveCard` and silently did nothing (§62).
 *
 * Checks every `name(` call where `name` is a private helper (leading `_`) or
 * a bare identifier that is imported by name somewhere in the codebase.
 *
 * Usage: node tools/harness/check-refs.mjs
 */

import fs   from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DIRS = ['ui', 'engine', 'store', 'data'];

const files = DIRS.flatMap(function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []);
});

// Remove comments only (block comments and whole-line // comments). String and
// template contents are kept: calls inside `${...}` in templates are real calls.
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function defined(src) {
  const names = new Set();
  for (const m of src.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g))
    for (const part of m[1].split(',')) { const n = part.split(':').pop().split('=')[0].trim(); if (n) names.add(n); }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g))
    for (const part of m[1].split(',')) { const n = part.split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // function parameters and arrow params named _x
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g))
    for (const part of m[1].split(',')) { const n = part.split('=')[0].replace(/[{}\[\]\s.]/g, ''); if (n) names.add(n); }
  return names;
}

const problems = [];
for (const rel of files) {
  const raw  = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // A stray '/**' turns real code into a comment until the next '*/' — this hid
  // App.js's audio setup (_getAudioCtx) for months (§62). Flag any block comment
  // containing a line-start declaration.
  for (const m of raw.matchAll(/\/\*[\s\S]*?\*\//g)) {
    if (/^(?:export\s+)?(?:async\s+)?(?:function\s+\w|let\s+\w+\s*=|const\s+\w+\s*=|var\s+\w+\s*=)/m.test(m[0])) {
      problems.push(`${rel}:${raw.slice(0, m.index).split('\n').length}  block comment hides code (stray '/*' opener?)`);
    }
  }
  const src  = stripNoise(raw);
  const defs = defined(src);
  for (const m of src.matchAll(/(?<![.\w$])(_[A-Za-z][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (defs.has(name)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${rel}:${line}  calls ${name}() — not defined or imported in this module`);
  }
}

if (problems.length) {
  console.log([...new Set(problems)].join('\n'));
  console.log(`\nFAIL  ${problems.length} undefined call(s)`);
  process.exit(1);
}
console.log(`PASS  every private helper call resolves (${files.length} modules)`);
