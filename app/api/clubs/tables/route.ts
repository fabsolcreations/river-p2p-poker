import { and, eq } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { clubMembers, clubTables, tables } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

async function requireMembership(db: ReturnType<typeof getDb>, clubId: string, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ id: clubMembers.id })
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, userId)))
    .limit(1);
  return Boolean(membership);
}

// A club's real linked rooms with their real live occupancy - reuses the
// exact tables-row shape /api/lobby/tables already returns, scoped down to
// just this club's rooms via clubTables. Replaces the mock's fake
// auto-overflow "table group" grid (there's no such concept in the real
// one-Durable-Object-per-room model - see the plan's explicit scope cut).
export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const url = new URL(request.url);
    const clubId = url.searchParams.get("clubId");
    if (!clubId) return Response.json({ error: "clubId required." }, { status: 400 });

    const db = getDb();
    if (!(await requireMembership(db, clubId, user.id))) {
      return Response.json({ error: "Not a member of this club." }, { status: 403 });
    }

    const rows = await db
      .select({
        roomCode: tables.roomCode,
        seatCount: tables.seatCount,
        occupiedCount: tables.occupiedCount,
        status: tables.status,
        smallBlind: tables.smallBlind,
        bigBlind: tables.bigBlind,
      })
      .from(clubTables)
      .innerJoin(tables, eq(clubTables.roomCode, tables.roomCode))
      .where(eq(clubTables.clubId, clubId));
    return Response.json({ tables: rows });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}

// Links an already-minted room code to a club - the room itself is created
// the same lazy-DO-creation way every other RIVER room is (the client mints
// a fresh code and the Durable Object comes into existence on first real
// WebSocket connect); this route only registers the label.
export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { clubId?: string; roomCode?: string } | null;
    const clubId = body?.clubId;
    const roomCode = body?.roomCode?.trim();
    if (!clubId || !roomCode) return Response.json({ error: "clubId and roomCode required." }, { status: 400 });

    const db = getDb();
    if (!(await requireMembership(db, clubId, user.id))) {
      return Response.json({ error: "Not a member of this club." }, { status: 403 });
    }

    await db.insert(clubTables).values({ id: crypto.randomUUID(), clubId, roomCode });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
