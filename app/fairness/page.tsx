import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Bot,
  Braces,
  Check,
  CircleHelp,
  Clock3,
  EyeOff,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Network,
  Radio,
  ShieldAlert,
  Users,
  WalletCards,
  Zap,
} from "lucide-react";
import { RiverShell } from "../components/river-shell";

const threatRows = [
  ["Server privately tests shuffles before ever committing to one", "Every seat supplies its own browser-generated seed; the server never controls enough of the combined entropy alone to pick a favorable deck", "Live, checked by verifyTableBundle", "pass"],
  ["Client or server tampers with hand history", "Hash-chained transcript rooted in the hand ID", "Live, checked by verifyTableBundle", "pass"],
  ["Receipt awards the wrong side pot or amount", "Independent side-pot recomputation + contribution replay", "Live, checked by verifyTableBundle", "pass"],
  ["A seat disconnects mid-hand", "Hand state persists server-side; reconnect resends it, not a re-deal", "Live", "pass"],
  ["Server delays dealing to wait for a more favorable already-committed seed set", "Hand start follows real-time seat occupancy; no way to add, drop, or replace a seed once it has arrived", "Narrow residual - operational, not eliminated by cryptography", "hard"],
  ["Operator reads every hole card", "None — inherent to a trusted-dealer model", "Not mitigated by cryptography; operational trust only", "hard"],
  ["Two players share cards out of band", "Table controls, reputation, review", "Mitigated, never eliminated", "hard"],
  ["Bot plays perfect strategy", "Policy + detection + bot-designated tables", "Product decision required", "hard"],
  ["Real money is deposited or withdrawn", "Licensed custodial ledger, audit, caps", "Not built — no real-money path exists yet", "block"],
];

