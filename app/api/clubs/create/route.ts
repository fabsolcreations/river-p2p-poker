import { friendlyDbError, getDb } from "../../../../db";
import { clubMembers, clubs } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

function randomInviteCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { name?: string } | null;
    const name = body?.name?.trim();
    if (!name || name.length < 2 || name.length > 40) {
      return Response.json({ error: "Club name must be 2-40 characters." }, { status: 400 });
    }
    const db = getDb();
    const id = crypto.randomUUID();
    const inviteCode = randomInviteCode();
    await db.insert(clubs).values({ id, name, inviteCode, ownerId: user.id });
    await db.insert(clubMembers).values({ id: crypto.randomUUID(), clubId: id, userId: user.id, role: "host" });
    return Response.json({ club: { id, name, inviteCode, ownerId: user.id, role: "host", memberCount: 1 } });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
