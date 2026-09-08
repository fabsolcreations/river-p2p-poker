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

console.log('log parsing');
const LOG = [
  `-- starting hand #1  (No Limit Texas Hold'em) (dealer: "Alice @ aaa") --`,
  `Player stacks: #1 "Alice @ aaa" (1000) | #2 "Bob @ bbb" (1000) | #3 "Cara @ ccc" (1000)`,
  `"Bob @ bbb" posts a small blind of 5`,
  `"Cara @ ccc" posts a big blind of 10`,
  `Your hand is A♠, K♦`,
  `"Alice @ aaa" raises to 30`,
  `"Bob @ bbb" folds`,
  `"Cara @ ccc" calls 30`,
  `Flop:  [7♣, 2♦, 9♠]`,
  `"Cara @ ccc" checks`,
  `"Alice @ aaa" bets 40`,
  `"Cara @ ccc" folds`,
  `Uncalled bet of 40 returned to "Alice @ aaa"`,
  `"Alice @ aaa" collected 65 from pot`,
  `-- ending hand #1 --`,
  `-- starting hand #2  (No Limit Texas Hold'em) (dealer: "Bob @ bbb") --`,
  `Player stacks: #1 "Alice @ aaa" (1035) | #2 "Bob @ bbb" (995) | #3 "Cara @ ccc" (970)`,
  `"Cara @ ccc" posts a small blind of 5`,
  `"Alice @ aaa" posts a big blind of 10`,
  `Your hand is 5♥, 5♣`,
  `"Bob @ bbb" calls 10`,
  `"Cara @ ccc" calls 10`,
  `"Alice @ aaa" checks`,
  `Flop:  [5♦, K♠, 2♣]`,
  `"Cara @ ccc" checks`,
  `"Alice @ aaa" bets 20`,
  `"Bob @ bbb" calls 20`,
  `"Cara @ ccc" folds`,
  `Turn: 5♦, K♠, 2♣ [Qh]`,
  `"Alice @ aaa" checks`,
  `"Bob @ bbb" checks`,
  `River: 5♦, K♠, 2♣, Qh [3s]`,
  `"Alice @ aaa" bets 30`,
  `"Bob @ bbb" calls 30 and go all in`,
  `"Bob @ bbb" shows a K♥, K♣.`,
  `"Alice @ aaa" shows a 5♥, 5♣.`,
  `"Alice @ aaa" collected 130 from pot with Three of a Kind`,
  `-- ending hand #2 --`,
];

const P = (s) => E.parseLogLine(s);
ok('hand-start parsed with dealer', (() => {
  const e = P(LOG[0]);
  return e.type === 'hand-start' && e.hand === 1 && e.dealer.name === 'Alice' && e.dealer.id === 'aaa';
})());
ok('player stacks parsed', (() => {
  const e = P(LOG[1]);
  return e.type === 'stacks' && e.players.length === 3 && e.players[0].stack === 1000 && e.players[2].name === 'Cara';
})());
ok('name containing " @ " splits on the last one',
  E.splitPlayer('a @ b @ zzz').name === 'a @ b' && E.splitPlayer('a @ b @ zzz').id === 'zzz');
ok('blind post parsed', P(LOG[2]).type === 'post' && P(LOG[2]).blind === 'sb' && P(LOG[2]).amount === 5);
ok('hero cards parsed from unicode suits',
  P(LOG[4]).cards.map(E.cardStr).join(' ') === 'As Kd', P(LOG[4]).cards.map(E.cardStr).join(' '));
ok('raise-to parsed', P(LOG[5]).action === 'raise' && P(LOG[5]).amount === 30);
ok('fold parsed', P(LOG[6]).action === 'fold');
ok('flop parsed', P(LOG[8]).street === 'flop' && P(LOG[8]).cards.length === 3);
ok('turn takes only the bracketed card', (() => {
  const e = P(LOG[28]);
  return e.street === 'turn' && e.cards.length === 1 && E.cardStr(e.cards[0]) === 'Qh';
})());
ok('all-in call flagged', P(LOG[33]).action === 'call' && P(LOG[33]).allIn === true);
ok('showdown cards parsed',
  P(LOG[34]).type === 'show' && P(LOG[34]).cards.map(E.cardStr).join(' ') === 'Kh Kc');
ok('collect parsed with hand name',
  P(LOG[36]).type === 'collect' && P(LOG[36]).amount === 130 && P(LOG[36]).hand === 'Three of a Kind');
ok('uncalled bet parsed', P(LOG[12]).type === 'uncalled' && P(LOG[12]).amount === 40);
ok('unrecognised line kept, not dropped', (() => {
  const e = P('"Zed @ zzz" invented a new verb');
  return e.type === 'unknown' && e.line.includes('invented');
})());
ok('blank line ignored', P('   ') === null);

