import { and, eq, gt } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { tables } from "../../../../db/schema";
import { stakesPresetForTier } from "../../../lobby/stakes-presets";

// Finds an open lounge room at the requested tier (isLounge, matching
// blinds, a free seat) - if none exists, the client mints a fresh room code
// itself and flags it isLounge=1 at connect time (see poker-table.ts's
// fetch(), lazy-DO-creation, same pattern as a normal "New table" link).
// This route never creates a room itself - a Durable Object only comes into
// existence on its first real WebSocket connection.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const tier = url.searchParams.get("tier") ?? "";
    const preset = stakesPresetForTier(tier);
    if (!preset) return Response.json({ error: "Unknown stakes tier." }, { status: 400 });

    const db = getDb();
    const [row] = await db
      .select({ roomCode: tables.roomCode })
      .from(tables)
      .where(
        and(
          eq(tables.isLounge, true),
          eq(tables.smallBlind, preset.smallBlind),
          eq(tables.bigBlind, preset.bigBlind),
          gt(tables.seatCount, tables.occupiedCount),
        ),
      )
      .orderBy(tables.updatedAt)
      .limit(1);

    return Response.json({ roomCode: row?.roomCode ?? null });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
