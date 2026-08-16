"use client";

import { ArrowRight, Plus, RefreshCcw, Search, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RiverShell } from "../components/river-shell";

type TableRow = { roomCode: string; seatCount: number; occupiedCount: number; status: "waiting" | "playing"; updatedAt: string };

const seatOptions = [2, 4, 6, 8, 9, 10];

// The room's opening stakes - the host can still change all four values
// any time between hands once the table exists (see the settings modal in
// table-lab), this just picks a sane starting point instead of always
// defaulting to the smallest stakes. Index 0 matches poker-table.ts's own
// defaults exactly, so a table created without touching this picker behaves
// identically to before this feature existed.
const stakesPresets = [
  { label: "Micro", smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 200 },
  { label: "Low", smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 1000 },
  { label: "Mid", smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 5000 },
  { label: "High", smallBlind: 100, bigBlind: 200, minBuyIn: 4000, maxBuyIn: 20000 },
];

export default function LobbyPage() {
  const [tables, setTables] = useState<TableRow[] | "loading">("loading");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createSeats, setCreateSeats] = useState(6);
  const [createStakes, setCreateStakes] = useState(stakesPresets[0]);

  async function loadTables() {
    const response = await fetch("/api/lobby/tables");
    if (!response.ok) {
      setTables([]);
      return;
    }
    const body = (await response.json()) as { tables: TableRow[] };
    setTables(body.tables);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time client-only bootstrap: fetch the real open-table list, which isn't available at SSR time
    loadTables();
  }, []);

  const rows = useMemo(() => {
    if (tables === "loading") return [];
    const needle = query.toLowerCase().trim();
    return tables.filter((table) => !needle || table.roomCode.toLowerCase().includes(needle));
  }, [tables, query]);

  return (
    <RiverShell active="lobby" dark footer={false}>
      <main className="r3-lobby">
        <section className="r3-lobby-head">
          <div><span>LIVE TABLES</span><h1>Pick a table.</h1><p>Every room below is a real Cloudflare Durable Object holding an actual game - not sample data.</p></div>
          <div className="r3-lobby-metrics">
            <span><i /> {tables === "loading" ? "..." : tables.length} open room{tables !== "loading" && tables.length === 1 ? "" : "s"}</span>
            <span>{tables === "loading" ? "..." : tables.reduce((sum, table) => sum + table.occupiedCount, 0)} seated</span>
            <button className="r3-lobby-refresh" onClick={() => loadTables()} aria-label="Refresh"><RefreshCcw size={13} /></button>
          </div>
        </section>

        <section className="r3-lobby-controls">
          <label className="r3-lobby-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by room code" /></label>
          <button className="r3-new-game" onClick={() => setCreateOpen(true)}><Plus size={16} /> New table</button>
        </section>

        <section className="r3-game-directory lobby-directory">
          <div className="lobby-row lobby-row-head"><span>ROOM</span><span>SEATS</span><span>STATUS</span><span /></div>
          {tables === "loading" ? (
            <div className="r3-empty"><Search size={22} /><b>Loading tables...</b></div>
          ) : rows.length === 0 ? (
            <div className="r3-empty">
              <Users size={22} />
              <b>{query ? "No matching tables" : "No tables open right now"}</b>
              <button onClick={() => (query ? setQuery("") : setCreateOpen(true))}>{query ? "Clear search" : "Start one"}</button>
            </div>
          ) : (
            rows.map((table) => (
              <a className="lobby-row" href={`/play/table-lab?room=${encodeURIComponent(table.roomCode)}&seats=${table.seatCount}`} key={table.roomCode}>
                <span className="lobby-room-name"><b>{table.roomCode}</b></span>
                <span className="lobby-seats"><b>{table.occupiedCount}<i> / {table.seatCount}</i></b></span>
                <span><i className={`casino-badge ${table.status === "playing" ? "live" : "idle"}`}>{table.status === "playing" ? "IN HAND" : "WAITING"}</i></span>
                <ArrowRight size={16} className="r3-row-arrow" />
              </a>
            ))
          )}
        </section>

        <section className="rail-scope lobby-honest-scope">
          <Users size={16} />
          <p><b>Honest scope</b> This lists real rooms with real occupancy, refreshed on join/leave/hand-start - not live-streamed second by second. No formats, stakes, or tournaments beyond what actually exists: one no-limit hold&apos;em engine, 2-10 seats, test chips.</p>
        </section>
      </main>

      {createOpen && (
        <div className="river-dialog-backdrop" onMouseDown={() => setCreateOpen(false)}>
          <section className="river-dialog r3-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-table-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="dialog-close" onClick={() => setCreateOpen(false)} aria-label="Close"><X size={18} /></button>
            <span className="dialog-index">NEW TABLE</span>
            <h2 id="create-table-title">How many seats?</h2>
            <p>A fresh room code is generated for you - share the link to fill the other seats.</p>
            <div className="lobby-seat-picker">
              {seatOptions.map((seats) => (
                <button key={seats} type="button" className={createSeats === seats ? "active" : ""} onClick={() => setCreateSeats(seats)}>{seats}</button>
              ))}
            </div>
            <span className="lobby-dialog-subhead">Stakes (changeable later by the host)</span>
            <div className="lobby-stakes-picker">
              {stakesPresets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={createStakes.label === preset.label ? "active" : ""}
                  onClick={() => setCreateStakes(preset)}
                >
                  <b>{preset.label}</b>
                  <small>{preset.smallBlind}/{preset.bigBlind} · {preset.minBuyIn}-{preset.maxBuyIn} buy-in</small>
                </button>
              ))}
            </div>
            <a
              className="r3-new-game lobby-create-confirm"
              href={`/play/table-lab?seats=${createSeats}&smallBlind=${createStakes.smallBlind}&bigBlind=${createStakes.bigBlind}&minBuyIn=${createStakes.minBuyIn}&maxBuyIn=${createStakes.maxBuyIn}`}
            >
              Create table <ArrowRight size={16} />
            </a>
          </section>
        </div>
      )}
    </RiverShell>
  );
}
