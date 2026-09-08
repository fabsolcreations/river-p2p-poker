"use client";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, CircleDot, Link2, LockKeyhole, Plus, ShieldCheck, Users, Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { RiverShell } from "./river-shell";
import { gameUrl, roomCodeFromInput, validateGameSetup, type GameSetup } from "../new-game/game-setup";

export function GameStart() {
  const [game, setGame] = useState<GameSetup>({ seats: 6, smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 200, trustless: false });
  const [room, setRoom] = useState("");
  const [joinError, setJoinError] = useState("");
  const [error, setError] = useState("");
  function create(event: FormEvent) {
    event.preventDefault();
    const validation = validateGameSetup(game);
    if (validation) { setError(validation); return; }
    window.location.assign(gameUrl(game));
  }
  function join(event: FormEvent) {
    event.preventDefault();
    const code = roomCodeFromInput(room);
    if (!code) { setJoinError("Paste a game link or enter a valid room code."); return; }
    window.location.assign(`${/^(cg|eg)_[a-f0-9]{32}$/.test(code) ? "/escrow" : "/play/table-lab"}?room=${encodeURIComponent(code)}`);
  }
  return (
    <RiverShell active="home" dark footer={false}>
      <main className="start-page">
        <header className="start-heading"><div><span className="client-kicker">GOOD COMPANY. GREAT POKER.</span><h1>Your table awaits<span>.</span></h1><p>Make room for your people. We’ll bring the cards.</p></div><a className="club-quiet-link" href="/lobby">Explore public tables <ArrowUpRight size={17} /></a></header>
        <section className="club-join-bar" aria-label="Join a private game"><div><Link2 size={19} /><b>Got an invite?</b></div><form onSubmit={join}><label className="poker-sr-only" htmlFor="room-invite">Game link or room code</label><input id="room-invite" value={room} onChange={(e) => { setRoom(e.target.value); setJoinError(""); }} placeholder="Paste a game link or room code" required autoComplete="off" spellCheck={false} /><button type="submit">Join table <ArrowRight size={17} /></button></form>{joinError && <p className="client-error" role="alert">{joinError}</p>}</section>
        <nav className="club-game-tabs" aria-label="Game funding"><Link href="/" aria-current="page"><CircleDot size={17} /> Play chips</Link><Link href="/escrow"><Wallet size={17} /> Crypto games</Link></nav>
        <div className="start-layout">
          <section className="start-builder" aria-labelledby="setup-title">
            <header><span className="client-icon"><Plus size={20} /></span><div><h2 id="setup-title">Make it your game</h2><p>A private table. A link for your friends.</p></div><span className="client-tag">NO ACCOUNT NEEDED</span></header>
            <form onSubmit={create}>
              <fieldset><legend>Game type</legend><div className="start-mode-picker">
                <button type="button" aria-pressed={!game.trustless} onClick={() => setGame({ ...game, trustless: false })}><Users size={20} /><span><b>No-limit hold’em</b><small>2–10 players · Server dealt</small></span>{!game.trustless && <Check size={17} />}</button>
                <button type="button" aria-pressed={game.trustless} onClick={() => setGame({ ...game, trustless: true, seats: 2 })}><ShieldCheck size={20} /><span><b>Trustless heads-up</b><small>2 players · Browsers deal together</small></span>{game.trustless && <Check size={17} />}</button>
              </div></fieldset>
              <fieldset><legend>Seats <span>{game.seats} players maximum</span></legend><div className="start-seat-picker">{[2,4,6,8,9,10].map((seats) => <button key={seats} type="button" aria-pressed={game.seats === seats} disabled={game.trustless && seats !== 2} onClick={() => setGame({ ...game, seats })}>{seats}</button>)}</div></fieldset>
              <div className="start-stakes-fields"><fieldset><legend>Blinds <span>Play chips</span></legend><div className="start-input-pair"><label>Small<input type="number" min="1" max="500000" value={game.smallBlind || ""} required onChange={(e) => setGame({ ...game, smallBlind: Number(e.target.value) })} /></label><label>Big<input type="number" min="2" max="50000" value={game.bigBlind || ""} required onChange={(e) => setGame({ ...game, bigBlind: Number(e.target.value) })} /></label></div></fieldset>
              <fieldset><legend>Buy-in range</legend><div className="start-input-pair"><label>Minimum<input type="number" min="1" max="1000000" value={game.minBuyIn || ""} required onChange={(e) => setGame({ ...game, minBuyIn: Number(e.target.value) })} /></label><label>Maximum<input type="number" min="1" max="1000000" value={game.maxBuyIn || ""} required onChange={(e) => setGame({ ...game, maxBuyIn: Number(e.target.value) })} /></label></div></fieldset></div>
              {error && <p className="client-error" role="alert">{error}</p>}
              <button className="client-primary start-create" type="submit">Create my table <ArrowRight size={19} /></button>
              <p className="start-form-note">{game.trustless ? "Dealing takes longer while both browsers encrypt the cards. Nobody — including us — can see your cards during the hand, but the receipt afterwards reveals every card in it, folds included." : "You’ll sit down automatically. Share the link to fill the other seats."}</p>
            </form>
          </section>
          <aside className="start-sidebar">
            <section className="club-table-preview" aria-label="Your table preview"><div className="club-table-photo" role="img" aria-label="Ivory playing cards and copper-edged chips on dark poker felt"><span><LockKeyhole size={14} /> PRIVATE TABLE</span></div><div className="club-preview-content"><span className="client-kicker">THE TABLE YOU’RE CREATING</span><h2>{game.trustless ? "Heads-up, just you two." : "A proper poker night."}</h2><div className="club-seat-preview" aria-label={`${game.seats} open seats`}>{Array.from({length: game.seats}, (_, i) => <span key={i} aria-hidden="true">{i === 0 ? <Users size={15} /> : <Plus size={13} />}</span>)}</div><dl><div><dt>Game</dt><dd>{game.trustless ? "Trustless heads-up" : "No-limit hold’em"}</dd></div><div><dt>Blinds</dt><dd>{game.smallBlind || 0} / {game.bigBlind || 0}</dd></div><div><dt>Buy-in</dt><dd>{game.minBuyIn || 0}–{game.maxBuyIn || 0} <small>chips</small></dd></div></dl></div></section>
            <a className="club-crypto-link" href="/escrow"><span className="club-mini-icon"><Wallet size={19} /></span><span><b>Bring your own coin.</b><small>Explore funded games</small></span><ArrowUpRight size={18} /></a>
            <details className="start-fairness"><summary><ShieldCheck size={19} /> How is the game verified?<ChevronDown size={17} /></summary><p>Each completed hand has a receipt you can check. Standard tables use a trusted server to deal; trustless heads-up tables use both players’ browsers.</p><a href="/fairness">Read the fairness model <ArrowUpRight size={15} /></a></details>
          </aside>
        </div>
        <footer className="start-footer"><span><LockKeyhole size={14} /> Play chips. No real funds at this table.</span><a href="/responsible">Responsible play</a></footer>
      </main>
    </RiverShell>
  );
}
