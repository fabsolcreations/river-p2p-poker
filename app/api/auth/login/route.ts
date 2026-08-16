import { eq } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { users } from "../../../../db/schema";
import { createSession, sessionCookieHeader, verifyPassword } from "../../../../worker/auth";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { username?: string; password?: string };
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";

    const db = getDb();
    const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
    const user = rows[0];
    // Same generic error whether the username doesn't exist or the password
    // is wrong - a distinct "no such user" message would let an attacker
    // enumerate valid usernames.
    if (!user || !(await verifyPassword(password, user.passwordHash, user.passwordSalt))) {
      return Response.json({ error: "Incorrect username or password." }, { status: 401 });
    }

    const token = await createSession(user.id);
    const secure = new URL(request.url).protocol === "https:";
    return Response.json(
      { user: { id: user.id, username: user.username, balance: user.balance } },
      { headers: { "Set-Cookie": sessionCookieHeader(token, secure) } },
    );
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
