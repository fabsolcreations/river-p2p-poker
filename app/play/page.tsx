"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Copy,
  Download,
  FileJson,
  Fingerprint,
  FlaskConical,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  appendTranscript,
  transcriptGenesis,
  botDecision,
  cardLabel,
  combinedSeed,
  commitment,
  compareHands,
  randomHex,
  shuffleDeck,
  verifyBundle,
  type Card,
  type ProofBundle,
  type TranscriptEntry,
  type VerificationResult,
} from "./proof";

type Street = "commit" | "preflop" | "flop" | "turn" | "river" | "complete";
type Winner = "player" | "opponent" | "split" | null;

type HandState = {
  handId: string;
  playerSeed: string;
  opponentSeed: string;
  playerCommitment: string;
  opponentCommitment: string;
  combinedSeed: string;
  deck: Card[];
  playerCards: Card[];
  opponentCards: Card[];
  board: Card[];
};

const INITIAL_STACK = 100;
const streetOrder: Street[] = ["preflop", "flop", "turn", "river"];

function shortHash(hash: string, length = 10) {
  if (!hash) return "pending";
  return `${hash.slice(0, length)}...${hash.slice(-6)}`;
}

function suitSymbol(suit: Card["suit"]) {
  return { s: "♠", h: "♥", d: "♦", c: "♣" }[suit];
}

function rankSymbol(rank: number) {
  return ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"][rank - 2];
}

function PlayingCard({ card, hidden = false, compact = false }: { card?: Card; hidden?: boolean; compact?: boolean }) {
  if (hidden || !card) {
    return <div className={`poc-card poc-card-back ${compact ? "compact" : ""}`} aria-label="Hidden card"><span>R</span></div>;
  }
  const red = card.suit === "h" || card.suit === "d";
  return (
    <div className={`poc-card ${red ? "red" : ""} ${compact ? "compact" : ""}`} aria-label={cardLabel(card)}>
      <b>{rankSymbol(card.rank)}</b>
      <span>{suitSymbol(card.suit)}</span>
    </div>
  );
}

