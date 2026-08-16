import { desc } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { tables } from "../../../../db/schema";

export async function GET() {
  try {
    const db = getDb();
    const rows = await db.select().from(tables).orderBy(desc(tables.updatedAt)).limit(50);
    return Response.json({ tables: rows });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
