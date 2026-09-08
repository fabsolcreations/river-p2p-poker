// ==UserScript==
// @name         PokerNow Panel
// @namespace    https://github.com/fabsolcreations/pokernow-panel
// @version      2.0.0
// @description  All-in-one PokerNow overlay: live equity and advice, opponent HUD built from the table log, hand history recorder and export. Runs entirely in your browser.
// @author       you
// @match        https://www.pokernow.com/*
// @match        https://pokernow.com/*
// @match        https://www.pokernow.club/*
// @match        https://pokernow.club/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * v2 architecture
 *
 * Two sources of truth, in order of trust:
 *
 *   1. The table LOG. PokerNow writes a stable, English, structured line per
 *      event ("Alice @ id" calls 20 / Flop: [7c, 2d, 9s] / ...). It is the same
 *      text the official hand-history export is built from, it is not affected
 *      by re-skins or seat layout, and it carries things the felt never shows —
 *      who folded, what everyone paid, who won. Stats and history come from here.
 *
 *   2. The FELT (DOM). Needed only for right-now state the log has not written
 *      yet: your hole cards this instant, the board, the pot, whether it is your
 *      turn and what a call costs. Every selector has fallbacks and a
 *      diagnostics view, because this is the layer that breaks.
 *
 * A third, dormant source is scaffolded: a WebSocket recorder. It captures the
 * shape of PokerNow's socket traffic so a real parser can be written from real
 * data. It deliberately does not guess at message shapes — see the Diag tab.
 *
 * Nothing is sent anywhere. All state lives in localStorage.
 */

