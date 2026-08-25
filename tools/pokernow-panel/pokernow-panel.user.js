// ==UserScript==
// @name         PokerNow Panel
// @namespace    https://github.com/fabsolcreations/pokernow-panel
// @version      1.0.0
// @description  Live equity / hand-strength / suggested-action panel for PokerNow tables. Reads the table DOM, runs a Monte Carlo, shows win%, outs, board warnings and a line.
// @author       you
// @match        https://www.pokernow.club/*
// @match        https://pokernow.club/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* eslint-disable no-bitwise */
(function () {
  'use strict';

  // ===========================================================================
  // CONFIG
  // ===========================================================================
  const DEFAULTS = {
    sims: 6000,        // Monte Carlo iterations per refresh
    mode: 'NORMAL',    // TIGHT | NORMAL | LOOSE
    debug: false,      // log what the scraper found
    collapsed: false,
    pos: null,         // {x, y} panel position
  };

  const STORE_KEY = 'pnpanel.cfg.v1';
  const cfg = Object.assign({}, DEFAULTS, readStore());

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  // ===========================================================================
  // CARD ENGINE
  // card = rank * 4 + suit ; rank 0..12 => 2..A ; suit 0..3 => c,d,h,s
  // ===========================================================================
  const RANK_CHARS = '23456789TJQKA';
  const SUIT_CHARS = 'cdhs';
  const SUIT_GLYPH = ['♣', '♦', '♥', '♠'];
  const CAT_NAMES = [
    'High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
  ];
  const CAT_BASE = 537824; // 14^5 — ranks are packed base-14 (0 = absent, 1..13 = 2..A)

  function makeCard(rank, suit) { return rank * 4 + suit; }
  function cardRank(c) { return c >> 2; }
  function cardSuit(c) { return c & 3; }
  function cardStr(c) { return RANK_CHARS[cardRank(c)] + SUIT_CHARS[cardSuit(c)]; }
  function cardPretty(c) { return RANK_CHARS[cardRank(c)] + SUIT_GLYPH[cardSuit(c)]; }

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
    if (r < 0 || su < 0) return -1;
    return makeCard(r, su);
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
    if ((mask & (1 << 12)) && (mask & 1) && (mask & 2) && (mask & 4) && (mask & 8)) return 3; // wheel
    return -1;
  }

  function score(cat, ranks) {
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 14 + ((ranks[i] === undefined ? -1 : ranks[i]) + 1);
    return v;
  }

  // Best 5-card score out of 5, 6 or 7 cards. Higher is better.
  function evaluate(cards) {
    const rc = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const sc = [0, 0, 0, 0];
    const sm = [0, 0, 0, 0];
    let mask = 0;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i], r = c >> 2, s = c & 3;
      rc[r]++; sc[s]++; sm[s] |= 1 << r; mask |= 1 << r;
    }
    let flushSuit = -1;
    for (let s = 0; s < 4; s++) if (sc[s] >= 5) flushSuit = s;
    if (flushSuit >= 0) {
      const fm = sm[flushSuit];
      const sf = straightHigh(fm);
      if (sf >= 0) return score(8, [sf]);
      return score(5, topRanks(fm, 5));
    }
    const quads = [], trips = [], pairs = [];
    for (let r = 12; r >= 0; r--) {
      if (rc[r] === 4) quads.push(r);
      else if (rc[r] === 3) trips.push(r);
      else if (rc[r] === 2) pairs.push(r);
    }
    if (quads.length) return score(7, [quads[0]].concat(topRanks(mask & ~(1 << quads[0]), 1)));
    if (trips.length && (pairs.length || trips.length > 1)) {
      const alt = trips.length > 1 ? trips[1] : -1;
      const pr = Math.max(pairs.length ? pairs[0] : -1, alt);
      return score(6, [trips[0], pr]);
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

  function catOf(sc) { return Math.floor(sc / CAT_BASE); }

  function handName(sc) {
    const cat = catOf(sc);
    if (cat === 8) {
      const hi = Math.floor(sc / 38416) - cat * 14 - 1; // 14^4
      return hi === 12 ? 'Royal Flush' : 'Straight Flush';
    }
    return CAT_NAMES[cat];
  }

  // Monte Carlo: hero equity + hero's final-hand category distribution.
  function simulate(hero, board, nOpp, sims) {
    const known = hero.concat(board);
    const deck = [];
    for (let c = 0; c < 52; c++) if (known.indexOf(c) < 0) deck.push(c);
    const need = (5 - board.length) + 2 * nOpp;
    if (hero.length !== 2 || need > deck.length || nOpp < 1) return null;

    let win = 0, tieCount = 0, tieShare = 0, lose = 0;
    const cats = new Array(9).fill(0);
    const full = new Array(7);
    const opp = new Array(7);
    const drawn = new Array(need);
    const runout = 5 - board.length;

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

      let best = -1, tied = 1;
      for (let o = 0; o < nOpp; o++) {
        opp[0] = drawn[runout + o * 2];
        opp[1] = drawn[runout + o * 2 + 1];
        for (let i = 0; i < 5; i++) opp[2 + i] = full[2 + i];
        const os = evaluate(opp);
        if (os > best) { best = os; tied = 1; }
        else if (os === best) tied++;
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

  // Cards that lift hero into a strictly better hand category next street.
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
    let flushDraw = false, backdoorFlush = false;
    for (let s = 0; s < 4; s++) {
      if (sc[s] === 4 && heroSuits[s] > 0) flushDraw = true;
      if (sc[s] === 3 && heroSuits[s] > 0 && board.length === 3) backdoorFlush = true;
    }
    let oesd = false, gutshot = false;
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
    let paired = false, trips = false, quads = false;
    for (let r = 0; r < 13; r++) {
      if (rc[r] === 2) paired = true;
      if (rc[r] === 3) trips = true;
      if (rc[r] === 4) quads = true;
    }
    let flushPossible = false, flushDrawPossible = false;
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

  // Chen formula — a cheap preflop sanity read.
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
    const suited = cardSuit(hero[0]) === cardSuit(hero[1]);
    return RANK_CHARS[a] + RANK_CHARS[b] + (suited ? 's' : 'o');
  }

  // ===========================================================================
  // ADVICE
  // ===========================================================================
  const MODE_MARGIN = { TIGHT: 0.06, NORMAL: 0.02, LOOSE: -0.03 };

  function advise(s) {
    const notes = [];
    const warns = [];
    const margin = MODE_MARGIN[cfg.mode] !== undefined ? MODE_MARGIN[cfg.mode] : 0.02;
    const toCall = s.toCall || 0;
    const pot = s.pot || 0;
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : null;
    let action = 'CHECK';
    let sub = '';

    // ---- preflop -----------------------------------------------------------
    if (s.board.length === 0) {
      const chen = chenScore(s.hero);
      const late = s.position === 'BTN' || s.position === 'CO';
      let open = cfg.mode === 'LOOSE' ? 6 : cfg.mode === 'TIGHT' ? 9 : 8;
      if (late) open -= 1.5;
      if (s.seats <= 3) open -= 2;
      notes.push('Chen score ' + chen + ' (open threshold ~' + open + ')');
      if (toCall <= 0) {
        if (chen >= open + 4) { action = 'RAISE'; sub = 'Strong opener — raise 3x'; }
        else if (chen >= open) { action = 'RAISE'; sub = 'Standard open'; }
        else { action = 'CHECK'; sub = 'Take the free look'; }
      } else if (toCall <= s.bigBlind * 1.5) {
        if (chen >= open + 5) { action = 'RAISE'; sub = 'Raise for value'; }
        else if (chen >= open - 1) { action = 'CALL'; sub = 'Cheap enough to see a flop'; }
        else { action = 'FOLD'; sub = 'Not worth the blind'; }
      } else {
        if (chen >= open + 6) { action = 'RAISE'; sub = 'Re-raise range'; }
        else if (chen >= open + 1) { action = 'CALL'; sub = 'Call the raise'; }
        else { action = 'FOLD'; sub = 'Facing a raise with a weak hand'; }
      }
      if (s.seats >= 7) notes.push('Full table — open tighter, more hands behind you');
      if (late) notes.push('Late position — you act last postflop, widen a little');
      return { action, sub, notes, warns, potOdds };
    }

    // ---- postflop ----------------------------------------------------------
    const eq = s.sim ? s.sim.equity : null;
    const tex = boardTexture(s.board);
    const draws = drawInfo(s.hero, s.board);
    const madeCat = catOf(evaluate(s.hero.concat(s.board)));
    const heroRanks = s.hero.map(cardRank);
    const boardRanks = s.board.map(cardRank);
    const usesBoardOnly = s.board.length === 5 &&
      evaluate(s.board) === evaluate(s.hero.concat(s.board)) &&
      heroRanks.every((r) => boardRanks.indexOf(r) < 0);

    if (tex.trips) warns.push('TRIPS ON BOARD — a full house is very live for everyone.');
    else if (tex.paired) warns.push('BOARD IS PAIRED — full house / trips possible.');
    if (tex.flushPossible) warns.push('FLUSH POSSIBLE — three of a suit out there.');
    else if (tex.flushDrawPossible) warns.push('Flush draw possible on this board.');
    if (tex.straightPossible) warns.push('STRAIGHT POSSIBLE — connected board.');
    if (usesBoardOnly) warns.push('You are playing the board — your cards add nothing.');

    if (draws.flushDraw) notes.push('You have a flush draw (~9 outs).');
    if (draws.oesd) notes.push('Open-ended straight draw (~8 outs).');
    else if (draws.gutshot) notes.push('Gutshot straight draw (~4 outs).');
    if (draws.backdoorFlush) notes.push('Backdoor flush possibility.');

    if (s.outs) {
      const pct = s.outs.streetsLeft === 2 ? s.outs.count * 4 : s.outs.count * 2;
      notes.push(s.outs.count + ' cards improve your hand class (~' + Math.min(pct, 95) + '% by river).');
    }

    if (eq === null) return { action: '—', sub: 'Waiting for cards', notes, warns, potOdds };

    if (toCall > 0) {
      if (eq > potOdds + 0.20 + margin && eq > 0.62) { action = 'RAISE'; sub = 'Ahead of the price — build the pot'; }
      else if (eq > potOdds + margin) { action = 'CALL'; sub = 'Equity beats the price'; }
      else if (eq > potOdds - 0.04 && (draws.flushDraw || draws.oesd) && s.board.length < 5) {
        action = 'CALL'; sub = 'Close, but the draw has implied odds';
      } else { action = 'FOLD'; sub = 'Price is worse than your equity'; }
      notes.push('Pot odds need ' + pct1(potOdds) + ', you have ' + pct1(eq) + '.');
    } else {
      if (eq > 0.72) { action = 'BET'; sub = 'Value bet ~2/3 pot'; }
      else if (eq > 0.55 && madeCat >= 1) { action = 'BET'; sub = 'Thin value / protection, ~1/3 pot'; }
      else if (eq > 0.45 || draws.flushDraw || draws.oesd) { action = 'CHECK'; sub = 'Keep the pot small, see the next card'; }
      else { action = 'CHECK'; sub = 'Check and give up if bet into'; }
      if (cfg.mode === 'LOOSE' && (draws.flushDraw || draws.oesd) && eq > 0.35) {
        action = 'BET'; sub = 'Semi-bluff with your draw';
      }
    }

    if (s.spr !== null && s.spr < 3) notes.push('Low SPR (' + s.spr.toFixed(1) + ') — commit or fold, no thin calls.');
    else if (s.spr !== null && s.spr > 12) notes.push('Deep SPR (' + s.spr.toFixed(1) + ') — implied odds matter, avoid bloating with one pair.');
    if (s.opponents >= 3) notes.push(s.opponents + ' opponents — someone usually has it; value narrows.');
    if (s.position === 'BTN' || s.position === 'CO') notes.push('In position — you can control the pot size.');
    else if (s.position === 'SB' || s.position === 'BB') notes.push('Out of position — play tighter, avoid bloated pots.');

    return { action, sub, notes, warns, potOdds };
  }

  function pct1(x) { return x === null || x === undefined ? '—' : (x * 100).toFixed(1) + '%'; }

  // ===========================================================================
  // EXPORTS FOR NODE TESTS — nothing below runs outside a browser
  // ===========================================================================
  const API = {
    RANK_CHARS, SUIT_CHARS, CAT_NAMES, parseCard, cardStr, cardPretty, evaluate,
    catOf, handName, simulate, improvementOuts, drawInfo, boardTexture, chenScore,
    heroLabel, straightHigh,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof document === 'undefined') return;
  window.PNPanel = API;

  // ===========================================================================
  // DOM SCRAPING (PokerNow)
  // Selectors are grouped here so they are easy to patch if the site changes.
  // Turn on debug from the panel footer to see what was picked up.
  // ===========================================================================
  const SEL = {
    player: '.table-player',
    hero: '.table-player.you-player, .you-player',
    heroCards: '.you-player .card',
    boardCards: ['.table-cards .card', '.community-cards .card', '.table-community-cards .card'],
    anyCard: '.card',
    name: '.table-player-name',
    stack: '.table-player-stack',
    bet: '.table-player-bet-value',
    pot: '.table-pot-size',
    blinds: '.blind-value, .table-blinds',
    buttons: '.game-decisions-ctn button, .action-buttons button, .controls-ctn button, .button-1, .button-2, .button-3',
    dealer: '.dealer-button-ctn, .dealer-button',
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

  function readBoard() {
    for (const sel of SEL.boardCards) {
      const els = qa(sel);
      if (els.length) {
        const cards = collectCards(els, 5);
        if (cards.length) return cards;
      }
    }
    // fallback: face-up cards that are not inside a seat
    const loose = qa(SEL.anyCard).filter((el) => !el.closest(SEL.player));
    return collectCards(loose, 5);
  }

  function isActiveSeat(p) {
    const cls = p.className || '';
    if (/fold/i.test(cls)) return false;
    const txt = (p.textContent || '').toUpperCase();
    if (txt.indexOf('FOLD') >= 0 && !q('.card', p)) return false;
    if (txt.indexOf('WAITING') >= 0) return false;
    return !!q('.card, .card-container', p);
  }

  function seatIndex(el) {
    const m = (el.className || '').match(/table-player-(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function readPosition(seats, heroSeat) {
    const dealerEl = q(SEL.dealer);
    if (!dealerEl || heroSeat === null) return null;
    const dm = (dealerEl.className || '').match(/(?:dealer-position|button-position)-(\d+)/);
    if (!dm) return null;
    const btnSeat = parseInt(dm[1], 10);
    const ordered = seats.slice().sort((a, b) => a - b);
    const bi = ordered.indexOf(btnSeat);
    const hi = ordered.indexOf(heroSeat);
    if (bi < 0 || hi < 0) return null;
    const n = ordered.length;
    const after = (hi - bi + n) % n; // 0 = button, 1 = SB, 2 = BB ...
    if (after === 0) return 'BTN';
    if (n === 2) return after === 1 ? 'BB' : 'BTN';
    if (after === 1) return 'SB';
    if (after === 2) return 'BB';
    if (after === n - 1) return 'CO';
    return after <= Math.floor(n / 2) ? 'EP' : 'MP';
  }

  function readToCallFromButtons() {
    const btns = qa(SEL.buttons);
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (/^call/i.test(t) || /\bcall\b/i.test(t)) {
        const n = numFrom(t);
        if (n !== null) return n;
      }
      if (/^check/i.test(t)) return 0;
    }
    return null;
  }

  function heroActing() {
    const btns = qa(SEL.buttons).filter((b) => b.offsetParent !== null && !b.disabled);
    return btns.some((b) => /fold|check|call|raise|bet|all.?in/i.test(b.textContent || ''));
  }

  function scrape() {
    const heroEl = q(SEL.hero);
    const players = qa(SEL.player);
    const hero = collectCards(qa(SEL.heroCards), 2);
    const board = readBoard().filter((c) => hero.indexOf(c) < 0).slice(0, 5);

    const seatNums = [];
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
      }
    }

    const heroStack = heroEl ? (numFrom((q(SEL.stack, heroEl) || {}).textContent) || 0) : 0;
    const heroBet = heroEl ? (numFrom((q(SEL.bet, heroEl) || {}).textContent) || 0) : 0;
    const potEl = q(SEL.pot);
    const potBase = potEl ? (numFrom(potEl.textContent) || 0) : 0;
    const pot = potBase + betSum;

    let toCall = readToCallFromButtons();
    if (toCall === null) toCall = Math.max(0, maxBet - heroBet);

    const heroSeat = heroEl ? seatIndex(heroEl) : null;
    const position = readPosition(seatNums, heroSeat);
    const effStack = Math.min(heroStack || Infinity, maxOppStack || Infinity);
    const spr = pot > 0 && isFinite(effStack) ? effStack / pot : null;
    const bigBlind = guessBigBlind(pot);

    const state = {
      hero, board, pot, toCall, heroStack, heroBet, maxBet, bigBlind,
      opponents: Math.max(opponents, 1), seats: players.length, position, spr,
      street: ['Preflop', '', '', 'Flop', 'Turn', 'River'][board.length] || 'Preflop',
      acting: heroActing(),
    };
    if (cfg.debug) console.log('[PNPanel] scrape', state, hero.map(cardStr), board.map(cardStr));
    return state;
  }

  let bbGuess = 0;
  function guessBigBlind(pot) {
    const el = q(SEL.blinds);
    const n = el ? numFrom(el.textContent) : null;
    if (n) { bbGuess = n; return n; }
    if (!bbGuess && pot > 0) bbGuess = Math.max(1, Math.round(pot / 3));
    return bbGuess || 1;
  }

  // ===========================================================================
  // UI
  // ===========================================================================
  const CSS = `
  #pnp-root{position:fixed;top:80px;right:16px;width:330px;z-index:2147483000;
    font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e7ecf3;
    background:rgba(16,20,28,.94);border:1px solid rgba(255,255,255,.12);border-radius:12px;
    box-shadow:0 12px 40px rgba(0,0,0,.55);backdrop-filter:blur(8px);overflow:hidden;user-select:none}
  #pnp-root *{box-sizing:border-box}
  .pnp-head{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;
    background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02));
    border-bottom:1px solid rgba(255,255,255,.08);font-weight:700;letter-spacing:.08em;font-size:11px}
  .pnp-head .pnp-sp{flex:1}
  .pnp-btn{cursor:pointer;padding:2px 6px;border-radius:5px;background:rgba(255,255,255,.08);
    border:1px solid rgba(255,255,255,.1);font-size:10px;font-weight:700}
  .pnp-btn:hover{background:rgba(255,255,255,.18)}
  .pnp-body{padding:9px 10px 10px;max-height:78vh;overflow:auto}
  .pnp-mode{text-align:center;color:#7ee787;font-weight:700;font-size:11px;margin-bottom:4px}
  .pnp-hand{text-align:center;color:#4dc9ff;font-weight:800;font-size:14px}
  .pnp-cards{text-align:center;font-size:15px;letter-spacing:.06em;margin:2px 0}
  .pnp-meta{text-align:center;color:#8b98a9;font-size:10px;margin-bottom:6px}
  .pnp-warn{background:rgba(240,180,40,.12);border:1px solid rgba(240,180,40,.35);color:#f0c14b;
    border-radius:6px;padding:4px 6px;margin:4px 0;font-size:10.5px}
  .pnp-row{display:flex;align-items:center;gap:6px;margin:3px 0}
  .pnp-row .pnp-lbl{width:62px;color:#8b98a9;font-size:10px}
  .pnp-bar{flex:1;height:6px;border-radius:4px;background:rgba(255,255,255,.09);overflow:hidden}
  .pnp-bar i{display:block;height:100%;border-radius:4px;background:#4dc9ff}
  .pnp-bar.g i{background:#7ee787}.pnp-bar.y i{background:#f0c14b}
  .pnp-row .pnp-val{width:48px;text-align:right;font-variant-numeric:tabular-nums;font-size:10.5px}
  .pnp-action{text-align:center;margin:8px 0 2px;font-weight:800;font-size:15px;color:#4dc9ff}
  .pnp-action.fold{color:#ff7b72}.pnp-action.call{color:#7ee787}.pnp-action.raise{color:#f0c14b}
  .pnp-sub{text-align:center;color:#c4ccd8;font-size:10.5px;margin-bottom:6px}
  .pnp-notes{margin:6px 0}
  .pnp-note{display:flex;gap:5px;color:#c4ccd8;font-size:10.5px;margin:3px 0}
  .pnp-note:before{content:"•";color:#4dc9ff}
  .pnp-cats{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;margin-top:8px;
    border-top:1px solid rgba(255,255,255,.08);padding-top:7px}
  .pnp-cat{font-size:9.5px}
  .pnp-cat .t{display:flex;justify-content:space-between;color:#a9b4c2}
  .pnp-cat .b{height:3px;border-radius:2px;background:rgba(255,255,255,.08);margin-top:1px}
  .pnp-cat .b i{display:block;height:100%;border-radius:2px;background:#4dc9ff}
  .pnp-foot{display:flex;align-items:center;gap:6px;margin-top:8px;padding-top:6px;
    border-top:1px solid rgba(255,255,255,.08);color:#6d7a8b;font-size:9.5px}
  .pnp-foot .pnp-sp{flex:1}
  .pnp-empty{text-align:center;color:#8b98a9;padding:18px 6px}
  #pnp-root.collapsed .pnp-body{display:none}
  `;

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  let root, bodyEl;

  function buildUI() {
    const style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    root = el('div');
    root.id = 'pnp-root';
    if (cfg.collapsed) root.classList.add('collapsed');

    const head = el('div', 'pnp-head');
    head.appendChild(el('span', null, '♟ POKER PANEL'));
    head.appendChild(el('span', 'pnp-sp'));
    const modeBtn = el('span', 'pnp-btn', cfg.mode);
    const minBtn = el('span', 'pnp-btn', cfg.collapsed ? '+' : '–');
    head.appendChild(modeBtn);
    head.appendChild(minBtn);
    root.appendChild(head);

    bodyEl = el('div', 'pnp-body');
    root.appendChild(bodyEl);
    document.body.appendChild(root);

    if (cfg.pos) { root.style.left = cfg.pos.x + 'px'; root.style.top = cfg.pos.y + 'px'; root.style.right = 'auto'; }

    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const order = ['TIGHT', 'NORMAL', 'LOOSE'];
      cfg.mode = order[(order.indexOf(cfg.mode) + 1) % order.length];
      modeBtn.textContent = cfg.mode;
      saveStore();
      render(true);
    });
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cfg.collapsed = !cfg.collapsed;
      root.classList.toggle('collapsed', cfg.collapsed);
      minBtn.textContent = cfg.collapsed ? '+' : '–';
      saveStore();
    });

    // drag
    let dragging = false, ox = 0, oy = 0;
    head.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = root.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - oy));
      root.style.left = x + 'px'; root.style.top = y + 'px'; root.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const r = root.getBoundingClientRect();
      cfg.pos = { x: Math.round(r.left), y: Math.round(r.top) };
      saveStore();
    });

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyP') {
        root.style.display = root.style.display === 'none' ? '' : 'none';
      }
    });
  }

  function bar(label, value, cls) {
    const row = el('div', 'pnp-row');
    row.appendChild(el('span', 'pnp-lbl', label));
    const b = el('div', 'pnp-bar' + (cls ? ' ' + cls : ''));
    const i = el('i');
    i.style.width = Math.max(0, Math.min(100, (value || 0) * 100)) + '%';
    b.appendChild(i);
    row.appendChild(b);
    row.appendChild(el('span', 'pnp-val', value === null ? '—' : pct1(value)));
    return row;
  }

  const simCache = new Map();

  function render(force) {
    if (!root) return;
    const s = scrape();
    const key = [
      s.hero.map(cardStr).join(''), s.board.map(cardStr).join(''),
      s.opponents, s.pot, s.toCall, cfg.mode, cfg.sims,
    ].join('|');
    if (!force && key === render.lastKey) return;
    render.lastKey = key;

    bodyEl.textContent = '';

    if (s.hero.length !== 2) {
      const e = el('div', 'pnp-empty', 'Waiting for your hole cards…');
      bodyEl.appendChild(e);
      bodyEl.appendChild(footer(s));
      return;
    }

    let sim = simCache.get(key);
    if (!sim) {
      const budget = Math.max(1500, Math.min(cfg.sims, Math.round(40000 / (s.opponents + 1))));
      sim = simulate(s.hero, s.board, s.opponents, budget);
      if (simCache.size > 60) simCache.clear();
      simCache.set(key, sim);
    }
    s.sim = sim;
    s.outs = improvementOuts(s.hero, s.board);

    const made = evaluate(s.hero.concat(s.board));
    const a = advise(s);

    bodyEl.appendChild(el('div', 'pnp-mode', cfg.mode + ' mode active · ' + s.street));
    bodyEl.appendChild(el('div', 'pnp-hand', 'Hand: ' + (s.board.length ? handName(made) : heroLabel(s.hero))));
    bodyEl.appendChild(el('div', 'pnp-cards', s.hero.map(cardPretty).join(' ') +
      (s.board.length ? '   |   ' + s.board.map(cardPretty).join(' ') : '')));
    bodyEl.appendChild(el('div', 'pnp-meta', [
      heroLabel(s.hero),
      s.spr !== null ? 'SPR ' + s.spr.toFixed(1) : null,
      a.potOdds !== null ? 'MDF ' + pct1(1 - a.potOdds) : null,
      'Pot ' + s.pot,
      s.toCall > 0 ? 'To call ' + s.toCall : 'No bet',
      s.position || null,
    ].filter(Boolean).join(' · ')));

    a.warns.forEach((w) => bodyEl.appendChild(el('div', 'pnp-warn', '⚠ ' + w)));

    bodyEl.appendChild(bar('Win', sim ? sim.win : null, 'g'));
    bodyEl.appendChild(bar('Equity', sim ? sim.equity : null));
    bodyEl.appendChild(bar('Pot odds', a.potOdds, 'y'));

    const act = el('div', 'pnp-action ' + a.action.toLowerCase(), 'Action: ' + a.action);
    bodyEl.appendChild(act);
    bodyEl.appendChild(el('div', 'pnp-sub', a.sub));

    const notes = el('div', 'pnp-notes');
    a.notes.forEach((n) => notes.appendChild(el('div', 'pnp-note', n)));
    bodyEl.appendChild(notes);

    if (sim) {
      const grid = el('div', 'pnp-cats');
      for (let i = CAT_NAMES.length - 1; i >= 0; i--) {
        const c = el('div', 'pnp-cat');
        const t = el('div', 't');
        t.appendChild(el('span', null, CAT_NAMES[i]));
        t.appendChild(el('span', null, (sim.cats[i] * 100).toFixed(1) + '%'));
        c.appendChild(t);
        const b = el('div', 'b');
        const fill = el('i');
        fill.style.width = (sim.cats[i] * 100).toFixed(1) + '%';
        b.appendChild(fill);
        c.appendChild(b);
        grid.appendChild(c);
      }
      bodyEl.appendChild(grid);
    }

    bodyEl.appendChild(footer(s));
  }

  function footer(s) {
    const f = el('div', 'pnp-foot');
    f.appendChild(el('span', null, s.opponents + ' opp · ' + (s.sim ? s.sim.sims : 0) + ' sims'));
    f.appendChild(el('span', 'pnp-sp'));
    const dbg = el('span', 'pnp-btn', cfg.debug ? 'debug on' : 'debug');
    dbg.addEventListener('click', () => { cfg.debug = !cfg.debug; saveStore(); render(true); });
    f.appendChild(dbg);
    return f;
  }

  // ===========================================================================
  // BOOT
  // ===========================================================================
  function boot() {
    if (document.getElementById('pnp-root')) return;
    buildUI();
    render(true);

    let t = null;
    const schedule = () => {
      if (t) return;
      t = setTimeout(() => { t = null; try { render(false); } catch (e) { console.error('[PNPanel]', e); } }, 250);
    };
    new MutationObserver(schedule).observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
    setInterval(schedule, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