export default function ProofLab() {
  const [street, setStreet] = useState<Street>("commit");
  const [hand, setHand] = useState<HandState | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [playerStack, setPlayerStack] = useState(INITIAL_STACK);
  const [opponentStack, setOpponentStack] = useState(INITIAL_STACK);
  const [pot, setPot] = useState(0);
  const [resultCopy, setResultCopy] = useState("");
  const [busy, setBusy] = useState(false);
  const [proofBundle, setProofBundle] = useState<ProofBundle | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [tamperResult, setTamperResult] = useState<VerificationResult | null>(null);
  const [showProof, setShowProof] = useState(false);
  const [toast, setToast] = useState("");
  const [completedHands, setCompletedHands] = useState(0);

  const visibleBoard = useMemo(() => {
    if (!hand) return [];
    if (street === "preflop" || street === "commit") return [];
    if (street === "flop") return hand.board.slice(0, 3);
    if (street === "turn") return hand.board.slice(0, 4);
    return hand.board;
  }, [hand, street]);

  const addEntry = useCallback(async (
    current: TranscriptEntry[],
    actor: TranscriptEntry["actor"],
    action: string,
    amount: number,
    actionStreet: string,
    handId: string,
  ) => appendTranscript(current, { actor, action, amount, street: actionStreet }, handId), []);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  async function prepareHand() {
    setBusy(true);
    setVerification(null);
    setTamperResult(null);
    setProofBundle(null);
    setResultCopy("");
    setShowProof(false);
    try {
      const handId = `river-${Date.now().toString(36)}-${randomHex(4)}`;
      const playerSeed = randomHex();
      const opponentSeed = randomHex();
      const [playerCommitment, opponentCommitment] = await Promise.all([
        commitment("player", handId, playerSeed),
        commitment("opponent", handId, opponentSeed),
      ]);
      const seed = await combinedSeed(handId, playerSeed, opponentSeed);
      const deck = await shuffleDeck(seed);
      const nextHand: HandState = {
        handId,
        playerSeed,
        opponentSeed,
        playerCommitment,
        opponentCommitment,
        combinedSeed: seed,
        deck,
        playerCards: [deck[0], deck[2]],
        opponentCards: [deck[1], deck[3]],
        board: [deck[5], deck[6], deck[7], deck[9], deck[11]],
      };
      let nextTranscript: TranscriptEntry[] = [];
      nextTranscript = await addEntry(nextTranscript, "protocol", "commit_player_seed", 0, "commit", handId);
      nextTranscript = await addEntry(nextTranscript, "protocol", "commit_opponent_seed", 0, "commit", handId);
      nextTranscript = await addEntry(nextTranscript, "player", "post_small_blind", 1, "preflop", handId);
      nextTranscript = await addEntry(nextTranscript, "opponent", "post_big_blind", 2, "preflop", handId);
      setHand(nextHand);
      setTranscript(nextTranscript);
      setPlayerStack(INITIAL_STACK - 1);
      setOpponentStack(INITIAL_STACK - 2);
      setPot(3);
      setStreet("preflop");
    } finally {
      setBusy(false);
    }
  }

  async function finishHand(
    nextTranscript: TranscriptEntry[],
    nextWinner: Exclude<Winner, null>,
    finalPot: number,
    copy: string,
  ) {
    if (!hand) return;
    let finalized = nextTranscript;
    finalized = await addEntry(finalized, "protocol", `award_${nextWinner}`, finalPot, "complete", hand.handId);
    if (nextWinner === "player") setPlayerStack((stack) => stack + finalPot);
    else if (nextWinner === "opponent") setOpponentStack((stack) => stack + finalPot);
    else {
      const half = finalPot / 2;
      setPlayerStack((stack) => stack + half);
      setOpponentStack((stack) => stack + half);
    }
    const bundle: ProofBundle = {
      version: "RIVER_POC_V2",
      handId: hand.handId,
      commitments: { player: hand.playerCommitment, opponent: hand.opponentCommitment },
      reveals: { playerSeed: hand.playerSeed, opponentSeed: hand.opponentSeed },
      combinedSeed: hand.combinedSeed,
      deck: hand.deck.map((card) => card.code),
      transcript: finalized,
      finalTranscriptHash:
        finalized.at(-1)?.hash ?? (await transcriptGenesis(hand.handId)),
    };
    const verified = await verifyBundle(bundle);
    setTranscript(finalized);
    setResultCopy(copy);
    setStreet("complete");
    setProofBundle(bundle);
    setVerification(verified);
    setPot(0);
    setCompletedHands((count) => {
      const next = count + 1;
      window.localStorage.setItem("river-poc-completed-hands", String(next));
      return next;
    });
  }

  async function showDown(nextTranscript: TranscriptEntry[], finalPot: number) {
    if (!hand) return;
    let updated = await addEntry(nextTranscript, "protocol", "reveal_seeds", 0, "showdown", hand.handId);
    updated = await addEntry(updated, "opponent", "reveal_hole_cards", 0, "showdown", hand.handId);
    const comparison = compareHands(hand.playerCards, hand.opponentCards, hand.board);
    if (comparison.result > 0) {
      await finishHand(updated, "player", finalPot, `You win with ${comparison.playerValue.label}.`);
    } else if (comparison.result < 0) {
      await finishHand(updated, "opponent", finalPot, `Opponent wins with ${comparison.opponentValue.label}.`);
    } else {
      await finishHand(updated, "split", finalPot, `Split pot - both hands make ${comparison.playerValue.label}.`);
    }
  }

  async function playerAction(action: "fold" | "call" | "raise" | "check" | "bet") {
    if (!hand || busy || street === "complete" || street === "commit") return;
    setBusy(true);
    try {
      let nextTranscript = transcript;
      let nextPot = pot;
      if (street === "preflop") {
        if (action === "fold") {
          nextTranscript = await addEntry(nextTranscript, "player", "fold", 0, street, hand.handId);
          await finishHand(nextTranscript, "opponent", nextPot, "You folded. The committed hand can still be verified.");
          return;
        }
        if (action === "call") {
          nextTranscript = await addEntry(nextTranscript, "player", "call", 1, street, hand.handId);
          nextTranscript = await addEntry(nextTranscript, "opponent", "check", 0, street, hand.handId);
          setPlayerStack((stack) => stack - 1);
          nextPot += 1;
          setPot(nextPot);
          setTranscript(nextTranscript);
          setStreet("flop");
          return;
        }
        const playerAdd = 5;
        nextTranscript = await addEntry(nextTranscript, "player", "raise_to_6", playerAdd, street, hand.handId);
        setPlayerStack((stack) => stack - playerAdd);
        nextPot += playerAdd;
        const response = await botDecision(hand.combinedSeed, "preflop", 72);
        if (response === "fold") {
          nextTranscript = await addEntry(nextTranscript, "opponent", "fold", 0, street, hand.handId);
          await finishHand(nextTranscript, "player", nextPot, "Opponent folded to your preflop raise.");
          return;
        }
        const opponentAdd = 4;
        nextTranscript = await addEntry(nextTranscript, "opponent", "call", opponentAdd, street, hand.handId);
        setOpponentStack((stack) => stack - opponentAdd);
        nextPot += opponentAdd;
        setPot(nextPot);
        setTranscript(nextTranscript);
        setStreet("flop");
        return;
      }

      const streetBet = { flop: 4, turn: 8, river: 12 }[street] ?? 0;
      if (action === "check") {
        nextTranscript = await addEntry(nextTranscript, "player", "check", 0, street, hand.handId);
        nextTranscript = await addEntry(nextTranscript, "opponent", "check", 0, street, hand.handId);
      } else {
        nextTranscript = await addEntry(nextTranscript, "player", "bet", streetBet, street, hand.handId);
        setPlayerStack((stack) => stack - streetBet);
        nextPot += streetBet;
        const response = await botDecision(hand.combinedSeed, street, street === "river" ? 62 : 68);
        if (response === "fold") {
          nextTranscript = await addEntry(nextTranscript, "opponent", "fold", 0, street, hand.handId);
          await finishHand(nextTranscript, "player", nextPot, `Opponent folded on the ${street}.`);
          return;
        }
        nextTranscript = await addEntry(nextTranscript, "opponent", "call", streetBet, street, hand.handId);
        setOpponentStack((stack) => stack - streetBet);
        nextPot += streetBet;
      }
      setPot(nextPot);
      setTranscript(nextTranscript);
      const index = streetOrder.indexOf(street);
      if (street === "river") await showDown(nextTranscript, nextPot);
      else setStreet(streetOrder[index + 1]);
    } finally {
      setBusy(false);
    }
  }

  async function runTamperTest() {
    if (!proofBundle) return;
    const corrupted: ProofBundle = {
      ...proofBundle,
      transcript: proofBundle.transcript.map((entry, index) =>
        index === 2 ? { ...entry, amount: entry.amount + 9 } : entry,
      ),
    };
    setTamperResult(await verifyBundle(corrupted));
  }

  async function copyProof() {
    if (!proofBundle) return;
    await navigator.clipboard.writeText(JSON.stringify(proofBundle, null, 2));
    notify("Proof JSON copied");
  }

  function downloadProof() {
    if (!proofBundle) return;
    const blob = new Blob([JSON.stringify(proofBundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${proofBundle.handId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const actionLabel = street === "preflop" ? "Action is on you" : `${street} - opponent checks`;

  return (
    <main className="proof-lab">
      <header className="lab-header">
        <Link className="brand" href="/" aria-label="Back to River home"><span className="brand-mark">R</span><span>RIVER</span></Link>
        <div className="lab-title"><FlaskConical size={15} /><span>PROOF LAB 001</span></div>
        <div className="lab-network"><span /> LOCAL PROOF MODE</div>
      </header>

      <div className="lab-shell">
        <aside className="lab-sidebar">
          <Link className="back-link" href="/"><ArrowLeft size={15} /> Back to lobby</Link>
          <div className="experiment-index">
            <span>EXPERIMENT</span>
            <strong>Committed<br />Heads-Up</strong>
            <p>A complete poker hand whose shuffle and action history can be independently recomputed.</p>
          </div>
          <div className="lab-mode-list">
            <button className="active"><span>01</span><div><b>NL Hold’em</b><small>Playable now</small></div><Check size={15} /></button>
            <button disabled><span>02</span><div><b>Pot-Limit Omaha</b><small>Deck module next</small></div></button>
            <button disabled><span>03</span><div><b>Short Deck</b><small>Rules module next</small></div></button>
          </div>
          <div className="guarantee-card">
            <Fingerprint size={20} />
            <div><b>What this proves</b><p>The deck and action log were not changed after both seeds were committed.</p></div>
          </div>
          <div className="scope-card">
            <CircleAlert size={17} />
            <p><b>Honest scope:</b> this browser plays both parties. Encrypted peer-to-peer dealing and Solana escrow are the next protocol milestone.</p>
          </div>
          <Link className="back-link" href="/play/deal-lab" style={{ marginTop: 18, marginBottom: 0 }}>Try the private-dealing demo <ArrowRight size={15} /></Link>
        </aside>

        <section className="lab-stage">
          <div className="lab-stage-head">
            <div><span className="section-kicker">PLAYABLE CRYPTOGRAPHIC POC</span><h1>Trust the proof,<br />not the dealer.</h1></div>
            <div className="hand-meta"><span>HANDS VERIFIED</span><strong>{completedHands.toString().padStart(2, "0")}</strong></div>
          </div>

          <div className="poc-table-shell">
            <div className="proof-strip">
              <div><span>PLAYER COMMIT</span><code>{hand ? shortHash(hand.playerCommitment) : "awaiting seed"}</code></div>
              <div><span>OPPONENT COMMIT</span><code>{hand ? shortHash(hand.opponentCommitment) : "awaiting seed"}</code></div>
              <div className={verification?.valid ? "verified" : ""}><span>HAND STATUS</span><code>{verification?.valid ? "VERIFIED" : hand ? "COMMITTED" : "NOT STARTED"}</code></div>
            </div>

            <div className="poker-scene">
              <div className="opponent-zone">
                <div className="player-tag"><span className="player-avatar opponent">OX</span><div><b>proofbot.sol</b><small>{opponentStack} test USDC</small></div></div>
                <div className="hole-cards">
                  <PlayingCard card={hand?.opponentCards[0]} hidden={street !== "complete"} compact />
                  <PlayingCard card={hand?.opponentCards[1]} hidden={street !== "complete"} compact />
                </div>
              </div>

              <div className="poc-felt">
                <div className="felt-stamp">RIVER / PROOF 001</div>
                <div className="board-cards">
                  {[0, 1, 2, 3, 4].map((index) => (
                    visibleBoard[index] ? <PlayingCard key={index} card={visibleBoard[index]} /> : <div className="board-placeholder" key={index}>{index < 3 ? "F" : index === 3 ? "T" : "R"}</div>
                  ))}
                </div>
                <div className="pot-chip"><span>POT</span><strong>{pot.toFixed(0)}</strong><small>TEST USDC</small></div>
                <div className="street-chip">{street === "commit" ? "READY" : street.toUpperCase()}</div>
              </div>

              <div className="player-zone">
                <div className="hole-cards">
                  <PlayingCard card={hand?.playerCards[0]} hidden={!hand} compact />
                  <PlayingCard card={hand?.playerCards[1]} hidden={!hand} compact />
                </div>
                <div className="player-tag"><span className="player-avatar">YOU</span><div><b>local player</b><small>{playerStack} test USDC</small></div></div>
              </div>
            </div>

            <div className="action-panel">
              {street === "commit" && (
                <><div><span className="action-eyebrow">NEW EXPERIMENT</span><h2>Commit both seeds and deal.</h2><p>The commitments appear before either seed is revealed.</p></div><button className="deal-button" onClick={prepareHand} disabled={busy}><Sparkles size={17} /> {busy ? "Committing..." : "Commit & deal"}</button></>
              )}
              {street !== "commit" && street !== "complete" && (
                <><div><span className="action-eyebrow">{actionLabel}</span><h2>{street === "preflop" ? "Call 1, raise, or fold." : "Check behind or apply pressure."}</h2><p>Every action extends the SHA-256 transcript chain.</p></div><div className="poker-actions">
                  {street === "preflop" ? <><button onClick={() => playerAction("fold")} disabled={busy}>Fold</button><button onClick={() => playerAction("call")} disabled={busy}>Call 1</button><button className="accent" onClick={() => playerAction("raise")} disabled={busy}>Raise to 6</button></> : <><button onClick={() => playerAction("check")} disabled={busy}>Check</button><button className="accent" onClick={() => playerAction("bet")} disabled={busy}>Bet {{ flop: 4, turn: 8, river: 12 }[street]}</button></>}
                </div></>
              )}
              {street === "complete" && (
                <><div className="result-message"><span className="action-eyebrow">HAND COMPLETE</span><h2>{resultCopy}</h2><p>{verification?.valid ? "All nine verification checks passed." : "Verification failed."}</p></div><div className="poker-actions"><button onClick={() => setShowProof(true)}><ShieldCheck size={16} /> Inspect proof</button><button className="accent" onClick={() => { setStreet("commit"); setHand(null); setTranscript([]); setPlayerStack(INITIAL_STACK); setOpponentStack(INITIAL_STACK); setPot(0); setVerification(null); setTamperResult(null); }}><RotateCcw size={16} /> New hand</button></div></>
              )}
            </div>
          </div>

          <section className="verification-explainer">
            <div className="section-heading"><div><span className="section-kicker">UNDER THE TABLE</span><h2>Nine checks. One verdict.</h2></div><p>The verifier binds the receipt to one hand, rebuilds the deck, replays the pot, and independently checks the winner.</p></div>
            <div className="verification-grid">
              {[
                ["01", "Receipt format", "The verifier rejects receipts from older or unknown proof formats."],
                ["02", "Seed commitments", "Each revealed seed must reproduce the hash published before the deal."],
                ["03", "Deterministic deck", "The verifier rebuilds all 52 card positions from the combined seed."],
                ["04", "Unique cards", "A valid deck contains every card exactly once - no duplicates or omissions."],
                ["05", "Hand-bound transcript", "Every action hash includes this hand ID, so another hand's history cannot be transplanted."],
                ["06", "Payout + winner", "The awarded pot must equal all contributions, and the winner must match the fold or reconstructed showdown."],
              ].map(([number, title, copy]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{copy}</p></article>)}
            </div>
          </section>
        </section>

        <aside className="transcript-panel">
          <div className="transcript-head"><TerminalSquare size={16} /><div><span>LIVE TRANSCRIPT</span><small>SHA-256 HASH CHAIN</small></div><i className={street !== "commit" && street !== "complete" ? "pulse" : ""} /></div>
          <div className="transcript-body">
            {transcript.length === 0 ? <div className="transcript-empty"><Zap size={20} /><p>Commit a hand to begin the tamper-evident event stream.</p></div> : transcript.map((entry) => <div className="log-entry" key={entry.hash}><div className="log-index">{entry.sequence.toString().padStart(2, "0")}</div><div><span>{entry.actor} / {entry.street}</span><b>{entry.action.replaceAll("_", " ")}{entry.amount ? ` · ${entry.amount}` : ""}</b><code>{shortHash(entry.hash, 8)}</code></div></div>)}
          </div>
          <div className="transcript-foot"><span>LATEST STATE HASH</span><code>{shortHash(transcript.at(-1)?.hash ?? "")}</code></div>
        </aside>
      </div>

      {showProof && proofBundle && verification && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowProof(false)}>
          <section className="modal proof-modal" role="dialog" aria-modal="true" aria-labelledby="proof-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" aria-label="Close proof" onClick={() => setShowProof(false)}><X size={19} /></button>
            <div className={`proof-verdict ${verification.valid ? "pass" : "fail"}`}><ShieldCheck size={27} /><div><span>VERIFICATION VERDICT</span><strong>{verification.valid ? "PROOF ACCEPTED" : "PROOF REJECTED"}</strong></div></div>
            <h2 id="proof-title">Independent hand receipt</h2>
            <p>These checks were run from revealed data, not trusted UI state. They prove internal consistency, not remote player identity.</p>
            <div className="proof-checks">
              {Object.entries(verification.checks).map(([name, passed]) => <div key={name}><span className={passed ? "passed" : "failed"}>{passed ? <Check size={14} /> : <X size={14} />}</span><b>{name.replace(/([A-Z])/g, " $1")}</b><small>{passed ? "MATCH" : "FAILED"}</small></div>)}
            </div>
            <div className="seed-reveal"><span>REVEALED COMBINED SEED</span><code>{proofBundle.combinedSeed}</code></div>
            {tamperResult && <div className={`tamper-result ${tamperResult.valid ? "bad" : "good"}`}><CircleAlert size={17} /><span>{tamperResult.valid ? "Unexpected acceptance" : "Tampered wager rejected - transcript hash mismatch detected."}</span></div>}
            <div className="proof-actions"><button onClick={runTamperTest}>Run tamper test</button><button onClick={copyProof}><Copy size={15} /> Copy JSON</button><button className="accent" onClick={downloadProof}><Download size={15} /> Download proof</button><a href="/receipts"><FileJson size={15} /> Receipt desk</a></div>
          </section>
        </div>
      )}

      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </main>
  );
}