console.log('hand replay');
const hands = E.replay(LOG.map(P));
ok('two hands reconstructed', hands.length === 2, 'got ' + hands.length);
ok('hand 1 pot nets out the uncalled bet', hands[0].pot === 65, 'got ' + hands[0].pot);
ok('hand 2 pot totals 130', hands[1].pot === 130, 'got ' + hands[1].pot);
ok('raise-to is a street total, not additive', hands[0].contributions.aaa === 30,
  'got ' + hands[0].contributions.aaa);
ok('bet is additive on a fresh street', hands[1].contributions.aaa === 60,
  'got ' + hands[1].contributions.aaa);
ok('board runs out to five cards',
  hands[1].board.map(E.cardStr).join(' ') === '5d Ks 2c Qh 3s', hands[1].board.map(E.cardStr).join(' '));
ok('hero cards captured per hand', hands[1].hero.map(E.cardStr).join(' ') === '5h 5c');
ok('winner captured', hands[1].winners.length === 1 && hands[1].winners[0].id === 'aaa');
ok('folds recorded', hands[0].players.bbb.folded === true);
ok('shown hands recorded', Object.keys(hands[1].shown).length === 2);
ok('closed hands are marked complete', hands[0].complete === true && hands[1].complete === true);
ok('a hand with no ending line is not complete', (() => {
  const partial = E.replay(LOG.slice(0, 8).map(P));
  return partial.length === 1 && partial[0].complete === false;
})());
for (const h of hands) {
  const paid = Object.values(h.contributions).reduce((a, b) => a + b, 0);
  const won = h.winners.reduce((a, w) => a + w.amount, 0);
  ok('hand #' + h.hand + ' books balance (' + paid + ' in / ' + won + ' out)', paid === won,
    'in ' + paid + ' out ' + won);
}

console.log('player stats');
const stats = E.accumulate(hands);
const A = E.statView(stats.aaa), B = E.statView(stats.bbb), C = E.statView(stats.ccc);
ok('alice dealt into both hands', A.hands === 2);
ok('checking the big blind is not VPIP', A.vpipPct === 50, 'got ' + A.vpipPct);
ok('alice pfr 50%', A.pfrPct === 50, 'got ' + A.pfrPct);
ok('bob vpip 50% (folded hand 1)', B.vpipPct === 50, 'got ' + B.vpipPct);
ok('nobody but alice raised preflop', B.pfrPct === 0 && C.pfrPct === 0);
ok('never-called player reads as infinitely aggressive, not as no data',
  A.af === Infinity, 'got ' + A.af);
ok('aggression factor is a ratio when there are calls',
  E.statView({ hands: 4, vpip: 2, pfr: 1, bets: 2, raises: 1, calls: 2 }).af === 1.5);
ok('a passive player with no action at all reports null',
  E.statView({ hands: 4, vpip: 0, pfr: 0, bets: 0, raises: 0, calls: 0 }).af === null);
ok('showdowns counted', B.showdowns === 1 && C.showdowns === 0);
ok('net: alice +105', A.net === 105, 'got ' + A.net);
ok('net: bob -65', B.net === -65, 'got ' + B.net);
ok('net across the table sums to zero', A.net + B.net + C.net === 0);
ok('a player with no hands reports null, not 0%',
  E.statView({ hands: 0, vpip: 0, pfr: 0, calls: 0, bets: 0, raises: 0 }).vpipPct === null);
ok('stats accumulate across calls', (() => {
  const acc = {};
  E.accumulate([hands[0]], acc);
  E.accumulate([hands[1]], acc);
  return acc.aaa.hands === 2 && acc.aaa.net === 105;
})());

console.log('advice');
const adv = (o) => E.advise(Object.assign({
  hero: H('Ah Kh'), board: [], pot: 100, toCall: 0, opponents: 1,
  seats: 6, bigBlind: 10, position: 'BTN', spr: 5, sim: null, outs: null,
}, o), 'NORMAL');
ok('premium preflop opens', adv({}).action === 'RAISE');
ok('trash preflop folds to a raise', adv({ hero: H('7c 2d'), toCall: 40 }).action === 'FOLD');
ok('bad price folds',
  adv({ board: H('2c 7d 9s'), toCall: 200, sim: { equity: 0.15 } }).action === 'FOLD');
ok('good price calls',
  adv({ board: H('2c 7d 9s'), toCall: 20, sim: { equity: 0.45 } }).action === 'CALL');
ok('nuts value bets',
  adv({ hero: H('Qh Jh'), board: H('Th 9h 8h'), toCall: 0, sim: { equity: 0.95 } }).action === 'BET');
ok('paired board warns',
  adv({ board: H('Kc Kd 2h'), sim: { equity: 0.5 } }).warns.some((w) => /PAIRED/.test(w)));
