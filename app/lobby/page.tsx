"use client";

import { ArrowRight, Plus, RefreshCcw, Search, Users, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RiverShell } from "../components/river-shell";
import { randomRoomCode } from "../play/table-transport";
import { STAKES_PRESETS, stakesPresetForTier, type StakesTier } from "./stakes-presets";

type TableRow = {
  roomCode: string;
  seatCount: number;
  occupiedCount: number;
  status: "waiting" | "playing";
  updatedAt: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  isLounge: boolean;
};

const seatOptions = [2, 4, 6, 8, 9, 10];

export default function LobbyPage() {
  const [tables, setTables] = useState<TableRow[] | "loading">("loading");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createSeats, setCreateSeats] = useState(6);
  const [createStakes, setCreateStakes] = useState(STAKES_PRESETS[0]);
  const [loungeBusy, setLoungeBusy] = useState<StakesTier | null>(null);

  // Finds an open public table at this tier (any seat free) and joins it,
  // or - if none exists yet - mints a fresh one at that tier's stakes, the
  // same lazy-DO-creation pattern the "New table" flow already uses. Either
  // way lands on table-lab with autosit=1, which sits the player down
  // immediately instead of the normal spectate-first flow (see
  // table-lab's bootstrap effect) - the whole point of a lounge tile is
  // "one click, in a hand," not "one click, choose a seat."
  async function joinLounge(tier: StakesTier) {
    const preset = stakesPresetForTier(tier);
    if (!preset || loungeBusy) return;
    setLoungeBusy(tier);
    try {
      const response = await fetch(`/api/lounge/join?tier=${tier}`);
      const body = (await response.json()) as { roomCode: string | null };
      if (body.roomCode) {
        window.location.href = `/play/table-lab?room=${encodeURIComponent(body.roomCode)}&seats=6&autosit=1`;
        return;
      }
      const code = randomRoomCode();
      window.location.href = `/play/table-lab?room=${code}&seats=6&smallBlind=${preset.smallBlind}&bigBlind=${preset.bigBlind}&minBuyIn=${preset.minBuyIn}&maxBuyIn=${preset.maxBuyIn}&lounge=1&autosit=1`;
    } finally {
      setLoungeBusy(null);
    }
  }

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

        <section className="lounge-tiles">
          <div className="lounge-tiles-head"><Zap size={15} /><span>LOUNGE</span><p>One click, in a hand - joins an open public table at this tier, or opens a fresh one.</p></div>
          <div className="lounge-tiles-grid">
            {STAKES_PRESETS.map((preset) => (
              <button key={preset.tier} type="button" disabled={loungeBusy !== null} onClick={() => joinLounge(preset.tier)}>
                <b>{preset.label}</b>
                <small>{preset.smallBlind}/{preset.bigBlind}</small>
                <span>{loungeBusy === preset.tier ? "Joining..." : "Join"}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="r3-lobby-controls">
          <label className="r3-lobby-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by room code" /></label>
          <button className="r3-new-game" onClick={() => setCreateOpen(true)}><Plus size={16} /> New table</button>
        </section>

        <section className="r3-game-directory lobby-directory">
          <div className="lobby-row lobby-row-head"><span>ROOM</span><span>STAKES</span><span>SEATS</span><span>STATUS</span><span /></div>
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
                <span className="lobby-room-name"><b>{table.roomCode}</b>{table.isLounge && <i className="casino-badge idle">LOUNGE</i>}</span>
                <span className="lobby-stakes-cell">{table.smallBlind}/{table.bigBlind}</span>
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
              {STAKES_PRESETS.map((preset) => (
                <button
                  key={preset.tier}
                  type="button"
                  className={createStakes.tier === preset.tier ? "active" : ""}
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
