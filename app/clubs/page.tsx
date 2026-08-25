"use client";

import {
  ArrowRight,
  CalendarDays,
  Check,
  Copy,
  Crown,
  Gamepad2,
  Layers3,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { RiverShell } from "../components/river-shell";
import { randomRoomCode } from "../play/table-transport";

type Account = { id: string; username: string; balance: number };
type ClubRow = { id: string; name: string; inviteCode: string; ownerId: string; role: string; memberCount: number };
type MemberRow = { username: string; role: string; joinedAt: string };
type GameRow = { id: string; clubId: string; name: string; format: string; stakes: string; scheduledAt: string; rsvpCount: number; rsvped: boolean };
type ClubTableRow = { roomCode: string; seatCount: number; occupiedCount: number; status: string; smallBlind: number; bigBlind: number };
type Stats = { members: number; linkedRooms: number; scheduledGames: number; handsLast7d: number };

const EMPTY_STATS: Stats = { members: 0, linkedRooms: 0, scheduledGames: 0, handsLast7d: 0 };

type Tab = "overview" | "members" | "games";

export default function ClubsPage() {
  const [account, setAccount] = useState<Account | null | "loading">("loading");
  const [myClubs, setMyClubs] = useState<ClubRow[] | "loading">("loading");
  const [activeClubId, setActiveClubId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [rooms, setRooms] = useState<ClubTableRow[]>([]);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [memberQuery, setMemberQuery] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  async function loadAccount() {
    const response = await fetch("/api/auth/me");
    const body = (await response.json()) as { user: Account | null };
    setAccount(body.user);
    if (body.user) await loadMyClubs();
    else setMyClubs([]);
  }

  async function loadMyClubs(preferClubId?: string) {
    const response = await fetch("/api/clubs/mine");
    if (!response.ok) {
      setMyClubs([]);
      return;
    }
    const body = (await response.json()) as { clubs: ClubRow[] };
    setMyClubs(body.clubs);
    const next = preferClubId ?? (body.clubs.some((c) => c.id === activeClubId) ? activeClubId : body.clubs[0]?.id ?? null);
    setActiveClubId(next);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time client-only session bootstrap
    loadAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadAccount is intentionally called only once, on mount
  }, []);

  async function loadClubData(clubId: string) {
    const [membersRes, gamesRes, roomsRes, statsRes] = await Promise.all([
      fetch(`/api/clubs/members?clubId=${clubId}`),
      fetch(`/api/clubs/games?clubId=${clubId}`),
      fetch(`/api/clubs/tables?clubId=${clubId}`),
      fetch(`/api/clubs/stats?clubId=${clubId}`),
    ]);
    setMembers(membersRes.ok ? ((await membersRes.json()) as { members: MemberRow[] }).members : []);
    setGames(gamesRes.ok ? ((await gamesRes.json()) as { games: GameRow[] }).games : []);
    setRooms(roomsRes.ok ? ((await roomsRes.json()) as { tables: ClubTableRow[] }).tables : []);
    setStats(statsRes.ok ? ((await statsRes.json()) as { stats: Stats }).stats : EMPTY_STATS);
  }

  useEffect(() => {
    if (!activeClubId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the newly-selected club's real data, unavailable until activeClubId changes
    loadClubData(activeClubId);
    // Refreshes the sidebar's memberCount too (myClubs is otherwise only
    // refetched after this account's own create/join actions, so another
    // member joining wouldn't otherwise show up there until next visit).
    loadMyClubs(activeClubId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadClubData/loadMyClubs are intentionally re-run only when activeClubId itself changes
  }, [activeClubId]);

  const activeClub = myClubs === "loading" ? null : (myClubs.find((c) => c.id === activeClubId) ?? null);

  async function createClub(name: string) {
    setBusy(true);
    setFormError("");
    try {
      const response = await fetch("/api/clubs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await response.json()) as { club?: ClubRow; error?: string };
      if (!response.ok || !body.club) throw new Error(body.error ?? "Could not create club.");
      await loadMyClubs(body.club.id);
      setCreateOpen(false);
      notify(`${body.club.name} created`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not create club.");
    } finally {
      setBusy(false);
    }
  }

  async function joinClub(inviteCode: string) {
    setBusy(true);
    setFormError("");
    try {
      const response = await fetch("/api/clubs/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteCode }),
      });
      const body = (await response.json()) as { club?: ClubRow; error?: string };
      if (!response.ok || !body.club) throw new Error(body.error ?? "Could not join club.");
      await loadMyClubs(body.club.id);
      setJoinOpen(false);
      notify(`Joined ${body.club.name}`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not join club.");
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    if (!activeClub) return;
    await navigator.clipboard.writeText(activeClub.inviteCode);
    notify("Invite code copied");
  }

  async function scheduleGame(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeClubId) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setFormError("");
    try {
      const response = await fetch("/api/clubs/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clubId: activeClubId,
          name: form.get("name"),
          format: form.get("format"),
          stakes: form.get("stakes"),
          scheduledAt: `${form.get("date")}T${form.get("time")}`,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not schedule game.");
      await loadClubData(activeClubId);
      setScheduleOpen(false);
      notify("Game scheduled");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not schedule game.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRsvp(gameId: string) {
    const response = await fetch("/api/clubs/games/rsvp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { rsvped: boolean };
    setGames((prev) => prev.map((game) => (game.id === gameId ? { ...game, rsvped: body.rsvped, rsvpCount: game.rsvpCount + (body.rsvped ? 1 : -1) } : game)));
  }

  async function openClubTable() {
    if (!activeClubId) return;
    const roomCode = randomRoomCode();
    await fetch("/api/clubs/tables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clubId: activeClubId, roomCode }),
    });
    window.location.href = `/play/table-lab?room=${encodeURIComponent(roomCode)}&seats=6`;
  }

  const filteredMembers = members.filter((m) => m.username.toLowerCase().includes(memberQuery.toLowerCase()));
  const upcomingGames = [...games].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  function formatWhen(iso: string) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return { day: "--", month: "---", time: iso };
    return {
      day: date.toLocaleDateString(undefined, { day: "2-digit" }),
      month: date.toLocaleDateString(undefined, { month: "short" }).toUpperCase(),
      time: date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    };
  }

  if (account === "loading" || myClubs === "loading") {
    return (
      <RiverShell active="clubs" dark footer={false}>
        <main className="club-empty-state"><Users size={30} /><h1>Loading clubs…</h1></main>
      </RiverShell>
    );
  }

  if (!account) {
    return (
      <RiverShell active="clubs" dark footer={false}>
        <main className="club-empty-state">
          <ShieldCheck size={30} />
          <h1>Sign in to use clubs</h1>
          <p>Clubs are real member groups with an invite code, real linked rooms, and a real game calendar - sign in first so RIVER knows who&apos;s joining.</p>
          <div className="club-empty-actions"><a href="/account"><UserPlus size={16} /> Sign in</a></div>
        </main>
      </RiverShell>
    );
  }

  if (myClubs.length === 0) {
    return (
      <RiverShell active="clubs" dark footer={false}>
        <main className="club-empty-state">
          <Users size={30} />
          <h1>No clubs yet</h1>
          <p>Create a club to get a real invite code, or join one with a code a friend shared with you.</p>
          <div className="club-empty-actions">
            <button onClick={() => setCreateOpen(true)}><Plus size={16} /> Create a club</button>
            <button className="ghost" onClick={() => setJoinOpen(true)}><UserPlus size={16} /> Join with code</button>
          </div>
        </main>
        {createOpen && (
          <ClubCreateDialog busy={busy} error={formError} onClose={() => setCreateOpen(false)} onSubmit={createClub} />
        )}
        {joinOpen && <ClubJoinDialog busy={busy} error={formError} onClose={() => setJoinOpen(false)} onSubmit={joinClub} />}
      </RiverShell>
    );
  }

  return (
    <RiverShell active="clubs" dark footer={false}>
      <main className="clubs-page">
        <aside className="club-sidebar">
          <div className="club-identity">
            <div className="club-emblem"><span>{(activeClub?.name ?? "??").slice(0, 2).toUpperCase()}</span><i /><i /></div>
            <div><span>REAL CLUB</span><h1>{activeClub?.name ?? "Club"}</h1><p>{activeClub?.memberCount ?? 0} real members</p></div>
          </div>
          <nav aria-label="Club console">
            {([
              ["overview", "Overview", Gamepad2],
              ["members", "Members", Users],
              ["games", "Games", CalendarDays],
            ] as const).map(([id, label, Icon]) => <button className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}><Icon size={16} />{label}<ArrowRight size={14} /></button>)}
          </nav>
          {myClubs.length > 1 && (
            <div className="club-switcher">
              {myClubs.map((club) => (
                <button key={club.id} className={club.id === activeClubId ? "active" : ""} onClick={() => setActiveClubId(club.id)}>
                  <span>{club.name}</span>{club.role === "host" && <Crown size={12} />}
                </button>
              ))}
            </div>
          )}
          <div className="club-sidebar-note">
            <ShieldCheck size={17} />
            <p><b>Real invite gate</b>Anyone with the invite code can join - approval queues aren&apos;t built yet, so keep the code to people you trust.</p>
          </div>
          <button className="back-to-lobby" style={{ background: "transparent", border: 0, cursor: "pointer" }} onClick={() => setJoinOpen(true)}>Join another club <ArrowRight size={14} /></button>
          <a className="back-to-lobby" href="/lobby">Browse public lobby <ArrowRight size={14} /></a>
        </aside>

        <section className="club-console">
          <header className="club-console-head">
            <div><span>CLUB CONSOLE / {tab.toUpperCase()}</span><h2>{tab === "overview" ? `Good to see you, ${account.username}.` : tab === "members" ? "Member directory" : "Game calendar"}</h2></div>
            <button onClick={() => setScheduleOpen(true)}><Plus size={16} /> Schedule game</button>
          </header>

          {tab === "overview" && <>
            <div className="club-metric-grid">
              <article><span>MEMBERS</span><b>{stats.members}</b><small>real, joined by code</small><i style={{ width: "100%" }} /></article>
              <article><span>CLUB ROOMS</span><b>{stats.linkedRooms}</b><small>real linked rooms</small><i style={{ width: "100%" }} /></article>
              <article><span>SCHEDULED GAMES</span><b>{stats.scheduledGames}</b><small>upcoming + past</small><i style={{ width: "100%" }} /></article>
              <article className="accent"><span>HANDS / 7D</span><b>{stats.handsLast7d}</b><small>real hands, club rooms only</small><i style={{ width: "100%" }} /></article>
            </div>

            <div className="club-overview-grid">
              <section className="upcoming-panel">
                <div className="panel-heading"><div><span>NEXT ON THE CALENDAR</span><h3>Scheduled games</h3></div><button onClick={() => setTab("games")}>View all <ArrowRight size={14} /></button></div>
                {upcomingGames.length === 0 ? (
                  <p className="club-rooms-empty">No games scheduled yet.</p>
                ) : (
                  <div className="schedule-list">
                    {upcomingGames.slice(0, 3).map((game) => {
                      const when = formatWhen(game.scheduledAt);
                      return (
                        <article key={game.id}>
                          <div className="schedule-date"><b>{when.day}</b><span>{when.month}</span></div>
                          <div><h4>{game.name}</h4><p>{when.time} / {game.format}</p></div>
                          <div><span>STAKES</span><b>{game.stakes}</b></div>
                          <div><span>RSVP</span><b>{game.rsvpCount}</b></div>
                          <button onClick={() => toggleRsvp(game.id)}>{game.rsvped ? <Check size={16} /> : <Plus size={16} />}</button>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
              <section className="invite-panel">
                <span>CLUB ACCESS</span><h3>Bring the right players.</h3><p>One real invite code - anyone who has it can join.</p>
                <button className="invite-code" onClick={copyInvite}><span><small>INVITE CODE</small><b>{activeClub?.inviteCode}</b></span><Copy size={17} /></button>
                <div className="invite-settings"><div><span>YOUR ROLE</span><b>{activeClub?.role === "host" ? "Host" : "Member"}</b></div><div><span>MEMBERS</span><b>{stats.members}</b></div></div>
              </section>
            </div>

            <section className="recent-members-panel">
              <div className="panel-heading"><div><span>CLUB REGULARS</span><h3>Member pulse</h3></div><button onClick={() => setTab("members")}>Manage members <ArrowRight size={14} /></button></div>
              <div className="member-mini-grid">
                {members.slice(0, 4).map((member) => (
                  <div key={member.username}>
                    <span className="member-avatar">{member.username.slice(0, 2).toUpperCase()}</span>
                    <div><b>{member.username}</b><small>{member.role}</small></div>
                  </div>
                ))}
              </div>
            </section>
          </>}

          {tab === "members" && <section className="members-view">
            <div className="console-toolbar"><label><Search size={15} /><input placeholder="Search members" value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)} /></label></div>
            <div className="members-table-head"><span>PLAYER</span><span>ROLE</span><span>JOINED</span><span /><span /></div>
            {filteredMembers.map((member) => (
              <article className="member-row" key={member.username}>
                <div><span className="member-avatar">{member.username.slice(0, 2).toUpperCase()}</span><b>{member.username}</b></div>
                <span>{member.role}{member.role === "host" && <Crown size={13} />}</span>
                <b>{new Date(member.joinedAt).toLocaleDateString()}</b>
                <span />
                <span />
              </article>
            ))}
          </section>}

          {tab === "games" && <section className="games-view">
            <div className="club-live-groups">
              <div className="club-groups-head">
                <div><Layers3 size={18} /><span><small>CLUB ROOMS</small><b>Real linked tables</b></span></div>
                <p>Real Durable-Object rooms tagged to this club - not a formatted table group, just what&apos;s actually open.</p>
                <button onClick={openClubTable}><RefreshCw size={14} /> Open a table</button>
              </div>
              {rooms.length === 0 ? (
                <p className="club-rooms-empty">No club rooms open yet - open one above.</p>
              ) : (
                <div className="club-group-tables">
                  {rooms.map((room, index) => (
                    <a href={`/play/table-lab?room=${encodeURIComponent(room.roomCode)}&seats=${room.seatCount}`} key={room.roomCode}>
                      <article>
                        <i>{String(index + 1).padStart(2, "0")}</i>
                        <span><b>{room.roomCode}</b><small>{room.occupiedCount} / {room.seatCount} seats</small></span>
                        <strong>{room.status === "playing" ? "PLAYING" : "WAITING"}</strong>
                      </article>
                    </a>
                  ))}
                </div>
              )}
            </div>
            {upcomingGames.length === 0 ? (
              <p className="club-rooms-empty">No games scheduled yet.</p>
            ) : (
              <div className="games-agenda">
                {upcomingGames.map((game, index) => {
                  const when = formatWhen(game.scheduledAt);
                  return (
                    <article key={game.id}>
                      <div className="agenda-time"><span>{when.day} {when.month}</span><b>{when.time}</b></div>
                      <div className={`agenda-marker marker-${index % 3}`} />
                      <div><span>{game.format} / {game.stakes}</span><h3>{game.name}</h3><p>{game.rsvpCount} member{game.rsvpCount === 1 ? "" : "s"} RSVPed</p></div>
                      <button onClick={() => toggleRsvp(game.id)}>{game.rsvped ? "Cancel RSVP" : "RSVP"} <ArrowRight size={14} /></button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>}
        </section>
      </main>

      {scheduleOpen && (
        <div className="river-dialog-backdrop" onMouseDown={() => setScheduleOpen(false)}>
          <section className="river-dialog schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="dialog-close" onClick={() => setScheduleOpen(false)} aria-label="Close"><X size={18} /></button>
            <span className="dialog-index">CLUB TOOL</span>
            <h2 id="schedule-title">Schedule a game.</h2>
            <p>Real event, saved to this club - members see it immediately.</p>
            <form className="river-form" onSubmit={scheduleGame}>
              <label>Game name<input name="name" required placeholder="Friday night" /></label>
              <div className="form-pair">
                <label>Format<select name="format" defaultValue="NL Hold'em"><option>NL Hold&apos;em</option><option>Pot-Limit Omaha</option><option>Short Deck</option></select></label>
                <label>Stakes<select name="stakes" defaultValue="1 / 2"><option>1 / 2</option><option>5 / 10</option><option>25 / 50</option><option>100 / 200</option></select></label>
              </div>
              <div className="form-pair">
                <label>Date<input name="date" type="date" required /></label>
                <label>Time<input name="time" type="time" required /></label>
              </div>
              {formError && <p className="auth-error">{formError}</p>}
              <button type="submit" disabled={busy}>{busy ? "Saving…" : "Schedule game"} <ArrowRight size={17} /></button>
            </form>
          </section>
        </div>
      )}
      {createOpen && <ClubCreateDialog busy={busy} error={formError} onClose={() => setCreateOpen(false)} onSubmit={createClub} />}
      {joinOpen && <ClubJoinDialog busy={busy} error={formError} onClose={() => setJoinOpen(false)} onSubmit={joinClub} />}
      {toast && <div className="river-toast"><Check size={15} /> {toast}</div>}
    </RiverShell>
  );
}

function ClubCreateDialog({ busy, error, onClose, onSubmit }: { busy: boolean; error: string; onClose: () => void; onSubmit: (name: string) => void }) {
  return (
    <div className="river-dialog-backdrop" onMouseDown={onClose}>
      <section className="river-dialog schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="create-club-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <span className="dialog-index">NEW CLUB</span>
        <h2 id="create-club-title">Name your club.</h2>
        <p>You get a real invite code the moment it&apos;s created.</p>
        <form
          className="river-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = new FormData(event.currentTarget).get("name");
            if (typeof name === "string") onSubmit(name);
          }}
        >
          <label>Club name<input name="name" required minLength={2} maxLength={40} placeholder="Night River" /></label>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create club"} <ArrowRight size={17} /></button>
        </form>
      </section>
    </div>
  );
}

function ClubJoinDialog({ busy, error, onClose, onSubmit }: { busy: boolean; error: string; onClose: () => void; onSubmit: (code: string) => void }) {
  return (
    <div className="river-dialog-backdrop" onMouseDown={onClose}>
      <section className="river-dialog schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="join-club-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <span className="dialog-index">JOIN CLUB</span>
        <h2 id="join-club-title">Enter an invite code.</h2>
        <p>Ask the club&apos;s host or a member for their real code.</p>
        <form
          className="river-form"
          onSubmit={(event) => {
            event.preventDefault();
            const code = new FormData(event.currentTarget).get("code");
            if (typeof code === "string") onSubmit(code);
          }}
        >
          <label>Invite code<input name="code" required placeholder="A1B2C3D4" /></label>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? "Joining…" : "Join club"} <ArrowRight size={17} /></button>
        </form>
      </section>
    </div>
  );
}
