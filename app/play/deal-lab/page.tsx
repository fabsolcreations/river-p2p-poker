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
import { useMemo, useState } from "react";
import { cardLabel, commitment, freshDeck, randomHex, transcriptGenesis, type Card, type TranscriptEntry } from "../proof";
import {
  applyMasking,
  appendProtocolEntry,
  buildInitialDeck,
  cardPointTable,
  dealCommunityCard,
  dealPrivateCard,
  deriveMaskingRound,
  jointPublicKey,
  revealPartialDecryption,
  serializeCiphertext,
  verifyMentalPokerBundle,
  type DealReveal,
  type ElGamalCiphertext,
  type MaskingRound,
  type MentalPokerVerificationResult,
  type ProofBundleV3,
} from "../mental-poker";

type Stage = "idle" | "masked" | "dealt" | "verified";

type MaskState = {
  handId: string;
  playerMaskerSeed: string;
  opponentMaskerSeed: string;
  playerCommitment: string;
  opponentCommitment: string;
  playerRound: MaskingRound;
  opponentRound: MaskingRound;
  jointPublicKeyHex: string;
  deck: ElGamalCiphertext[];
};

const HOLE_POSITIONS = { player: [0, 2], opponent: [1, 3] };
const BOARD_POSITIONS = [5, 6, 7, 9, 11];

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

