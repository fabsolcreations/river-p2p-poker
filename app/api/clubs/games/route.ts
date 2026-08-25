import { and, count, eq, inArray } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { clubGameRsvps, clubMembers, clubScheduledGames } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

async function requireMembership(db: ReturnType<typeof getDb>, clubId: string, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ id: clubMembers.id })
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, userId)))
    .limit(1);
  return Boolean(membership);
}

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

    const games = await db
      .select()
      .from(clubScheduledGames)
      .where(eq(clubScheduledGames.clubId, clubId))
      .orderBy(clubScheduledGames.scheduledAt);
    if (games.length === 0) return Response.json({ games: [] });

    const rsvpRows = await db
      .select({ gameId: clubGameRsvps.gameId, userId: clubGameRsvps.userId })
      .from(clubGameRsvps)
      .where(eq(clubGameRsvps.userId, user.id));
    const myRsvpGameIds = new Set(rsvpRows.map((r) => r.gameId));

    const counts = await db
      .select({ gameId: clubGameRsvps.gameId, rsvpCount: count(clubGameRsvps.id) })
      .from(clubGameRsvps)
      .where(inArray(clubGameRsvps.gameId, games.map((g) => g.id)))
      .groupBy(clubGameRsvps.gameId);
    const countByGame = new Map(counts.map((row) => [row.gameId, row.rsvpCount]));

    return Response.json({
      games: games.map((game) => ({
        ...game,
        rsvpCount: countByGame.get(game.id) ?? 0,
        rsvped: myRsvpGameIds.has(game.id),
      })),
    });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const body = (await request.json().catch(() => null)) as
      | { clubId?: string; name?: string; format?: string; stakes?: string; scheduledAt?: string }
      | null;
    const clubId = body?.clubId;
    const name = body?.name?.trim();
    const format = body?.format?.trim();
    const stakes = body?.stakes?.trim();
    const scheduledAt = body?.scheduledAt?.trim();
    if (!clubId || !name || !format || !stakes || !scheduledAt) {
      return Response.json({ error: "clubId, name, format, stakes, and scheduledAt are required." }, { status: 400 });
    }
    if (Number.isNaN(Date.parse(scheduledAt))) {
      return Response.json({ error: "scheduledAt must be a valid date/time." }, { status: 400 });
    }

    const db = getDb();
    if (!(await requireMembership(db, clubId, user.id))) {
      return Response.json({ error: "Not a member of this club." }, { status: 403 });
    }

    const id = crypto.randomUUID();
    await db.insert(clubScheduledGames).values({ id, clubId, name, format, stakes, scheduledAt });
    return Response.json({ game: { id, clubId, name, format, stakes, scheduledAt, rsvpCount: 0, rsvped: false } });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
