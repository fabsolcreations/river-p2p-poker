"use client";

import {
  Check,
  CircleAlert,
  Copy,
  Download,
  FileJson,
  Fingerprint,
  LockKeyhole,
  LogOut,
  MessageCircle,
  Mic,
  MicOff,
  Rabbit,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { RiverShell } from "../../components/river-shell";
import { cardLabel, freshDeck, randomHex, type Card } from "../proof";
import {
  connectTable,
  type ActionType,
  type ChatMessage,
  type InitialTableSettings,
  type PublicHandState,
  type Seat,
  type ServerMessage,
  type SidePot,
  type TableConnection,
  type TransportStatus,
} from "../table-transport";
import { verifyTableBundle, type TableProofBundle, type TableVerificationResult } from "../../../worker/table-engine";
import { createVoiceChat, type VoiceChat, type VoiceStatus } from "../voice-chat";

const MIN_SEATS = 2;
const MAX_SEATS = 10;
const DEFAULT_SEATS = 6;

function randomRoomCode() {
  const bytes = new Uint8Array(3);
  window.crypto.getRandomValues(bytes);
  return `TABLE-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function suitSymbol(suit: Card["suit"]) {
  return { s: "♠", h: "♥", d: "♦", c: "♣" }[suit];
}

function rankSymbol(rank: number) {
  return ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"][rank - 2];
}

function TableCard({ card, hidden = false, mini = false }: { card?: Card; hidden?: boolean; mini?: boolean }) {
  if (!card || hidden) return <div className={`table-card card-back ${mini ? "mini" : ""}`} aria-label="Hidden card"><span>R</span></div>;
  const red = card.suit === "h" || card.suit === "d";
  return <div className={`table-card ${red ? "red" : ""} ${mini ? "mini" : ""}`} aria-label={cardLabel(card)}><b>{rankSymbol(card.rank)}</b><span>{suitSymbol(card.suit)}</span></div>;
}

// Ring position for a seat, expressed as % of .room-felt-wrap - displayIndex 0
// always lands south (the viewer's own seat, once assigned), rotating
// clockwise from there so every browser sees itself "from the same side."
function seatPosition(displayIndex: number, seatCount: number) {
  const angle = 180 + (displayIndex * 360) / seatCount;
  const rad = (angle * Math.PI) / 180;
  // rx is smaller than ry (not a symmetric circle) so the seat boxes -
  // which are wider than they are tall - keep clear of the felt-wrap's
  // edges at narrow viewports. A plain constant, not viewport-reactive:
  // reading window.innerWidth here would run during SSR too and mismatch
  // the client's real width, the same hydration bug already hit once this
  // session with Math.sin/cos precision.
  const rx = 33;
  const ry = 40;
  // Rounded to a fixed precision so the SSR (Workers runtime) and client
  // (browser) renders always agree on the exact string - Math.sin/cos
  // aren't guaranteed bit-identical across JS engines, and React's
  // hydration check is a strict string compare.
  return { left: `${(50 + rx * Math.sin(rad)).toFixed(3)}%`, top: `${(50 - ry * Math.cos(rad)).toFixed(3)}%` };
}

function myFacingBet(state: PublicHandState | null, seat: Seat | null): number {
  if (!state || seat === null) return 0;
  const currentBet = Math.max(0, ...state.streetContributed);
  return currentBet - (state.streetContributed[seat] ?? 0);
}

// Mirrors worker/table-engine.ts's legalActions() - the server is the real
// authority (it validates independently), this is just for a responsive UI.
function legalActionsForDisplay(state: PublicHandState | null, mySeat: Seat | null, myStack: number | undefined): ActionType[] {
  if (!state || mySeat === null || state.toAct !== mySeat || myStack === undefined) return [];
  if (state.street === "waiting" || state.street === "complete") return [];
  const owed = myFacingBet(state, mySeat);
  if (owed > 0) return myStack > owed ? ["fold", "call", "raise"] : ["fold", "call"];
  if (state.street === "preflop") return myStack > 0 ? ["check", "raise"] : ["check"];
  return myStack > 0 ? ["check", "bet"] : ["check"];
}

// Mirrors worker/table-engine.ts's betBounds().
function computeBetBounds(state: PublicHandState | null, mySeat: Seat | null, myStack: number | undefined): { min: number; max: number } | null {
  if (!state || mySeat === null || myStack === undefined) return null;
  const owed = myFacingBet(state, mySeat);
  if (owed === 0) return { min: Math.min(state.bigBlind, myStack), max: myStack };
  if (myStack > owed) return { min: Math.min(owed + state.minRaiseIncrement, myStack), max: myStack };
  return null;
}

function actionLabel(action: ActionType, owed: number): string {
  if (action === "fold") return "Fold";
  if (action === "check") return "Check";
  return `Call ${owed}`;
}

function actorLabel(actor: string): string {
  const match = /^seat_(\d+)$/.exec(actor);
  return match ? `Seat ${match[1]}` : actor;
}

function shortHash(hash: string) {
  return `${hash.slice(0, 12)}...${hash.slice(-6)}`;
}

function handSummary(payouts: number[]): string {
  const winners = payouts.map((amount, seat) => ({ seat, amount })).filter((w) => w.amount > 0);
  if (winners.length === 0) return "Hand complete";
  if (winners.length === 1) return `Seat ${winners[0].seat} wins ${winners[0].amount}`;
  return winners.map((w) => `Seat ${w.seat} +${w.amount}`).join(" · ");
}

type HandCompleteState = { sidePots: SidePot[]; payouts: number[]; bundle: TableProofBundle };

export default function TableLab() {
  const deckByCode = useMemo(() => new Map(freshDeck().map((card) => [card.code, card])), []);
  const resolveCard = (code?: string) => (code ? deckByCode.get(code) : undefined);

  // Room code and seat count are derived from the URL, which is only
  // knowable client-side - reading window.location in a lazy useState
  // initializer would run during hydration and mismatch the
  // server-rendered output. An effect is the correct place for this
  // one-time client-only bootstrap; both fields are set together in a
  // single setState call so this effect stays compliant with
  // react-hooks/set-state-in-effect (which flags effects that commit
  // state more than once).
  const [table, setTable] = useState<{ roomCode: string; seatCount: number; initialSettings?: InitialTableSettings }>({
    roomCode: "",
    seatCount: DEFAULT_SEATS,
  });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let code = params.get("room");
    const requestedSeats = Number(params.get("seats"));
    const seatCount = Number.isInteger(requestedSeats) ? Math.min(MAX_SEATS, Math.max(MIN_SEATS, requestedSeats)) : DEFAULT_SEATS;
    // Only meaningful the moment a room is created (see poker-table.ts
    // fetch()) - lobby's "New table" dialog passes these when the creator
    // picked a stakes preset; a join link for an existing room simply won't
    // have them, and the server ignores them for a room that already exists.
    const smallBlind = Number(params.get("smallBlind"));
    const bigBlind = Number(params.get("bigBlind"));
    const minBuyIn = Number(params.get("minBuyIn"));
    const maxBuyIn = Number(params.get("maxBuyIn"));
    const initialSettings =
      Number.isInteger(smallBlind) && Number.isInteger(bigBlind) && Number.isInteger(minBuyIn) && Number.isInteger(maxBuyIn)
        ? { smallBlind, bigBlind, minBuyIn, maxBuyIn }
        : undefined;
    if (!code) {
      code = randomRoomCode();
      const url = new URL(window.location.href);
      url.searchParams.set("room", code);
      url.searchParams.set("seats", String(seatCount));
      window.history.replaceState(null, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- this synchronizes state with the URL, which is unavailable at SSR time
    setTable({ roomCode: code, seatCount, initialSettings });
  }, []);
  const { roomCode, seatCount, initialSettings } = table;

  const [status, setStatus] = useState<TransportStatus>("connecting");
  const [mySeat, setMySeat] = useState<Seat | null>(null);
  const [holeCards, setHoleCards] = useState<[string, string] | null>(null);
  const [publicState, setPublicState] = useState<PublicHandState | null>(null);
  const [handComplete, setHandComplete] = useState<HandCompleteState | null>(null);
  const [verification, setVerification] = useState<TableVerificationResult | null>(null);
  const [tamperResult, setTamperResult] = useState<TableVerificationResult | null>(null);
  const [readySent, setReadySent] = useState(false);
  const [awaySeats, setAwaySeats] = useState<Set<Seat>>(new Set());
  const [showProof, setShowProof] = useState(false);
  const [railTab, setRailTab] = useState<"hand" | "table" | "chat">("hand");
  const [toast, setToast] = useState("");
  const [betAmount, setBetAmount] = useState<number | null>(null);
  const [sitPickerOpen, setSitPickerOpen] = useState(false);
  const [buyInChoice, setBuyInChoice] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<{ smallBlind: number; bigBlind: number; minBuyIn: number; maxBuyIn: number } | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [unreadChat, setUnreadChat] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("off");
  const [voicePeerSeats, setVoicePeerSeats] = useState<Seat[]>([]);
  const connectionRef = useRef<TableConnection | null>(null);
  const voiceChatRef = useRef<VoiceChat | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  // The WebSocket message handler is registered once (its effect only
  // depends on [roomCode, seatCount], so the socket isn't torn down and
  // reopened on every tab switch) - it reads the live tab via this ref
  // instead of closing over a stale `railTab` to decide whether an
  // incoming chat message should bump the unread badge.
  const railTabRef = useRef(railTab);
  useEffect(() => {
    railTabRef.current = railTab;
  }, [railTab]);
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight });
  }, [chatMessages]);

  // A fresh bet/raise decision should start from a clean slate rather than
  // carrying over whatever amount was picked (or left mid-edit) last turn.
  // Adjusted during render (React's documented pattern for "reset state
  // when a value changes") rather than in an effect, which would cost an
  // extra commit-then-rerun round trip for no benefit here.
  const [lastToAct, setLastToAct] = useState(publicState?.toAct);
  if (publicState?.toAct !== lastToAct) {
    setLastToAct(publicState?.toAct);
    setBetAmount(null);
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  useEffect(() => {
    if (!roomCode) return;
    const connection = connectTable(roomCode, seatCount, initialSettings);
    connectionRef.current = connection;
    const voiceChat = createVoiceChat(connection);
    voiceChatRef.current = voiceChat;
    const unsubscribeVoice = voiceChat.onChange((nextStatus, peerSeats) => {
      setVoiceStatus(nextStatus);
      setVoicePeerSeats(peerSeats);
    });

    const unsubscribeStatus = connection.onStatusChange(setStatus);
    const unsubscribeMessages = connection.subscribe((message: ServerMessage) => {
      if (message.type === "seat-assigned") {
        // The sit message itself already carried this seat's own random
        // contribution (table-transport.ts attaches one to every "sit" -
        // see its send() for why that has to ride along with the sit
        // rather than follow as a separate message), so nothing more is
        // needed here for the hand this sit might immediately start.
        setMySeat(message.seat);
        setAwaySeats((prev) => {
          const next = new Set(prev);
          next.delete(message.seat);
          return next;
        });
      } else if (message.type === "hole-cards") {
        setHoleCards(message.cards);
        setHandComplete(null);
        setVerification(null);
        setTamperResult(null);
        setShowProof(false);
        setReadySent(false);
      } else if (message.type === "state") {
        setPublicState(message.state);
        setAwaySeats((prev) => {
          const next = new Set(prev);
          message.state.seatsOccupied.forEach((occupied, seat) => {
            if (occupied) next.delete(seat);
          });
          return next;
        });
      } else if (message.type === "hand-complete") {
        setHandComplete({ sidePots: message.sidePots, payouts: message.payouts, bundle: message.bundle });
        verifyTableBundle(message.bundle).then(setVerification);
        // Pre-supply the NEXT hand's seed now rather than waiting - a
        // seed is single-use (the server clears it the moment a hand
        // consumes it), so without this, only the very first hand after
        // sitting down would ever get this seat's own randomness.
        connection.send({ type: "provide-seed", seed: randomHex() });
      } else if (message.type === "opponent-left") {
        setAwaySeats((prev) => new Set(prev).add(message.seat));
      } else if (message.type === "left-table") {
        setMySeat(null);
        setHoleCards(null);
        notify(message.payout > 0 ? `Left the table - ${message.payout} test chips credited to your account.` : "Left the table.");
      } else if (message.type === "chat-history") {
        setChatMessages(message.messages);
      } else if (message.type === "chat") {
        setChatMessages((prev) => [...prev, message.message]);
        if (railTabRef.current !== "chat") setUnreadChat((count) => count + 1);
      } else if (message.type === "error") {
        notify(message.message);
      }
    });

    return () => {
      unsubscribeStatus();
      unsubscribeMessages();
      unsubscribeVoice();
      voiceChat.destroy();
      connection.close();
    };
  }, [roomCode, seatCount, initialSettings]);

  function act(action: ActionType, amount?: number) {
    connectionRef.current?.send({ type: "action", action, amount });
  }

  function sendReady() {
    connectionRef.current?.send({ type: "ready-for-next-hand" });
    setReadySent(true);
  }

  function sendChat() {
    const text = chatInput.trim();
    if (!text) return;
    connectionRef.current?.send({ type: "chat", text });
    setChatInput("");
  }

  function leaveTable() {
    connectionRef.current?.send({ type: "leave-table" });
  }

  function sitDown(buyIn: number) {
    connectionRef.current?.send({ type: "sit", buyIn });
    setSitPickerOpen(false);
  }

  function rabbitHunt() {
    connectionRef.current?.send({ type: "rabbit-hunt" });
  }

  function openSettings() {
    setSettingsDraft({
      smallBlind: publicState?.smallBlind ?? 1,
      bigBlind: publicState?.bigBlind ?? 2,
      minBuyIn: publicState?.minBuyIn ?? 40,
      maxBuyIn: publicState?.maxBuyIn ?? 200,
    });
    setShowSettings(true);
  }

  function saveSettings() {
    if (!settingsDraft) return;
    connectionRef.current?.send({ type: "update-settings", ...settingsDraft });
    setShowSettings(false);
  }

  async function toggleVoice() {
    await voiceChatRef.current?.toggle();
    if (voiceChatRef.current?.getStatus() === "error") notify("Microphone access denied or unavailable.");
  }

  async function copyLink() {
    await navigator.clipboard.writeText(window.location.href);
    notify("Room link copied");
  }

  async function runTamperTest() {
    if (!handComplete) return;
    const corrupted: TableProofBundle = {
      ...handComplete.bundle,
      deck: handComplete.bundle.deck.map((code, index) => (index === 3 ? handComplete.bundle.deck[7] : code)),
    };
    setTamperResult(await verifyTableBundle(corrupted));
  }

  async function copyProof() {
    if (!handComplete) return;
    await navigator.clipboard.writeText(JSON.stringify(handComplete.bundle, null, 2));
    notify("Proof JSON copied");
  }

  function downloadProof() {
    if (!handComplete) return;
    const blob = new Blob([JSON.stringify(handComplete.bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${handComplete.bundle.handId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const street = publicState?.street ?? "waiting";
  const myStack = mySeat !== null ? publicState?.stacks[mySeat] : undefined;
  const owed = myFacingBet(publicState, mySeat);
  const legal = legalActionsForDisplay(publicState, mySeat, myStack);
  const betBounds = computeBetBounds(publicState, mySeat, myStack);
  const isMyTurn = mySeat !== null && publicState?.toAct === mySeat;
  const inHand = street !== "waiting" && street !== "complete";
  // The server is the real authority on whether leaving is allowed right
  // now (it rejects mid-hand leaves with an error toast) - this is just a
  // best-effort client-side guess to avoid offering a button that's about
  // to bounce: holding live hole cards during an active, unfolded street
  // means a hand is in progress for this seat.
  const canLeave = mySeat !== null && (!inHand || !holeCards || (publicState?.folded[mySeat] ?? false));
  const sitBounds = { min: publicState?.minBuyIn ?? 40, max: publicState?.maxBuyIn ?? 200 };
  const buyInAmount = Math.min(sitBounds.max, Math.max(sitBounds.min, buyInChoice ?? sitBounds.max));
  const isHost = mySeat !== null && publicState?.hostSeat === mySeat;
  const canEditSettings = street === "waiting" || street === "complete";
  const rabbitHuntAvailable = street === "complete" && (publicState?.board.length ?? 5) < 5;

  const voiceActiveSeats = useMemo(() => {
    const set = new Set(voicePeerSeats);
    if (voiceStatus === "on" && mySeat !== null) set.add(mySeat);
    return set;
  }, [voicePeerSeats, voiceStatus, mySeat]);

  const revealSeats = useMemo(() => {
    const set = new Set<number>();
    if (handComplete) {
      for (const pot of handComplete.sidePots) {
        if (pot.eligibleSeats.length > 1) for (const seat of pot.eligibleSeats) set.add(seat);
      }
    }
    return set;
  }, [handComplete]);

  const bundleHole = (seat: Seat): [string, string] | null => {
    if (!handComplete) return null;
    const indices = handComplete.bundle.holeCardDeckIndices[seat];
    if (!indices) return null;
    return [handComplete.bundle.deck[indices[0]], handComplete.bundle.deck[indices[1]]];
  };

  return (
    <RiverShell active="lobby" dark footer={false}>
      <main className="table-page">
        <section className="table-topbar">
          <a href="/play/deal-lab">← Deal lab</a>
          <div><span>{roomCode || "..."} / LIVE TABLE</span><b>{seatCount}-MAX · SERVER DEALT · TEST CHIPS</b></div>
          <div className="table-top-proof"><span className={`casino-badge ${status === "open" ? "live" : "idle"}`}><i />{status === "open" ? "Live" : status}</span></div>
          {isHost && (
            <button aria-label="Table settings" title="Table settings (host only)" onClick={openSettings}>
              <Settings2 size={15} />
            </button>
          )}
          <button
            className={`voice-toggle ${voiceStatus}`}
            aria-label={voiceStatus === "on" ? "Leave voice chat" : "Join voice chat"}
            aria-pressed={voiceStatus === "on"}
            disabled={mySeat === null || voiceStatus === "connecting"}
            title={mySeat === null ? "Take a seat to use voice chat" : undefined}
            onClick={toggleVoice}
          >
            {voiceStatus === "on" ? <Mic size={15} /> : <MicOff size={15} />}
          </button>
          <button aria-label="Copy room link" onClick={copyLink}><Copy size={15} /></button>
        </section>

        <div className="game-room">
          <section className="game-room-main">
            <div className="table-status-ribbon">
              <span>LIVE MULTIPLAYER</span><p>Real hands, dealt by a Durable Object. Test chips only - no real-money custody.</p>
            </div>

            <div className="room-felt-wrap">
              {Array.from({ length: seatCount }).map((_, seat) => {
                const displayIndex = mySeat === null ? seat : (seat - mySeat + seatCount) % seatCount;
                const pos = seatPosition(displayIndex, seatCount);
                const occupied = publicState?.seatsOccupied[seat] ?? false;

                if (!occupied) {
                  return (
                    <button key={seat} className="room-seat empty" style={pos} onClick={copyLink}>
                      <span className="empty-plus">+</span><div><b>Open seat</b><small>Copy invite</small></div>
                    </button>
                  );
                }

                const isMe = seat === mySeat;
                const folded = publicState?.folded[seat] ?? false;
                const allIn = publicState?.allIn[seat] ?? false;
                const acting = inHand && publicState?.toAct === seat;
                const isButton = publicState?.buttonSeat === seat;
                const away = awaySeats.has(seat);
                const stack = publicState?.stacks[seat];
                const revealed = handComplete && revealSeats.has(seat);
                const holeCodes: [string, string] | null = isMe ? holeCards : revealed ? bundleHole(seat) : null;

                return (
                  <div key={seat} className={`room-seat ${acting ? "acting" : ""} ${folded ? "folded" : ""}`} style={pos}>
                    <span className={`seat-avatar ${isMe ? "coral" : "violet"}`}>{isMe ? "YOU" : seat}</span>
                    <div>
                      <b>
                        {isMe ? "You" : `Seat ${seat}`}{" "}
                        {allIn && <span className="casino-badge gold">All in</span>}
                        {folded && <span className="casino-badge idle">Folded</span>}
                      </b>
                      <small>{away ? "AWAY" : <><i className="chip-icon" />{stack ?? "-"} TEST</>}</small>
                    </div>
                    <div className="seat-cards">
                      <TableCard card={resolveCard(holeCodes?.[0])} hidden={!holeCodes} mini />
                      <TableCard card={resolveCard(holeCodes?.[1])} hidden={!holeCodes} mini />
                    </div>
                    {isButton && <span className="dealer-button">D</span>}
                    {voiceActiveSeats.has(seat) && <span className="seat-voice-badge" aria-label="In voice chat"><Mic size={10} /></span>}
                  </div>
                );
              })}

              <div className="room-table">
                <div className="room-board">
                  {[0, 1, 2, 3, 4].map((index) => (
                    publicState?.board[index]
                      ? <TableCard key={index} card={resolveCard(publicState.board[index])} />
                      : <div className="empty-board-card" key={index}><span>{index < 3 ? "F" : index === 3 ? "T" : "R"}</span></div>
                  ))}
                </div>
                <div className="room-pot"><span>POT</span><b><i className="chip-icon" />{publicState?.pot ?? 0}</b><small>TEST CHIPS</small></div>
                <div className="room-brand">RIVER <span>/ LIVE TABLE</span></div>
              </div>
            </div>

            <div className="table-action-dock">
              {status !== "open" ? (
                <div className="action-state"><span>CONNECTING</span><h2>Reaching the table...</h2><p>Reconnects automatically if the connection drops.</p></div>
              ) : mySeat === null ? (
                <><div className="action-state"><span>SPECTATING</span><h2>You don&apos;t have a seat.</h2><p>Sit down to join the next hand - your seat isn&apos;t held automatically after leaving.</p></div>
                {!sitPickerOpen ? (
                  <div className="action-controls"><button className="action-accent" onClick={() => setSitPickerOpen(true)}><UserPlus size={15} /> Sit down</button><button onClick={copyLink}><Copy size={15} /> Copy room link</button></div>
                ) : (
                  <div className="action-controls">
                    <div className="bet-size-control">
                      <span>BUY-IN ({sitBounds.min}-{sitBounds.max} TEST)</span>
                      <div>
                        {([["Min", sitBounds.min], ["Half", Math.round((sitBounds.min + sitBounds.max) / 2)], ["Max", sitBounds.max]] as [string, number][]).map(([label, value]) => (
                          <button key={label} type="button" className={buyInAmount === value ? "active" : ""} onClick={() => setBuyInChoice(value)}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <input
                      type="number"
                      min={sitBounds.min}
                      max={sitBounds.max}
                      value={buyInAmount}
                      aria-label="Buy-in amount"
                      onChange={(event) => setBuyInChoice(Math.min(sitBounds.max, Math.max(sitBounds.min, Number(event.target.value) || sitBounds.min)))}
                    />
                    <button className="action-accent" onClick={() => sitDown(buyInAmount)}><UserPlus size={15} /> Confirm &amp; sit</button>
                    <button onClick={() => setSitPickerOpen(false)}>Cancel</button>
                  </div>
                )}</>
              ) : street === "waiting" ? (
                <><div className="action-state"><span>WAITING FOR PLAYERS</span><h2>Share this room to start.</h2><p>The hand deals automatically once at least 2 of the {seatCount} seats are filled.</p></div>
                <div className="action-controls"><button className="action-accent" onClick={copyLink}><Copy size={15} /> Copy room link</button></div></>
              ) : street === "complete" && handComplete ? (
                <><div className="action-state"><span>HAND COMPLETE</span><h2>{handSummary(handComplete.payouts)}</h2><p>{publicState?.rabbitHuntRevealed ? "Rabbit hunt revealed the rest of the board." : verification?.valid ? "All checks passed." : "Verifying..."}</p></div>
                <div className="action-controls">
                  <button onClick={() => setShowProof(true)}><ShieldCheck size={15} /> Inspect proof</button>
                  {rabbitHuntAvailable && <button onClick={rabbitHunt}><Rabbit size={15} /> Rabbit hunt</button>}
                  <button className="action-accent" onClick={sendReady} disabled={readySent}><RotateCcw size={15} /> {readySent ? "Waiting on the table..." : "Ready for next hand"}</button>
                </div></>
              ) : (
                <><div className="action-state"><span>{isMyTurn ? `${street.toUpperCase()} / YOUR ACTION` : `${street.toUpperCase()} / SEAT ${publicState?.toAct ?? "-"}'S ACTION`}</span><h2>{isMyTurn ? "Choose an action." : "Waiting on another seat."}</h2><p>Every action extends the SHA-256 transcript chain.</p></div>
                <div className="action-controls">
                  {legal.includes("fold") && <button onClick={() => act("fold")}>{actionLabel("fold", owed)}</button>}
                  {legal.includes("check") && <button onClick={() => act("check")}>{actionLabel("check", owed)}</button>}
                  {legal.includes("call") && <button onClick={() => act("call")}>{actionLabel("call", owed)}</button>}
                  {(legal.includes("raise") || legal.includes("bet")) && betBounds && (() => {
                    const kind: "raise" | "bet" = legal.includes("raise") ? "raise" : "bet";
                    const pot = publicState?.pot ?? 0;
                    const clamp = (value: number) => Math.min(betBounds.max, Math.max(betBounds.min, Math.round(value)));
                    const amount = betAmount ?? betBounds.min;
                    const presets: [string, number][] = [
                      ["Min", betBounds.min],
                      ["1/2 Pot", clamp(pot * 0.5)],
                      ["Pot", clamp(pot)],
                      ["All-in", betBounds.max],
                    ];
                    return (
                      <>
                        <div className="bet-size-control">
                          <span>{kind === "raise" ? "RAISE AMOUNT" : "BET AMOUNT"}</span>
                          <div>
                            {presets.map(([label, value]) => (
                              <button key={label} type="button" className={amount === value ? "active" : ""} onClick={() => setBetAmount(value)}>
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <input
                          type="number"
                          min={betBounds.min}
                          max={betBounds.max}
                          value={amount}
                          aria-label={`${kind} amount`}
                          onChange={(event) => setBetAmount(clamp(Number(event.target.value) || betBounds.min))}
                        />
                        <button className="action-accent" onClick={() => act(kind, amount)}>
                          {kind === "raise" ? `Raise +${amount}` : `Bet ${amount}`}
                        </button>
                      </>
                    );
                  })()}
                </div></>
              )}
            </div>
          </section>

          <aside className="table-rail">
            <div className="rail-tabs" role="tablist">
              <button role="tab" aria-selected={railTab === "hand"} className={railTab === "hand" ? "active" : ""} onClick={() => setRailTab("hand")}><Fingerprint size={14} /> Hand</button>
              <button role="tab" aria-selected={railTab === "table"} className={railTab === "table" ? "active" : ""} onClick={() => setRailTab("table")}><Settings2 size={14} /> Table</button>
              <button role="tab" aria-selected={railTab === "chat"} className={railTab === "chat" ? "active" : ""} onClick={() => { setRailTab("chat"); setUnreadChat(0); }}>
                <MessageCircle size={14} /> Chat{unreadChat > 0 && <span className="chat-unread-badge">{unreadChat}</span>}
              </button>
            </div>

            {railTab === "hand" && (
              <div className="hand-proof-card">
                <div className="hand-proof-head"><Fingerprint size={17} /><span>HAND PROOF</span><i className={publicState?.handId ? "ready" : ""} /></div>
                {!publicState?.handId ? (
                  <div className="proof-awaiting"><ShieldCheck size={24} /><p>Take a seat to begin a hand - commitments appear as soon as it deals.</p></div>
                ) : (
                  <>
                    <div className="proof-field"><span>HAND ID</span><code>{publicState.handId.slice(-14)}</code></div>
                    {publicState.commitments.map((commit, seat) => commit ? (
                      <div className="proof-field" key={seat}>
                        <span>
                          SEAT {seat} COMMIT
                          {publicState.seedSources[seat] === "client" && <b className="entropy-tag client">PLAYER-SUPPLIED</b>}
                          {publicState.seedSources[seat] === "server" && <b className="entropy-tag server">SERVER FALLBACK</b>}
                        </span>
                        <code>{shortHash(commit)}</code>
                      </div>
                    ) : null)}
                    <div className="proof-events">
                      <span>EVENT STREAM</span>
                      {publicState.transcript.map((entry) => (
                        <div key={entry.hash}><i>{entry.sequence.toString().padStart(2, "0")}</i><p><b>{actorLabel(entry.actor)}</b>{entry.action.replaceAll("_", " ")}</p><code>{entry.hash.slice(0, 7)}</code></div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {railTab === "table" && (
              <div className="table-info-panel">
                <div className="table-info-title"><Settings2 size={17} /><span><b>Live Table</b><small>{seatCount}-max, server dealt</small></span></div>
                <dl>
                  <div><dt>ROOM</dt><dd>{roomCode}</dd></div>
                  <div><dt>YOUR SEAT</dt><dd>{mySeat === null ? "assigning..." : `Seat ${mySeat}`}</dd></div>
                  <div><dt>CONNECTION</dt><dd>{status.toUpperCase()}</dd></div>
                  <div><dt>BLINDS</dt><dd>{publicState?.smallBlind ?? 1} / {publicState?.bigBlind ?? 2} TEST</dd></div>
                  <div><dt>BUY-IN RANGE</dt><dd>{sitBounds.min}-{sitBounds.max} TEST</dd></div>
                  <div><dt>HOST</dt><dd>{publicState?.hostSeat === null || publicState?.hostSeat === undefined ? "unassigned" : isHost ? "You" : `Seat ${publicState.hostSeat}`}</dd></div>
                  <div><dt>DEALER</dt><dd><Check size={12} /> Trusted server</dd></div>
                </dl>
                <button className="invite-seat" onClick={copyLink}><LockKeyhole size={14} /> Copy room invite</button>
                {isHost && (
                  <button className="invite-seat" onClick={openSettings}><Settings2 size={14} /> Table settings</button>
                )}
                {mySeat !== null && (
                  <button className="invite-seat" onClick={leaveTable} disabled={!canLeave} title={canLeave ? undefined : "Finish this hand before leaving"}>
                    <LogOut size={14} /> Leave table
                  </button>
                )}
              </div>
            )}

            {railTab === "chat" && (
              <div className="table-chat-panel">
                <div className="chat-room-meta"><MessageCircle size={17} /><span><b>Table chat</b><small>{roomCode} · {publicState?.seatsOccupied.filter(Boolean).length ?? 0} seated</small></span></div>
                <div className="table-chat-messages" ref={chatScrollRef}>
                  {chatMessages.length === 0 ? (
                    <div className="proof-awaiting"><MessageCircle size={24} /><p>No messages yet - say something to the table.</p></div>
                  ) : (
                    chatMessages.map((entry, index) => (
                      <article key={`${entry.ts}-${index}`} className={entry.seat === mySeat ? "you" : ""}>
                        <div><b>{entry.seat === mySeat ? "You" : `Seat ${entry.seat}`}</b><span>{new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
                        <p>{entry.text}</p>
                      </article>
                    ))
                  )}
                </div>
                <div className="quick-chat">{["Nice hand", "Good luck", "Well played"].map((preset) => <button key={preset} type="button" onClick={() => setChatInput(preset)}>{preset}</button>)}</div>
                <form onSubmit={(event) => { event.preventDefault(); sendChat(); }}>
                  <input
                    aria-label="Table message"
                    value={chatInput}
                    disabled={mySeat === null}
                    maxLength={240}
                    placeholder={mySeat === null ? "Take a seat to chat" : "Message the table"}
                    onChange={(event) => setChatInput(event.target.value)}
                  />
                  <button aria-label="Send message" disabled={mySeat === null || !chatInput.trim()}><Send size={15} /></button>
                </form>
                <p className="chat-scope">Live · visible to everyone seated at this table</p>
              </div>
            )}

            <div className="rail-scope">
              <CircleAlert size={16} />
              <p><b>Honest scope</b> The server deals and holds every seat&apos;s seed now - trusted-dealer model. Test chips only, no real-money custody yet.{awaySeats.size > 0 && ` ${awaySeats.size} seat${awaySeats.size > 1 ? "s" : ""} disconnected; held for reconnect.`}</p>
            </div>
          </aside>
        </div>

        {showProof && handComplete && verification && (
          <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowProof(false)}>
            <section className="modal" role="dialog" aria-modal="true" aria-labelledby="proof-title" onMouseDown={(event) => event.stopPropagation()}>
              <button className="modal-close" aria-label="Close proof" onClick={() => setShowProof(false)}><X size={19} /></button>
              <div className={`proof-verdict ${verification.valid ? "pass" : "fail"}`}><ShieldCheck size={27} /><div><span>VERIFICATION VERDICT</span><strong>{verification.valid ? "PROOF ACCEPTED" : "PROOF REJECTED"}</strong></div></div>
              <h2 id="proof-title">Independent hand receipt</h2>
              <p>Computed client-side from the server&apos;s bundle - these checks are not trusted UI state, even though the server dealt the hand.</p>
              <div className="proof-checks">
                {Object.entries(verification.checks).map(([name, passed]) => <div key={name}><span className={passed ? "passed" : "failed"}>{passed ? <Check size={14} /> : <X size={14} />}</span><b>{name.replace(/([A-Z])/g, " $1")}</b><small>{passed ? "MATCH" : "FAILED"}</small></div>)}
              </div>
              <div className="seed-reveal"><span>REVEALED COMBINED SEED</span><code>{handComplete.bundle.combinedSeed}</code></div>
              {tamperResult && <div className={`tamper-result ${tamperResult.valid ? "bad" : "good"}`}><CircleAlert size={17} /><span>{tamperResult.valid ? "Unexpected acceptance" : "Tampered deck rejected - verification mismatch detected."}</span></div>}
              <div className="proof-actions"><button onClick={runTamperTest}><Sparkles size={15} /> Run tamper test</button><button onClick={copyProof}><Copy size={15} /> Copy JSON</button><button className="accent" onClick={downloadProof}><Download size={15} /> Download proof</button><a href="/receipts"><FileJson size={15} /> Receipt desk</a></div>
            </section>
          </div>
        )}

        {showSettings && settingsDraft && (
          <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSettings(false)}>
            <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
              <button className="modal-close" aria-label="Close settings" onClick={() => setShowSettings(false)}><X size={19} /></button>
              <h2 id="settings-title">Table settings</h2>
              <p>{canEditSettings ? "Applies from the next hand onward." : "Locked while a hand is in progress - finish this hand first."}</p>
              <div className="settings-grid">
                <label>
                  <span>Small blind</span>
                  <input
                    type="number"
                    min={1}
                    value={settingsDraft.smallBlind}
                    onChange={(event) => setSettingsDraft({ ...settingsDraft, smallBlind: Number(event.target.value) || 1 })}
                  />
                </label>
                <label>
                  <span>Big blind</span>
                  <input
                    type="number"
                    min={settingsDraft.smallBlind + 1}
                    value={settingsDraft.bigBlind}
                    onChange={(event) => setSettingsDraft({ ...settingsDraft, bigBlind: Number(event.target.value) || settingsDraft.smallBlind + 1 })}
                  />
                </label>
                <label>
                  <span>Min buy-in</span>
                  <input
                    type="number"
                    min={settingsDraft.bigBlind * 2}
                    value={settingsDraft.minBuyIn}
                    onChange={(event) => setSettingsDraft({ ...settingsDraft, minBuyIn: Number(event.target.value) || 0 })}
                  />
                </label>
                <label>
                  <span>Max buy-in</span>
                  <input
                    type="number"
                    min={settingsDraft.minBuyIn}
                    value={settingsDraft.maxBuyIn}
                    onChange={(event) => setSettingsDraft({ ...settingsDraft, maxBuyIn: Number(event.target.value) || 0 })}
                  />
                </label>
              </div>
              <div className="proof-actions">
                <button className="action-accent" onClick={saveSettings} disabled={!canEditSettings}><Check size={15} /> Save settings</button>
                <button onClick={() => setShowSettings(false)}>Cancel</button>
              </div>
            </section>
          </div>
        )}

        {toast && <div className="river-toast"><Check size={15} /> {toast}</div>}
      </main>
    </RiverShell>
  );
}
