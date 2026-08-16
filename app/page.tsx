"use client";

import { ArrowRight, BadgeCheck, Check, FileCheck2, Play, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { RiverShell } from "./components/river-shell";

export default function HomePage() {
  return (
    <RiverShell active="home" dark>
      <main className="r3-home">
        <section className="r3-hero r3-hero-solo">
          <div className="r3-hero-copy">
            <div className="r3-eyebrow"><i /> TRUSTED-DEALER POKER · TEST CHIPS</div>
            <h1>Real hands.<br /><em>Real receipts.</em></h1>
            <p>
              A real server deals every card and runs every hand over a live connection — no download, no
              wallet. Set your own blinds and buy-in range when you open a table, and every completed hand
              ships a cryptographic receipt you can independently verify.
            </p>
            <div className="r3-hero-actions">
              <a className="r3-button primary" href="/lobby"><Play size={16} /> Find a table</a>
              <a className="r3-button ghost" href="/fairness"><ShieldCheck size={16} /> See how hands are proven</a>
            </div>
            <div className="r3-proof-strip">
              <span><Check size={13} /> Real accounts, real bankroll</span>
              <span><Check size={13} /> 2–10 seats, host-set stakes</span>
              <span><Check size={13} /> Receipt after every hand</span>
            </div>
          </div>
        </section>

        <section className="r3-promise">
          <article><span>01</span><Users size={20} /><h3>Pick a table</h3><p>Browse real open rooms in the lobby, or open your own with a blind structure and buy-in range you set.</p></article>
          <article><span>02</span><SlidersHorizontal size={20} /><h3>Sit down and play</h3><p>Choose your buy-in within the host&apos;s range and play real turn-based hold&apos;em against real accounts.</p></article>
          <article><span>03</span><FileCheck2 size={20} /><h3>Verify the finish</h3><p>Every hand ships a receipt. Independently replay the deck, actions, pot, and winner - don&apos;t just trust the UI.</p></article>
        </section>

        <section className="r3-proof-band">
          <div>
            <span><ShieldCheck size={15} /> THE RIVER DIFFERENCE</span>
            <h2>The proof stays<br />under the table.</h2>
            <p>No wallet popups interrupt checks, calls, folds, or raises. The receipt appears after the hand, when it can be independently verified - not trusted UI state.</p>
            <div><a href="/play">See the proof engine <ArrowRight size={15} /></a><a href="/fairness">Read the fairness model</a></div>
          </div>
          <div className="r3-receipt-card">
            <header><span><FileCheck2 size={15} /> HAND #1842</span><b><BadgeCheck size={14} /> VERIFIED</b></header>
            <code>7f2c91a4...b81e</code>
            <ul><li><Check size={12} /> Deck rebuilt</li><li><Check size={12} /> 52 unique cards</li><li><Check size={12} /> Actions matched</li><li><Check size={12} /> Pot replayed</li><li><Check size={12} /> Winner confirmed</li></ul>
            <footer><span>9 / 9 CHECKS PASSED</span><a href="/receipts">Inspect <ArrowRight size={13} /></a></footer>
          </div>
        </section>

        <section className="r3-lobby-callout">
          <div><span>LIVE RIGHT NOW</span><h2>Every room in the lobby is real.</h2><p>Each one is a real Cloudflare Durable Object holding an actual game, not sample data - refreshed as players join, leave, and hands start.</p></div>
          <a href="/lobby">Browse open tables <ArrowRight size={15} /></a>
        </section>
      </main>
    </RiverShell>
  );
}
