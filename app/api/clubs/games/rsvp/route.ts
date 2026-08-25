import { and, eq } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../../db";
import { clubGameRsvps, clubMembers, clubScheduledGames } from "../../../../../db/schema";
import { getSessionUser } from "../../../../../worker/auth";

// Toggles the signed-in user's RSVP for a game - idempotent by construction:
// calling this twice in a row RSVPs then un-RSVPs, never double-inserts
// (the unique clubId+userId-style index on gameId+userId would reject a
// duplicate insert anyway, but checking first keeps the response accurate).
export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { gameId?: string } | null;
    const gameId = body?.gameId;
    if (!gameId) return Response.json({ error: "gameId required." }, { status: 400 });

    const db = getDb();
    const [game] = await db.select({ clubId: clubScheduledGames.clubId }).from(clubScheduledGames).where(eq(clubScheduledGames.id, gameId)).limit(1);
    if (!game) return Response.json({ error: "Game not found." }, { status: 404 });

    const [membership] = await db
      .select({ id: clubMembers.id })
      .from(clubMembers)
      .where(and(eq(clubMembers.clubId, game.clubId), eq(clubMembers.userId, user.id)))
      .limit(1);
    if (!membership) return Response.json({ error: "Not a member of this club." }, { status: 403 });

    const [existing] = await db
      .select({ id: clubGameRsvps.id })
      .from(clubGameRsvps)
      .where(and(eq(clubGameRsvps.gameId, gameId), eq(clubGameRsvps.userId, user.id)))
      .limit(1);

    if (existing) {
      await db.delete(clubGameRsvps).where(eq(clubGameRsvps.id, existing.id));
      return Response.json({ rsvped: false });
    }
    await db.insert(clubGameRsvps).values({ id: crypto.randomUUID(), gameId, userId: user.id });
    return Response.json({ rsvped: true });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
