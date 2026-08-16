import { eq } from "drizzle-orm";
import { bytesToHex, randomHex } from "../app/play/proof";
import { getDb } from "../db";
import { sessions, users } from "../db/schema";

/**
 * Real account auth - password + session cookie, backed by D1 (see
 * db/schema.ts). Nothing here touches real money: `users.balance` is TEST
 * chips, same convention as everywhere else in the app. Password hashing
 * uses PBKDF2 via Web Crypto (available in both the Workers runtime and
 * local dev) rather than bcrypt/argon2, since those need native/WASM
 * modules this project deliberately avoids.
 */

export const SESSION_COOKIE = "river_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PBKDF2_ITERATIONS = 100_000;

export type SessionUser = { id: string; username: string; balance: number };

async function pbkdf2Hash(password: string, saltHex: string): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  return bytesToHex(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomHex(16);
  const hash = await pbkdf2Hash(password, salt);
  return { hash, salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const candidate = await pbkdf2Hash(password, salt);
  if (candidate.length !== hash.length) return false;
  // Constant-time compare - password hashes are exactly the kind of secret
  // a timing side-channel could leak one byte at a time.
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

export async function createSession(userId: string): Promise<string> {
  const token = randomHex(32);
  const db = getDb();
  await db.insert(sessions).values({ token, userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export async function destroySession(token: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.token, token));
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const db = getDb();
  const rows = await db
    .select({ id: users.id, username: users.username, balance: users.balance, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.token, token))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt < Date.now()) return null;
  return { id: row.id, username: row.username, balance: row.balance };
}

// `secure` should be the request's own protocol (`request.url.startsWith("https:")`) -
// a `Secure` cookie is silently refused by browsers over plain HTTP, which
// would otherwise make login look like it worked while no cookie is ever
// actually stored during local dev.
export function sessionCookieHeader(token: string, secure: boolean): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearedSessionCookieHeader(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=0`;
}
