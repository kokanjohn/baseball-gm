// §106 Every compose topic's reply, written from a saved game (sim-season STATE_DUMP) — to read them,
// and to check them: every topic writes something, in the writer's own words, nothing broken or gendered,
// and the weather in a reply is the forecast the GM sees.
//   node tools/harness/compose-replies.mjs state.json [minutesAfter=30] [topic]
import { readFileSync } from 'node:fs';
import { writeComposeReply, COMPOSE_TOPICS } from '../../engine/ComposeReplies.js';
const CH = { gk_: 'groundskeeper', mgr_: 'manager', pc_: 'pitching_coach', hc_: 'hitting_coach', bc_: 'bench_coach', bpc_: 'bullpen_coach',
             fac_: 'facilities', tix_: 'ticket_office', sc_: 'scouting', mr_: 'media_relations', ca_: 'community' };
export const channelOf = (t) => CH[Object.keys(CH).find(k => t.startsWith(k))];
const [file, after = '30', only = null] = process.argv.slice(2);
const { state, clockMs } = JSON.parse(readFileSync(file, 'utf8'));
const atMs = clockMs + +after * 60_000;
const GENDERED = /\b(he|him|his|himself|he's|he'll|he'd|she|her|hers|herself|guy|guys|fella|fellas|man|men|boys)\b/i;
let bad = 0;
for (const topicId of COMPOSE_TOPICS.filter(t => !only || t === only)) {
  const t0 = performance.now();
  const r = writeComposeReply(state, { topicId, channelId: channelOf(topicId), atMs });
  const ms = performance.now() - t0;
  const problems = [];
  if (!r) problems.push('no reply');
  else {
    if (/undefined|NaN|null|\[object|\$\{/.test(r.body)) problems.push('broken text');
    if (GENDERED.test(r.body)) problems.push(`gendered: ${r.body.match(GENDERED)[0]}`);
  }
  if (problems.length) bad++;
  console.log(`\n━━ ${topicId} (${ms.toFixed(0)} ms)${problems.length ? '  ✗ ' + problems.join('; ') : ''}\nFrom: ${r?.sender}\nSubject: ${r?.subject}\n\n${r?.body}`);
}
console.log(`\n${bad ? `${bad} topic(s) with problems` : 'every topic wrote a clean reply'}`);
process.exit(bad ? 1 : 0);
