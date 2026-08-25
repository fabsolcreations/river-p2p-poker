import { and, count, eq, gte, sql } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { clubMembers, clubScheduledGames, clubTables, hands } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Real overview metrics only - no invented "host fee"/"modeled volume"
// (there's no fee-taking logic anywhere in the real backend, see the
// dropped Treasury tab). Hands/7d counts real completed hands at rooms
// actually linked to this club.
export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const url = new URL(request.url);
    const clubId = url.searchParams.get("clubId");
    if (!clubId) return Response.json({ error: "clubId required." }, { status: 400 });

    const db = getDb();
    const [membership] = await db
      .select({ id: clubMembers.id })
      .from(clubMembers)
      .where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, user.id)))
      .limit(1);
    if (!membership) return Response.json({ error: "Not a member of this club." }, { status: 403 });

    const [memberRow] = await db.select({ n: count(clubMembers.id) }).from(clubMembers).where(eq(clubMembers.clubId, clubId));
    const [roomRow] = await db.select({ n: count(clubTables.id) }).from(clubTables).where(eq(clubTables.clubId, clubId));
    const [gameRow] = await db.select({ n: count(clubScheduledGames.id) }).from(clubScheduledGames).where(eq(clubScheduledGames.clubId, clubId));
    // SQLite's CURRENT_TIMESTAMP (what `completedAt` is stored with) formats
    // as "YYYY-MM-DD HH:MM:SS" - space-separated, no milliseconds, no "Z".
    // Comparing against a plain toISOString() ("...T...Z") would compare
    // correctly on every day except the exact cutoff day, where the 'T' vs
    // ' ' byte at the same position breaks the lexicographic ordering -
    // matching the stored format exactly avoids that edge case entirely.
    const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString().slice(0, 19).replace("T", " ");
    const [handRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(hands)
      .innerJoin(clubTables, eq(hands.roomCode, clubTables.roomCode))
      .where(and(eq(clubTables.clubId, clubId), gte(hands.completedAt, since)));

    return Response.json({
      stats: { members: memberRow.n, linkedRooms: roomRow.n, scheduledGames: gameRow.n, handsLast7d: handRow.n },
    });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
