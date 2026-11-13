// r158 Every message in the written library reads right for who sent it (§122.30): the rules are in
// voice-rules.mjs (sim-season.js applies the same rules to every message a real season delivers).
//   node tools/harness/check-message-voice.mjs
import { voiceProblems, RULE_NAMES } from './voice-rules.mjs';
let ok = true, n = 0;
const check = (name, cond, info = '') => { n++; ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const files = ['cards-moments.js', 'cards-money.js', 'cards-pool.js'];
const cards = [];
for (const f of files) {
  const m = await import(new URL(`../../data/${f}`, import.meta.url));
  const seen = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      if (x.id && x.body) { if (!seen.has(x.id)) { seen.add(x.id); cards.push({ f, ...x }); } }
      else Object.values(x).forEach(walk);
    }
  };
  for (const [k, v] of Object.entries(m)) if (k !== 'default') walk(v);
}
// A variant body (NarrativeEngine.selectCardVariant) is the same message in another situation: checked too.
for (const c of [...cards]) (c.variants || []).forEach((v, i) => v.body && cards.push({ ...c, id: `${c.id}#variant${i + 1}`, body: v.body, variants: null }));
const live = cards.filter(c => !c._retired);
console.log(`  ${live.length} live messages (${cards.length - live.length} retired, not checked)`);

// A person signs as their name token, maybe with a role ("{manager_name} (Manager)"); "{x_name}'s agent" is the agent.
const personOf = (sender) => {
  const tok = (String(sender).match(/^(\{\w+_name\})(\s*\(.+\))?$/) || [])[1] || null;
  return tok === '{owner_name}' ? { name: tok, owner: true } : tok;
};
const bad = {};
for (const c of live) for (const [rule, f] of voiceProblems(c, personOf)) (bad[rule] ||= []).push(`${c.id}${f ? '.' + f : ''}`);
for (const [rule, name] of Object.entries(RULE_NAMES)) check(name, !bad[rule], (bad[rule] || []).join(', '));
const relayed = live.filter(c => c.relay).length;
check(`a mix of voices: some relayed, most direct (${relayed} relayed of ${live.length})`, relayed >= 8 && relayed <= live.length * 0.35);
console.log(`\n${ok ? `${n} passed` : 'FAILED'}`);
process.exit(ok ? 0 : 1);
