"use client";

import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  Copy,
  Crown,
  Gamepad2,
  Layers3,
  MoreHorizontal,
  Plus,
  Search,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { RiverShell } from "../components/river-shell";

const members = [
  { name: "mira.sol", role: "Host", games: 42, status: "Online", initials: "M", color: "violet" },
  { name: "oxcoast", role: "Moderator", games: 31, status: "In game", initials: "OX", color: "blue" },
  { name: "riverside", role: "Member", games: 18, status: "Online", initials: "RS", color: "mint" },
  { name: "juno", role: "Member", games: 12, status: "Away", initials: "JU", color: "coral" },
  { name: "lowkey", role: "Member", games: 9, status: "Offline", initials: "LK", color: "amber" },
];

const scheduledGames = [
  { day: "14", month: "AUG", name: "After Hours", time: "9:00 PM CT", format: "NLH", stakes: "$0.25 / $0.50", rsvps: 5 },
  { day: "16", month: "AUG", name: "Sunday Signal", time: "7:00 PM CT", format: "NLH MTT", stakes: "20 USDC", rsvps: 18 },
  { day: "19", month: "AUG", name: "Blackbird", time: "8:30 PM CT", format: "PLO", stakes: "$0.50 / $1", rsvps: 4 },
];

type Tab = "overview" | "members" | "games" | "treasury";

