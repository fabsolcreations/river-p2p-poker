/*
 * Differential test: our engines vs Duel's own shipped verification modules.
 *
 *   node tools/duel-live-verifier/engines.test.cjs
 *
 * It resolves the current asset hashes from duel.com, downloads the fairness
 * chunks into .vendor/ (gitignored), imports them, and asserts our output is
 * identical on random inputs. If Duel changes an algorithm, this fails.
 *
 * Needs network. Without it the vendor comparison is skipped and only the
 * self-contained checks run — the run then reports SKIPPED, not passed.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const VENDOR_DIR = path.join(__dirname, '.vendor');
const ORIGIN = 'https://duel.com';

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, condition, extra) {
  if (condition) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`);
  }
}

function skipped(name, why) {
  skip++;
  console.log(`  skip ${name} — ${why}`);
}

/* ---------------------------------------------------------------- our code */

function loadEngines() {
  const src = fs.readFileSync(path.join(__dirname, 'duel-live-verifier.user.js'), 'utf8');
  const mod = { exports: {} };
  // Runs in this realm, so crypto/TextEncoder/DataView are the real ones and
  // `document` is undefined, which makes the script bail before touching the UI.
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports;
}

/* ------------------------------------------------------------ vendor fetch */

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'duel-live-verifier-test' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function resolveVendorChunks() {
  const html = await get(`${ORIGIN}/`);
  const entry = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (!entry) throw new Error('could not find entry chunk in duel.com HTML');

  const index = await get(`${ORIGIN}/${entry[0]}`);

  const find = (name) => {
    const m = index.match(new RegExp(`assets/${name}-[A-Za-z0-9_-]+\\.js`));
    if (!m) throw new Error(`could not resolve ${name} chunk`);
    return m[0];
  };

  return {
    blackjack: find('blackjackFairness'),
    videoPoker: find('videoPokerFairness'),
    verify: find('verify'),
  };
}

async function download(assetPath) {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const file = path.join(VENDOR_DIR, path.basename(assetPath));
  if (!fs.existsSync(file)) fs.writeFileSync(file, await get(`${ORIGIN}/${assetPath}`), 'utf8');
  return file;
}

/* ------------------------------------------------------------------ inputs */

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const rng = makeRng(0xC0FFEE);
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('');
const int = (min, max) => min + Math.floor(rng() * (max - min + 1));