export default function DealLab() {
  const deckByCode = useMemo(() => new Map(freshDeck().map((card) => [card.code, card])), []);
  const resolveCard = (code?: string) => (code ? deckByCode.get(code) : undefined);

  const [stage, setStage] = useState<Stage>("idle");
  const [mask, setMask] = useState<MaskState | null>(null);
  const [deals, setDeals] = useState<DealReveal[]>([]);
  const [holeCards, setHoleCards] = useState<{ player: string[]; opponent: string[]; board: string[] }>({
    player: [],
    opponent: [],
    board: [],
  });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [bundle, setBundle] = useState<ProofBundleV3 | null>(null);
  const [verification, setVerification] = useState<MentalPokerVerificationResult | null>(null);
  const [tamperResult, setTamperResult] = useState<MentalPokerVerificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [showProof, setShowProof] = useState(false);
  const [toast, setToast] = useState("");
  const [experimentsVerified, setExperimentsVerified] = useState(0);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  async function runCommitAndMask() {
    setBusy(true);
    setBundle(null);
    setVerification(null);
    setTamperResult(null);
    setShowProof(false);
    try {
      const handId = `river-mp-${Date.now().toString(36)}-${randomHex(4)}`;
      const playerMaskerSeed = randomHex();
      const opponentMaskerSeed = randomHex();
      const [playerCommitment, opponentCommitment] = await Promise.all([
        commitment("player", handId, playerMaskerSeed),
        commitment("opponent", handId, opponentMaskerSeed),
      ]);
      const table = await cardPointTable();
      const playerRound = await deriveMaskingRound(handId, "player", playerMaskerSeed);
      const opponentRound = await deriveMaskingRound(handId, "opponent", opponentMaskerSeed);
      const jointPublicKeyHex = jointPublicKey(playerRound.publicKeyHex, opponentRound.publicKeyHex);

      let deck = buildInitialDeck(table.byCode);
      deck = applyMasking(deck, jointPublicKeyHex, playerRound.randomizersHex, playerRound.permutation);
      deck = applyMasking(deck, jointPublicKeyHex, opponentRound.randomizersHex, opponentRound.permutation);

      let nextTranscript: TranscriptEntry[] = [];
      nextTranscript = await appendProtocolEntry(nextTranscript, "commit_player_masking", handId);
      nextTranscript = await appendProtocolEntry(nextTranscript, "commit_opponent_masking", handId);
      nextTranscript = await appendProtocolEntry(nextTranscript, "mask_round_player", handId);
      nextTranscript = await appendProtocolEntry(nextTranscript, "mask_round_opponent", handId);

      setMask({
        handId,
        playerMaskerSeed,
        opponentMaskerSeed,
        playerCommitment,
        opponentCommitment,
        playerRound,
        opponentRound,
        jointPublicKeyHex,
        deck,
      });
      setDeals([]);
      setHoleCards({ player: [], opponent: [], board: [] });
      setTranscript(nextTranscript);
      setStage("masked");
    } finally {
      setBusy(false);
    }
  }

  async function runDeal() {
    if (!mask) return;
    setBusy(true);
    try {
      const table = await cardPointTable();
      const { handId, deck, playerRound, opponentRound } = mask;
      let nextTranscript = transcript;
      const nextDeals: DealReveal[] = [];
      const player: string[] = [];
      const opponent: string[] = [];
      const board: string[] = [];

      for (const position of HOLE_POSITIONS.player) {
        const ciphertext = deck[position];
        const otherPartial = await revealPartialDecryption(opponentRound.secretKeyHex, ciphertext);
        const code = dealPrivateCard(ciphertext, playerRound.secretKeyHex, otherPartial, table.byPointHex)!;
        nextDeals.push({ position, recipients: ["player"], partials: { opponent: otherPartial }, cardCode: code });
        player.push(code);
        nextTranscript = await appendProtocolEntry(nextTranscript, `deal_hole_player_${position}`, handId);
      }
      for (const position of HOLE_POSITIONS.opponent) {
        const ciphertext = deck[position];
        const otherPartial = await revealPartialDecryption(playerRound.secretKeyHex, ciphertext);
        const code = dealPrivateCard(ciphertext, opponentRound.secretKeyHex, otherPartial, table.byPointHex)!;
        nextDeals.push({ position, recipients: ["opponent"], partials: { player: otherPartial }, cardCode: code });
        opponent.push(code);
        nextTranscript = await appendProtocolEntry(nextTranscript, `deal_hole_opponent_${position}`, handId);
      }
      for (const position of BOARD_POSITIONS) {
        const ciphertext = deck[position];
        const playerPartial = await revealPartialDecryption(playerRound.secretKeyHex, ciphertext);
        const opponentPartial = await revealPartialDecryption(opponentRound.secretKeyHex, ciphertext);
        const code = dealCommunityCard(ciphertext, playerPartial, opponentPartial, table.byPointHex)!;
        nextDeals.push({
          position,
          recipients: ["player", "opponent"],
          partials: { player: playerPartial, opponent: opponentPartial },
          cardCode: code,
        });
        board.push(code);
        nextTranscript = await appendProtocolEntry(nextTranscript, `deal_board_${position}`, handId);
      }

      setDeals(nextDeals);
      setHoleCards({ player, opponent, board });
      setTranscript(nextTranscript);
      setStage("dealt");
    } finally {
      setBusy(false);
    }
  }

  async function runRevealAndVerify() {
    if (!mask) return;
    setBusy(true);
    try {
      let nextTranscript = transcript;
      nextTranscript = await appendProtocolEntry(nextTranscript, "reveal_player_masking", mask.handId);
      nextTranscript = await appendProtocolEntry(nextTranscript, "reveal_opponent_masking", mask.handId);

      const nextBundle: ProofBundleV3 = {
        version: "RIVER_POC_V3",
        handId: mask.handId,
        commitments: { player: mask.playerCommitment, opponent: mask.opponentCommitment },
        reveals: { playerMaskerSeed: mask.playerMaskerSeed, opponentMaskerSeed: mask.opponentMaskerSeed },
        maskingRounds: { player: mask.playerRound, opponent: mask.opponentRound },
        jointPublicKeyHex: mask.jointPublicKeyHex,
        maskedDeck: mask.deck.map(serializeCiphertext),
        deals,
        transcript: nextTranscript,
        finalTranscriptHash: nextTranscript.at(-1)?.hash ?? (await transcriptGenesis(mask.handId)),
      };
      const result = await verifyMentalPokerBundle(nextBundle);
      setTranscript(nextTranscript);
      setBundle(nextBundle);
      setVerification(result);
      setStage("verified");
      setExperimentsVerified((count) => count + 1);
    } finally {
      setBusy(false);
    }
  }

  async function runTamperTest() {
    if (!bundle) return;
    const corrupted: ProofBundleV3 = {
      ...bundle,
      maskedDeck: bundle.maskedDeck.map((entry, index) => (index === 10 ? bundle.maskedDeck[20] : entry)),
    };
    setTamperResult(await verifyMentalPokerBundle(corrupted));
  }

  async function copyProof() {
    if (!bundle) return;
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    notify("Proof JSON copied");
  }

  function downloadProof() {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${bundle.handId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function newExperiment() {
    setStage("idle");
    setMask(null);
    setDeals([]);
    setHoleCards({ player: [], opponent: [], board: [] });
    setTranscript([]);
    setBundle(null);
    setVerification(null);
    setTamperResult(null);
    setShowProof(false);
  }

  const statusLabel = { idle: "NOT STARTED", masked: "MASKED", dealt: "DEALT", verified: "VERIFIED" }[stage];

  return (
    <main className="proof-lab">
      <header className="lab-header">
        <Link className="brand" href="/" aria-label="Back to River home"><span className="brand-mark">R</span><span>RIVER</span></Link>
        <div className="lab-title"><FlaskConical size={15} /><span>DEAL LAB 002</span></div>
        <div className="lab-network"><span /> LOCAL MENTAL POKER</div>
      </header>

      <div className="lab-shell">
        <aside className="lab-sidebar">
          <Link className="back-link" href="/play"><ArrowLeft size={15} /> Back to proof lab</Link>
          <div className="experiment-index">
            <span>EXPERIMENT</span>
            <strong>No Trusted<br />Dealer</strong>
            <p>Two browsers mask, shuffle, and deal a deck to each other with ElGamal encryption - neither one can see the other&apos;s hole cards.</p>
          </div>
          <div className="lab-mode-list">
            <button className="active"><span>01</span><div><b>ElGamal masking</b><small>Playable now</small></div><Check size={15} /></button>
            <button disabled><span>02</span><div><b>Remote transport</b><small>Next protocol milestone</small></div></button>
          </div>
          <div className="guarantee-card">
            <Fingerprint size={20} />
            <div><b>What this proves</b><p>A player&apos;s own key alone cannot resolve a dealt card - it also needs the other player&apos;s partial decryption, computed from a key that stays secret until reveal.</p></div>
          </div>
          <div className="scope-card">
            <CircleAlert size={17} />
            <p><b>Honest scope:</b> this browser still plays both parties for the demo. The masking math is the same either way - real two-device transport is the next milestone.</p>
          </div>
          <Link className="back-link" href="/play/table-lab" style={{ marginTop: 18, marginBottom: 0 }}>Play a real hand against another browser <ArrowRight size={15} /></Link>
        </aside>

        <section className="lab-stage">
          <div className="lab-stage-head">
            <div><span className="section-kicker">PLAYABLE CRYPTOGRAPHIC POC</span><h1>No one dealt<br />these cards.</h1></div>
            <div className="hand-meta"><span>EXPERIMENTS VERIFIED</span><strong>{experimentsVerified.toString().padStart(2, "0")}</strong></div>
          </div>

          <div className="poc-table-shell">
            <div className="proof-strip">
              <div><span>PLAYER COMMIT</span><code>{mask ? shortHash(mask.playerCommitment) : "awaiting seed"}</code></div>
              <div><span>OPPONENT COMMIT</span><code>{mask ? shortHash(mask.opponentCommitment) : "awaiting seed"}</code></div>
              <div className={verification?.valid ? "verified" : ""}><span>STATUS</span><code>{statusLabel}</code></div>
            </div>

            <div className="poker-scene">
              <div className="opponent-zone">
                <div className="player-tag"><span className="player-avatar opponent">OX</span><div><b>proofbot.sol</b><small>masking key held privately</small></div></div>
                <div className="hole-cards">
                  <PlayingCard card={resolveCard(holeCards.opponent[0])} hidden={stage === "idle" || stage === "masked"} compact />
                  <PlayingCard card={resolveCard(holeCards.opponent[1])} hidden={stage === "idle" || stage === "masked"} compact />
                </div>
              </div>

              <div className="poc-felt">
                <div className="felt-stamp">RIVER / DEAL 002</div>
                <div className="board-cards">
                  {[0, 1, 2, 3, 4].map((index) => (
                    holeCards.board[index]
                      ? <PlayingCard key={index} card={resolveCard(holeCards.board[index])} />
                      : <div className="board-placeholder" key={index}>{index < 3 ? "F" : index === 3 ? "T" : "R"}</div>
                  ))}
                </div>
                <div className="street-chip">{statusLabel}</div>
              </div>

              <div className="player-zone">
                <div className="hole-cards">
                  <PlayingCard card={resolveCard(holeCards.player[0])} hidden={stage === "idle" || stage === "masked"} compact />
                  <PlayingCard card={resolveCard(holeCards.player[1])} hidden={stage === "idle" || stage === "masked"} compact />
                </div>
                <div className="player-tag"><span className="player-avatar">YOU</span><div><b>local player</b><small>masking key held privately</small></div></div>
              </div>
            </div>

            <div className="action-panel">
              {stage === "idle" && (
                <><div><span className="action-eyebrow">NEW EXPERIMENT</span><h2>Commit seeds and mask the deck.</h2><p>Both masking keys and permutations stay secret until reveal.</p></div><button className="deal-button" onClick={runCommitAndMask} disabled={busy}><Sparkles size={17} /> {busy ? "Masking..." : "Commit & mask"}</button></>
              )}
              {stage === "masked" && (
                <><div><span className="action-eyebrow">DECK MASKED &amp; SHUFFLED TWICE</span><h2>Deal hole and board cards.</h2><p>Each card is resolved through a real partial-decryption exchange, not a shortcut.</p></div><button className="deal-button" onClick={runDeal} disabled={busy}><Sparkles size={17} /> {busy ? "Dealing..." : "Deal all cards"}</button></>
              )}
              {stage === "dealt" && (
                <><div><span className="action-eyebrow">CARDS DEALT</span><h2>Reveal seeds and verify.</h2><p>Independent replay must reproduce the exact masking, dealing, and transcript history.</p></div><button className="deal-button" onClick={runRevealAndVerify} disabled={busy}><ShieldCheck size={17} /> {busy ? "Verifying..." : "Reveal & verify"}</button></>
              )}
              {stage === "verified" && (
                <><div className="result-message"><span className="action-eyebrow">EXPERIMENT COMPLETE</span><h2>{verification?.valid ? "All checks passed." : "Verification failed."}</h2><p>{verification?.valid ? "Every masking round, deal, and partial decryption replayed exactly." : "One or more checks did not match."}</p></div><div className="poker-actions"><button onClick={() => setShowProof(true)}><ShieldCheck size={16} /> Inspect proof</button><button className="accent" onClick={newExperiment}><RotateCcw size={16} /> New experiment</button></div></>
              )}
            </div>
          </div>

          <section className="verification-explainer">
            <div className="section-heading"><div><span className="section-kicker">UNDER THE TABLE</span><h2>Fifteen checks. One verdict.</h2></div><p>The verifier recomputes every key, permutation, masking round, and deal from the revealed seeds alone - not from trusted UI state.</p></div>
            <div className="verification-grid">
              {[
                ["01", "Seed commitments", "Each revealed masker seed must reproduce the hash published before the deal."],
                ["02", "Key + shuffle derivation", "Every masking key, permutation, and randomizer must be reproducible from the revealed seed alone."],
                ["03", "Joint public key", "The combined key used to mask the deck must equal the sum of both revealed public keys."],
                ["04", "Deterministic masked deck", "Replaying both masking rounds from a fresh deck must reproduce the exact ciphertexts play used."],
                ["05", "Well-formed deals", "Every dealt position is in range, appears once, and resolves to a real, unique card."],
                ["06", "Correct partial decryptions", "Every partial decryption recorded during play must match what the revealed key actually produces."],
                ["07", "Plaintexts match ciphertexts", "Every dealt card code must match independent decryption of its ciphertext."],
                ["08", "Hand-bound transcript", "Every protocol event hashes in this hand ID, so history cannot be transplanted."],
              ].map(([number, title, copy]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{copy}</p></article>)}
            </div>
          </section>
        </section>

        <aside className="transcript-panel">
          <div className="transcript-head"><TerminalSquare size={16} /><div><span>LIVE TRANSCRIPT</span><small>SHA-256 HASH CHAIN</small></div><i className={stage === "masked" || stage === "dealt" ? "pulse" : ""} /></div>
          <div className="transcript-body">
            {transcript.length === 0 ? <div className="transcript-empty"><Zap size={20} /><p>Commit and mask to begin the tamper-evident event stream.</p></div> : transcript.map((entry) => <div className="log-entry" key={entry.hash}><div className="log-index">{entry.sequence.toString().padStart(2, "0")}</div><div><span>{entry.actor} / {entry.street}</span><b>{entry.action.replaceAll("_", " ")}</b><code>{shortHash(entry.hash, 8)}</code></div></div>)}
          </div>
          <div className="transcript-foot"><span>LATEST STATE HASH</span><code>{shortHash(transcript.at(-1)?.hash ?? "")}</code></div>
        </aside>
      </div>

      {showProof && bundle && verification && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowProof(false)}>
          <section className="modal proof-modal" role="dialog" aria-modal="true" aria-labelledby="proof-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" aria-label="Close proof" onClick={() => setShowProof(false)}><X size={19} /></button>
            <div className={`proof-verdict ${verification.valid ? "pass" : "fail"}`}><ShieldCheck size={27} /><div><span>VERIFICATION VERDICT</span><strong>{verification.valid ? "PROOF ACCEPTED" : "PROOF REJECTED"}</strong></div></div>
            <h2 id="proof-title">Independent dealing receipt</h2>
            <p>These checks replay the masking, shuffling, and dealing from revealed data, not trusted UI state.</p>
            <div className="proof-checks">
              {Object.entries(verification.checks).map(([name, passed]) => <div key={name}><span className={passed ? "passed" : "failed"}>{passed ? <Check size={14} /> : <X size={14} />}</span><b>{name.replace(/([A-Z])/g, " $1")}</b><small>{passed ? "MATCH" : "FAILED"}</small></div>)}
            </div>
            <div className="seed-reveal"><span>REVEALED JOINT PUBLIC KEY</span><code>{bundle.jointPublicKeyHex}</code></div>
            {tamperResult && <div className={`tamper-result ${tamperResult.valid ? "bad" : "good"}`}><CircleAlert size={17} /><span>{tamperResult.valid ? "Unexpected acceptance" : "Tampered masked deck rejected - replay mismatch detected."}</span></div>}
            <div className="proof-actions"><button onClick={runTamperTest}>Run tamper test</button><button onClick={copyProof}><Copy size={15} /> Copy JSON</button><button className="accent" onClick={downloadProof}><Download size={15} /> Download proof</button><a href="/receipts"><FileJson size={15} /> Receipt desk</a></div>
          </section>
        </div>
      )}

      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </main>
  );
}