export default function ClubsPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [toast, setToast] = useState("");

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  async function copyCode() {
    await navigator.clipboard.writeText("NIGHT-RIVER-88");
    notify("Invite code copied");
  }

  function schedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setScheduleOpen(false);
    notify("Game saved as a local draft");
  }

  return (
    <RiverShell active="clubs" dark footer={false}>
      <main className="clubs-page">
        <aside className="club-sidebar">
          <div className="club-identity">
            <div className="club-emblem"><span>NR</span><i /><i /></div>
            <div><span>PRIVATE CLUB MODEL</span><h1>Night River</h1><p>128 modeled members</p></div>
          </div>
          <nav aria-label="Club console">
            {([
              ["overview", "Overview", Gamepad2],
              ["members", "Members", Users],
              ["games", "Games", CalendarDays],
              ["treasury", "Fee ledger", CircleDollarSign],
            ] as const).map(([id, label, Icon]) => <button className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}><Icon size={16} />{label}<ArrowRight size={14} /></button>)}
          </nav>
          <div className="club-sidebar-note"><ShieldCheck size={17} /><p><b>Host without custody</b>The operator configures games and access. The production target keeps player funds outside the host account.</p></div>
          <a className="back-to-lobby" href="/lobby">Browse public lobby <ArrowRight size={14} /></a>
        </aside>

        <section className="club-console">
          <header className="club-console-head">
            <div><span>CLUB CONSOLE / {tab.toUpperCase()}</span><h2>{tab === "overview" ? "Good evening, darc." : tab === "members" ? "Member directory" : tab === "games" ? "Game calendar" : "Transparent fee ledger"}</h2></div>
            <button onClick={() => setScheduleOpen(true)}><Plus size={16} /> Schedule game</button>
          </header>

          {tab === "overview" && <>
            <div className="club-truth-banner"><i /><span>PRODUCT MODEL</span><p>All balances, members, and revenue below are illustrative interface data. No live club or treasury exists.</p></div>
            <div className="club-metric-grid">
              <article><span>ACTIVE MEMBERS / 30D</span><b>64</b><small>of 128 modeled</small><i style={{ width: "50%" }} /></article>
              <article><span>HANDS / 7D</span><b>2,418</b><small>interface sample</small><i style={{ width: "72%" }} /></article>
              <article><span>MODELED VOLUME / 7D</span><b>42.8K</b><small>USDC example</small><i style={{ width: "61%" }} /></article>
              <article className="accent"><span>HOST FEE / CURRENT</span><b>0.50%</b><small>hard cap: 1 USDC</small><i style={{ width: "35%" }} /></article>
            </div>

            <div className="club-overview-grid">
              <section className="upcoming-panel">
                <div className="panel-heading"><div><span>NEXT ON THE CALENDAR</span><h3>Scheduled games</h3></div><button onClick={() => setTab("games")}>View all <ArrowRight size={14} /></button></div>
                <div className="schedule-list">{scheduledGames.map((game) => <article key={game.name}><div className="schedule-date"><b>{game.day}</b><span>{game.month}</span></div><div><h4>{game.name}</h4><p>{game.time} / {game.format}</p></div><div><span>STAKES</span><b>{game.stakes}</b></div><div><span>RSVP</span><b>{game.rsvps}</b></div><button><MoreHorizontal size={16} /></button></article>)}</div>
              </section>
              <section className="invite-panel">
                <span>CLUB ACCESS</span><h3>Bring the right players.</h3><p>One invite code, optional approval, visible table rules.</p>
                <button className="invite-code" onClick={copyCode}><span><small>INVITE CODE</small><b>NIGHT-RIVER-88</b></span><Copy size={17} /></button>
                <div className="invite-settings"><div><span>NEW MEMBERS</span><b>Manual approval</b></div><div><span>GAME VISIBILITY</span><b>Members only</b></div></div>
              </section>
            </div>

            <section className="recent-members-panel">
              <div className="panel-heading"><div><span>TABLE REGULARS</span><h3>Member pulse</h3></div><button onClick={() => setTab("members")}>Manage members <ArrowRight size={14} /></button></div>
              <div className="member-mini-grid">{members.slice(0, 4).map((member) => <div key={member.name}><span className={`member-avatar ${member.color}`}>{member.initials}</span><div><b>{member.name}</b><small>{member.role} / {member.games} games</small></div><i className={member.status.toLowerCase().replace(" ", "-")} /></div>)}</div>
            </section>
          </>}

          {tab === "members" && <section className="members-view">
            <div className="console-toolbar"><label><Search size={15} /><input placeholder="Search members" /></label><button><SlidersHorizontal size={15} /> Filters</button><button><Plus size={15} /> Invite</button></div>
            <div className="members-table-head"><span>PLAYER</span><span>ROLE</span><span>GAMES</span><span>STATUS</span><span /></div>
            {members.map((member) => <article className="member-row" key={member.name}><div><span className={`member-avatar ${member.color}`}>{member.initials}</span><b>{member.name}</b></div><span>{member.role}{member.role === "Host" && <Crown size={13} />}</span><b>{member.games}</b><span className={`member-status ${member.status.toLowerCase().replace(" ", "-")}`}><i />{member.status}</span><button><MoreHorizontal size={16} /></button></article>)}
          </section>}

          {tab === "games" && <section className="games-view">
            <div className="club-live-groups"><div className="club-groups-head"><div><Layers3 size={18} /><span><small>LIVE ROOM GROUP</small><b>After Hours</b></span></div><p>Open-ended cash room · 6 seats per table · automatic table opening</p><button onClick={() => notify("Local table group manager opened")}><RefreshCw size={14} /> Manage balancing</button></div><div className="club-group-tables">{[["01", "Main Table", "6 / 6", "PLAYING"], ["02", "Overflow 1", "5 / 6", "PLAYING"], ["03", "Overflow 2", "2 / 6", "SEATING"], ["04+", "Next table", "—", "ON DEMAND"]].map((table) => <article key={table[0]}><i>{table[0]}</i><span><b>{table[1]}</b><small>{table[2]} seats</small></span><strong>{table[3]}</strong></article>)}</div></div>
            <div className="calendar-strip"><button>Today</button><div className="calendar-days">{["MON 12", "TUE 13", "WED 14", "THU 15", "FRI 16", "SAT 17", "SUN 18"].map((day, index) => <button className={index === 2 ? "active" : ""} key={day}>{day}</button>)}</div><button><ChevronDown size={15} /></button></div>
            <div className="games-agenda">{scheduledGames.map((game, index) => <article key={game.name}><div className="agenda-time"><span>{game.day} {game.month}</span><b>{game.time}</b></div><div className={`agenda-marker marker-${index}`} /><div><span>{game.format} / {game.stakes}</span><h3>{game.name}</h3><p>{game.rsvps} members have modeled RSVPs</p></div><button>Open draft <ArrowRight size={14} /></button></article>)}</div>
          </section>}

          {tab === "treasury" && <section className="treasury-view">
            <div className="treasury-summary"><span>ILLUSTRATIVE / LAST 30 DAYS</span><h3>Every fee should reconcile.</h3><p>The production ledger will distinguish protocol fees, host fees, refunds, and payouts at the hand level.</p></div>
            <div className="treasury-cards"><article><span>MODELED HOST FEES</span><b>428.14</b><small>USDC example</small></article><article><span>PROTOCOL FEES</span><b>856.28</b><small>1% target model</small></article><article><span>UNRECONCILED</span><b>0.00</b><small>expected invariant</small></article></div>
            <div className="ledger-table"><div className="ledger-table-head"><span>DATE / HAND RANGE</span><span>VOLUME</span><span>HOST FEE</span><span>PROTOCOL</span><span>STATUS</span></div>{[
              ["AUG 11 / 02A1-19FD", "8,420.00", "42.10", "84.20"], ["AUG 10 / 72B0-EEC4", "11,806.00", "59.03", "118.06"], ["AUG 09 / 11CC-90A2", "6,344.00", "31.72", "63.44"], ["AUG 08 / 4A8B-B012", "9,780.00", "48.90", "97.80"],
            ].map((row) => <div className="ledger-table-row" key={row[0]}><span>{row[0]}</span><b>{row[1]}</b><b>{row[2]}</b><b>{row[3]}</b><span><Check size={12} /> RECONCILED</span></div>)}</div>
          </section>}
        </section>
      </main>

      {scheduleOpen && <div className="river-dialog-backdrop" onMouseDown={() => setScheduleOpen(false)}><section className="river-dialog schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-title" onMouseDown={(event) => event.stopPropagation()}><button className="dialog-close" onClick={() => setScheduleOpen(false)} aria-label="Close"><X size={18} /></button><span className="dialog-index">CLUB TOOL / LOCAL DRAFT</span><h2 id="schedule-title">Schedule a game.</h2><p>Create a reusable club event without moving funds or opening seats.</p><form className="river-form" onSubmit={schedule}><label>Game name<input required placeholder="Friday night" /></label><div className="form-pair"><label>Format<select><option>NL Hold’em</option><option>Pot-Limit Omaha</option><option>Short Deck</option></select></label><label>Stakes<select><option>$0.25 / $0.50</option><option>$0.50 / $1</option><option>$1 / $2</option></select></label></div><div className="form-pair"><label>Date<input type="date" required /></label><label>Time<input type="time" required /></label></div><label className="fee-preview"><span>ACCESS</span><b>Club members / approval on</b><small>Editable after saving</small></label><button type="submit">Save local draft <ArrowRight size={17} /></button></form></section></div>}
      {toast && <div className="river-toast"><Check size={15} /> {toast}</div>}
    </RiverShell>
  );
}