ok('playing the board is called out',
  adv({ hero: H('2c 3d'), board: H('Ah Kh Qh Jh Th'), toCall: 0, sim: { equity: 0.2 } })
    .warns.some((w) => /playing the board/i.test(w)));
ok('no equity yet => no recommendation',
  adv({ board: H('2c 7d 9s'), sim: null }).action === '—');

console.log('blind levels');
ok('reads the big blind, not the small one', (() => {
  const b = E.parseBlinds('NLH ~ 20 / 40');
  return b.sb === 20 && b.bb === 40;
})(), JSON.stringify(E.parseBlinds('NLH ~ 20 / 40')));
ok('ignores the level that has not started', E.parseBlinds('NEXT BLIND: 40/80 IN 00:42') === null);
ok('handles thousands separators', E.parseBlinds('1,000 / 2,000').bb === 2000);
ok('a lone number is treated as the big blind', E.parseBlinds('BB 50').bb === 50);
ok('no digits => nothing', E.parseBlinds('No Limit Hold’em') === null);
ok('zero is not a blind level', E.parseBlinds('0 / 0') === null);

console.log('equity against face-up cards');
const eq = (h, b, opps, unknown, sims) => E.equityVsKnown(H(h), b ? H(b) : [], opps.map(H), unknown || 0, sims);

ok('made royal is unbeatable and enumerated exactly', (() => {
  const r = eq('Ah Kh', 'Qh Jh Th 2c', ['Ac Kc']);
  return r.exact === true && r.equity === 1;
})());
ok('aces over kings on a blank turn: 42 of 44 runouts', (() => {
  const r = eq('As Ad', '2c 7d 9h 3s', ['Ks Kd']);
  return r.exact === true && r.trials === 44 && Math.abs(r.equity - 42 / 44) < 1e-12;
})(), JSON.stringify(eq('As Ad', '2c 7d 9h 3s', ['Ks Kd'])));
ok('identical straights split the pot', (() => {
  const r = eq('As Ks', 'Qc Jd Ts 2h 3c', ['Ah Kh']);
  return r.exact === true && r.trials === 1 && r.tie === 1 && r.equity === 0.5;
})());
ok('a completed board needs no runout', eq('As Ks', 'Qc Jd Ts 2h 3c', ['Ah Kh']).trials === 1);
ok('three-way equities sum to one', (() => {
  const board = '9h 8h 2c 3d';
  const a = eq('Ah Kh', board, ['9c 9d', '7s 6s']);
  const b = eq('9c 9d', board, ['Ah Kh', '7s 6s']);
  const c = eq('7s 6s', board, ['Ah Kh', '9c 9d']);
  return Math.abs(a.equity + b.equity + c.equity - 1) < 1e-9;
})());
ok('flop with two to come is still enumerated', (() => {
  const r = eq('As Ad', 'Kc 7d 2h', ['Qs Qd']);
  return r.exact === true && r.trials === 990;
})(), 'trials ' + eq('As Ad', 'Kc 7d 2h', ['Qs Qd']).trials);
ok('an unknown opponent forces sampling, not enumeration', (() => {
  const r = eq('As Ad', 'Kc 7d 2h', ['Qs Qd'], 1, 3000);
  return r.exact === false && r.trials === 3000;
})());
ok('sampling against one unknown matches the random-hand model', (() => {
  const r = eq('Ah As', '', [], 1, 40000);
  return Math.abs(r.equity - 0.852) <= 0.02;
})(), 'got ' + (eq('Ah As', '', [], 1, 40000).equity * 100).toFixed(1) + '%');
ok('a card dealt twice is refused rather than answered', eq('Ah As', 'Kc 7d 2h', ['Ah Qd']) === null);
ok('no opponents at all returns nothing', eq('Ah As', 'Kc 7d 2h', []) === null);
ok('category distribution still sums to one', (() => {
  const r = eq('As Ad', 'Kc 7d 2h', ['Qs Qd']);
  return Math.abs(r.cats.reduce((a, b) => a + b, 0) - 1) < 1e-9;
})());
// A set over an overpair, worked by hand: 990 two-card runouts, of which 87
// contain an ace (86 single + 1 both). Two of those pair the case king and give
// the set quads, so the overpair wins exactly 85 and the set wins 905.
ok('set over overpair is exactly 905 of 990 runouts', (() => {
  const r = eq('Kc Kd', 'Ks 7d 2h', ['Ah Ad']);
  return r.trials === 990 && Math.round(r.win * r.trials) === 905 && r.tie === 0;
})(), JSON.stringify(eq('Kc Kd', 'Ks 7d 2h', ['Ah Ad']).equity));
ok('combination counts are exact', E.combinationCount(45, 2) === 990 && E.combinationCount(44, 1) === 44
  && E.combinationCount(10, 0) === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
