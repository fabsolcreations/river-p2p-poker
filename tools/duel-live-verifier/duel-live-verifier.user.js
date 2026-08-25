// ==UserScript==
// @name         Duel Live Verifier
// @namespace    https://github.com/fabsolcreations/seed-lab
// @version      3.2.0
// @description  Captures settled Duel bets from the API layer and independently recomputes their provably-fair results. COMPUTED and MATCHED stay separate.
// @author       seed-lab
// @match        https://duel.com/*
// @match        https://*.duel.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * v3.0 — two changes that matter:
 *
 * 1. Capture moved from the DOM to the network layer. v2.7 matched rendered
 *    i18n labels ("Client seed", "Nonce"), which only exist in English, and
 *    recovered CSS-truncated hashes by guessing. This hooks fetch/XHR and reads
 *    the JSON the modal is rendered from, so it is locale-proof and gets fields
 *    the UI never displays.
 *
 * 2. The engines are real. Transcribed from Duel's own shipped verification
 *    code (assets/blackjackFairness-*.js, videoPokerFairness-*.js, verify-*.js).
 *
 * The detail that silently breaks naive reimplementations: the HMAC key is the
 * server seed decoded from hex to raw bytes, not the 64-character hex string.
 * Get that wrong and every honest round reads as a mismatch.
 */

