import type { Seat, ServerMessage, TableConnection } from "./table-transport";

/**
 * Peer-to-peer WebRTC audio mesh between seated players, signaled entirely
 * over the same WebSocket used for gameplay (see table-transport.ts /
 * worker/poker-table.ts's voice-join/voice-leave/voice-signal messages -
 * the Durable Object only relays opaque offer/answer/ICE payloads, never
 * touches media). No TURN server - STUN-only (a public Google STUN server,
 * standard for WebRTC prototyping), so a call between two peers behind
 * restrictive/symmetric NATs can fail to connect; there's no fallback
 * relay for that case in this v1.
 *
 * Double-offer avoidance: only the seat that JUST joined initiates offers,
 * to every seat already present in the `voice-presence` list it receives.
 * A seat already in voice never proactively offers to a new joiner - it
 * only answers the incoming offer. Because the Durable Object processes
 * WebSocket messages one at a time, two seats joining "simultaneously"
 * still get strictly ordered voice-presence snapshots, so this rule alone
 * is enough to prevent both sides ever offering to each other at once.
 */

export type VoiceStatus = "off" | "connecting" | "on" | "error";

export interface VoiceChat {
  toggle(): Promise<void>;
  getStatus(): VoiceStatus;
  getPeerSeats(): Seat[];
  onChange(listener: (status: VoiceStatus, peerSeats: Seat[]) => void): () => void;
  destroy(): void;
}

type VoiceSignal =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

function isVoiceSignal(value: unknown): value is VoiceSignal {
  return !!value && typeof value === "object" && "kind" in value;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export function createVoiceChat(connection: TableConnection): VoiceChat {
  let status: VoiceStatus = "off";
  let localStream: MediaStream | null = null;
  const peers = new Map<Seat, RTCPeerConnection>();
  const audioEls = new Map<Seat, HTMLAudioElement>();
  const listeners = new Set<(status: VoiceStatus, peerSeats: Seat[]) => void>();

  function notify() {
    for (const listener of listeners) listener(status, [...peers.keys()]);
  }

  function setStatus(next: VoiceStatus) {
    status = next;
    notify();
  }

  function removePeer(seat: Seat) {
    peers.get(seat)?.close();
    peers.delete(seat);
    const audio = audioEls.get(seat);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      audioEls.delete(seat);
    }
    notify();
  }

  function ensurePeer(seat: Seat): RTCPeerConnection {
    const existing = peers.get(seat);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    if (localStream) for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.onicecandidate = (event) => {
      if (event.candidate) connection.send({ type: "voice-signal", toSeat: seat, signal: { kind: "ice", candidate: event.candidate.toJSON() } });
    };
    pc.ontrack = (event) => {
      let audio = audioEls.get(seat);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audioEls.set(seat, audio);
        document.body.appendChild(audio);
      }
      audio.srcObject = event.streams[0] ?? null;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") removePeer(seat);
    };

    peers.set(seat, pc);
    notify();
    return pc;
  }

  async function offerTo(seat: Seat) {
    const pc = ensurePeer(seat);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    connection.send({ type: "voice-signal", toSeat: seat, signal: { kind: "offer", sdp: offer.sdp ?? "" } });
  }

  async function handleSignal(fromSeat: Seat, raw: unknown) {
    if (!isVoiceSignal(raw)) return;
    if (raw.kind === "offer") {
      const pc = ensurePeer(fromSeat);
      await pc.setRemoteDescription({ type: "offer", sdp: raw.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      connection.send({ type: "voice-signal", toSeat: fromSeat, signal: { kind: "answer", sdp: answer.sdp ?? "" } });
    } else if (raw.kind === "answer") {
      await peers.get(fromSeat)?.setRemoteDescription({ type: "answer", sdp: raw.sdp });
    } else if (raw.kind === "ice") {
      try {
        await peers.get(fromSeat)?.addIceCandidate(raw.candidate);
      } catch {
        // A candidate can legitimately arrive before/after the connection is torn down - not fatal.
      }
    }
  }

  const unsubscribe = connection.subscribe((message: ServerMessage) => {
    if (message.type === "voice-presence") {
      for (const seat of message.seats) offerTo(seat);
    } else if (message.type === "voice-left") {
      removePeer(message.seat);
    } else if (message.type === "voice-signal") {
      handleSignal(message.fromSeat, message.signal);
    }
    // "voice-joined" needs no action here - the newly-joined seat is the
    // one that initiates the offer, per the module-level doc comment.
  });

  function stopLocal() {
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  return {
    async toggle() {
      if (status === "on" || status === "connecting") {
        connection.send({ type: "voice-leave" });
        stopLocal();
        for (const seat of [...peers.keys()]) removePeer(seat);
        setStatus("off");
        return;
      }
      setStatus("connecting");
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setStatus("error");
        return;
      }
      connection.send({ type: "voice-join" });
      setStatus("on");
    },
    getStatus: () => status,
    getPeerSeats: () => [...peers.keys()],
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      unsubscribe();
      stopLocal();
      for (const seat of [...peers.keys()]) removePeer(seat);
    },
  };
}