function sample(count) {
  return Array.from({ length: count }, () => ({
    clientSeed: `client-${hex(8)}`,
    serverSeed: hex(64),
    nonce: int(0, 5000),
  }));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* -------------------------------------------------------------------- main */

(async () => {
  const E = loadEngines();

  console.log('self-contained checks');

  ok('exports the engine surface',
    typeof E.dice === 'function' && typeof E.crash === 'function' && typeof E.videoPoker === 'function');

  ok('hex helpers round-trip',
    E.bytesToHex(E.hexToBytes('00ff10ab')) === '00ff10ab');

  {
    // The trap: HMAC key is the seed's raw bytes, not its hex text.
    const seed = hex(64);
    const bytesKeyed = await E.hmacHex(seed, 'x:0');
    const crypto = require('crypto');
    const textKeyed = crypto.createHmac('sha256', seed).update('x:0').digest('hex');
    const rawKeyed = crypto.createHmac('sha256', Buffer.from(seed, 'hex')).update('x:0').digest('hex');

    ok('HMAC keys on raw seed bytes', bytesKeyed === rawKeyed);
    ok('raw-byte key differs from hex-string key', bytesKeyed !== textKeyed);
  }

  {
    const r = await E.dice({ clientSeed: 'a', serverSeed: hex(64), nonce: 1 });
    ok('dice lands in 0–100', r >= 0 && r <= 100 && Math.round(r * 100) === r * 100);

    const l = await E.limbo({ clientSeed: 'a', serverSeed: hex(64), nonce: 1 });
    ok('limbo is at least 1x', l >= 1);

    const c = await E.crash({ serverSeed: hex(64), drandRandomness: hex(64) });
    ok('crash is at least 1x', c >= 1);

    const roll = await E.roulette({ serverSeed: hex(64), drandRandomness: hex(64) });
    ok('roulette roll in 0–47', Number.isInteger(roll) && roll >= 0 && roll < 48);

    const flip = await E.coinflip({ serverSeed: hex(64), drandRandomness: hex(64) });
    ok('coinflip is 1 or 2', flip === 1 || flip === 2);
  }

  {
    /*
     * Real captured bet #749774. duel.com's own Verify page renders 8.21 for
     * these inputs, and the API reported it as 821 basis points.
     */
    const roll = await E.dice({
      clientSeed: 'xRYcSv7Bd9hjvozX',
      serverSeed: 'd45924bd24d4dd147106b5f36b3dd7dfe6d34d119022f63ef33b9868d52fd900',
      nonce: 49,
    });

    ok('agrees with duel.com verify page on bet #749774', roll === 8.21, 'got ' + roll);
    ok('accepts the API basis-point form (821)', E.numericMatch(roll, 821, 'dice') === 'basis-points');
    ok('accepts the decimal form (8.21)', E.numericMatch(roll, 8.21, 'dice') === 'as-reported');
    ok('still rejects a genuinely wrong result', E.numericMatch(roll, 99.99, 'dice') === null);
    ok('crash tolerates 2dp truncation', E.numericMatch(1.121094, 1.12, 'crash') === 'truncated-2dp');
  }

  console.log('\ndifferential vs duel.com shipped modules');

  let chunks;
  let vendor;
  let verifySource;

  try {
    chunks = await resolveVendorChunks();
    const [bjPath, vpPath] = await Promise.all([
      download(chunks.blackjack),
      download(chunks.videoPoker),
    ]);
    verifySource = await get(`${ORIGIN}/${chunks.verify}`);

    vendor = {
      bj: await import(pathToFileURL(bjPath).href),
      vp: await import(pathToFileURL(vpPath).href),
    };

    console.log(`  using ${path.basename(chunks.blackjack)}, ${path.basename(chunks.videoPoker)}, ${path.basename(chunks.verify)}`);
  } catch (e) {
    skipped('vendor differential', `could not fetch duel.com assets (${e.message})`);
  }

  if (vendor) {
    const cases = sample(12);

    // vendor export aliases, read off the modules' export maps
    const vDice = vendor.vp.m;
    const vLimbo = vendor.vp.i;
    const vPlinko = vendor.vp.o;
    const vMines = vendor.vp.f;
    const vBeef = vendor.vp.c;
    const vKeno = vendor.vp.u;
    const vCards = vendor.vp.n;
    const vBlackjack = vendor.bj.n;

    let diceOk = true; let limboOk = true; let plinkoOk = true;
    let minesOk = true; let beefOk = true; let kenoOk = true;
    let vpOk = true; let bjOk = true;
    let firstDiff = '';

    for (const c of cases) {
      const args = { clientSeed: c.clientSeed, serverSeed: c.serverSeed, nonce: c.nonce };

      const [mineD, theirD] = await Promise.all([E.dice(args), vDice(args)]);
      if (Number(theirD) !== mineD) { diceOk = false; firstDiff ||= `dice ${mineD} vs ${theirD}`; }

      const [mineL, theirL] = await Promise.all([E.limbo(args), vLimbo(args)]);
      if (mineL.toFixed(6) !== String(theirL)) { limboOk = false; firstDiff ||= `limbo ${mineL} vs ${theirL}`; }

      const rows = int(8, 16);
      const [mineP, theirP] = await Promise.all([E.plinko({ ...args, rows }), vPlinko({ ...args, rows })]);
      if (mineP !== theirP) { plinkoOk = false; firstDiff ||= `plinko ${mineP} vs ${theirP}`; }

      const minesCount = int(1, 10);
      const [mineM, theirM] = await Promise.all([
        E.mines({ ...args, minesCount, gridSize: 25 }),
        vMines({ ...args, minesCount, gridSize: 25 }),
      ]);
      if (!same(mineM, theirM)) { minesOk = false; firstDiff ||= `mines ${mineM} vs ${theirM}`; }

      const gridSize = int(10, 25);
      const deathPointsCount = int(1, Math.max(1, gridSize - 2));
      const [mineB, theirB] = await Promise.all([
        E.beef({ ...args, deathPointsCount, gridSize }),
        vBeef({ ...args, deathPointsCount, gridSize }),
      ]);
      if (!same(mineB, theirB)) { beefOk = false; firstDiff ||= `beef ${mineB} vs ${theirB}`; }

      const [mineK, theirK] = await Promise.all([E.keno(args), vKeno(args)]);
      if (!same(mineK, theirK)) { kenoOk = false; firstDiff ||= `keno ${mineK} vs ${theirK}`; }

      const mineVP = await E.videoPoker(args);
      const [theirInitial, theirReplacement] = await Promise.all([
        vCards({ ...args, cardsOffset: 0 }),
        vCards({ ...args, cardsOffset: 5 }),
      ]);
      if (!same(mineVP.initialCards, theirInitial) || !same(mineVP.replacementCards, theirReplacement)) {
        vpOk = false;
        firstDiff ||= `video poker ${mineVP.initialCards} vs ${theirInitial}`;
      }

      const mineBJ = await E.blackjackCards({ ...args, drawAmount: 12 });
      const theirBJ = await vBlackjack({ ...args, startingCursor: 0, drawAmount: 12 });
      const theirBJCards = theirBJ.map((c2) => `${c2.rank}${c2.suit}`);
      if (!same(mineBJ, theirBJCards)) { bjOk = false; firstDiff ||= `blackjack ${mineBJ[0]} vs ${theirBJCards[0]}`; }
    }

    ok('dice matches vendor', diceOk, firstDiff);
    ok('limbo matches vendor', limboOk, firstDiff);
    ok('plinko matches vendor', plinkoOk, firstDiff);
    ok('mines matches vendor', minesOk, firstDiff);
    ok('beef matches vendor', beefOk, firstDiff);
    ok('keno matches vendor', kenoOk, firstDiff);
    ok('video poker matches vendor', vpOk, firstDiff);
    ok('blackjack matches vendor', bjOk, firstDiff);
  }

  /*
   * Crash / coinflip / roulette live inside the Vue verify chunk and cannot be
   * imported, so instead assert the constants we transcribed are still the ones
   * duel.com ships. This is what catches a silent algorithm change.
   */
  if (verifySource) {
    ok('crash still uses 0.1% edge on 2^32/(v+1)',
      /2\*\*32\/\(parseInt\(.{1,40}?\.slice\(0,8\),16\)\+1\)\*\.999/.test(verifySource));

    ok('crash floors at 1x',
      /Math\.max\(1,[A-Za-z$_]\)\}/.test(verifySource));

    ok('coinflip still value % 2 + 1',
      /parseInt\(.{1,40}?\.slice\(0,8\),16\)%2\+1/.test(verifySource));

    ok('roulette range is still 48',
      /bt=48|RANGE = 48/.test(verifySource) || /%bt\}/.test(verifySource));

    ok('drand games still hash randomness:nonce',
      /hexToUtf8String\(drandSeed\)/.test(verifySource));
  } else {
    skipped('verify-chunk constant guards', 'verify chunk unavailable');
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
