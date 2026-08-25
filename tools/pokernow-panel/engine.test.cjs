// Node sanity tests for the PokerNow Panel engine:
//   node tools/pokernow-panel/engine.test.cjs
// The userscript is loaded in a bare VM context (no document/window), so only
// the engine half of the file executes.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'pokernow-panel.user.js'), 'utf8');
const mod = { exports: {} };
vm.runInNewContext(src, { module: mod, exports: mod.exports, console });
const E = mod.exports;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
const H = (s) => s.trim().split(/\s+/).map((x) => {
  const c = E.parseCard(x);
  if (c < 0) throw new Error('bad card ' + x);
  return c;
});
const ev = (s) => E.evaluate(H(s));
const nameOf = (s) => E.handName(ev(s));

console.log('parsing');
ok('10d parses', E.cardStr(E.parseCard('10d')) === 'Td');
ok('unicode suit parses', E.cardStr(E.parseCard('K♥')) === 'Kh');
ok('rejects junk', E.parseCard('Zx') === -1);

console.log('hand naming');
ok('royal flush', nameOf('Ah Kh Qh Jh Th 2c 3d') === 'Royal Flush', nameOf('Ah Kh Qh Jh Th 2c 3d'));
ok('straight flush', nameOf('9h 8h 7h 6h 5h Ac Kd') === 'Straight Flush');
ok('quads', nameOf('9h 9s 9d 9c 5h Ac Kd') === 'Four of a Kind');
ok('full house', nameOf('9h 9s 9d 5c 5h Ac Kd') === 'Full House');
ok('full house from two trips', nameOf('9h 9s 9d 5c 5h 5d Kd') === 'Full House');
ok('flush', nameOf('Ah 9h 7h 4h 2h Kc Qd') === 'Flush');
ok('straight', nameOf('9h 8s 7d 6c 5h Ac Kd') === 'Straight');
ok('wheel straight', nameOf('Ah 2s 3d 4c 5h 9d Kd') === 'Straight');
ok('no wrap-around straight', nameOf('Qh Kh As 2d 3c 7h 9s') !== 'Straight', nameOf('Qh Kh As 2d 3c 7h 9s'));
ok('trips', nameOf('9h 9s 9d 5c 2h Ac Kd') === 'Three of a Kind');
ok('two pair', nameOf('9h 9s 5d 5c 2h Ac Kd') === 'Two Pair');
ok('one pair', nameOf('9h 9s 5d 3c 2h 7c Kd') === 'One Pair');
ok('high card', nameOf('9h 7s 5d 3c 2h Jc Kd') === 'High Card');

console.log('ordering');
ok('flush beats straight', ev('Ah 9h 7h 4h 2h Kc Qd') > ev('9h 8s 7d 6c 5h Ac Kd'));
ok('boat beats flush', ev('9h 9s 9d 5c 5h Ah 2h') > ev('Ah 9h 7h 4h 2h Kc Qd'));
ok('higher kicker wins', ev('Ah As Kd 7c 2h 9s 3d') > ev('Ah As Qd 7c 2h 9s 3d'));
ok('ace-high straight > wheel', ev('Ah Ks Qd Jc Th 2s 3d') > ev('Ah 2s 3d 4c 5h 9d Kd'));
ok('best 5 of 7 used', ev('Ah As Ad Ac Kh 2s 3d') === ev('Ah As Ad Ac Kh 7s 8d'));

console.log('draws & outs');
const fd = E.drawInfo(H('Ah Kh'), H('2h 7h 9c'));
ok('flush draw detected', fd.flushDraw === true);
const oe = E.drawInfo(H('9h 8s'), H('7d 6c 2s'));
ok('open-ender detected', oe.oesd === true);
const gs = E.drawInfo(H('9h 5s'), H('7d 6c 2s'));
ok('gutshot detected', gs.gutshot === true && gs.oesd === false);
const outs = E.improvementOuts(H('Ah Kh'), H('2h 7h 9c'));
ok('flush outs counted (>=9)', outs.count >= 9, 'got ' + outs.count);

console.log('board texture');
const tx = E.boardTexture(H('Kc Kd Kh'));
ok('trips board flagged', tx.trips === true && tx.paired === false);
ok('flush board flagged', E.boardTexture(H('2h 7h 9h')).flushPossible === true);
ok('straight board flagged', E.boardTexture(H('5c 6d 7h')).straightPossible === true);

console.log('monte carlo (tolerance ±2%)');
const near = (a, b, t) => Math.abs(a - b) <= t;
const aa = E.simulate(H('Ah As'), [], 1, 40000);
ok('AA heads-up ~85.2%', near(aa.equity, 0.852, 0.02), 'got ' + (aa.equity * 100).toFixed(1) + '%');
const s72 = E.simulate(H('7c 2d'), [], 1, 40000);
ok('72o heads-up ~35%', near(s72.equity, 0.352, 0.02), 'got ' + (s72.equity * 100).toFixed(1) + '%');
const aks = E.simulate(H('Ah Kh'), [], 5, 30000);
ok('AKs 6-way ~29%', near(aks.equity, 0.29, 0.03), 'got ' + (aks.equity * 100).toFixed(1) + '%');
const nuts = E.simulate(H('Ah Kh'), H('Qh Jh Th'), 2, 5000);
ok('river-proof nuts = 100%', nuts.equity === 1);
const dead = E.simulate(H('2c 3d'), H('Ah Kh Qh Jh Th'), 1, 5000);
ok('playing the board splits often', dead.tie > 0.5, 'tie ' + dead.tie.toFixed(2));
const cats = E.simulate(H('3c 8h'), H('Kc Kd Kh'), 5, 30000);
const catSum = cats.cats.reduce((a, b) => a + b, 0);
ok('category distribution sums to 1', near(catSum, 1, 1e-6));
ok('trips-on-board => trips or better', cats.cats[3] + cats.cats[6] + cats.cats[7] > 0.95,
  'trips ' + cats.cats[3].toFixed(3) + ' boat ' + cats.cats[6].toFixed(3));

console.log('preflop score');
ok('AA = 20', E.chenScore(H('Ah As')) === 20);
ok('AKs = 12', E.chenScore(H('Ah Kh')) === 12);
ok('72o = -1.5', E.chenScore(H('7c 2d')) === -1.5, 'got ' + E.chenScore(H('7c 2d')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
