import { count, eq, inArray } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { clubMembers, clubs } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

// Every club the signed-in user is a member of, with their role and a real
// member count - drives the club switcher on /clubs (a user can belong to
// more than one, unlike the old single-hardcoded-club mock). Two queries
// rather than one join+groupBy: the membership row is already filtered to
// this user (one row per club, by the unique clubId+userId index), so a
// count() over that filtered join would just read back 1 for every club -
// the real per-club total needs its own unfiltered aggregate.
export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const db = getDb();
    const memberships = await db
      .select({ id: clubs.id, name: clubs.name, inviteCode: clubs.inviteCode, ownerId: clubs.ownerId, role: clubMembers.role })
      .from(clubMembers)
      .innerJoin(clubs, eq(clubMembers.clubId, clubs.id))
      .where(eq(clubMembers.userId, user.id));
    if (memberships.length === 0) return Response.json({ clubs: [] });
    const counts = await db
      .select({ clubId: clubMembers.clubId, memberCount: count(clubMembers.id) })
      .from(clubMembers)
      .where(inArray(clubMembers.clubId, memberships.map((m) => m.id)))
      .groupBy(clubMembers.clubId);
    const countByClub = new Map(counts.map((row) => [row.clubId, row.memberCount]));
    return Response.json({
      clubs: memberships.map((club) => ({ ...club, memberCount: countByClub.get(club.id) ?? 1 })),
    });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
