import { and, eq } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { clubMembers, clubs } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { inviteCode?: string } | null;
    const inviteCode = body?.inviteCode?.trim().toUpperCase();
    if (!inviteCode) return Response.json({ error: "Invite code required." }, { status: 400 });

    const db = getDb();
    const [club] = await db.select().from(clubs).where(eq(clubs.inviteCode, inviteCode)).limit(1);
    if (!club) return Response.json({ error: "That invite code doesn't match any club." }, { status: 404 });

    const [existing] = await db
      .select({ id: clubMembers.id })
      .from(clubMembers)
      .where(and(eq(clubMembers.clubId, club.id), eq(clubMembers.userId, user.id)))
      .limit(1);
    if (existing) return Response.json({ error: "You're already a member of this club." }, { status: 409 });

    await db.insert(clubMembers).values({ id: crypto.randomUUID(), clubId: club.id, userId: user.id, role: "member" });
    return Response.json({ club: { id: club.id, name: club.name, inviteCode: club.inviteCode, ownerId: club.ownerId, role: "member" } });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
