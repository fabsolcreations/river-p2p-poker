"use client";

import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Radio,
  ShieldCheck,
  Ticket,
  Trophy,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { RiverShell } from "../components/river-shell";
import { tournamentEvents, type TournamentEvent } from "../components/game-data";

const filters = ["All", "Registering", "Scheduled", "Club"] as const;

export default function TournamentsPage() {
  const [filter, setFilter] = useState<(typeof filters)[number]>("All");
  const [selected, setSelected] = useState<TournamentEvent | null>(null);
  const [registered, setRegistered] = useState<string[]>([]);
  const [toast, setToast] = useState("");

  const events = useMemo(() => tournamentEvents.filter((event) => {
    if (filter === "All") return true;
    if (filter === "Club") return event.access === "Club";
    return event.status === filter || (filter === "Registering" && event.status === "Late registration");
  }), [filter]);

  function register(event: TournamentEvent) {
    setRegistered((current) => current.includes(event.id) ? current : [...current, event.id]);
    setSelected(null);
    setToast(`Demo ticket created for ${event.name}`);
    window.setTimeout(() => setToast(""), 2400);
  }

  return (
    <RiverShell active="tournaments" dark footer={false}>
      <main className="tournaments-page">
        <section className="tourney-hero">
          <div className="tourney-hero-copy">
            <span><Radio size={14} /> RIVER TOURNAMENTS / PRODUCT MODEL</span>
            <h1>One table becomes<br />the whole field.</h1>
            <p>Scheduled poker with visible structures, portable receipts, and a tournament clock that stays out of the way.</p>
            <div className="tourney-hero-actions"><button onClick={() => setSelected(tournamentEvents[0])}>Explore the main event <ArrowRight size={16} /></button><a href="#schedule">View schedule <CalendarDays size={15} /></a></div>
            <div className="tourney-truth"><ShieldCheck size={15} /><span>Registration, prizes, and player counts are illustrative. No entry is collected.</span></div>
          </div>
          <article className="featured-event-card">
            <div className="featured-event-top"><span>RIVER OPEN 01</span><i>FEATURED</i></div>
            <div className="featured-date"><span>SUN</span><b>16</b><small>AUG / 7:00 PM CT</small></div>
            <h2>Sunday Signal</h2>
            <p>72-player NL Hold’em with a measured structure and a receipt for every completed table.</p>
            <div className="featured-event-stats"><div><span>ENTRY</span><b>20 USDC</b></div><div><span>MODEL GTD</span><b>2,000</b></div><div><span>FIELD</span><b>48 / 72</b></div></div>
            <div className="field-meter"><i style={{ width: "66.6%" }} /></div>
            <button onClick={() => setSelected(tournamentEvents[0])}>Event details <ChevronRight size={16} /></button>
          </article>
        </section>

        <section className="tourney-principles">
          <article><Clock3 size={19} /><div><span>STRUCTURE FIRST</span><b>Blinds before hype</b><p>Every event exposes levels, breaks, late registration, and payout assumptions before a ticket.</p></div></article>
          <article><BadgeCheck size={19} /><div><span>RECEIPT COVERAGE</span><b>Proof at every table</b><p>Completed hands use the same portable receipt model as private cash tables.</p></div></article>
          <article><Users size={19} /><div><span>TABLE BALANCING</span><b>Visible movement</b><p>The target product explains seat changes and preserves the hand trail across tables.</p></div></article>
        </section>

        <section className="tourney-schedule" id="schedule">
          <div className="tourney-section-head"><div><span>EVENT DIRECTORY</span><h2>Upcoming structures.</h2><p>Five modeled formats. One registration flow.</p></div><div className="tourney-filters" role="group" aria-label="Filter tournaments">{filters.map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item}</button>)}</div></div>
          <div className="tourney-list-head"><span>DATE</span><span>EVENT</span><span>FORMAT</span><span>ENTRY / MODEL GTD</span><span>FIELD</span><span>STATUS</span><span /></div>
          <div className="tourney-list">{events.map((event) => <button className="tourney-row" onClick={() => setSelected(event)} key={event.id}>
            <div className="tourney-row-date"><b>{event.day}</b><span>{event.date}</span></div>
            <div><small>{event.series}</small><b>{event.name}</b><span>{event.starts}</span></div>
            <div><b>{event.format}</b><span>{event.speed}</span></div>
            <div><b>{event.entry}</b><span>{event.guarantee}</span></div>
            <div><b>{event.registered} / {event.capacity}</b><i><span style={{ width: `${event.registered / event.capacity * 100}%` }} /></i></div>
            <div><span className={`event-status ${event.status.toLowerCase().replaceAll(" ", "-")}`}>{event.status}</span>{registered.includes(event.id) && <small className="ticket-held"><Check size={11} /> TICKET</small>}</div>
            <ArrowRight size={17} />
          </button>)}</div>
        </section>

        <section className="tourney-roadmap-strip"><Trophy size={24} /><div><span>TOURNAMENT ENGINEERING GATE</span><h2>Receipts are the easy half.</h2></div><p>Production still needs deterministic table balancing, synchronized clocks, reconnect-safe state, cancellation rules, and audited entry escrow.</p><a href="/fairness#roadmap">See build gates <ArrowRight size={15} /></a></section>
      </main>

      {selected && <div className="river-dialog-backdrop" onMouseDown={() => setSelected(null)}><section className="river-dialog tournament-dialog" role="dialog" aria-modal="true" aria-labelledby="tournament-title" onMouseDown={(event) => event.stopPropagation()}><button className="dialog-close" aria-label="Close" onClick={() => setSelected(null)}><X size={18} /></button>
        <span className="dialog-index">{selected.series} / {selected.status.toUpperCase()}</span><h2 id="tournament-title">{selected.name}</h2><p>{selected.format} · {selected.speed} · {selected.day} {selected.date} at {selected.starts}</p>
        <div className="tournament-dialog-stats"><div><Ticket size={17} /><span><small>ENTRY</small><b>{selected.entry}</b></span></div><div><Trophy size={17} /><span><small>MODEL GUARANTEE</small><b>{selected.guarantee}</b></span></div><div><Users size={17} /><span><small>REGISTERED</small><b>{selected.registered} / {selected.capacity}</b></span></div><div><Clock3 size={17} /><span><small>LATE REG</small><b>6 levels</b></span></div></div>
        <div className="structure-preview"><span>BLIND STRUCTURE / SAMPLE</span>{[["01", "100 / 200", "20 MIN"], ["02", "150 / 300", "20 MIN"], ["03", "200 / 400", "20 MIN"], ["04", "300 / 600", "BREAK"]].map((level) => <div key={level[0]}><b>{level[0]}</b><span>{level[1]}</span><small>{level[2]}</small></div>)}</div>
        <div className="tournament-assurance"><ShieldCheck size={16} /><p><b>Demo registration only.</b> This creates a local ticket state. No funds, seat, or payout claim exists.</p></div>
        <button className="dialog-primary-action" onClick={() => register(selected)} disabled={registered.includes(selected.id)}>{registered.includes(selected.id) ? <><Check size={16} /> Demo ticket held</> : <><CircleDollarSign size={16} /> Create demo ticket</>}</button>
      </section></div>}
      {toast && <div className="river-toast"><Check size={15} /> {toast}</div>}
    </RiverShell>
  );
}
