import { desc, eq } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { handParticipants, hands } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const db = getDb();
    const rows = await db
      .select({
        handId: hands.handId,
        roomCode: hands.roomCode,
        seatCount: hands.seatCount,
        completedAt: hands.completedAt,
        bundle: hands.bundle,
        seat: handParticipants.seat,
        netResult: handParticipants.netResult,
      })
      .from(handParticipants)
      .innerJoin(hands, eq(handParticipants.handId, hands.handId))
      .where(eq(handParticipants.userId, user.id))
      .orderBy(desc(hands.completedAt))
      .limit(30);
    return Response.json({ hands: rows });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