(function () {
  'use strict';

  const VERSION = '2.0';
  const STORE = 'pokernow-panel.v2';

  /* ==========================================================================
   * 1. CARD ENGINE
   *
   * card = rank * 4 + suit ; rank 0..12 => 2..A ; suit 0..3 => c,d,h,s
   * Ranks are packed base-14 (0 = absent) so a nut flush cannot overflow into
   * the full-house band — a base-13 packing silently does.
   * ========================================================================== */

  const RANK_CHARS = '23456789TJQKA';
  const SUIT_CHARS = 'cdhs';
  const SUIT_GLYPH = ['♣', '♦', '♥', '♠'];
  const CAT_NAMES = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
  const CAT_BASE = 537824; // 14^5

  const makeCard = (rank, suit) => rank * 4 + suit;
  const cardRank = (c) => c >> 2;
  const cardSuit = (c) => c & 3;
  const cardStr = (c) => RANK_CHARS[cardRank(c)] + SUIT_CHARS[cardSuit(c)];
  const cardPretty = (c) => RANK_CHARS[cardRank(c)] + SUIT_GLYPH[cardSuit(c)];

  function parseCard(str) {
    if (!str) return -1;
    const s = String(str).trim();
    if (s.length < 2) return -1;

    let rankPart = s.slice(0, s.length - 1).toUpperCase();
    const suitPart = s.slice(-1);
    if (rankPart === '10') rankPart = 'T';

    const r = RANK_CHARS.indexOf(rankPart);
    let su = SUIT_CHARS.indexOf(suitPart.toLowerCase());
    if (su < 0) su = SUIT_GLYPH.indexOf(suitPart);

    return r < 0 || su < 0 ? -1 : makeCard(r, su);
  }

  function topRanks(mask, n) {
    const out = [];
    for (let r = 12; r >= 0 && out.length < n; r--) if ((mask >> r) & 1) out.push(r);
    return out;
  }

  function straightHigh(mask) {
    for (let hi = 12; hi >= 4; hi--) {
      let ok = true;
      for (let i = 0; i < 5; i++) if (!((mask >> (hi - i)) & 1)) { ok = false; break; }
      if (ok) return hi;
    }
    // wheel: A,2,3,4,5
    return (mask & (1 << 12)) && (mask & 1) && (mask & 2) && (mask & 4) && (mask & 8) ? 3 : -1;
  }

  function score(cat, ranks) {
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 14 + ((ranks[i] === undefined ? -1 : ranks[i]) + 1);
    return v;
  }

  // Best five-card score out of 5, 6 or 7 cards. Higher is better.
  function evaluate(cards) {
    const rc = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const sc = [0, 0, 0, 0];
    const sm = [0, 0, 0, 0];
    let mask = 0;

    for (let i = 0; i < cards.length; i++) {
      const c = cards[i]; const r = c >> 2; const s = c & 3;
      rc[r]++; sc[s]++; sm[s] |= 1 << r; mask |= 1 << r;
    }

    let flushSuit = -1;
    for (let s = 0; s < 4; s++) if (sc[s] >= 5) flushSuit = s;

    if (flushSuit >= 0) {
      const fm = sm[flushSuit];
      const sf = straightHigh(fm);
      return sf >= 0 ? score(8, [sf]) : score(5, topRanks(fm, 5));
    }

    const quads = []; const trips = []; const pairs = [];
    for (let r = 12; r >= 0; r--) {
      if (rc[r] === 4) quads.push(r);
      else if (rc[r] === 3) trips.push(r);
      else if (rc[r] === 2) pairs.push(r);
    }

    if (quads.length) return score(7, [quads[0]].concat(topRanks(mask & ~(1 << quads[0]), 1)));

    if (trips.length && (pairs.length || trips.length > 1)) {
      const alt = trips.length > 1 ? trips[1] : -1;
      return score(6, [trips[0], Math.max(pairs.length ? pairs[0] : -1, alt)]);
    }

    const st = straightHigh(mask);
    if (st >= 0) return score(4, [st]);

    if (trips.length) return score(3, [trips[0]].concat(topRanks(mask & ~(1 << trips[0]), 2)));

    if (pairs.length >= 2) {
      const m2 = mask & ~(1 << pairs[0]) & ~(1 << pairs[1]);
      return score(2, [pairs[0], pairs[1]].concat(topRanks(m2, 1)));
    }

    if (pairs.length === 1) return score(1, [pairs[0]].concat(topRanks(mask & ~(1 << pairs[0]), 3)));

    return score(0, topRanks(mask, 5));
  }

  const catOf = (s) => Math.floor(s / CAT_BASE);

  function handName(s) {
    const cat = catOf(s);
    if (cat === 8) {
      const hi = Math.floor(s / 38416) - cat * 14 - 1; // 14^4
      return hi === 12 ? 'Royal Flush' : 'Straight Flush';
    }
    return CAT_NAMES[cat];
  }

  // Monte Carlo: hero equity plus the distribution of hero's final hand class.
  function simulate(hero, board, nOpp, sims) {
    const known = hero.concat(board);
    const deck = [];
    for (let c = 0; c < 52; c++) if (known.indexOf(c) < 0) deck.push(c);

    const runout = 5 - board.length;
    const need = runout + 2 * nOpp;
    if (hero.length !== 2 || nOpp < 1 || need > deck.length) return null;

    let win = 0; let tieCount = 0; let tieShare = 0; let lose = 0;
    const cats = new Array(9).fill(0);
    const full = new Array(7);
    const opp = new Array(7);
    const drawn = new Array(need);

    for (let s = 0; s < sims; s++) {
      for (let i = 0; i < need; i++) { // partial Fisher-Yates
        const j = i + ((Math.random() * (deck.length - i)) | 0);
        const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
        drawn[i] = deck[i];
      }

      full[0] = hero[0]; full[1] = hero[1];
      for (let i = 0; i < board.length; i++) full[2 + i] = board[i];
      for (let i = 0; i < runout; i++) full[2 + board.length + i] = drawn[i];

      const hs = evaluate(full);
      cats[catOf(hs)]++;

      let best = -1; let tied = 1;
      for (let o = 0; o < nOpp; o++) {
        opp[0] = drawn[runout + o * 2];
        opp[1] = drawn[runout + o * 2 + 1];
        for (let i = 0; i < 5; i++) opp[2 + i] = full[2 + i];
        const os = evaluate(opp);
        if (os > best) { best = os; tied = 1; } else if (os === best) tied++;
      }

      if (hs > best) win++;
      else if (hs === best) { tieCount++; tieShare += 1 / (tied + 1); }
      else lose++;
    }

    return {
      sims,
      win: win / sims,
      tie: tieCount / sims,
      lose: lose / sims,
      equity: (win + tieShare) / sims,
      cats: cats.map((n) => n / sims),
    };
  }

  // Cards that lift hero into a strictly better hand class next street.
  function improvementOuts(hero, board) {
    if (hero.length !== 2 || board.length < 3 || board.length > 4) return null;
    const known = hero.concat(board);
    const cur = catOf(evaluate(known));

    let count = 0;
    for (let c = 0; c < 52; c++) {
      if (known.indexOf(c) >= 0) continue;
      if (catOf(evaluate(known.concat([c]))) > cur) count++;
    }
    return { count, current: cur, streetsLeft: board.length === 3 ? 2 : 1 };
  }

  function drawInfo(hero, board) {
    const all = hero.concat(board);
    const sc = [0, 0, 0, 0];
    const heroSuits = [0, 0, 0, 0];
    let mask = 0;

    for (const c of all) { sc[c & 3]++; mask |= 1 << (c >> 2); }
    for (const c of hero) heroSuits[c & 3]++;

    let flushDraw = false; let backdoorFlush = false;
    for (let s = 0; s < 4; s++) {
      if (sc[s] === 4 && heroSuits[s] > 0) flushDraw = true;
      if (sc[s] === 3 && heroSuits[s] > 0 && board.length === 3) backdoorFlush = true;
    }

    let oesd = false; let gutshot = false;
    if (straightHigh(mask) < 0) {
      for (let r = 0; r < 13; r++) {
        if ((mask >> r) & 1) continue;
        if (straightHigh(mask | (1 << r)) >= 0) {
          let neighbours = 0;
          if (r > 0 && ((mask >> (r - 1)) & 1)) neighbours++;
          if (r < 12 && ((mask >> (r + 1)) & 1)) neighbours++;
          if (neighbours === 1) oesd = true; else gutshot = true;
        }
      }
    }

    return { flushDraw, backdoorFlush, oesd, gutshot: gutshot && !oesd };
  }

  function boardTexture(board) {
    const rc = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const sc = [0, 0, 0, 0];
    let mask = 0;
    for (const c of board) { rc[c >> 2]++; sc[c & 3]++; mask |= 1 << (c >> 2); }

    let paired = false; let trips = false; let quads = false;
    for (let r = 0; r < 13; r++) {
      if (rc[r] === 2) paired = true;
      if (rc[r] === 3) trips = true;
      if (rc[r] === 4) quads = true;
    }

    let flushPossible = false; let flushDrawPossible = false;
    for (let s = 0; s < 4; s++) {
      if (sc[s] >= 3) flushPossible = true;
      if (sc[s] === 2 && board.length < 5) flushDrawPossible = true;
    }

    let straightPossible = false;
    for (let a = 0; a < 13 && !straightPossible; a++) {
      for (let b = a; b < 13; b++) {
        if (straightHigh(mask | (1 << a) | (1 << b)) >= 0) { straightPossible = true; break; }
      }
    }

    return { paired, trips, quads, flushPossible, flushDrawPossible, straightPossible };
  }

  // Chen formula — a cheap preflop sanity read, not a solver.
  function chenScore(hero) {
    const r1 = Math.max(cardRank(hero[0]), cardRank(hero[1]));
    const r2 = Math.min(cardRank(hero[0]), cardRank(hero[1]));
    const val = (r) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);

    if (r1 === r2) return Math.max(val(r1) * 2, 5);

    let pts = val(r1);
    if (cardSuit(hero[0]) === cardSuit(hero[1])) pts += 2;

    const gap = r1 - r2 - 1;
    if (gap === 1) pts -= 1;
    else if (gap === 2) pts -= 2;
    else if (gap === 3) pts -= 4;
    else if (gap >= 4) pts -= 5;
    if (gap <= 1 && r1 < 10) pts += 1;

    return Math.ceil(pts * 2) / 2;
  }

  function heroLabel(hero) {
    if (hero.length !== 2) return '';
    const a = Math.max(cardRank(hero[0]), cardRank(hero[1]));
    const b = Math.min(cardRank(hero[0]), cardRank(hero[1]));
    if (a === b) return RANK_CHARS[a] + RANK_CHARS[b];
    return RANK_CHARS[a] + RANK_CHARS[b] + (cardSuit(hero[0]) === cardSuit(hero[1]) ? 's' : 'o');
  }

  /* ==========================================================================
   * 2. LOG PARSER
   *
   * PokerNow writes one line per event. The wording below is what the client
   * renders and what the official CSV export contains. Unknown lines are kept
   * verbatim as `type: 'unknown'` rather than dropped, so nothing is silently
   * lost and the Diag tab can show what the parser did not understand.
   * ========================================================================== */

  const PLAYER = '"([^"]+)"';

  // "Alice @ 8fJ2kQ" -> { name: 'Alice', id: '8fJ2kQ' }
  function splitPlayer(raw) {
    const s = String(raw || '').trim();
    const at = s.lastIndexOf(' @ ');
    if (at < 0) return { name: s, id: s };
    return { name: s.slice(0, at).trim(), id: s.slice(at + 3).trim() };
  }

  const amount = (v) => {
    const n = Number(String(v).replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  function parseCardList(raw) {
    return String(raw || '')
      .split(',')
      .map((s) => parseCard(s.replace(/[[\]]/g, '').trim()))
      .filter((c) => c >= 0);
  }

  const LOG_RULES = [
    [/^--\s*starting hand\s*#(\d+)/i, (m, line) => {
      const dealer = line.match(/dealer:\s*"([^"]+)"/i);
      const variant = line.match(/\(([^)]*Hold'?em[^)]*|[^)]*Omaha[^)]*)\)/i);
      return {
        type: 'hand-start',
        hand: Number(m[1]),
        dealer: dealer ? splitPlayer(dealer[1]) : null,
        variant: variant ? variant[1].trim() : null,
      };
    }],

    [/^--\s*ending hand\s*#(\d+)/i, (m) => ({ type: 'hand-end', hand: Number(m[1]) })],

    [/^Player stacks:\s*(.+)$/i, (m) => ({
      type: 'stacks',
      players: m[1].split('|').map((chunk) => {
        const hit = chunk.match(/#(\d+)\s*"([^"]+)"\s*\(([\d.,]+)\)/);
        if (!hit) return null;
        return { seat: Number(hit[1]), ...splitPlayer(hit[2]), stack: amount(hit[3]) };
      }).filter(Boolean),
    })],

    [/^Your hand is\s+(.+)$/i, (m) => ({ type: 'hero-cards', cards: parseCardList(m[1]) })],

    [new RegExp(`^${PLAYER}\\s+posts a small blind of\\s+([\\d.,]+)`, 'i'),
      (m) => ({ type: 'post', blind: 'sb', player: splitPlayer(m[1]), amount: amount(m[2]) })],

    [new RegExp(`^${PLAYER}\\s+posts a big blind of\\s+([\\d.,]+)`, 'i'),
      (m) => ({ type: 'post', blind: 'bb', player: splitPlayer(m[1]), amount: amount(m[2]) })],

    [new RegExp(`^${PLAYER}\\s+posts a straddle of\\s+([\\d.,]+)`, 'i'),
      (m) => ({ type: 'post', blind: 'straddle', player: splitPlayer(m[1]), amount: amount(m[2]) })],

    [new RegExp(`^${PLAYER}\\s+folds`, 'i'), (m) => ({ type: 'action', action: 'fold', player: splitPlayer(m[1]) })],
    [new RegExp(`^${PLAYER}\\s+checks`, 'i'), (m) => ({ type: 'action', action: 'check', player: splitPlayer(m[1]) })],

    [new RegExp(`^${PLAYER}\\s+calls\\s+([\\d.,]+)`, 'i'), (m, line) => ({
      type: 'action', action: 'call', player: splitPlayer(m[1]), amount: amount(m[2]), allIn: /all\s*in/i.test(line),
    })],

    [new RegExp(`^${PLAYER}\\s+bets\\s+([\\d.,]+)`, 'i'), (m, line) => ({
      type: 'action', action: 'bet', player: splitPlayer(m[1]), amount: amount(m[2]), allIn: /all\s*in/i.test(line),
    })],

    [new RegExp(`^${PLAYER}\\s+raises to\\s+([\\d.,]+)`, 'i'), (m, line) => ({
      type: 'action', action: 'raise', player: splitPlayer(m[1]), amount: amount(m[2]), allIn: /all\s*in/i.test(line),
    })],

    [/^(Flop|Turn|River):?\s*(.*)$/i, (m) => {
      const brackets = m[2].match(/\[([^\]]+)\]/g) || [];
      const last = brackets.length ? brackets[brackets.length - 1] : m[2];
      return { type: 'street', street: m[1].toLowerCase(), cards: parseCardList(last) };
    }],

    [new RegExp(`^${PLAYER}\\s+collected\\s+([\\d.,]+)\\s+from pot`, 'i'), (m, line) => {
      const with_ = line.match(/with\s+(.+?)(?:\s*\(|$)/i);
      return { type: 'collect', player: splitPlayer(m[1]), amount: amount(m[2]), hand: with_ ? with_[1].trim() : null };
    }],

    [new RegExp(`^${PLAYER}\\s+shows a\\s+(.+?)\\.?$`, 'i'),
      (m) => ({ type: 'show', player: splitPlayer(m[1]), cards: parseCardList(m[2]) })],

    [new RegExp(`^${PLAYER}\\s+(joined|quits|sits|stands|requested|approved|updated|enqueued|left)`, 'i'),
      (m) => ({ type: 'table', player: splitPlayer(m[1]) })],

    [/^Uncalled bet of\s+([\d.,]+)\s+returned to\s+"([^"]+)"/i,
      (m) => ({ type: 'uncalled', amount: amount(m[1]), player: splitPlayer(m[2]) })],
  ];

  function parseLogLine(rawLine) {
    const line = String(rawLine || '').replace(/\s+/g, ' ').trim();
    if (!line) return null;

    for (const [pattern, build] of LOG_RULES) {
      const m = line.match(pattern);
      if (m) return { ...build(m, line), line };
    }
    return { type: 'unknown', line };
  }

  /*
   * Folds a stream of parsed events into hands. Street contribution is tracked
   * per player because PokerNow reports "raises to X" as a street total but
   * "bets X" as a fresh amount — mixing those up corrupts every pot figure.
   */
  function replay(events) {
    const hands = [];
    let hand = null;

    const startHand = (number, dealer) => ({
      hand: number,
      dealer,
      board: [],
      hero: [],
      players: {},
      actions: [],
      street: 'preflop',
      contributions: {},
      streetContrib: {},
      pot: 0,
      winners: [],
      shown: {},
      complete: false,
    });

    const seat = (h, p) => {
      if (!h.players[p.id]) h.players[p.id] = { ...p, stack: null };
      return h.players[p.id];
    };

    const put = (h, p, target, { additive = false } = {}) => {
      seat(h, p);
      const prev = h.streetContrib[p.id] || 0;
      const delta = additive ? target : Math.max(0, target - prev);
      h.streetContrib[p.id] = prev + delta;
      h.contributions[p.id] = (h.contributions[p.id] || 0) + delta;
      h.pot += delta;
      return delta;
    };

    for (const e of events) {
      if (!e) continue;

      if (e.type === 'hand-start') {
        if (hand) hands.push(hand);
        hand = startHand(e.hand, e.dealer);
        continue;
      }

      if (!hand) hand = startHand(null, null);

      switch (e.type) {
        case 'stacks':
          for (const p of e.players) hand.players[p.id] = { ...p };
          break;

        case 'hero-cards':
          hand.hero = e.cards;
          break;

        case 'post':
          put(hand, e.player, e.amount);
          seat(hand, e.player).posted = true;
          break;

        case 'action': {
          const rec = { ...e, street: hand.street };
          if (e.action === 'call' || e.action === 'raise') rec.paid = put(hand, e.player, e.amount);
          else if (e.action === 'bet') rec.paid = put(hand, e.player, e.amount, { additive: true });
          else seat(hand, e.player);

          if (e.action === 'fold') seat(hand, e.player).folded = true;
          hand.actions.push(rec);
          break;
        }

        case 'street':
          hand.street = e.street;
          hand.streetContrib = {};
          hand.board = hand.board.concat(e.cards).slice(0, 5);
          break;

        case 'collect':
          hand.winners.push({ ...e.player, amount: e.amount, hand: e.hand });
          break;

        case 'uncalled':
          hand.pot -= e.amount;
          hand.contributions[e.player.id] = (hand.contributions[e.player.id] || 0) - e.amount;
          break;

        case 'show':
          hand.shown[e.player.id] = e.cards;
          break;

        case 'hand-end':
          hand.complete = true;
          hands.push(hand);
          hand = null;
          break;

        default:
          break;
      }
    }

    if (hand) hands.push(hand);
    return hands;
  }

  /*
   * Player statistics. Every figure is derived from observed lines only, so a
   * player who has not been dealt in yet shows as "—" rather than 0%.
   */
  function accumulate(hands, into = {}) {
    const stats = into;

    const row = (p) => {
      if (!stats[p.id]) {
        stats[p.id] = {
          id: p.id, name: p.name, hands: 0, vpip: 0, pfr: 0,
          bets: 0, raises: 0, calls: 0, folds: 0, showdowns: 0, net: 0,
        };
      }
      stats[p.id].name = p.name || stats[p.id].name;
      return stats[p.id];
    };

    for (const h of hands) {
      const dealtIn = new Set();
      for (const a of h.actions) dealtIn.add(a.player.id);
      for (const id of Object.keys(h.contributions)) dealtIn.add(id);

      for (const id of dealtIn) {
        const p = h.players[id] || { id, name: id };
        row(p).hands++;
      }

      const voluntary = new Set();
      const raisedPre = new Set();

      for (const a of h.actions) {
        const r = row(a.player);

        if (a.action === 'bet') r.bets++;
        if (a.action === 'raise') r.raises++;
        if (a.action === 'call') r.calls++;
        if (a.action === 'fold') r.folds++;

        if (a.street === 'preflop') {
          if (a.action === 'call' || a.action === 'bet' || a.action === 'raise') voluntary.add(a.player.id);
          if (a.action === 'raise' || a.action === 'bet') raisedPre.add(a.player.id);
        }
      }

      for (const id of voluntary) if (stats[id]) stats[id].vpip++;
      for (const id of raisedPre) if (stats[id]) stats[id].pfr++;
      for (const id of Object.keys(h.shown)) if (stats[id]) stats[id].showdowns++;

      for (const [id, paid] of Object.entries(h.contributions)) {
        if (stats[id]) stats[id].net -= paid;
      }
      for (const w of h.winners) {
        const r = row(w);
        r.net += w.amount || 0;
      }
    }

    return stats;
  }

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

  function statView(s) {
    return {
      ...s,
      vpipPct: pct(s.vpip, s.hands),
      pfrPct: pct(s.pfr, s.hands),
      // No calls at all is not "no data" — it is a player who has never called.
      af: s.calls > 0 ? Math.round(((s.bets + s.raises) / s.calls) * 10) / 10
        : (s.bets + s.raises > 0 ? Infinity : null),
    };
  }

  /* ==========================================================================
   * 3. ADVICE
   * ========================================================================== */

  const MODE_MARGIN = { TIGHT: 0.06, NORMAL: 0.02, LOOSE: -0.03 };
  const pctText = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

  function advise(s, mode) {
    const notes = [];
    const warns = [];
    const margin = MODE_MARGIN[mode] ?? 0.02;
    const toCall = s.toCall || 0;
    const pot = s.pot || 0;
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : null;

    if (s.board.length === 0) {
      const chen = chenScore(s.hero);
      const late = s.position === 'BTN' || s.position === 'CO';
      let open = mode === 'LOOSE' ? 6 : mode === 'TIGHT' ? 9 : 8;
      if (late) open -= 1.5;
      if (s.seats <= 3) open -= 2;

      notes.push(`Chen score ${chen} (open threshold ~${open})`);

      let action; let sub;
      if (toCall <= 0) {
        if (chen >= open + 4) { action = 'RAISE'; sub = 'Strong opener — raise 3x'; }
        else if (chen >= open) { action = 'RAISE'; sub = 'Standard open'; }
        else { action = 'CHECK'; sub = 'Take the free look'; }
      } else if (toCall <= s.bigBlind * 1.5) {
        if (chen >= open + 5) { action = 'RAISE'; sub = 'Raise for value'; }
        else if (chen >= open - 1) { action = 'CALL'; sub = 'Cheap enough to see a flop'; }
        else { action = 'FOLD'; sub = 'Not worth the blind'; }
      } else if (chen >= open + 6) { action = 'RAISE'; sub = 'Re-raise range'; }
      else if (chen >= open + 1) { action = 'CALL'; sub = 'Call the raise'; }
      else { action = 'FOLD'; sub = 'Facing a raise with a weak hand'; }

      if (s.seats >= 7) notes.push('Full table — more hands behind you, open tighter');
      if (late) notes.push('Late position — you act last postflop');

      return { action, sub, notes, warns, potOdds };
    }

    const eq = s.sim ? s.sim.equity : null;
    const tex = boardTexture(s.board);
    const draws = drawInfo(s.hero, s.board);
    const madeCat = catOf(evaluate(s.hero.concat(s.board)));

    const heroRanks = s.hero.map(cardRank);
    const boardRanks = s.board.map(cardRank);
    const playingBoard = s.board.length === 5
      && evaluate(s.board) === evaluate(s.hero.concat(s.board))
      && heroRanks.every((r) => boardRanks.indexOf(r) < 0);

    if (tex.trips) warns.push('TRIPS ON BOARD — a full house is live for everyone.');
    else if (tex.paired) warns.push('BOARD IS PAIRED — full house / trips possible.');
    if (tex.flushPossible) warns.push('FLUSH POSSIBLE — three of a suit out there.');
    else if (tex.flushDrawPossible) warns.push('Flush draw possible on this board.');
    if (tex.straightPossible) warns.push('STRAIGHT POSSIBLE — connected board.');
    if (playingBoard) warns.push('You are playing the board — your cards add nothing.');

    if (draws.flushDraw) notes.push('You have a flush draw (~9 outs).');
    if (draws.oesd) notes.push('Open-ended straight draw (~8 outs).');
    else if (draws.gutshot) notes.push('Gutshot straight draw (~4 outs).');
    if (draws.backdoorFlush) notes.push('Backdoor flush possibility.');

    if (s.outs) {
      const rough = s.outs.streetsLeft === 2 ? s.outs.count * 4 : s.outs.count * 2;
      notes.push(`${s.outs.count} cards improve your hand class (~${Math.min(rough, 95)}% by river).`);
    }

    if (eq === null) return { action: '—', sub: 'Waiting for cards', notes, warns, potOdds };

    let action; let sub;
    if (toCall > 0) {
      if (eq > potOdds + 0.20 + margin && eq > 0.62) { action = 'RAISE'; sub = 'Ahead of the price — build the pot'; }
      else if (eq > potOdds + margin) { action = 'CALL'; sub = 'Equity beats the price'; }
      else if (eq > potOdds - 0.04 && (draws.flushDraw || draws.oesd) && s.board.length < 5) {
        action = 'CALL'; sub = 'Close, but the draw has implied odds';
      } else { action = 'FOLD'; sub = 'Price is worse than your equity'; }
      notes.push(`Pot odds need ${pctText(potOdds)}, you have ${pctText(eq)}.`);
    } else if (eq > 0.72) { action = 'BET'; sub = 'Value bet ~2/3 pot'; }
    else if (eq > 0.55 && madeCat >= 1) { action = 'BET'; sub = 'Thin value / protection, ~1/3 pot'; }
    else if (eq > 0.45 || draws.flushDraw || draws.oesd) { action = 'CHECK'; sub = 'Keep the pot small, see the next card'; }
    else { action = 'CHECK'; sub = 'Check and give up if bet into'; }

    if (mode === 'LOOSE' && toCall <= 0 && (draws.flushDraw || draws.oesd) && eq > 0.35) {
      action = 'BET'; sub = 'Semi-bluff with your draw';
    }

    if (s.spr !== null && s.spr < 3) notes.push(`Low SPR (${s.spr.toFixed(1)}) — commit or fold, no thin calls.`);
    else if (s.spr !== null && s.spr > 12) notes.push(`Deep SPR (${s.spr.toFixed(1)}) — implied odds matter.`);
    if (s.opponents >= 3) notes.push(`${s.opponents} opponents — someone usually has it.`);

    return { action, sub, notes, warns, potOdds };
  }

  /*
   * Blind levels read as "NLH ~ 20 / 40", and the same corner of the screen also
   * carries "NEXT BLIND: 40/80". Taking the first number found gives the small
   * blind, and reading the wrong line gives the level that has not started yet —
   * both make every "cheap enough to see a flop" call wrong by a factor of two.
   */
  function parseBlinds(text) {
    const s = String(text || '');
    if (/next/i.test(s)) return null;

    const num = (v) => {
      const n = Number(String(v).replace(/,/g, ''));
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const pair = s.match(/(\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)/);
    if (pair) {
      const sb = num(pair[1]);
      const bb = num(pair[2]);
      return bb ? { sb, bb } : null;
    }

    const one = s.match(/(\d[\d,]*(?:\.\d+)?)/);
    const bb = one ? num(one[1]) : null;
    return bb ? { sb: null, bb } : null;
  }

  const combinationCount = (n, k) => {
    let c = 1;
    for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
    return c;
  };

  /*
   * Equity when some opponents' cards are face up — at an all-in showdown, or
   * after someone shows. `simulate` deals every opponent a random hand, which is
   * simply wrong once the cards are on the felt. With no unknown opponents left
   * and few board cards to come this enumerates every runout instead of
   * sampling, so the answer is exact rather than noisy.
   */
  function equityVsKnown(hero, board, oppHands, unknownOpps, sims) {
    const opps = (oppHands || []).filter((h) => h && h.length === 2);
    const unknown = unknownOpps || 0;
    if (hero.length !== 2 || opps.length + unknown < 1) return null;

    const used = hero.concat(board);
    for (const h of opps) used.push(h[0], h[1]);
    if (new Set(used).size !== used.length) return null; // a card read twice

    const deck = [];
    for (let c = 0; c < 52; c++) if (used.indexOf(c) < 0) deck.push(c);

    const need = 5 - board.length;
    if (need < 0 || need + 2 * unknown > deck.length) return null;

    const full = new Array(7);
    const oppBuf = new Array(7);
    const cats = new Array(9).fill(0);
    let win = 0;
    let tieCount = 0;
    let tieShare = 0;
    let trials = 0;

    full[0] = hero[0];
    full[1] = hero[1];
    for (let i = 0; i < board.length; i++) full[2 + i] = board[i];

    const settle = (runout, extraOpps) => {
      for (let i = 0; i < need; i++) full[2 + board.length + i] = runout[i];

      const hs = evaluate(full);
      cats[catOf(hs)]++;

      let best = -1;
      let tied = 1;
      const consider = (a, b) => {
        oppBuf[0] = a;
        oppBuf[1] = b;
        for (let i = 0; i < 5; i++) oppBuf[2 + i] = full[2 + i];
        const os = evaluate(oppBuf);
        if (os > best) { best = os; tied = 1; } else if (os === best) tied++;
      };

      for (const h of opps) consider(h[0], h[1]);
      for (let o = 0; o < unknown; o++) consider(extraOpps[o * 2], extraOpps[o * 2 + 1]);

      if (hs > best) win++;
      else if (hs === best) { tieCount++; tieShare += 1 / (tied + 1); }
      trials++;
    };

    const exact = unknown === 0 && combinationCount(deck.length, need) <= 200000;

    if (exact) {
      const pick = new Array(need);
      const walk = (start, depth) => {
        if (depth === need) { settle(pick, null); return; }
        for (let i = start; i <= deck.length - (need - depth); i++) {
          pick[depth] = deck[i];
          walk(i + 1, depth + 1);
        }
      };
      walk(0, 0);
    } else {
      const draws = need + 2 * unknown;
      const drawn = new Array(draws);
      const runout = new Array(need);
      const extra = new Array(2 * unknown);

      for (let s = 0; s < (sims || 8000); s++) {
        for (let i = 0; i < draws; i++) {
          const j = i + ((Math.random() * (deck.length - i)) | 0);
          const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
          drawn[i] = deck[i];
        }
        for (let i = 0; i < need; i++) runout[i] = drawn[i];
        for (let i = 0; i < 2 * unknown; i++) extra[i] = drawn[need + i];
        settle(runout, extra);
      }
    }

    return {
      exact,
      trials,
      sims: trials,
      win: win / trials,
      tie: tieCount / trials,
      lose: (trials - win - tieCount) / trials,
      equity: (win + tieShare) / trials,
      cats: cats.map((n) => n / trials),
    };
  }

  /* ==========================================================================
   * Node export: everything above is pure and unit-tested.
   * ========================================================================== */

  const API = {
    RANK_CHARS, SUIT_CHARS, CAT_NAMES,
    parseCard, cardStr, cardPretty, evaluate, catOf, handName, simulate,
    improvementOuts, drawInfo, boardTexture, chenScore, heroLabel, straightHigh,
    parseLogLine, replay, accumulate, statView, splitPlayer, advise,
    parseBlinds, equityVsKnown, combinationCount,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof document === 'undefined') return;

  /* ==========================================================================
   * 4. DOM ADAPTER (the felt)
   *
   * Every read reports where it came from so the Diag tab can show which
   * strategy fired and which returned nothing.
   * ========================================================================== */

  const SEL = {
    player: '.table-player',
    hero: '.table-player.you-player, .you-player',
    heroCards: '.you-player .card',
    board: ['.table-cards .card', '.community-cards .card', '.table-community-cards .card'],
    anyCard: '.card',
    name: '.table-player-name',
    stack: '.table-player-stack',
    bet: '.table-player-bet-value',
    pot: '.table-pot-size',
    blinds: '.blind-value, .table-blinds, [class*="blind"]',
    buttons: '.game-decisions-ctn button, .action-buttons button, .controls-ctn button',
    dealer: '.dealer-button-ctn, .dealer-button',
    log: ['.log-entries', '.game-log', '.messages-ctn', '.log-ctn'],
    logEntry: ['.log-entry', '.message', 'li', 'p'],
  };

  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const q = (sel, root) => (root || document).querySelector(sel);

  function numFrom(text) {
    if (!text) return null;
    const m = String(text).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function readCardEl(el) {
    const v = q('.value', el);
    const s = q('.suit', el);
    if (v && s) {
      const c = parseCard(v.textContent.trim() + s.textContent.trim());
      if (c >= 0) return c;
    }
    const t = (el.textContent || '').replace(/\s+/g, '');
    const m = t.match(/(10|[2-9TJQKAtjqka])([cdhs♣♦♥♠])/);
    return m ? parseCard(m[1] + m[2]) : -1;
  }

  function collectCards(els, limit) {
    const out = [];
    for (const el of els) {
      const c = readCardEl(el);
      if (c >= 0 && out.indexOf(c) < 0) out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }

  const opacityOf = (el) => {
    try {
      const v = parseFloat(getComputedStyle(el).opacity);
      return Number.isFinite(v) ? v : 1;
    } catch { return 1; }
  };

  const meanOpacity = (els) => els.reduce((a, el) => a + opacityOf(el), 0) / (els.length || 1);

  function groupByContainer(els) {
    const groups = [];
    const index = new Map();
    for (const el of els) {
      const key = ((el.closest('.card-container') || el).parentElement) || el;
      if (!index.has(key)) { index.set(key, groups.length); groups.push([]); }
      groups[index.get(key)].push(el);
    }
    return groups;
  }

  const inDocOrder = (a, b) => ((a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

  /*
   * Run it twice puts two boards on the felt at once. Blending them produces a
   * board that was never dealt — and therefore an equity figure for a hand that
   * does not exist. Prefer a single container; if one container holds both runs,
   * keep the brighter five (the second run is rendered dimmed until it is live)
   * and say so in Diag rather than quietly picking.
   */
  function pickBoard(els, diag) {
    if (!els.length) return [];

    const groups = groupByContainer(els);
    let chosen = groups[0];

    if (groups.length > 1) {
      diag.boards = groups.length + ' card groups — run it twice?';
      chosen = groups.slice().sort((a, b) => meanOpacity(b) - meanOpacity(a))[0];
    }

    if (chosen.length > 5) {
      diag.boards = chosen.length + ' board cards — run it twice?';
      chosen = chosen.slice()
        .sort((a, b) => opacityOf(b) - opacityOf(a))
        .slice(0, 5)
        .sort(inDocOrder);
    }

    return collectCards(chosen, 5);
  }

  function readBoard(diag) {
    for (const sel of SEL.board) {
      const els = qa(sel);
      if (!els.length) continue;
      const cards = pickBoard(els, diag);
      if (cards.length) { diag.board = sel; return cards; }
    }

    const loose = qa(SEL.anyCard).filter((el) => !el.closest(SEL.player));
    const cards = pickBoard(loose, diag);
    diag.board = cards.length ? 'fallback: cards outside seats' : null;
    return cards;
  }

  /*
   * The log lives behind a "LOG / LEDGER" control and is closed by default, so
   * on a real table there is nothing to read until it is opened. Finding the
   * control lets the panel offer a button instead of sitting there empty.
   */
  let logButtonCache = { at: 0, el: null };

  function findLogButton() {
    if (Date.now() - logButtonCache.at < 5000) return logButtonCache.el;

    const looksLikeLog = (el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return t && t.length <= 24 && /^log\s*\/?\s*(ledger)?$/i.test(t);
    };

    // Clickable elements first. A wrapper div can carry the same text, and
    // clicking a wrapper does not fire the listener bound to the control inside
    // it — so if a match is not itself clickable, drill down to what is.
    let found = qa('button, a, [role="button"]').find(looksLikeLog)
      || qa('[class*="log"]').find(looksLikeLog)
      || null;
    if (found && !found.matches('button, a, [role="button"]')) {
      found = found.querySelector('button, a, [role="button"]') || found;
    }

    logButtonCache = { at: Date.now(), el: found };
    return found;
  }

  function isActiveSeat(p) {
    if (/fold/i.test(p.className || '')) return false;
    const txt = (p.textContent || '').toUpperCase();
    if (txt.includes('FOLD') && !q('.card', p)) return false;
    if (txt.includes('WAITING')) return false;
    return !!q('.card, .card-container', p);
  }

  const seatIndex = (el) => {
    const m = (el.className || '').match(/table-player-(\d+)/);
    return m ? Number(m[1]) : null;
  };

  function readPosition(seats, heroSeat) {
    const dealerEl = q(SEL.dealer);
    if (!dealerEl || heroSeat === null) return null;

    const dm = (dealerEl.className || '').match(/(?:dealer-position|button-position)-(\d+)/);
    if (!dm) return null;

    const ordered = seats.slice().sort((a, b) => a - b);
    const bi = ordered.indexOf(Number(dm[1]));
    const hi = ordered.indexOf(heroSeat);
    if (bi < 0 || hi < 0) return null;

    const n = ordered.length;
    const after = (hi - bi + n) % n;
    if (after === 0) return 'BTN';
    if (n === 2) return after === 1 ? 'BB' : 'BTN';
    if (after === 1) return 'SB';
    if (after === 2) return 'BB';
    if (after === n - 1) return 'CO';
    return after <= Math.floor(n / 2) ? 'EP' : 'MP';
  }

  function readToCall() {
    for (const b of qa(SEL.buttons)) {
      const t = (b.textContent || '').trim();
      if (/\bcall\b/i.test(t)) {
        const n = numFrom(t);
        if (n !== null) return { value: n, from: 'call button' };
      }
      if (/^check/i.test(t)) return { value: 0, from: 'check button' };
    }
    return { value: null, from: null };
  }

  let bbGuess = 0;
  function guessBigBlind(pot) {
    for (const el of qa(SEL.blinds)) {
      const level = parseBlinds(el.textContent);
      if (level && level.bb) { bbGuess = level.bb; return bbGuess; }
    }
    if (!bbGuess && pot > 0) bbGuess = Math.max(1, Math.round(pot / 3));
    return bbGuess || 1;
  }

  function scrapeTable() {
    const diag = {};
    const heroEl = q(SEL.hero);
    const players = qa(SEL.player);

    diag.hero = heroEl ? SEL.hero : null;
    diag.seats = players.length;

    const hero = collectCards(qa(SEL.heroCards), 2);
    const board = readBoard(diag).filter((c) => hero.indexOf(c) < 0).slice(0, 5);

    const seatNums = [];
    const shownHands = [];
    let opponents = 0;
    let maxOppStack = 0;
    let maxBet = 0;
    let betSum = 0;

    for (const p of players) {
      const si = seatIndex(p);
      const isHero = heroEl && (p === heroEl || p.contains(heroEl) || heroEl.contains(p));
      const active = isActiveSeat(p);
      if (active && si !== null) seatNums.push(si);

      const bet = numFrom((q(SEL.bet, p) || {}).textContent);
      if (bet) { betSum += bet; if (bet > maxBet) maxBet = bet; }

      if (!isHero && active) {
        opponents++;
        const st = numFrom((q(SEL.stack, p) || {}).textContent) || 0;
        if (st > maxOppStack) maxOppStack = st;

        // Face-up cards at a showdown: card backs read as -1 and are skipped.
        const shown = collectCards(qa(SEL.anyCard, p), 2);
        if (shown.length === 2) shownHands.push(shown);
      }
    }

    const heroStack = heroEl ? (numFrom((q(SEL.stack, heroEl) || {}).textContent) || 0) : 0;
    const heroBet = heroEl ? (numFrom((q(SEL.bet, heroEl) || {}).textContent) || 0) : 0;
    const potEl = q(SEL.pot);
    const pot = (potEl ? numFrom(potEl.textContent) || 0 : 0) + betSum;
    diag.pot = potEl ? SEL.pot : null;

    const call = readToCall();
    diag.toCall = call.from;
    const toCall = call.value !== null ? call.value : Math.max(0, maxBet - heroBet);

    const heroSeat = heroEl ? seatIndex(heroEl) : null;
    const effStack = Math.min(heroStack || Infinity, maxOppStack || Infinity);

    return {
      hero,
      board,
      pot,
      toCall,
      heroStack,
      bigBlind: guessBigBlind(pot),
      opponents: Math.max(opponents, 1),
      shownHands,
      multiBoard: !!diag.boards,
      seats: players.length,
      position: readPosition(seatNums, heroSeat),
      spr: pot > 0 && Number.isFinite(effStack) ? effStack / pot : null,
      street: ['Preflop', '', '', 'Flop', 'Turn', 'River'][board.length] || 'Preflop',
      diag,
    };
  }

  /* --------------------------------------------------------- log ingestion */

  function findLogRoot() {
    for (const sel of SEL.log) {
      const el = q(sel);
      if (el) return { el, sel };
    }
    return { el: null, sel: null };
  }

  /*
   * Lines are claimed per DOM node, never by their text: "Bob folds" is a line
   * that legitimately recurs every few hands, so content-based deduplication
   * would drop all but the first one and quietly corrupt every stat.
   */
  const logState = { orientation: 0, fallbackCount: 0 };

  // +1 oldest-first, -1 newest-first, 0 not yet determined.
  function detectOrientation(texts) {
    const numbers = [];
    for (const t of texts) {
      const m = t.match(/^--\s*(?:starting|ending) hand\s*#(\d+)/i);
      if (m) numbers.push(Number(m[1]));
    }
    if (numbers.length < 2) return 0;

    const first = numbers[0];
    const last = numbers[numbers.length - 1];
    if (first === last) return 0;
    return first > last ? -1 : 1;
  }

  function readNewLogLines(root) {
    for (const sel of SEL.logEntry) {
      const nodes = qa(sel, root);
      if (!nodes.length) continue;

      logDiag.lines = nodes.length;
      const text = (n) => (n.innerText || n.textContent || '').trim();

      if (!logState.orientation) logState.orientation = detectOrientation(nodes.map(text));

      const fresh = [];
      for (const n of nodes) {
        if (n.dataset && n.dataset.pnpSeen) continue;
        if (n.dataset) n.dataset.pnpSeen = '1';
        const t = text(n);
        if (t) fresh.push(t);
      }
      return logState.orientation < 0 ? fresh.reverse() : fresh;
    }

    // No per-entry elements to mark — fall back to a running line count.
    const all = (root.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
    logDiag.lines = all.length;
    const fresh = all.slice(logState.fallbackCount);
    logState.fallbackCount = all.length;
    return fresh;
  }

  /* ==========================================================================
   * 5. WEBSOCKET RECORDER (diagnostic only — no parser, by design)
   * ========================================================================== */

  const wsLog = [];

  function describe(data) {
    if (typeof data !== 'string') return { kind: typeof data, sample: null };
    const trimmed = data.slice(0, 400);
    try {
      const parsed = JSON.parse(data);
      return { kind: 'json', keys: Object.keys(parsed).slice(0, 12), sample: trimmed };
    } catch {
      return { kind: 'text', sample: trimmed };
    }
  }

  (function hookWebSocket() {
    const Native = window.WebSocket;
    if (typeof Native !== 'function') return;

    function Wrapped(url, protocols) {
      const socket = protocols === undefined ? new Native(url) : new Native(url, protocols);
      try {
        socket.addEventListener('message', (ev) => {
          if (wsLog.length > 200) wsLog.shift();
          wsLog.push({ at: Date.now(), url: String(url), ...describe(ev.data) });
        });
      } catch { /* recording is best-effort */ }
      return socket;
    }

    Wrapped.prototype = Native.prototype;
    Wrapped.CONNECTING = Native.CONNECTING;
    Wrapped.OPEN = Native.OPEN;
    Wrapped.CLOSING = Native.CLOSING;
    Wrapped.CLOSED = Native.CLOSED;

    try { window.WebSocket = Wrapped; } catch { /* leave the native one alone */ }
  }());

  /* ==========================================================================
   * 6. STATE
   * ========================================================================== */

  const blank = () => ({
    version: VERSION,
    mode: 'NORMAL',
    sims: 6000,
    tab: 'play',
    collapsed: false,
    pos: null,
    stats: {},
    hands: [],
    recorded: {},
  });

  let state;
  try {
    const prior = JSON.parse(localStorage.getItem(STORE) || 'null');
    state = prior && typeof prior === 'object' ? { ...blank(), ...prior } : blank();
    state.stats ||= {};
    state.hands ||= [];
    state.recorded ||= {};
  } catch {
    state = blank();
  }

  let saveQueued = false;
  function save({ rerender = true } = {}) {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        ...state,
        hands: state.hands.slice(-200),
      }));
    } catch (e) {
      console.warn('[PokerNowPanel] persist failed', e);
    }
    // setTimeout, not requestAnimationFrame: rAF is suspended while the tab is
    // in the background, which would freeze the panel behind a stale render.
    if (rerender && !saveQueued) {
      saveQueued = true;
      setTimeout(() => { saveQueued = false; render(); }, 0);
    }
  }

  /* --------------------------------------------------- log -> hands -> stats */

  let pendingEvents = [];

  /*
   * A hand is banked once. Hand numbers restart at 1 on every table, so the key
   * is scoped to the table URL; without it, a page reload would replay the whole
   * visible log into stats that had already been counted.
   */
  const handKey = (h) => location.pathname + '#'
    + (h.hand === null ? h.board.map(cardStr).join('') + ':' + h.pot : h.hand);

  function ingestLog() {
    const { el, sel } = findLogRoot();
    logDiag.selector = sel;
    if (!el) return;

    const lines = readNewLogLines(el);
    if (!lines.length) return;

    let unknown = 0;
    for (const line of lines) {
      const ev = parseLogLine(line);
      if (!ev) continue;
      if (ev.type === 'unknown') { unknown++; logDiag.unparsed.unshift(line); }
      pendingEvents.push(ev);
    }
    logDiag.unparsed = logDiag.unparsed.slice(0, 10);
    logDiag.unknownCount += unknown;

    // Only hands the log has closed are counted; the hand in progress stays in
    // the buffer until its "-- ending hand --" line arrives.
    const lastEnd = pendingEvents.map((e) => e.type).lastIndexOf('hand-end');
    if (lastEnd >= 0) {
      const settled = replay(pendingEvents.slice(0, lastEnd + 1))
        .filter((h) => h.complete && !state.recorded[handKey(h)]);
      pendingEvents = pendingEvents.slice(lastEnd + 1);

      if (settled.length) {
        for (const h of settled) state.recorded[handKey(h)] = 1;
        accumulate(settled, state.stats);
        state.hands.push(...settled.map((h) => ({
          hand: h.hand,
          board: h.board.map(cardStr),
          hero: h.hero.map(cardStr),
          pot: h.pot,
          winners: h.winners.map((w) => ({ name: w.name, amount: w.amount })),
          players: Object.values(h.players).map((p) => p.name),
          actions: h.actions.length,
        })));
      }
    }

    if (pendingEvents.length > 600) pendingEvents = pendingEvents.slice(-600);

    save();
  }

  const logDiag = { selector: null, lines: 0, unparsed: [], unknownCount: 0 };

  /* ==========================================================================
   * 7. RENDER
   * ========================================================================== */

  let panel;
  const simCache = new Map();
  let lastKey = '';

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  function bar(label, value, tint) {
    const width = Math.max(0, Math.min(100, (value || 0) * 100));
    return `<div class="pnp-row">
      <span class="pnp-lbl">${esc(label)}</span>
      <div class="pnp-bar"><i style="width:${width}%;background:${tint}"></i></div>
      <span class="pnp-val">${esc(pctText(value))}</span>
    </div>`;
  }

  function playTab() {
    const s = scrapeTable();
    tableDiag = s.diag;

    if (s.hero.length !== 2) {
      return `<div class="pnp-empty">Waiting for your hole cards…</div>`;
    }

    const shown = s.shownHands.filter((h) => h.every((c) => s.hero.indexOf(c) < 0 && s.board.indexOf(c) < 0));
    const unknownOpps = Math.max(0, s.opponents - shown.length);

    const key = [s.hero.map(cardStr).join(''), s.board.map(cardStr).join(''),
      shown.map((h) => h.map(cardStr).join('')).join('/'),
      s.opponents, s.pot, s.toCall, state.mode, state.sims].join('|');

    let sim = simCache.get(key);
    if (!sim) {
      const budget = Math.max(1500, Math.min(state.sims, Math.round(40000 / (s.opponents + 1))));
      // Once cards are face up, dealing opponents random hands is just wrong.
      sim = shown.length
        ? equityVsKnown(s.hero, s.board, shown, unknownOpps, budget)
        : simulate(s.hero, s.board, s.opponents, budget);
      if (!sim) sim = simulate(s.hero, s.board, s.opponents, budget);
      if (simCache.size > 60) simCache.clear();
      simCache.set(key, sim);
    }
    lastKey = key;

    s.sim = sim;
    s.outs = improvementOuts(s.hero, s.board);

    const made = evaluate(s.hero.concat(s.board));
    const a = advise(s, state.mode);

    const meta = [
      heroLabel(s.hero),
      shown.length ? shown.length + ' hand' + (shown.length > 1 ? 's' : '') + ' face up' : null,
      s.spr !== null ? `SPR ${s.spr.toFixed(1)}` : null,
      a.potOdds !== null ? `MDF ${pctText(1 - a.potOdds)}` : null,
      `Pot ${s.pot}`,
      s.toCall > 0 ? `To call ${s.toCall}` : 'No bet',
      s.position,
    ].filter(Boolean).join(' · ');

    const cats = CAT_NAMES.map((name, i) => `
      <div class="pnp-cat">
        <div class="t"><span>${esc(name)}</span><span>${(sim.cats[i] * 100).toFixed(1)}%</span></div>
        <div class="b"><i style="width:${(sim.cats[i] * 100).toFixed(1)}%"></i></div>
      </div>`).reverse().join('');

    return `
      <div class="pnp-mode">${esc(state.mode)} mode · ${esc(s.street)}</div>
      <div class="pnp-hand">${esc(s.board.length ? handName(made) : heroLabel(s.hero))}</div>
      <div class="pnp-cards">${esc(s.hero.map(cardPretty).join(' '))}${s.board.length ? `   |   ${esc(s.board.map(cardPretty).join(' '))}` : ''}</div>
      <div class="pnp-meta">${esc(meta)}</div>
      ${(s.multiBoard ? ['Two boards on the felt (run it twice) — reading the brighter one.'] : [])
        .concat(a.warns).map((w) => `<div class="pnp-warn">⚠ ${esc(w)}</div>`).join('')}
      ${bar('Win', sim.win, '#20e39c')}
      ${bar('Equity', sim.equity, '#4dc9ff')}
      ${bar('Pot odds', a.potOdds, '#f0c14b')}
      <div class="pnp-action ${esc(a.action.toLowerCase())}">Action: ${esc(a.action)}</div>
      <div class="pnp-sub">${esc(a.sub)}</div>
      <div class="pnp-notes">${a.notes.map((n) => `<div class="pnp-note">${esc(n)}</div>`).join('')}</div>
      <div class="pnp-cats">${cats}</div>
      <div class="pnp-foot">${s.opponents} opp · ${sim.exact ? sim.trials + ' runouts (exact)' : sim.sims + ' sims'}</div>`;
  }

  function hudTab() {
    const rows = Object.values(state.stats)
      .map(statView)
      .sort((a, b) => b.hands - a.hands)
      .slice(0, 12);

    if (!rows.length) {
      const btn = findLogButton();
      return `<div class="pnp-empty">No hands recorded yet.<br>
        <span class="pnp-dim">Stats are built from the table log, which starts closed.</span><br><br>
        ${btn ? '<button data-a="openlog">Open the log panel</button>'
          : '<span class="pnp-dim">Open LOG / LEDGER yourself — the control was not found.</span>'}</div>`;
    }

    const body = rows.map((r) => `
      <div class="pnp-hudrow">
        <span class="pnp-name">${esc(r.name)}</span>
        <span>${r.hands}</span>
        <span>${r.vpipPct === null ? '—' : `${r.vpipPct}%`}</span>
        <span>${r.pfrPct === null ? '—' : `${r.pfrPct}%`}</span>
        <span>${r.af === null ? '—' : Number.isFinite(r.af) ? r.af : '∞'}</span>
        <span class="${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}">${r.net > 0 ? '+' : ''}${Math.round(r.net)}</span>
      </div>`).join('');

    return `
      <div class="pnp-hudrow pnp-hudhead">
        <span>Player</span><span>Hands</span><span>VPIP</span><span>PFR</span><span>AF</span><span>Net</span>
      </div>
      ${body}
      <div class="pnp-foot">VPIP/PFR/AF from observed log lines only.</div>`;
  }

  function handsTab() {
    const rows = state.hands.slice(-15).reverse();
    if (!rows.length) return `<div class="pnp-empty">No completed hands recorded yet.</div>`;

    return rows.map((h) => `
      <div class="pnp-handrow">
        <span class="pnp-dim">#${esc(h.hand ?? '?')}</span>
        <span>${esc(h.hero.join(' ') || '—')}</span>
        <span class="pnp-dim">${esc(h.board.join(' ') || '—')}</span>
        <span>${esc(h.winners.map((w) => `${w.name} +${w.amount}`).join(', ') || '—')}</span>
      </div>`).join('');
  }

  function diagTab() {
    const felt = Object.entries(tableDiag || {})
      .map(([k, v]) => `<div class="pnp-diagrow"><span>${esc(k)}</span><span class="${v ? 'ok' : 'bad'}">${esc(v ?? 'not found')}</span></div>`)
      .join('');

    const unparsed = logDiag.unparsed.length
      ? logDiag.unparsed.map((l) => `<div class="pnp-dim pnp-wrap">${esc(l)}</div>`).join('')
      : '<div class="pnp-dim">none</div>';

    const ws = wsLog.length
      ? `${wsLog.length} messages recorded · last kind: ${esc(wsLog[wsLog.length - 1].kind)}`
      : 'no socket traffic seen';

    return `
      <div class="pnp-sect">Felt selectors</div>${felt || '<div class="pnp-dim">nothing scraped yet</div>'}
      <div class="pnp-sect">Log</div>
      <div class="pnp-diagrow"><span>panel</span><span class="${logDiag.selector ? 'ok' : 'bad'}">${esc(logDiag.selector ?? 'not found — open the table Log')}</span></div>
      <div class="pnp-diagrow"><span>lines read</span><span>${logDiag.lines}</span></div>
      <div class="pnp-diagrow"><span>log control</span><span class="${findLogButton() ? 'ok' : 'bad'}">${findLogButton() ? 'found' : 'not found'}</span></div>
      <div class="pnp-diagrow"><span>order</span><span>${logState.orientation < 0 ? 'newest first' : logState.orientation > 0 ? 'oldest first' : 'assumed oldest first'}</span></div>
      <div class="pnp-diagrow"><span>hands banked</span><span>${Object.keys(state.recorded).length}</span></div>
      <div class="pnp-diagrow"><span>unparsed</span><span class="${logDiag.unknownCount ? 'warn' : 'ok'}">${logDiag.unknownCount}</span></div>
      ${unparsed}
      <div class="pnp-sect">WebSocket recorder</div>
      <div class="pnp-dim pnp-wrap">${esc(ws)}. Shapes only — no parser is guessed. <b>dumpProtocol()</b> in the console prints what was seen.</div>`;
  }

  let tableDiag = {};

  const TABS = [['play', 'Play'], ['hud', 'HUD'], ['hands', 'Hands'], ['diag', 'Diag']];

  function render() {
    if (!panel) return;

    let body = '';
    try {
      body = state.tab === 'play' ? playTab()
        : state.tab === 'hud' ? hudTab()
          : state.tab === 'hands' ? handsTab() : diagTab();
    } catch (e) {
      body = `<div class="pnp-warn">Render failed: ${esc(e.message)}</div>`;
      console.error('[PokerNowPanel]', e);
    }

    panel.innerHTML = `
      <div id="pnp-header">
        <span class="pnp-dot"></span>
        <span class="pnp-title">POKER PANEL v${VERSION}</span>
        <button data-a="mode">${esc(state.mode)}</button>
        <button data-a="export">export</button>
        <button data-a="min">${state.collapsed ? '+' : '–'}</button>
      </div>
      <div class="pnp-body" ${state.collapsed ? 'hidden' : ''}>
        <div class="pnp-tabs">
          ${TABS.map(([id, label]) => `<button data-tab="${id}" class="${state.tab === id ? 'on' : ''}">${label}</button>`).join('')}
        </div>
        <div class="pnp-content">${body}</div>
      </div>`;

    panel.querySelector('[data-a="mode"]').addEventListener('click', () => {
      const order = ['TIGHT', 'NORMAL', 'LOOSE'];
      state.mode = order[(order.indexOf(state.mode) + 1) % order.length];
      simCache.clear();
      save();
    });

    panel.querySelector('[data-a="export"]').addEventListener('click', (e) => (e.shiftKey ? exportJSON() : exportCSV()));

    panel.querySelector('[data-a="min"]').addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      save();
    });

    const openLog = panel.querySelector('[data-a="openlog"]');
    if (openLog) {
      openLog.addEventListener('click', () => {
        const target = findLogButton();
        if (target) target.click();
      });
    }

    for (const btn of panel.querySelectorAll('[data-tab]')) {
      btn.addEventListener('click', () => { state.tab = btn.dataset.tab; save(); });
    }
  }

  /* ==========================================================================
   * 8. EXPORT
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

  const exportJSON = () => download(`pokernow-${stamp()}.json`, 'application/json',
    JSON.stringify({ exportedAt: new Date().toISOString(), version: VERSION, ...state }, null, 2));

  function exportCSV() {
    const head = ['player', 'hands', 'vpip%', 'pfr%', 'af', 'bets', 'raises', 'calls', 'folds', 'showdowns', 'net'];
    const rows = Object.values(state.stats).map(statView).map((r) => [
      r.name, r.hands, r.vpipPct ?? '', r.pfrPct ?? '', r.af ?? '',
      r.bets, r.raises, r.calls, r.folds, r.showdowns, Math.round(r.net),
    ]);

    const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    download(`pokernow-stats-${stamp()}.csv`, 'text/csv;charset=utf-8', csv);
  }

  /* ==========================================================================
   * 9. BOOT
   * ========================================================================== */

  const CSS = `
  #pokernow-panel{position:fixed;top:80px;right:16px;width:340px;max-width:calc(100vw - 16px);z-index:2147483000;
    background:rgba(16,20,28,.95);border:1px solid rgba(255,255,255,.12);border-radius:12px;color:#e7ecf3;
    box-shadow:0 12px 40px rgba(0,0,0,.55);font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    user-select:none;backdrop-filter:blur(8px)}
  #pokernow-panel *{box-sizing:border-box}
  #pnp-header{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;font-weight:700;font-size:11px;
    letter-spacing:.06em;border-bottom:1px solid rgba(255,255,255,.08);
    background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02))}
  #pokernow-panel .pnp-dot{width:7px;height:7px;border-radius:50%;background:#20e39c}
  #pokernow-panel .pnp-title{flex:1}
  #pokernow-panel button{cursor:pointer;padding:2px 6px;border-radius:5px;background:rgba(255,255,255,.08);
    border:1px solid rgba(255,255,255,.1);color:#e7ecf3;font:inherit;font-size:10px;font-weight:700}
  #pokernow-panel button:hover{background:rgba(255,255,255,.18)}
  #pokernow-panel .pnp-body{padding:8px 10px 10px}
  #pokernow-panel .pnp-tabs{display:flex;gap:4px;margin-bottom:8px}
  #pokernow-panel .pnp-tabs button{flex:1;background:transparent;border-color:transparent;color:#8b98a9}
  #pokernow-panel .pnp-tabs button.on{background:rgba(77,201,255,.15);color:#4dc9ff;border-color:rgba(77,201,255,.3)}
  #pokernow-panel .pnp-content{max-height:70vh;overflow:auto}
  #pokernow-panel .pnp-mode{text-align:center;color:#7ee787;font-weight:700;font-size:11px}
  #pokernow-panel .pnp-hand{text-align:center;color:#4dc9ff;font-weight:800;font-size:14px}
  #pokernow-panel .pnp-cards{text-align:center;font-size:15px;letter-spacing:.06em;margin:2px 0}
  #pokernow-panel .pnp-meta{text-align:center;color:#8b98a9;font-size:10px;margin-bottom:6px}
  #pokernow-panel .pnp-warn{background:rgba(240,180,40,.12);border:1px solid rgba(240,180,40,.35);color:#f0c14b;
    border-radius:6px;padding:4px 6px;margin:4px 0;font-size:10.5px}
  #pokernow-panel .pnp-row{display:flex;align-items:center;gap:6px;margin:3px 0}
  #pokernow-panel .pnp-lbl{width:60px;color:#8b98a9;font-size:10px}
  #pokernow-panel .pnp-bar{flex:1;height:6px;border-radius:4px;background:rgba(255,255,255,.09);overflow:hidden}
  #pokernow-panel .pnp-bar i{display:block;height:100%;border-radius:4px}
  #pokernow-panel .pnp-val{width:48px;text-align:right;font-size:10.5px;font-variant-numeric:tabular-nums}
  #pokernow-panel .pnp-action{text-align:center;margin:8px 0 2px;font-weight:800;font-size:15px;color:#4dc9ff}
  #pokernow-panel .pnp-action.fold{color:#ff7b72}
  #pokernow-panel .pnp-action.call{color:#7ee787}
  #pokernow-panel .pnp-action.raise,#pokernow-panel .pnp-action.bet{color:#f0c14b}
  #pokernow-panel .pnp-sub{text-align:center;color:#c4ccd8;font-size:10.5px;margin-bottom:6px}
  #pokernow-panel .pnp-note{display:flex;gap:5px;color:#c4ccd8;font-size:10.5px;margin:3px 0}
  #pokernow-panel .pnp-note:before{content:"•";color:#4dc9ff}
  #pokernow-panel .pnp-cats{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;margin-top:8px;
    border-top:1px solid rgba(255,255,255,.08);padding-top:7px}
  #pokernow-panel .pnp-cat{font-size:9.5px}
  #pokernow-panel .pnp-cat .t{display:flex;justify-content:space-between;color:#a9b4c2}
  #pokernow-panel .pnp-cat .b{height:3px;border-radius:2px;background:rgba(255,255,255,.08);margin-top:1px}
  #pokernow-panel .pnp-cat .b i{display:block;height:100%;border-radius:2px;background:#4dc9ff}
  #pokernow-panel .pnp-foot{margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);
    color:#6d7a8b;font-size:9.5px}
  #pokernow-panel .pnp-empty{text-align:center;color:#8b98a9;padding:18px 6px}
  #pokernow-panel .pnp-dim{color:#6d7a8b}
  #pokernow-panel .pnp-wrap{word-break:break-word;white-space:normal}
  #pokernow-panel .pnp-hudrow{display:grid;grid-template-columns:1fr 42px 46px 44px 36px 52px;gap:4px;
    font-size:10px;padding:4px 0;border-top:1px solid rgba(255,255,255,.06);text-align:right}
  #pokernow-panel .pnp-hudrow .pnp-name{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #pokernow-panel .pnp-hudhead{color:#8b98a9;border-top:none;font-weight:700}
  #pokernow-panel .pnp-hudrow .pos{color:#20e39c}
  #pokernow-panel .pnp-hudrow .neg{color:#ff7b72}
  #pokernow-panel .pnp-handrow{display:grid;grid-template-columns:34px 62px 1fr 1fr;gap:6px;font-size:10px;
    padding:4px 0;border-top:1px solid rgba(255,255,255,.06)}
  #pokernow-panel .pnp-sect{margin:8px 0 4px;color:#8b98a9;font-size:10px;font-weight:700;letter-spacing:.05em}
  #pokernow-panel .pnp-diagrow{display:flex;justify-content:space-between;gap:8px;font-size:10px;padding:2px 0}
  #pokernow-panel .pnp-diagrow .ok{color:#20e39c}
  #pokernow-panel .pnp-diagrow .bad{color:#ff7b72}
  #pokernow-panel .pnp-diagrow .warn{color:#f0c14b}
  `;

  /*
   * Drag is bound to the panel, not the header: render() replaces innerHTML,
   * so a listener on the header dies at the first update.
   */
  function installDrag() {
    let active = false; let dx = 0; let dy = 0;

    panel.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#pnp-header') || e.target.closest('button')) return;
      active = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      try { panel.setPointerCapture?.(e.pointerId); } catch { /* nicety */ }
      e.preventDefault();
    });

    panel.addEventListener('pointermove', (e) => {
      if (!active) return;
      const left = Math.max(0, Math.min(innerWidth - panel.offsetWidth, e.clientX - dx));
      const top = Math.max(0, Math.min(innerHeight - panel.offsetHeight, e.clientY - dy));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
      state.pos = { left, top };
    });

    const stop = () => { if (active) { active = false; save({ rerender: false }); } };
    panel.addEventListener('pointerup', stop);
    panel.addEventListener('pointercancel', stop);
  }

  function mount() {
    if (!document.body) return setTimeout(mount, 100);
    if (document.getElementById('pokernow-panel')) return;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'pokernow-panel';
    if (state.pos) {
      panel.style.left = `${state.pos.left}px`;
      panel.style.top = `${state.pos.top}px`;
      panel.style.right = 'auto';
    }

    document.body.appendChild(panel);
    installDrag();
    render();

    let queued = null;
    const schedule = () => {
      if (queued) return;
      queued = setTimeout(() => {
        queued = null;
        try { ingestLog(); } catch (e) { console.error('[PokerNowPanel] log', e); }
        try { if (state.tab === 'play' || state.tab === 'diag') render(); } catch (e) { console.error(e); }
      }, 300);
    };

    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(schedule, 1500);

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyP') {
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
      }
    });

    console.log(`[PokerNowPanel] v${VERSION} ready`);
  }

  mount();

  window.PokerNowPanel = {
    version: VERSION,
    api: API,
    state: () => state,
    scrape: scrapeTable,
    ingestLog,
    render,
    exportCSV,
    exportJSON,
    dumpProtocol: () => {
      console.log(`[PokerNowPanel] ${wsLog.length} socket messages recorded`);
      console.table(wsLog.slice(-40).map((m) => ({ kind: m.kind, keys: (m.keys || []).join(','), sample: (m.sample || '').slice(0, 120) })));
      return wsLog;
    },
    reset: () => {
      if (!confirm('Reset PokerNow Panel data?')) return;
      state = blank();
      pendingEvents = [];
      logState.orientation = 0;
      logState.fallbackCount = 0;
      for (const n of qa('[data-pnp-seen]')) delete n.dataset.pnpSeen;
      localStorage.removeItem(STORE);
      render();
    },
  };
}());
