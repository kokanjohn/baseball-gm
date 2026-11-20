/**
 * tools/harness/audit-messages.mjs — r214 §122.92 The message audit: how many messages, and how many that want
 * an answer, arrive per waking day (8am–10pm), by the kind of day.
 *
 *   AUDIT=/tmp/a.json node tools/harness/multi-season.mjs 2 1     (writes every message and each season's schedule)
 *   node tools/harness/audit-messages.mjs /tmp/a.json [/tmp/b.json …] [--md out.md]
 *
 * Kinds of day: the first three days of a new team; spring (home / road); regular season home, road, rainout
 * (our game called off that day), off day; the stretch (the last 30 days of the regular season, game days);
 * postseason; offseason. For each: days, messages a day, decisions a day, the share of days with no decision,
 * the longest wait between messages in waking hours, and where the messages come from.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mdAt = args.indexOf('--md');
const md = mdAt >= 0 ? args[mdAt + 1] : null;
const files = args.filter((a, i) => a !== '--md' && i !== mdAt + 1);
const DAY = 86_400_000;
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const at = (key, h) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, h, 0, 0, 0).getTime(); };
const hour = (ms) => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; };

/** Where a message comes from, roughly: the pool it was drawn from, or the system that wrote it. */
function catOf(c) {
  if (c.emergency) return 'emergency';
  if (c.firstDay) return c.gm ? 'GM hello' : 'first day';
  if (c.gm) return 'GM hello';
  if (c.compose) return 'compose reply';
  if (c.pool) return { PREGAME_POOL: 'pregame', INGAME_POOL: 'in-game', BETWEEN_GAMES_POOL: 'between games', DECISIONS_POOL: 'decisions pool', PERSONAL_LEAVE_POOL: 'personal leave' }[c.pool] || c.pool;
  const id = c.cardId || '';
  if (/^(wx_|field_|crew)/.test(id) || /Groundskeeper/.test(c.sender || '')) return 'weather';
  if (/^(trade|talk|lt_|fa_|watch|agent)/.test(id) || /front office/.test(c.sender || '')) return 'trades & market';
  if (/^(os_|fo_)/.test(id)) return 'offseason';
  if (/^(owner|fin_)/.test(id)) return 'owner & money';
  if (/^(injury|il_|rest|lineup|bats|open_spots|advice|manager_|dev_|work|teach)/.test(id)) return 'roster & health';
  if (/^(mo_|as_)/.test(id)) return 'moments';
  return 'other';
}

const rows = {};   // kind → [{ msgs, decs, wait, senders }]
const families = {};
const add = (kind, rec) => { (rows[kind] ||= []).push(rec); };

for (const f of files) {
  const A = JSON.parse(readFileSync(f, 'utf8'));
  const cards = A.cards.filter(c => Number.isFinite(c.at)).sort((a, b) => a.at - b.at);
  // Every day from the team's start to the last message.
  const first = A.createdAt, last = cards[cards.length - 1]?.at || first;
  // Our games, every season: by day.
  const games = new Map();   // dayKey → { kind, home, stretch }
  for (const [, sched] of Object.entries(A.schedules)) {
    const reg = sched.filter(g => !g.isSpring && !g.isPlayoff);
    const lastReg = Math.max(...reg.map(g => g.gameTime));
    for (const g of sched) {
      const k = dayKey(g.gameTime);
      const kind = g.isPlayoff ? 'postseason' : g.isSpring ? (g.isHome ? 'spring_home' : 'spring_road') : g.isHome ? 'home' : 'road';
      if (!games.has(k)) games.set(k, { kind, stretch: !g.isSpring && !g.isPlayoff && lastReg - g.gameTime < 30 * DAY });
      for (const p of g.postponed || []) games.set(dayKey(p), { kind: 'rainout', stretch: lastReg - p < 30 * DAY });
    }
  }
  const seasons = Object.values(A.schedules).map(s => [Math.min(...s.map(g => g.gameTime)), Math.max(...s.map(g => g.gameTime))]);
  for (let t = first; t <= last + DAY; t += DAY) {
    const k = dayKey(t);
    const from = Math.max(at(k, 8), first), to = at(k, 22);
    if (to <= from) continue;
    const day = cards.filter(c => dayKey(c.at) === k && !c.seed);
    const waking = day.filter(c => hour(c.at) >= 8 && hour(c.at) < 22);
    const decs = day.filter(c => c.decision).length;
    // The longest wait between messages in waking hours (from 8am, or the start, to 10pm).
    const pts = [from, ...waking.map(c => c.at).filter(x => x >= from && x <= to), to];
    let wait = 0; for (let i = 1; i < pts.length; i++) wait = Math.max(wait, pts[i] - pts[i - 1]);
    const g = games.get(k);
    const inSeason = seasons.some(([a, b]) => t >= a - DAY && t <= b + DAY);
    const kind = t - first < 3 * DAY ? 'first3' : g ? g.kind : inSeason ? 'off' : 'offseason';
    const rec = { msgs: day.length, decs, wait: wait / 3_600_000, senders: day.map(c => c.sender), ids: day.map(c => c.cardId) };
    add(kind, rec);
    if (g?.stretch && g.kind !== 'rainout') add('stretch', rec);
    for (const c of day.filter(x => x.decision)) { const cat = catOf(c); (families[kind] ||= {})[cat] = (families[kind][cat] || 0) + 1; if (g?.stretch && g.kind !== 'rainout') (families.stretch ||= {})[cat] = (families.stretch[cat] || 0) + 1; }
  }
}

const ORDER = ['first3', 'spring_home', 'spring_road', 'home', 'road', 'rainout', 'off', 'stretch', 'postseason', 'offseason'];
const LABEL = { first3: 'First 3 days', spring_home: 'Spring, home', spring_road: 'Spring, road', home: 'Season, home game', road: 'Season, road game',
  rainout: 'Our game called off', off: 'Off day (in season)', stretch: 'Stretch run (last 30 days)', postseason: 'Postseason', offseason: 'Offseason' };
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const lines = [];
lines.push('| Kind of day | Days | Messages a day | Decisions a day | Days with no decision | Longest quiet stretch (median) | Most from |');
lines.push('|---|---|---|---|---|---|---|');
for (const k of ORDER) {
  const r = rows[k]; if (!r?.length) continue;
  const top = {}; for (const x of r) for (const s of x.senders) top[s] = (top[s] || 0) + 1;
  const most = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s} (${(n / r.length).toFixed(1)})`).join(', ');
  lines.push(`| ${LABEL[k]} | ${r.length} | ${avg(r.map(x => x.msgs)).toFixed(1)} | ${avg(r.map(x => x.decs)).toFixed(1)} | ${Math.round(r.filter(x => !x.decs).length / r.length * 100)}% | ${med(r.map(x => x.wait)).toFixed(1)}h | ${most} |`);
}
lines.push('');
lines.push('Decisions a day, by where they come from:');
lines.push('');
const cats = [...new Set(Object.values(families).flatMap(o => Object.keys(o)))].sort();
lines.push(`| Kind of day | ${cats.join(' | ')} |`);
lines.push(`|---|${cats.map(() => '---').join('|')}|`);
for (const k of ORDER) {
  const r = rows[k]; if (!r?.length) continue;
  lines.push(`| ${LABEL[k]} | ${cats.map(c => ((families[k]?.[c] || 0) / r.length).toFixed(2).replace(/^0\.00$/, '·')).join(' | ')} |`);
}
const out = lines.join('\n');
console.log(out);
if (md) writeFileSync(md, out + '\n');
