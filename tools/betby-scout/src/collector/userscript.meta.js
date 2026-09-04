// ==UserScript==
// @name         Betby Scout collector
// @namespace    https://github.com/local/betby-scout
// @version      0.1.0
// @description  Read-only observer for BETBY-powered sportsbooks. Records traffic the page already makes so it can be analysed locally. Never places bets.
// @author       local
// @match        https://duel.com/*
// @match        https://*.duel.com/*
// @run-at       document-start
// @all-frames   true
// @grant        none
// @noframes     false
// ==/UserScript==
//
// SCOPE, STATED PLAINLY
//
// A userscript runs in the top frame and in same-origin frames. It CANNOT run
// inside a cross-origin iframe, and BETBY widgets are usually embedded in one.
// If the panel fills with page traffic but nothing ever classifies as a bets
// feed, that is what has happened - use the MV3 extension instead, which can
// be granted access to the widget origin at runtime.
//
// More @match lines get added here only once frame discovery reports the real
// widget origin. They are not guessed in advance: this file must never assert a
// host we have not actually observed.