(function () {
  'use strict';

  const VERSION = '3.2';
  const STORE = 'duel-live-verifier.v3';

  /* ==========================================================================
   * ENGINES — transcribed from Duel's published verification code
   * ========================================================================== */

  const MAX_U32 = 4294967295;
  const TWO32 = 2 ** 32;

  const CARDS = ('2D.2H.2S.2C.3D.3H.3S.3C.4D.4H.4S.4C.5D.5H.5S.5C.6D.6H.6S.6C.' +
    '7D.7H.7S.7C.8D.8H.8S.8C.9D.9H.9S.9C.10D.10H.10S.10C.JD.JH.JS.JC.' +
    'QD.QH.QS.QC.KD.KH.KS.KC.AD.AH.AS.AC').split('.');

  function hexToBytes(hex) {
    const clean = String(hex).trim();
    const out = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function hexToUtf8(hex) {
    return new TextDecoder().decode(hexToBytes(hex));
  }

  async function sha256Hex(input) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
    return bytesToHex(new Uint8Array(digest));
  }

  async function sha256HexOfHexBytes(hex) {
    const digest = await crypto.subtle.digest('SHA-256', hexToBytes(hex));
    return bytesToHex(new Uint8Array(digest));
  }

  async function hmacHex(serverSeedHex, message) {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(serverSeedHex),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(message)));
    return bytesToHex(new Uint8Array(sig));
  }

  const uint32At = (hash, offset) => parseInt(hash.slice(offset, offset + 8), 16);

  const DICE_RANGE = 10001;
  const DICE_FAIR = MAX_U32 - (MAX_U32 % DICE_RANGE);

  async function dice({ clientSeed, serverSeed, nonce }) {
    const hash = await hmacHex(serverSeed, `${clientSeed}:${nonce}`);
    for (let o = 0; o + 8 <= hash.length; o += 8) {
      const v = uint32At(hash, o);
      if (v < DICE_FAIR) return (v % DICE_RANGE) / 100;
    }
    throw new Error('dice: hash exhausted without an unbiased value');
  }

  async function limbo({ clientSeed, serverSeed, nonce }) {
    const hash = await hmacHex(serverSeed, `${clientSeed}:${nonce}`);
    const v = uint32At(hash, 0);
    return Math.max(1, Math.floor((TWO32 / (v + 1)) * 1e6) / 1e6);
  }

  async function plinko({ clientSeed, serverSeed, nonce, rows }) {
    let bucket = 0;
    for (let row = 0; row < rows; row++) {
      const hash = await hmacHex(serverSeed, `${clientSeed}:${nonce}:${row}`);
      bucket += uint32At(hash, 0) % 2;
    }
    return bucket;
  }

  /*
   * Fisher-Yates over gridSize; one cursor per swap, advanced on rejection.
   * Mines and beef return their picks sorted; keno keeps draw order.
   */
  async function shufflePick({ clientSeed, serverSeed, nonce, gridSize, pick, sorted = true }) {
    if (pick >= gridSize) throw new Error('pick must be less than gridSize');
    const arr = Array.from({ length: gridSize }, (_, i) => i);

    for (let i = gridSize - 1; i > 0; i--) {
      const bound = i + 1;
      const fair = MAX_U32 - (MAX_U32 % bound);
      let cursor = gridSize - 1 - i;

      for (;;) {
        const hash = await hmacHex(serverSeed, `${clientSeed}:${nonce}:${cursor}`);
        let swapped = false;
        for (let o = 0; o + 8 <= hash.length; o += 8) {
          const v = uint32At(hash, o);
          if (v < fair) {
            const j = v % bound;
            [arr[i], arr[j]] = [arr[j], arr[i]];
            swapped = true;
            break;
          }
        }
        if (swapped) break;
        cursor++;
      }
    }
    const picked = arr.slice(0, pick);
    return sorted ? picked.sort((a, b) => a - b) : picked;
  }

  const mines = ({ clientSeed, serverSeed, nonce, minesCount, gridSize = 25 }) =>
    shufflePick({ clientSeed, serverSeed, nonce, gridSize, pick: minesCount });

  const beef = ({ clientSeed, serverSeed, nonce, deathPointsCount, gridSize }) =>
    shufflePick({ clientSeed, serverSeed, nonce, gridSize, pick: deathPointsCount });

  async function keno({ clientSeed, serverSeed, nonce }) {
    const picked = await shufflePick({ clientSeed, serverSeed, nonce, gridSize: 40, pick: 10, sorted: false });
    return picked.map((n) => n + 1);
  }

  const CARD_FAIR = 52 * 82595524; // 52 * floor(2^32 / 52)

  function cardFromHash(hash) {
    const bytes = hexToBytes(hash);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i + 4 <= bytes.length; i += 4) {
      const v = view.getUint32(i);
      if (v < CARD_FAIR) return CARDS[v % 52];
    }
    throw new Error('card: hash exhausted without an unbiased value');
  }

  // Blackjack draws each card independently (infinite-deck behaviour).
  async function blackjackCards({ clientSeed, serverSeed, nonce, startingCursor = 0, drawAmount = 20 }) {
    const count = drawAmount > 0 ? drawAmount : 20;
    const cards = [];
    for (let cursor = startingCursor; cursor < startingCursor + count; cursor++) {
      cards.push(cardFromHash(await hmacHex(serverSeed, `${clientSeed}:${nonce}:${cursor}`)));
    }
    return cards;
  }

  // Video poker shuffles one real 52-card deck (single hash per swap, no retry).
  async function shuffleDeck({ clientSeed, serverSeed, nonce }) {
    const deck = [...CARDS];
    for (let i = deck.length - 1; i > 0; i--) {
      const bound = i + 1;
      const fair = MAX_U32 - (MAX_U32 % bound);
      const cursor = deck.length - 1 - i;
      const hash = await hmacHex(serverSeed, `${clientSeed}:${nonce}:${cursor}`);

      let swapped = false;
      for (let o = 0; o + 8 <= hash.length; o += 8) {
        const v = uint32At(hash, o);
        if (v < fair) {
          const j = v % bound;
          [deck[i], deck[j]] = [deck[j], deck[i]];
          swapped = true;
          break;
        }
      }
      if (!swapped) throw new Error(`deck: no unbiased value for swap at index ${i}`);
    }
    return deck;
  }

  async function videoPoker({ clientSeed, serverSeed, nonce }) {
    const deck = await shuffleDeck({ clientSeed, serverSeed, nonce });
    return { initialCards: deck.slice(0, 5), replacementCards: deck.slice(5, 10) };
  }

  // Drand games: randomness is hex-decoded to a UTF-8 string, nonce is 0.
  async function drandUint32({ serverSeed, drandRandomness, nonce = 0 }) {
    const hash = await hmacHex(serverSeed, `${hexToUtf8(drandRandomness)}:${nonce}`);
    return uint32At(hash, 0);
  }

  const CRASH_HOUSE_EDGE = 0.001;
  const ROULETTE_RANGE = 48;

  async function crash(args) {
    const v = await drandUint32(args);
    return Math.max(1, (TWO32 / (v + 1)) * (1 - CRASH_HOUSE_EDGE));
  }

  const coinflip = async (args) => ((await drandUint32(args)) % 2) + 1; // 1 Crown, 2 Swords
  const roulette = async (args) => (await drandUint32(args)) % ROULETTE_RANGE;

  /*
   * The API reports some results in a different unit to the one the algorithm
   * produces: dice comes back as 0-10000 basis points while the algorithm (and
   * the UI) works in 0.00-100.00. Comparing raw numbers turns an honest bet into
   * a MISMATCHED accusation, so both readings are tried and the one that fits is
   * recorded rather than assumed.
   */
  const EPS = 1e-6;

  function numericMatch(computed, reported, game) {
    if (!Number.isFinite(computed) || !Number.isFinite(reported)) return null;

    const forms = [
      { scale: 'as-reported', value: computed },
      { scale: 'basis-points', value: computed * 100 },
    ];

    if (game === 'crash') {
      // Crash points are displayed truncated to 2dp.
      forms.push(
        { scale: 'truncated-2dp', value: Math.floor(computed * 100) / 100 },
        { scale: 'truncated-basis-points', value: Math.floor(computed * 100) },
      );
    }

    for (const form of forms) {
      if (Math.abs(form.value - reported) < EPS) return form.scale;
    }
    return null;
  }

  const ENGINES = {
    CARDS,
    constants: { MAX_U32, DICE_RANGE, DICE_FAIR, CARD_FAIR, CRASH_HOUSE_EDGE, ROULETTE_RANGE },
    hexToBytes, bytesToHex, hexToUtf8, sha256Hex, sha256HexOfHexBytes, hmacHex,
    dice, limbo, plinko, mines, beef, keno, shufflePick, shuffleDeck, cardFromHash,
    blackjackCards, videoPoker, drandUint32, crash, coinflip, roulette,
    numericMatch,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINES;
  if (typeof document === 'undefined') return; // Node: engines only, no UI.

  /* ==========================================================================
   * STATE
   * ========================================================================== */

  const blank = () => ({
    version: VERSION,
    stats: { captured: 0, computed: 0, matched: 0, mismatched: 0, commitmentBad: 0 },
    bets: [],
    events: [],
    seedState: null,
  });

  let state;
  try {
    const prior = JSON.parse(localStorage.getItem(STORE) || 'null');
    state = prior && typeof prior === 'object' ? { ...blank(), ...prior } : blank();
    state.stats = { ...blank().stats, ...(state.stats || {}) };
    state.bets ||= [];
    state.events ||= [];
  } catch {
    state = blank();
  }

  let renderQueued = false;
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(state));
    } catch (e) {
      console.warn('[DuelVerifier] persist failed', e);
    }
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(() => { renderQueued = false; render(); });
    }
  }

  function event(message, type = 'info') {
    state.events.unshift({ at: new Date().toISOString(), type, message });
    state.events = state.events.slice(0, 60);
    console.log(`[DuelVerifier] ${message}`);
    save();
  }

  /* ==========================================================================
   * NETWORK CAPTURE
   *
   * Field names are inferred from Duel's fairness UI and verify page. The scan
   * is deliberately shape-agnostic: it walks any JSON body and keeps objects
   * that carry a usable fairness tuple, so an unexpected envelope or a renamed
   * wrapper does not break capture.
   * ========================================================================== */

  const ALIASES = {
    clientSeed: ['client_seed', 'clientSeed'],
    serverSeed: ['server_seed', 'serverSeed'],
    serverSeedHash: ['server_seed_hashed', 'server_seed_hash', 'serverSeedHashed', 'hashed_server_seed'],
    nonce: ['nonce'],
    drandRandomness: ['drand_randomness', 'drandRandomness', 'randomness'],
    drandRoundId: ['drand_round_id', 'drandRoundId'],
    roundId: ['round_id', 'roundId'],
    betId: ['id', 'bet_id', 'transaction_id', 'public_id', 'secure_id'],
    game: ['game', 'game_name', 'game_type', 'type'],
    rows: ['rows', 'row_count'],
    minesCount: ['mines_count', 'minesCount', 'mines'],
    gridSize: ['grid_size', 'gridSize'],
    deathPoints: ['death_points_count', 'deathPointsCount', 'death_points'],
    difficulty: ['difficulty'],
  };

  /*
   * Result keys are per game and type-checked. A generic sweep for
   * "value"/"multiplier" picks up wagers and payouts, which would let a bet be
   * declared MISMATCHED for disagreeing with a number that was never the result.
   */
  const RESULT_KEYS = {
    dice: { keys: ['result', 'roll'], kind: 'number' },
    // Not 'multiplier'/'target_multiplier': on a bet those are usually what the
    // player aimed at or was paid, not what was rolled.
    limbo: { keys: ['result', 'roll', 'roll_multiplier'], kind: 'number' },
    // Not 'multiplier': on a crash bet that is the cashout, which is <= the
    // crash point by definition, so comparing it would fail every won bet.
    crash: { keys: ['crash_point', 'crashed_at', 'crash_multiplier'], kind: 'number' },
    roulette: { keys: ['roll', 'winning_number', 'result'], kind: 'number' },
    // Not 'side': that is the side the player picked.
    coinflip: { keys: ['result', 'outcome', 'winning_side'], kind: 'number' },
    plinko: { keys: ['bucket', 'slot', 'result'], kind: 'number' },
    mines: { keys: ['mine_positions', 'minePositions', 'bomb_positions'], kind: 'array' },
    beef: { keys: ['death_point_positions', 'death_points_positions'], kind: 'array' },
    keno: { keys: ['drawn_numbers', 'drawnNumbers', 'numbers'], kind: 'array' },
  };

  function readReported(candidate, game) {
    const spec = RESULT_KEYS[game];
    if (!spec) return { value: null, from: null };

    const chain = [candidate.node, ...candidate.ancestors.slice().reverse()];
    for (const obj of chain) {
      if (!obj || typeof obj !== 'object') continue;
      for (const key of spec.keys) {
        const v = obj[key];
        if (v === undefined || v === null || v === '') continue;
        if (spec.kind === 'array' && Array.isArray(v)) return { value: v, from: key };
        if (spec.kind === 'number' && Number.isFinite(Number(v))) return { value: Number(v), from: key };
      }
    }
    return { value: null, from: null };
  }

  const pick = (obj, key) => {
    for (const alias of ALIASES[key] || []) {
      if (obj && obj[alias] !== undefined && obj[alias] !== null) return obj[alias];
    }
    return undefined;
  };

  const isHex64 = (v) => /^[a-f0-9]{64}$/i.test(String(v ?? '').trim());
  const isHex = (v) => /^[a-f0-9]{32,}$/i.test(String(v ?? '').trim());

  function toInt(v) {
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
    return null;
  }

  /*
   * Some payloads nest the fairness tuple one level down (e.g. a `fairness` or
   * `provably_fair` object) while the bet id and game live on the parent, so
   * candidates carry a reference to their ancestors.
   */
  function collectCandidates(root) {
    const found = [];
    const seen = new Set();

    (function walk(node, ancestors) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);

      if (!Array.isArray(node)) {
        const serverSeed = pick(node, 'serverSeed');
        const clientSeed = pick(node, 'clientSeed');
        const nonce = toInt(pick(node, 'nonce'));
        const drand = pick(node, 'drandRandomness');

        const nonceTuple = isHex64(serverSeed) && clientSeed && nonce !== null;
        const drandTuple = isHex64(serverSeed) && isHex(drand);

        if (nonceTuple || drandTuple) found.push({ node, ancestors: [...ancestors] });
      }

      const next = [...ancestors, node];
      for (const value of Array.isArray(node) ? node : Object.values(node)) {
        if (value && typeof value === 'object') walk(value, next);
      }
    }(root, []));

    return found;
  }

  function fromChain(candidate, key) {
    const chain = [candidate.node, ...candidate.ancestors.slice().reverse()];
    for (const obj of chain) {
      const v = pick(obj, key);
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  }

  const GAME_PATTERNS = [
    [/video[_\s-]*poker/i, 'video_poker'],
    [/black\s*jack/i, 'blackjack'],
    [/cross[_\s-]*road|beef/i, 'beef'],
    [/castle[_\s-]*roulette|roulette/i, 'roulette'],
    [/coin\s*flip/i, 'coinflip'],
    [/plinko/i, 'plinko'],
    [/mines/i, 'mines'],
    [/keno/i, 'keno'],
    [/limbo/i, 'limbo'],
    [/crash/i, 'crash'],
    [/dice/i, 'dice'],
  ];

  function detectGame(candidate, url) {
    const hint = `${fromChain(candidate, 'game') ?? ''} ${url ?? ''}`;
    for (const [pattern, game] of GAME_PATTERNS) if (pattern.test(hint)) return game;

    // Structural fallback when nothing is labelled.
    const node = candidate.node;
    if (isHex(pick(node, 'drandRandomness'))) return 'drand-unknown';
    if (toInt(fromChain(candidate, 'rows')) !== null) return 'plinko';
    if (toInt(fromChain(candidate, 'minesCount')) !== null) return 'mines';
    return 'unknown';
  }

  function buildRecord(candidate, url) {
    const node = candidate.node;
    const game = detectGame(candidate, url);
    const reported = readReported(candidate, game);

    return {
      capturedAt: new Date().toISOString(),
      source: url,
      game,
      betId: fromChain(candidate, 'betId') ?? null,
      clientSeed: pick(node, 'clientSeed') ?? fromChain(candidate, 'clientSeed') ?? null,
      serverSeed: pick(node, 'serverSeed') ?? null,
      serverSeedHash: fromChain(candidate, 'serverSeedHash') ?? null,
      nonce: toInt(pick(node, 'nonce')),
      drandRandomness: pick(node, 'drandRandomness') ?? null,
      drandRoundId: toInt(fromChain(candidate, 'drandRoundId')),
      roundId: toInt(fromChain(candidate, 'roundId')),
      rows: toInt(fromChain(candidate, 'rows')),
      minesCount: toInt(fromChain(candidate, 'minesCount')),
      gridSize: toInt(fromChain(candidate, 'gridSize')),
      deathPoints: toInt(fromChain(candidate, 'deathPoints')),
      reported: reported.value,
      reportedFrom: reported.from,
      raw: node,
    };
  }

  /* ==========================================================================
   * VERIFICATION
   * ========================================================================== */

  async function computeResult(rec) {
    const { clientSeed, serverSeed, nonce, drandRandomness } = rec;
    const base = { clientSeed, serverSeed, nonce };

    switch (rec.game) {
      case 'dice': return { supported: true, value: await dice(base) };
      case 'limbo': return { supported: true, value: await limbo(base) };
      case 'keno': return { supported: true, value: await keno(base) };

      case 'plinko':
        if (rec.rows === null) return { supported: false, reason: 'row count missing from payload' };
        return { supported: true, value: await plinko({ ...base, rows: rec.rows }) };

      case 'mines':
        if (rec.minesCount === null) return { supported: false, reason: 'mine count missing from payload' };
        return {
          supported: true,
          value: await mines({ ...base, minesCount: rec.minesCount, gridSize: rec.gridSize ?? 25 }),
        };

      case 'beef':
        if (rec.deathPoints === null || rec.gridSize === null) {
          return { supported: false, reason: 'death points / grid size missing from payload' };
        }
        return {
          supported: true,
          value: await beef({ ...base, deathPointsCount: rec.deathPoints, gridSize: rec.gridSize }),
        };

      case 'blackjack':
        return { supported: true, value: await blackjackCards({ ...base, drawAmount: 20 }) };

      case 'video_poker':
        return { supported: true, value: await videoPoker(base) };

      case 'crash':
        return { supported: true, value: await crash({ serverSeed, drandRandomness }) };

      case 'coinflip':
        return { supported: true, value: await coinflip({ serverSeed, drandRandomness }) };

      case 'roulette':
        return { supported: true, value: await roulette({ serverSeed, drandRandomness }) };

      default:
        return { supported: false, reason: `no engine mapped for "${rec.game}"` };
    }
  }

  /*
   * Only claims MATCHED when the payload actually carries a comparable result.
   * Anything else stays COMPUTED — a recomputation nobody cross-checked is not
   * a verification.
   */
  function compare(rec, computed) {
    if (!computed?.supported) return { status: 'computed-only', scale: null };
    if (rec.reported === null || rec.reported === undefined) return { status: 'computed-only', scale: null };

    const value = computed.value;

    if (typeof value === 'number') {
      const scale = numericMatch(value, Number(rec.reported), rec.game);
      return scale ? { status: 'matched', scale } : { status: 'mismatched', scale: null };
    }

    if (Array.isArray(value) && Array.isArray(rec.reported)) {
      const sorted = (arr) => JSON.stringify([...arr].sort((a, b) => a - b));
      // Order differs between games (keno keeps draw order), so compare as sets.
      const matched = sorted(value) === sorted(rec.reported);
      return { status: matched ? 'matched' : 'mismatched', scale: matched ? 'set' : null };
    }

    return { status: 'computed-only', scale: null };
  }

  /*
   * Duel never states which preimage the published server-seed hash commits to,
   * so both are tried and the winner is recorded rather than guessed at.
   */
  async function checkCommitment(rec) {
    if (!isHex64(rec.serverSeed) || !isHex64(rec.serverSeedHash)) return null;

    const expected = rec.serverSeedHash.toLowerCase();
    const [utf8, bytes] = await Promise.all([
      sha256Hex(rec.serverSeed),
      sha256HexOfHexBytes(rec.serverSeed),
    ]);

    if (utf8 === expected) return { matched: true, preimage: 'hex-string' };
    if (bytes === expected) return { matched: true, preimage: 'raw-bytes' };
    return { matched: false, preimage: null, expected, sha256OfHexString: utf8, sha256OfBytes: bytes };
  }

  const fingerprint = (rec) =>
    `${rec.game}|${rec.betId ?? ''}|${rec.serverSeed ?? ''}|${rec.nonce ?? ''}|${rec.drandRandomness ?? ''}`;

  const seenFingerprints = new Set(state.bets.map(fingerprint));

  async function record(rec) {
    const fp = fingerprint(rec);
    if (seenFingerprints.has(fp)) return;
    seenFingerprints.add(fp);

    let computed;
    try {
      computed = await computeResult(rec);
    } catch (e) {
      computed = { supported: false, reason: e.message };
    }

    const commitment = await checkCommitment(rec);
    const { status, scale } = compare(rec, computed);

    state.bets.push({ ...rec, computed, commitment, status, reportedScale: scale });
    state.bets = state.bets.slice(-400);
    state.stats.captured++;

    if (computed?.supported) state.stats.computed++;
    if (status === 'matched') state.stats.matched++;
    if (status === 'mismatched') state.stats.mismatched++;
    if (commitment?.matched === false) state.stats.commitmentBad++;

    const label = rec.betId ? `#${rec.betId}` : rec.game;
    let type = 'good';
    let note = status.toUpperCase();

    if (status === 'computed-only') {
      type = 'info';
      note = computed?.supported ? 'COMPUTED (nothing to compare against)' : `NOT COMPUTED: ${computed?.reason}`;
    }
    if (status === 'mismatched') type = 'bad';

    if (commitment?.matched === false) {
      type = 'bad';
      note += ' · SEED-HASH MISMATCH';
      event(`COMMITMENT MISMATCH ${label} ${rec.game}`, 'bad');
    }

    event(`${label} ${rec.game} → ${note}`, type);
  }

  function ingest(url, body) {
    try {
      const candidates = collectCandidates(body);
      if (!candidates.length) return;
      for (const candidate of candidates) record(buildRecord(candidate, url));
    } catch (e) {
      console.warn('[DuelVerifier] ingest failed', e);
    }
  }

  function captureSeedState(url, body) {
    if (!/client-seed/i.test(url)) return;
    const data = body?.data ?? body;
    if (data && typeof data === 'object') {
      state.seedState = { at: new Date().toISOString(), data };
      save();
    }
  }

  const INTERESTING = /\/api\//i;

  // Relative request URLs ("api/v2/...") must be resolved before matching.
  function absolute(url) {
    try {
      return new URL(String(url ?? ''), location.href).href;
    } catch {
      return String(url ?? '');
    }
  }

  function handlePayload(url, text) {
    if (!text || text.length > 4_000_000) return;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    captureSeedState(url, body);
    ingest(url, body);
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const promise = nativeFetch.apply(this, args);
      try {
        const url = absolute(args[0]?.url ?? args[0] ?? '');
        if (INTERESTING.test(url)) {
          promise.then((res) => {
            try {
              res.clone().text().then((t) => handlePayload(url, t)).catch(() => {});
            } catch {}
          }).catch(() => {});
        }
      } catch {}
      return promise;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR?.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      this.__dlvUrl = absolute(url);
      return open.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...args) {
      try {
        if (INTERESTING.test(this.__dlvUrl || '')) {
          this.addEventListener('load', () => {
            try {
              const type = this.responseType;
              if (type === '' || type === 'text') handlePayload(this.__dlvUrl, this.responseText);
              else if (type === 'json' && this.response) handlePayload(this.__dlvUrl, JSON.stringify(this.response));
            } catch {}
          });
        }
      } catch {}
      return send.apply(this, args);
    };
  }

  /* ==========================================================================
   * EXPORT
   * ========================================================================== */

  function download(name, mime, content) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  const exportJSON = () => download(
    `duel-verifier-${stamp()}.json`,
    'application/json',
    JSON.stringify({ exportedAt: new Date().toISOString(), verifierVersion: VERSION, ...state }, null, 2),
  );

  function exportCSV() {
    const head = ['capturedAt', 'betId', 'game', 'status', 'clientSeed', 'serverSeed', 'nonce',
      'drandRandomness', 'roundId', 'commitmentMatched', 'commitmentPreimage', 'computed', 'reported', 'reportedFrom', 'reportedScale'];

    const rows = state.bets.map((b) => [
      b.capturedAt, b.betId ?? '', b.game, b.status,
      b.clientSeed ?? '', b.serverSeed ?? '', b.nonce ?? '',
      b.drandRandomness ?? '', b.roundId ?? '',
      b.commitment?.matched ?? '', b.commitment?.preimage ?? '',
      JSON.stringify(b.computed?.value ?? b.computed?.reason ?? null),
      JSON.stringify(b.reported ?? null), b.reportedFrom ?? '', b.reportedScale ?? '',
    ]);

    const csv = [head, ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    download(`duel-verifier-${stamp()}.csv`, 'text/csv;charset=utf-8', csv);
  }

  function reset() {
    if (!confirm('Reset Duel Live Verifier data?')) return;
    state = blank();
    seenFingerprints.clear();
    localStorage.removeItem(STORE);
    event('data reset', 'info');
  }

  /* ==========================================================================
   * PANEL
   * ========================================================================== */

  let panel;
  let minimized = false;

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  const short = (v, n = 12) => (String(v ?? '').length > n ? `${String(v).slice(0, n)}…` : String(v ?? '—'));

  const colour = (t) => ({ bad: '#ff6978', good: '#20e39c', warn: '#ffc857' }[t] || '#aab2c5');

  function summarise(value) {
    if (value === null || value === undefined) return '—';
    if (Array.isArray(value)) return value.length > 6 ? `${value.slice(0, 6).join(',')}…` : value.join(',');
    if (typeof value === 'object') return Object.values(value).flat().slice(0, 5).join(',');
    if (typeof value === 'number') return String(Math.round(value * 1e6) / 1e6);
    return String(value);
  }

  function statBox(label, value, tint = '#dfe5f1') {
    return `<div style="background:#15191f;border:1px solid #292f39;border-radius:5px;padding:7px">
      <div style="color:#949daf;font-size:9px">${esc(label)}</div>
      <div style="color:${tint};font-size:15px;font-weight:700;margin-top:2px">${esc(value)}</div>
    </div>`;
  }

  function render() {
    if (!panel) return;

    const recent = state.bets.slice(-6).reverse().map((b) => {
      const tint = b.status === 'mismatched' || b.commitment?.matched === false ? '#ff6978'
        : b.status === 'matched' ? '#20e39c' : '#aab2c5';
      return `<div style="display:grid;grid-template-columns:74px 1fr 84px;gap:6px;border-top:1px solid #242a35;padding:5px 0;font-size:10px">
        <span>${esc(b.game)}</span>
        <span style="color:#8f97a8">${esc(summarise(b.computed?.value))}</span>
        <span style="color:${tint}">${esc(b.status)}</span>
      </div>`;
    }).join('');

    const events = state.events.slice(0, 6).map((e) =>
      `<div style="color:${colour(e.type)};margin:3px 0;line-height:1.25;word-break:break-word">${esc(e.message)}</div>`,
    ).join('');

    const last = state.bets[state.bets.length - 1];

    panel.innerHTML = `
      <div id="dlv-header" style="display:flex;align-items:center;gap:6px;padding:8px;font-weight:700;cursor:move">
        <span style="width:7px;height:7px;background:#20e39c;border-radius:50%"></span>
        <span style="flex:1">LIVE VERIFIER v${VERSION}</span>
        <button data-a="export">export</button>
        <button data-a="reset">reset</button>
        <button data-a="min">${minimized ? '+' : '−'}</button>
      </div>
      <div style="display:${minimized ? 'none' : 'block'};padding:0 8px 8px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;border-top:1px solid #242a35;padding-top:8px">
          ${statBox('Matched', state.stats.matched, '#20e39c')}
          ${statBox('Mismatched', state.stats.mismatched, '#ff6978')}
          ${statBox('Captured', state.stats.captured)}
          ${statBox('Computed', state.stats.computed)}
        </div>
        <div style="border-top:1px solid #242a35;margin-top:8px;padding-top:7px;font-size:10px;line-height:1.7">
          <div style="display:flex;justify-content:space-between"><span>last game</span><span>${esc(last?.game || '—')}</span></div>
          <div style="display:flex;justify-content:space-between"><span>client seed</span><span>${esc(short(last?.clientSeed))}</span></div>
          <div style="display:flex;justify-content:space-between"><span>nonce</span><span>${esc(last?.nonce ?? '—')}</span></div>
          <div style="display:flex;justify-content:space-between"><span>seed commitment</span><span style="color:${
            last?.commitment?.matched === true ? '#20e39c' : last?.commitment?.matched === false ? '#ff6978' : '#ffc857'
          }">${
            last?.commitment?.matched === true ? `matched (${esc(last.commitment.preimage)})`
              : last?.commitment?.matched === false ? 'MISMATCH' : 'no hash in payload'
          }</span></div>
        </div>
        <div style="margin-top:7px;max-height:130px;overflow:auto">
          ${recent || '<div style="opacity:.55;font-size:10px">Waiting for a settled bet…</div>'}
        </div>
        <div style="border-top:1px solid #242a35;margin-top:6px;padding-top:5px;font-size:9px;max-height:96px;overflow:auto">${events}</div>
      </div>`;

    panel.querySelector('[data-a="export"]').addEventListener('click', (e) => (e.shiftKey ? exportJSON() : exportCSV()));
    panel.querySelector('[data-a="reset"]').addEventListener('click', reset);
    panel.querySelector('[data-a="min"]').addEventListener('click', () => { minimized = !minimized; render(); });
  }

  /*
   * Bound to the panel itself, not the header: render() replaces innerHTML, so
   * anything attached to the header dies the moment a bet is captured.
   */
  function installDrag() {
    let active = false;
    let dx = 0;
    let dy = 0;

    panel.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#dlv-header') || e.target.closest('button')) return;
      active = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      try { panel.setPointerCapture?.(e.pointerId); } catch { /* capture is a nicety */ }
      e.preventDefault();
    });

    panel.addEventListener('pointermove', (e) => {
      if (!active) return;
      const left = Math.max(0, Math.min(innerWidth - panel.offsetWidth, e.clientX - dx));
      const top = Math.max(0, Math.min(innerHeight - panel.offsetHeight, e.clientY - dy));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      state.panelPos = { left, top };
    });

    const stop = () => {
      if (!active) return;
      active = false;
      save(); // remember where it was dropped
    };

    panel.addEventListener('pointerup', stop);
    panel.addEventListener('pointercancel', stop);
  }

  function mount() {
    if (!document.body) return setTimeout(mount, 100);
    if (document.getElementById('duel-live-verifier-panel')) return;

    const style = document.createElement('style');
    style.textContent = `#duel-live-verifier-panel button{appearance:none;border:1px solid #3b4350;background:#202630;
      color:#e3e8f2;padding:3px 6px;border-radius:4px;font:inherit;font-size:9px;cursor:pointer}
      #duel-live-verifier-panel button:hover{background:#2c3441}`;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'duel-live-verifier-panel';
    Object.assign(panel.style, {
      position: 'fixed', left: '8px', top: '45%', width: '355px', maxWidth: 'calc(100vw - 16px)',
      zIndex: '2147483647', background: '#0d1117', color: '#cbd3df', border: '1px solid #303744',
      borderRadius: '8px', boxShadow: '0 12px 35px rgba(0,0,0,.45)', fontSize: '10px',
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
    });

    if (state.panelPos) {
      panel.style.left = `${state.panelPos.left}px`;
      panel.style.top = `${state.panelPos.top}px`;
    }

    document.body.appendChild(panel);
    installDrag();
    render();
    console.log(`[DuelVerifier] v${VERSION} armed — capturing /api/ responses`);
  }

  mount();

  window.DuelLiveVerifier = {
    version: VERSION,
    engines: ENGINES,
    state: () => state,
    ingest,
    exportJSON,
    exportCSV,
    reset,
  };
}());