export default function FairnessPage() {
  return (
    <RiverShell active="protocol" dark>
      <main className="fairness-page">
        <section className="fairness-hero">
          <div className="fairness-hero-copy">
            <span>RIVER / PROTOCOL</span>
            <h1>Fairness is not<br />one random number.</h1>
            <p>
              RIVER&apos;s server deals every hand — that&apos;s a real trust decision, not a cryptographic
              privacy guarantee. What is guaranteed: every seat contributes its own browser-generated
              randomness to the shuffle, committed before it&apos;s revealed, so the server can&apos;t
              unilaterally choose a favorable deck. Every action extends a hash-chained receipt, and
              anyone can independently replay both after the fact.
            </p>
            <div><a className="river-button primary" href="/play/table-lab">Play a live table <ArrowRight size={16} /></a><a className="river-button ghost" href="#architecture">Read the architecture</a></div>
          </div>
          <div className="fairness-scope-board">
            <div className="scope-board-head"><span>PROTOCOL CLAIM REGISTER</span><small>CURRENT STATUS</small></div>
            <article className="live"><Check size={16} /><div><span>LIVE</span><b>Player-seeded commit-reveal shuffle</b></div><small>NOT SERVER-CHOSEN ALONE</small></article>
            <article className="live"><Check size={16} /><div><span>LIVE</span><b>2-10 seat tables, real no-limit betting</b></div><small>DURABLE OBJECT</small></article>
            <article className="live"><Check size={16} /><div><span>LIVE</span><b>Accounts + persistent bankroll</b></div><small>D1-BACKED, REAL SESSIONS</small></article>
            <article><Clock3 size={16} /><div><span>BUILT, NOT LIVE</span><b>On-chain escrow contract</b></div><small>DEPLOY GATED ON LICENSING</small></article>
          </div>
        </section>

        <section className="protocol-premise">
          <div className="premise-index"><span>01 / THE PREMISE</span><p>Most poker sites ask you to trust a server you can&apos;t see inside, and stop there.</p></div>
          <div className="premise-main"><h2>RIVER trusts the same server. It just makes that trust checkable.</h2><div className="premise-grid">
            <article><Radio size={20} /><span>SHUFFLE</span><h3>Who picks the deck?</h3><p>Each seat&apos;s own browser generates its own random seed and commits (hashes) it before the hand deals. The server combines every seat&apos;s contribution but doesn&apos;t control any single one alone, so it can&apos;t unilaterally choose a favorable shuffle.</p></article>
            <article><EyeOff size={20} /><span>DEALING</span><h3>Who sees each card?</h3><p>Hole cards are sent 1:1 to the owning connection only, never broadcast to the table — an operational guarantee, not a cryptographic one.</p></article>
            <article><Zap size={20} /><span>ACTIONS</span><h3>What happened at the table?</h3><p>Every fold, check, call, bet, and raise extends a hash chain rooted in the hand ID. Reordering or altering one breaks the chain.</p></article>
            <article><WalletCards size={20} /><span>SETTLEMENT</span><h3>Did the payout match the pot?</h3><p>The awarded amount is checked against replayed contributions and recomputed side pots — a receipt can&apos;t quietly award more than was wagered.</p></article>
          </div></div>
        </section>

        <section className="architecture-section" id="architecture">
          <div className="architecture-head"><span>02 / HAND LIFECYCLE</span><h2>Fast path at the table.<br />Proof path underneath.</h2><p>This is the lifecycle every live hand actually runs today, not a target.</p></div>
          <div className="architecture-flow">
            <article className="implemented"><div className="architecture-node"><KeyRound size={21} /><span>01</span></div><div><span>PRE-HAND</span><h3>Commit entropy</h3><p>Every dealt-in seat&apos;s own browser generates its randomness and commits it before the deck is shuffled. The server only falls back to generating a seed itself if a seat&apos;s browser doesn&apos;t supply one in time - and that fallback is always disclosed per-seat, never silent.</p><small><Check size={12} /> LIVE</small></div></article>
            <article className="implemented"><div className="architecture-node"><LockKeyhole size={21} /><span>02</span></div><div><span>DEAL</span><h3>Deal privately</h3><p>The deck is shuffled deterministically from the combined committed seeds; each seat&apos;s hole cards go out 1:1 over its own connection.</p><small><Check size={12} /> LIVE</small></div></article>
            <article className="implemented"><div className="architecture-node"><Fingerprint size={21} /><span>03</span></div><div><span>PLAY</span><h3>Chain table actions</h3><p>Real no-limit betting — variable sizing, min-raise, unlimited re-raising, all-in-for-less — with every action logged into the hand&apos;s transcript.</p><small><Check size={12} /> LIVE</small></div></article>
            <article className="implemented"><div className="architecture-node"><Network size={21} /><span>04</span></div><div><span>CLOSE</span><h3>Verify and settle</h3><p>An independent verifier recomputes the deck, replays the transcript, and recomputes every side pot before trusting the server&apos;s own summary.</p><small><Check size={12} /> LIVE</small></div></article>
          </div>
          <div className="architecture-constraint"><AlertTriangle size={19} /><div><span>WHAT&apos;S STILL OPEN</span><p>Accounts and a cross-session bankroll ledger are real and live — what doesn&apos;t exist yet is rake/fee accounting, since there&apos;s no real money to take a fee from. Every balance today is still test chips.</p></div></div>
        </section>

        <section className="encryption-section">
          <div className="encryption-copy"><span>03 / WHY A TRUSTED SERVER</span><h2>No-trusted-dealer poker was the original plan. It didn&apos;t survive contact with players.</h2><p>An earlier version of this protocol used ElGamal mental poker so no single party — not even the server — could learn a card before it was dealt. It worked: two browsers dealt a full hand with no trusted dealer, verified locally.</p><p>Real poker players didn&apos;t want it. The added round-trip coordination, the disconnect handling it demands, and the UX cost bought a guarantee nobody asked for. RIVER now runs a conventional trusted-server model instead, matching how the sites people actually use are built — and puts the engineering effort into making that trust checkable after the fact instead of removing it.</p></div>
          <div className="encryption-options">
            <article><span>PARKED</span><Braces size={20} /><h3>Mental poker</h3><p>No-trusted-dealer ElGamal dealing between two browsers.</p><ul><li>Proven locally, 15 verifier checks</li><li>Not wired to the live product</li><li><a href="/play/deal-lab">Try the research demo <ArrowRight size={12} /></a></li></ul></article>
            <article><span>LIVE</span><Network size={20} /><h3>Trusted server</h3><p>A Durable Object deals every hand and holds both the deck and the transcript.</p><ul><li>Matches conventional poker sites</li><li>No wallet, no per-action signature</li><li>Shuffle entropy comes from every seat&apos;s own browser, not the server alone</li></ul></article>
            <article><span>BUILT</span><EyeOff size={20} /><h3>On-chain escrow</h3><p>A pooled vault contract holds deposits; the operator releases funds against the off-chain ledger, fee on withdrawal.</p><ul><li>Built, unit-tested, verified end-to-end on a local chain</li><li>Not deployed anywhere real funds could reach</li><li>Public launch still gated on licensing</li></ul></article>
          </div>
          <p className="option-verdict"><CircleHelp size={17} /><span><b>No fake certainty:</b> the server sees every hole card. That&apos;s the model. What&apos;s cryptographically checkable is the receipt, not real-time privacy from the operator.</span></p>
        </section>

        <section className="threat-section" id="threats">
          <div className="section-title-row"><div><span>04 / THREAT REGISTER</span><h2>What fails, how it fails, and what exists today.</h2></div><p>A trusted-dealer model has a different attack surface than a no-trusted-dealer one — here&apos;s what&apos;s actually mitigated versus what&apos;s an honest, open limitation.</p></div>
          <div className="threat-table"><div className="threat-table-head"><span>THREAT</span><span>PRIMARY CONTROL</span><span>CURRENT STATUS</span><span>CLASS</span></div>{threatRows.map(([threat, control, status, state]) => <div className="threat-row" key={threat}><b>{threat}</b><p>{control}</p><span>{status}</span><i className={state}>{state === "pass" ? <Check size={13} /> : state === "hard" ? <ShieldAlert size={13} /> : <Clock3 size={13} />}{state === "pass" ? "DEMO" : state === "block" ? "BLOCKER" : state === "hard" ? "SOCIAL" : "OPEN"}</i></div>)}</div>
        </section>

        <section className="collusion-section">
          <div className="collusion-title"><span>05 / COLLUSION + BOTS</span><h2>Some poker problems remain human problems.</h2></div>
          <div className="collusion-grid">
            <article><Users size={22} /><span>COLLUSION</span><h3>Cryptography can prove the deal. It cannot stop two players from texting.</h3><p>Mitigations include table composition controls, shared-device and behavioral signals where lawful, player reports, hand review, stake limits, and portable reputation. None produces a perfect guarantee.</p></article>
            <article><Bot size={22} /><span>BOTS</span><h3>&ldquo;Trusted dealer&rdquo; does not mean automation should be invisible.</h3><p>The product needs an explicit policy: human-only tables with detection and enforcement, bot-labeled tables, or both. Pretending a browser check can permanently solve bots is not credible.</p></article>
          </div>
        </section>

        <section className="chain-section">
          <div className="chain-copy"><span>06 / WHY A DURABLE OBJECT, NOT A CHAIN</span><h2>Settlement speed matters.<br />Chain maximalism doesn&apos;t.</h2><p>RIVER&apos;s dealer still isn&apos;t on a chain — a Cloudflare Durable Object holds the deck and the transcript directly, with no consensus latency in the hot path. What changed since the earlier Solana-settlement plan: a real EVM escrow contract now exists for the money side specifically — deposits and operator-authorized payouts — kept deliberately separate from hand logic, built and tested, but not deployed anywhere real value could reach it.</p></div>
          <div className="chain-scorecard">
            <div><span>HAND ACTIONS</span><b>Direct WebSocket, no chain</b><small>Every action is instant</small></div>
            <div><span>HAND STATE</span><b>Durable Object storage</b><small>Survives hibernation, reconnect</small></div>
            <div><span>RECEIPTS</span><b>Portable JSON, verifiable offline</b><small>No on-chain anchoring</small></div>
            <div><span>REAL MONEY</span><b>On-chain escrow contract (built, not deployed)</b><small>Tested locally, gated on licensing</small></div>
          </div>
        </section>

        <section className="roadmap-section" id="roadmap">
          <div className="roadmap-head"><span>07 / BUILD GATES</span><h2>The protocol earns the right to touch money.</h2></div>
          <div className="roadmap-list">
            <article className="complete"><span>001</span><div><small>COMPLETE / LIVE</small><h3>Trusted-dealer tables</h3><p>Player-seeded commit-reveal dealing, real no-limit betting, 2-10 seat side pots, hash-chained receipts, host-configurable stakes, and an independent verifier.</p></div><BadgeCheck size={20} /></article>
            <article className="complete"><span>002</span><div><small>COMPLETE / LIVE</small><h3>Accounts + persistent ledger</h3><p>Real auth, a bankroll that survives across sessions and tables, a lobby of real open rooms, hand history. Still test chips - no rake accounting yet.</p></div><BadgeCheck size={20} /></article>
            <article><span>003</span><div><small>BUILT, NOT LIVE</small><h3>On-chain escrow</h3><p>A real EVM vault contract (deposit, operator-authorized withdrawal), unit-tested and verified end-to-end on a local chain. Not deployed anywhere real funds could reach — public launch is gated on actual gambling and money-transmitter licensing being in place.</p></div><ArrowRight size={20} /></article>
            <article><span>004</span><div><small>BEFORE REAL MONEY</small><h3>Independent review</h3><p>Engine logic, abuse model, operations, and legal scope.</p></div><ArrowRight size={20} /></article>
          </div>
        </section>

        <section className="fairness-closing"><Fingerprint size={32} /><span>THE PART YOU CAN TEST NOW</span><h2>Break the receipt.</h2><p>Play a hand at a live table, download the proof, then alter its wager, payout, winner, or hand ID. Verification rejects each mismatch.</p><a className="river-button primary" href="/play/table-lab">Open a live table <ArrowRight size={16} /></a></section>
      </main>
    </RiverShell>
  );
}
