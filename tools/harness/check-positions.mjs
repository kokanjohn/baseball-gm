// r163 §122.35 phase 1 — Positions: one answer to "where can this player play?". The same answers the
// old labels gave (every label, old saves without a positions record), every new player carries the
// record, and the label everyone reads is unchanged.
//   node tools/harness/check-positions.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as Pos from '../../engine/Positions.js';
import { eligibleSlotsFor } from '../../engine/RosterEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

// The rule before r163 (RosterEngine.eligibleSlotsFor), kept here as the reference.
function oldSlots(nat) {
  switch (nat) {
    case 'C': return ['C', 'DH']; case '1B': return ['1B', 'DH']; case '2B': return ['2B', 'DH'];
    case '3B': return ['3B', 'DH']; case 'SS': return ['SS', 'DH']; case 'OF': return ['OF', 'DH'];
    case 'DH': return ['DH']; case 'DH/OF': return ['OF', 'DH']; case '2B/SS': return ['2B', 'SS', 'DH'];
    case '1B/3B': return ['1B', '3B', 'DH']; case 'SS/OF': return ['SS', 'OF', 'DH']; case '1B/OF': return ['1B', 'OF', 'DH'];
    default: return nat.includes('/') ? [...new Set([...nat.split('/'), 'DH'])] : nat ? [nat, 'DH'] : ['DH'];
  }
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

console.log('Every label reads as it did (a save from before r163: no positions record)');
const LABELS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'DH', 'DH/OF', '2B/SS', '1B/3B', 'SS/OF', '1B/OF', '2B/3B', 'C/1B'];
for (const lab of LABELS) {
  const p = { pos: lab, nativePos: lab };
  check(`${lab}: slots ${eligibleSlotsFor(p).join(',')} · label "${Pos.posLabel(p)}"`, same(eligibleSlotsFor(p), oldSlots(lab)) && Pos.posLabel(p) === lab);
}
for (const r of ['SP', 'RP']) {
  const p = { pos: r, nativePos: r };
  check(`${r}: no lineup slots, roles [${Pos.pitchRoles(p)}], label "${Pos.posLabel(p)}", stretched ${Pos.stretchOf(p)}`,
        eligibleSlotsFor(p).length === 0 && same(Pos.pitchRoles(p), [r]) && Pos.posLabel(p) === r && Pos.stretchOf(p) === (r === 'SP' ? 3 : 0));
}

console.log('The record and the label agree');
for (const lab of LABELS) {
  const legacy = { pos: lab, nativePos: lab };
  const seeded = { ...legacy, positions: Pos.seedPositions(legacy) };
  check(`${lab}: seeded the same as read`, same(eligibleSlotsFor(seeded), eligibleSlotsFor(legacy)) && Pos.posLabel(seeded) === lab && Pos.primaryPos(seeded) === Pos.primaryPos(legacy));
}
{
  const p = { pos: '2B', nativePos: '2B', positions: { primary: '2B', elig: ['2B', '3B'], fam: {} } };
  check('a record that differs from the label wins (2B, now eligible at 3B too)', Pos.canPlay(p, '3B') && Pos.posLabel(p) === '2B/3B' && eligibleSlotsFor(p).includes('3B'));
  const dh = { pos: 'DH', nativePos: 'DH' }, of = { pos: 'OF', nativePos: 'OF' };
  check('a pure DH covers DH only; any hitter can DH', !Pos.canPlay(dh, '1B') && Pos.canPlay(dh, 'DH') && Pos.canPlay(of, 'DH'));
  check('CF / LF / RF read as OF', Pos.canPlay({ pos: 'CF', nativePos: 'CF' }, 'OF'));
  const rp = { pos: 'RP', nativePos: 'RP' };
  Pos.setPitchRole(rp, 'SP');
  check('a staff card\'s role swap moves the label and the designation together', rp.pos === 'SP' && same(Pos.pitchRoles(rp), ['SP']) && Pos.stretchOf(rp) === 3);
}

console.log('A new league: every player carries the record');
seedRandom(71);
clock.set(Date.UTC(2026, 10, 13, 15));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const all = Object.values(SM.get().players);
const missing = all.filter(p => !p.positions);
check(`${all.length} players, every one with a positions record`, missing.length === 0, missing.slice(0, 3).map(p => p.name).join(', '));
const differ = all.filter(p => p.positions && Pos.posLabel(p) !== (p.nativePos || p.pos));
check('…each one\'s label the same as before', differ.length === 0, differ.slice(0, 3).map(p => `${p.name} ${p.nativePos} → ${Pos.posLabel(p)}`).join(', '));
const u = SM.get().userTeam;
const ok = u.lineupSlots.every(sl => !sl.playerId || sl.emergency || Pos.canPlay(SM.get().players[sl.playerId], sl.slot));
check('our lineup: everyone in a spot they can play', ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
