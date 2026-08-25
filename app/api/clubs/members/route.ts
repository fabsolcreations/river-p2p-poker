import { and, eq } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { clubMembers, users } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

// Real usernames, joined against `users` - the mock's per-member "games
// played"/online-away-offline presence had no real backing data anywhere
// in the app (no presence tracker exists outside a live table's own
// connected seats), so it's dropped rather than faked. Role + join date
// are both real.
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

    const rows = await db
      .select({ username: users.username, role: clubMembers.role, joinedAt: clubMembers.joinedAt })
      .from(clubMembers)
      .innerJoin(users, eq(clubMembers.userId, users.id))
      .where(eq(clubMembers.clubId, clubId))
      .orderBy(clubMembers.joinedAt);
    return Response.json({ members: rows });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
