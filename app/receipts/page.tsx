"use client";

import {
  ArrowRight,
  BadgeCheck,
  Check,
  CircleAlert,
  Download,
  FileJson,
  Fingerprint,
  FolderOpen,
  Pause,
  Play,
  Search,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { RiverShell } from "../components/river-shell";
import {
  appendTranscript,
  cardLabel,
  combinedSeed,
  commitment,
  freshDeck,
  shuffleDeck,
  verifyBundle,
  type Card,
  type ProofBundle,
  type TranscriptEntry,
  type VerificationResult,
} from "../play/proof";
import { verifyTableBundle, type TableProofBundle, type TableVerificationResult } from "../../worker/table-engine";
import { buildReplay, type ReplayData } from "./hand-replay";

type Inspection = { bundle: ProofBundle; result: VerificationResult; source: string };

// Same small presentational helpers table-lab/page.tsx defines locally for
// its own live felt - duplicated here rather than shared, since it's a
// handful of lines tightly coupled to each page's own layout.
function suitSymbol(suit: Card["suit"]) {
  return { s: "♠", h: "♥", d: "♦", c: "♣" }[suit];
}
function rankSymbol(rank: number) {
  return ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"][rank - 2];
}
function ReplayCard({ card, hidden = false }: { card?: Card; hidden?: boolean }) {
  if (!card || hidden) return <div className="table-card card-back mini" aria-label="Hidden card"><span>R</span></div>;
  const red = card.suit === "h" || card.suit === "d";
  return <div className={`table-card mini ${red ? "red" : ""}`} aria-label={cardLabel(card)}><b>{rankSymbol(card.rank)}</b><span>{suitSymbol(card.suit)}</span></div>;
}
function actorLabel(actor: string): string {
  const match = /^seat_(\d+)$/.exec(actor);
  return match ? `Seat ${match[1]}` : actor;
}

type RealHandRow = {
  handId: string;
  roomCode: string;
  seatCount: number;
  completedAt: string;
  bundle: string;
  seat: number;
  netResult: number;
};

async function sampleBundle(handId = "river-receipt-sample-v2"): Promise<ProofBundle> {
  const playerSeed = "10".repeat(32);
  const opponentSeed = "20".repeat(32);
  const [playerCommit, opponentCommit, seed] = await Promise.all([
    commitment("player", handId, playerSeed),
    commitment("opponent", handId, opponentSeed),
    combinedSeed(handId, playerSeed, opponentSeed),
  ]);
  const deck = await shuffleDeck(seed);
  let transcript: TranscriptEntry[] = [];
  transcript = await appendTranscript(transcript, { actor: "player", street: "preflop", action: "post_small_blind", amount: 1 }, handId);
  transcript = await appendTranscript(transcript, { actor: "opponent", street: "preflop", action: "post_big_blind", amount: 2 }, handId);
  transcript = await appendTranscript(transcript, { actor: "player", street: "preflop", action: "fold", amount: 0 }, handId);
  transcript = await appendTranscript(transcript, { actor: "protocol", street: "complete", action: "award_opponent", amount: 3 }, handId);
  return {
    version: "RIVER_POC_V2",
    handId,
    commitments: { player: playerCommit, opponent: opponentCommit },
    reveals: { playerSeed, opponentSeed },
    combinedSeed: seed,
    deck: deck.map((card) => card.code),
    transcript,
    finalTranscriptHash: transcript.at(-1)?.hash ?? "",
  };
}

function looksLikeBundle(value: unknown): value is ProofBundle {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProofBundle>;
  return typeof candidate.handId === "string" && !!candidate.commitments && !!candidate.reveals && Array.isArray(candidate.deck) && Array.isArray(candidate.transcript) && typeof candidate.finalTranscriptHash === "string";
}

export default function ReceiptsPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<"All" | "Won" | "Lost">("All");
  const deckByCode = useMemo(() => new Map(freshDeck().map((card) => [card.code, card])), []);

  const [signedIn, setSignedIn] = useState<boolean | "loading">("loading");
  const [realHands, setRealHands] = useState<RealHandRow[]>([]);
  const [tableInspection, setTableInspection] = useState<{ bundle: TableProofBundle; result: TableVerificationResult } | null>(null);
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replaying, setReplaying] = useState(false);
  // Derived, not stored: once the last step is reached there's nothing
  // left to auto-advance to, so "actually playing" is false regardless of
  // the `replaying` intent flag - avoids an effect synchronously calling
  // setReplaying(false) just to keep the two in sync (that was the
  // original lint complaint here).
  const isAutoPlaying = replaying && !!replay && replayIndex < replay.steps.length - 1;

  // Deliberately depends on replayIndex (not just isAutoPlaying) so a
  // fresh timeout gets scheduled every single step - collapsing the
  // dependency down to the derived boolean alone stops re-triggering once
  // the boolean's VALUE stops changing between renders, even though the
  // step itself keeps advancing (confirmed live: auto-play advanced
  // exactly once, then silently stalled, before this fix).
  useEffect(() => {
    if (!replaying || !replay || replayIndex >= replay.steps.length - 1) return;
    const timer = window.setTimeout(() => setReplayIndex((index) => index + 1), 900);
    return () => window.clearTimeout(timer);
  }, [replaying, replay, replayIndex]);

  function openReplay(bundle: TableProofBundle) {
    setReplay(buildReplay(bundle));
    setReplayIndex(0);
    setReplaying(false);
  }

  function closeReplay() {
    setReplay(null);
    setReplaying(false);
  }

  useEffect(() => {
    async function load() {
      const me = await fetch("/api/auth/me");
      const meBody = (await me.json()) as { user: unknown };
      const isSignedIn = Boolean(meBody.user);
      if (isSignedIn) {
        const response = await fetch("/api/account/hands");
        if (response.ok) {
          const body = (await response.json()) as { hands: RealHandRow[] };
          setRealHands(body.hands);
        }
      }
      setSignedIn(isSignedIn);
    }
    load();
  }, []);

  const rows = realHands.filter((row) => {
    const won = row.netResult > 0;
    const resultMatch = resultFilter === "All" || (resultFilter === "Won") === won;
    const needle = query.toLowerCase().trim();
    return resultMatch && (!needle || `${row.handId} ${row.roomCode}`.toLowerCase().includes(needle));
  });

  async function inspect(bundle: ProofBundle, source: string) {
    try {
      const result = await verifyBundle(bundle);
      setInspection({ bundle, result, source });
      setError("");
    } catch {
      setInspection(null);
      setError("The file resembles a receipt but cannot be evaluated safely.");
    }
  }

  async function loadSample(handId?: string) {
    await inspect(await sampleBundle(handId), "Generated known-good V2 sample");
  }

  async function inspectRealHand(row: RealHandRow) {
    const bundle = JSON.parse(row.bundle) as TableProofBundle;
    const result = await verifyTableBundle(bundle);
    setTableInspection({ bundle, result });
  }

  async function importFile(file?: File) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!looksLikeBundle(parsed)) throw new Error("shape");
      await inspect(parsed, file.name);
    } catch {
      setInspection(null);
      setError("That file is not a recognizable RIVER V2 hand receipt.");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function downloadSample() {
    if (!inspection) return;
    const blob = new Blob([JSON.stringify(inspection.bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${inspection.bundle.handId}.river.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <RiverShell active="receipts" dark footer={false}>
      <main className="receipts-page">
        <section className="receipts-hero">
          <div><span><Fingerprint size={15} /> RIVER / RECEIPT DESK</span><h1>Trust the file,<br />not the screenshot.</h1><p>Import a completed hand receipt and rerun every local check. The verifier does not rely on the table UI that produced it.</p><div><button onClick={() => inputRef.current?.click()}><Upload size={16} /> Import receipt</button><button className="secondary" onClick={() => loadSample()}><FileJson size={16} /> Load known-good sample</button></div><input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(event) => importFile(event.target.files?.[0])} /></div>
          <article className="receipt-anatomy"><div><ShieldCheck size={18} /><span>V2 RECEIPT ANATOMY</span><b>09 / 09</b></div>{["Format and hand ID", "Two seed commitments", "Combined seed + full deck", "Hand-bound action chain", "Pot contribution replay", "Independent winner check"].map((item, index) => <p key={item}><span>{String(index + 1).padStart(2, "0")}</span>{item}<Check size={14} /></p>)}</article>
        </section>

        <section className="receipt-workbench">
          <div className="receipt-workbench-head"><div><span>LOCAL VERIFICATION WORKBENCH</span><h2>Drop JSON. Get a verdict.</h2></div><p>Processing stays in this browser. The sample uses the same verifier as Proof Lab.</p></div>
          <button className="receipt-dropzone" onClick={() => inputRef.current?.click()}><FolderOpen size={28} /><b>Choose a RIVER receipt</b><span>V2 JSON · local processing · no upload</span></button>
          {error && <div className="receipt-import-error"><CircleAlert size={18} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={15} /></button></div>}
          {inspection && <section className={`receipt-inspection ${inspection.result.valid ? "valid" : "invalid"}`}>
            <div className="receipt-verdict"><span>{inspection.result.valid ? <BadgeCheck size={25} /> : <CircleAlert size={25} />}</span><div><small>VERIFICATION VERDICT</small><h3>{inspection.result.valid ? "Receipt accepted" : "Receipt rejected"}</h3><p>{inspection.source} · {inspection.bundle.handId}</p></div><b>{Object.values(inspection.result.checks).filter(Boolean).length} / 9</b></div>
            <div className="receipt-check-grid">{Object.entries(inspection.result.checks).map(([name, passed]) => <div key={name}><span className={passed ? "pass" : "fail"}>{passed ? <Check size={13} /> : <X size={13} />}</span><b>{name.replace(/([A-Z])/g, " $1")}</b><small>{passed ? "MATCH" : "FAILED"}</small></div>)}</div>
            <div className="receipt-inspection-foot"><div><span>FINAL TRANSCRIPT HASH</span><code>{inspection.bundle.finalTranscriptHash}</code></div><button onClick={downloadSample}><Download size={15} /> Download inspected copy</button></div>
          </section>}
        </section>

        <section className="receipt-archive">
          <div className="receipt-archive-head"><div><span>YOUR HAND HISTORY</span><h2>Recent hand trail.</h2><p>Real hands you played, signed in - independently re-verifiable, not a stored verdict.</p></div><label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search hand or room" /></label><div>{(["All", "Won", "Lost"] as const).map((item) => <button className={resultFilter === item ? "active" : ""} onClick={() => setResultFilter(item)} key={item}>{item}</button>)}</div></div>
          <div className="receipt-table-head"><span>HAND ID</span><span>ROOM</span><span>SEAT</span><span>RESULT</span><span>COMPLETED</span><span>VERDICT</span><span /></div>
          {signedIn === "loading" ? (
            <div className="receipt-rows"><p className="receipt-history-empty">Loading your hand history...</p></div>
          ) : signedIn === false ? (
            <div className="receipt-rows"><p className="receipt-history-empty">Sign in to see hands you&apos;ve actually played. <a href="/account">Sign in <ArrowRight size={13} /></a></p></div>
          ) : rows.length === 0 ? (
            <div className="receipt-rows"><p className="receipt-history-empty">No hands yet - play one at a <a href="/lobby">live table <ArrowRight size={13} /></a> and it&apos;ll show up here.</p></div>
          ) : (
            <div className="receipt-rows">{rows.map((row) => (
              // Keyed by handId+seat, not handId alone - the same account
              // can hold two participant rows for one hand (e.g. testing
              // both seats of a heads-up table from one account), which
              // would otherwise collide.
              <button key={`${row.handId}-${row.seat}`} onClick={() => inspectRealHand(row)}>
                <code>{row.handId.slice(-14)}</code>
                <b>{row.roomCode}</b>
                <span>Seat {row.seat}</span>
                <b className={row.netResult >= 0 ? "positive" : ""}>{row.netResult >= 0 ? "+" : ""}{row.netResult}</b>
                <span>{new Date(row.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <i><ShieldCheck size={12} /> Inspect</i>
                <ArrowRight size={16} />
              </button>
            ))}</div>
          )}
        </section>

        {tableInspection && (
          <div className="modal-backdrop" role="presentation" onMouseDown={() => setTableInspection(null)}>
            <section className="modal" role="dialog" aria-modal="true" aria-labelledby="table-proof-title" onMouseDown={(event) => event.stopPropagation()}>
              <button className="modal-close" aria-label="Close proof" onClick={() => setTableInspection(null)}><X size={19} /></button>
              <div className={`proof-verdict ${tableInspection.result.valid ? "pass" : "fail"}`}><ShieldCheck size={27} /><div><span>VERIFICATION VERDICT</span><strong>{tableInspection.result.valid ? "PROOF ACCEPTED" : "PROOF REJECTED"}</strong></div></div>
              <h2 id="table-proof-title">Independent hand receipt</h2>
              <p>Recomputed client-side from the stored bundle, the same way it was verified live at the table.</p>
              <div className="proof-checks">
                {Object.entries(tableInspection.result.checks).map(([name, passed]) => <div key={name}><span className={passed ? "passed" : "failed"}>{passed ? <Check size={14} /> : <X size={14} />}</span><b>{name.replace(/([A-Z])/g, " $1")}</b><small>{passed ? "MATCH" : "FAILED"}</small></div>)}
              </div>
              <div className="seed-reveal"><span>REVEALED COMBINED SEED</span><code>{tableInspection.bundle.combinedSeed}</code></div>
              <div className="proof-actions"><button onClick={() => openReplay(tableInspection.bundle)}><Play size={15} /> Replay hand</button></div>
            </section>
          </div>
        )}

        {replay && (() => {
          const step = replay.steps[replayIndex];
          return (
            <div className="modal-backdrop" role="presentation" onMouseDown={closeReplay}>
              <section className="modal" role="dialog" aria-modal="true" aria-labelledby="replay-title" onMouseDown={(event) => event.stopPropagation()}>
                <button className="modal-close" aria-label="Close replay" onClick={closeReplay}><X size={19} /></button>
                <h2 id="replay-title">Hand replay</h2>
                <p>Stepped forward from the stored transcript - board, pot, and contributions exactly as they happened. No pacing data is stored, so this steps one action at a time rather than replaying at the original speed.</p>
                <div className="replay-board">
                  {[0, 1, 2, 3, 4].map((index) => (
                    step.board[index]
                      ? <ReplayCard key={index} card={deckByCode.get(step.board[index])} />
                      : <div className="empty-board-card" key={index}><span>{index < 3 ? "F" : index === 3 ? "T" : "R"}</span></div>
                  ))}
                </div>
                <p className="replay-pot"><i className="chip-icon" /> Pot {step.pot} TEST</p>
                <div className="replay-seats">
                  {Array.from({ length: replay.seatCount }, (_, seat) => (
                    <div className={`replay-seat ${step.folded[seat] ? "folded" : ""}`} key={seat}>
                      <b>Seat {seat}{step.folded[seat] ? " (folded)" : ""}</b>
                      <div className="replay-seat-cards">
                        <ReplayCard card={replay.holeCards[seat] ? deckByCode.get(replay.holeCards[seat]![0]) : undefined} hidden={!replay.holeCards[seat]} />
                        <ReplayCard card={replay.holeCards[seat] ? deckByCode.get(replay.holeCards[seat]![1]) : undefined} hidden={!replay.holeCards[seat]} />
                      </div>
                      <small>Contributed {step.contributed[seat]}</small>
                    </div>
                  ))}
                </div>
                <p className="replay-step-label">STEP {replayIndex + 1} / {replay.steps.length} · {step.street.toUpperCase()} · {actorLabel(step.actor)} {step.action}{step.amount ? ` ${step.amount}` : ""}</p>
                <div className="proof-actions replay-controls">
                  <button onClick={() => { setReplaying(false); setReplayIndex(0); }} disabled={replayIndex === 0}><SkipBack size={15} /> Start</button>
                  <button onClick={() => { setReplaying(false); setReplayIndex((i) => Math.max(0, i - 1)); }} disabled={replayIndex === 0}>Prev</button>
                  <button className="replay-play-toggle" onClick={() => setReplaying((p) => !p)} disabled={replayIndex >= replay.steps.length - 1}>
                    {isAutoPlaying ? <><Pause size={15} /> Pause</> : <><Play size={15} /> Play</>}
                  </button>
                  <button onClick={() => { setReplaying(false); setReplayIndex((i) => Math.min(replay.steps.length - 1, i + 1)); }} disabled={replayIndex >= replay.steps.length - 1}>Next</button>
                  <button onClick={() => { setReplaying(false); setReplayIndex(replay.steps.length - 1); }} disabled={replayIndex >= replay.steps.length - 1}><SkipForward size={15} /> End</button>
                </div>
              </section>
            </div>
          );
        })()}
      </main>
    </RiverShell>
  );
}
