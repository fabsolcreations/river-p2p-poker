import { eq, sql } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { handParticipants } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const db = getDb();
    const [row] = await db
      .select({
        handsPlayed: sql<number>`count(*)`,
        handsWon: sql<number>`coalesce(sum(case when ${handParticipants.netResult} > 0 then 1 else 0 end), 0)`,
        netResult: sql<number>`coalesce(sum(${handParticipants.netResult}), 0)`,
        biggestWin: sql<number>`coalesce(max(${handParticipants.netResult}), 0)`,
        biggestLoss: sql<number>`coalesce(min(${handParticipants.netResult}), 0)`,
      })
      .from(handParticipants)
      .where(eq(handParticipants.userId, user.id));
    return Response.json({ stats: row });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
