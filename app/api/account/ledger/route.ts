import { desc, eq } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { ledgerEntries } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const db = getDb();
    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, user.id))
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(20);
    return Response.json({ entries: rows });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
