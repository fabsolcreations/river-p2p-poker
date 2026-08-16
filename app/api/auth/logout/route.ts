import { clearedSessionCookieHeader, destroySession, readCookie, SESSION_COOKIE } from "../../../../worker/auth";

export async function POST(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await destroySession(token);
  const secure = new URL(request.url).protocol === "https:";
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookieHeader(secure) } });
}
