import { eq } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { ledgerEntries, STARTING_BALANCE, users } from "../../../../db/schema";
import { createSession, hashPassword, isValidUsername, sessionCookieHeader } from "../../../../worker/auth";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { username?: string; password?: string };
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";

    if (!isValidUsername(username)) {
      return Response.json({ error: "Username must be 3-20 letters, numbers, or underscores." }, { status: 400 });
    }
    if (password.length < 8) {
      return Response.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    const db = getDb();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing.length > 0) {
      return Response.json({ error: "That username is taken." }, { status: 409 });
    }

    const { hash, salt } = await hashPassword(password);
    const id = crypto.randomUUID();
    await db.insert(users).values({ id, username, passwordHash: hash, passwordSalt: salt });
    await db.insert(ledgerEntries).values({ id: crypto.randomUUID(), userId: id, delta: STARTING_BALANCE, reason: "signup_bonus" });

    const token = await createSession(id);
    const secure = new URL(request.url).protocol === "https:";
    return Response.json(
      { user: { id, username, balance: STARTING_BALANCE } },
      { status: 201, headers: { "Set-Cookie": sessionCookieHeader(token, secure) } },
    );
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
