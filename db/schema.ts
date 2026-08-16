import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const STARTING_BALANCE = 1000;

// Real accounts, real persistent bankroll - still test chips (`balance` is
// TEST chips, matching the app's convention everywhere; no real-money path
// exists yet, see the roadmap in memory / app/fairness). Passwords are
// hashed with PBKDF2 (Web Crypto, available in both the Workers runtime
// and local dev) - see worker/auth.ts.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  balance: integer("balance").notNull().default(STARTING_BALANCE),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: integer("expires_at").notNull(),
});

// A lightweight directory of live tables, kept in sync by
// worker/poker-table.ts whenever seat occupancy changes (not on every
// betting action - Durable Objects can't be listed/enumerated by
// Cloudflare's API, so this is the only way a lobby page can show what's
// actually open right now).
export const tables = sqliteTable("tables", {
  roomCode: text("room_code").primaryKey(),
  seatCount: integer("seat_count").notNull(),
  occupiedCount: integer("occupied_count").notNull(),
  status: text("status").notNull(), // "waiting" | "playing"
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Append-only audit trail behind `users.balance` - every balance change is
// also logged here so a player's history is reconstructable independent of
// the cached total. `roomCode` is null for account-level entries (signup
// bonus) and set for table buy-ins/cash-outs.
export const ledgerEntries = sqliteTable("ledger_entries", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(), // "signup_bonus" | "buy_in" | "cash_out" | "crypto_deposit" | "crypto_withdraw" | "crypto_withdraw_failed_refund"
  roomCode: text("room_code"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// One row per completed hand that had at least one authenticated
// participant - `bundle` is the full TableProofBundle JSON, so a hand's
// receipt stays independently re-verifiable (via verifyTableBundle) long
// after the room's Durable Object storage might be gone.
export const hands = sqliteTable("hands", {
  handId: text("hand_id").primaryKey(),
  roomCode: text("room_code").notNull(),
  seatCount: integer("seat_count").notNull(),
  bundle: text("bundle").notNull(),
  completedAt: text("completed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const handParticipants = sqliteTable("hand_participants", {
  id: text("id").primaryKey(),
  handId: text("hand_id").notNull().references(() => hands.handId),
  userId: text("user_id").notNull().references(() => users.id),
  seat: integer("seat").notNull(),
  netResult: integer("net_result").notNull(),
});

// One verified on-chain address per account (see worker/chain.ts). Linking
// requires a signed challenge message, not just a claimed address - see
// app/api/wallet/link/route.ts.
export const wallets = sqliteTable("wallets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id).unique(),
  address: text("address").notNull().unique(), // lowercase-normalized 0x...
  verifiedAt: text("verified_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Audit trail + idempotency for real on-chain deposits/withdrawals through
// EscrowVault.sol (contracts/contracts/EscrowVault.sol). `txHash` as the
// primary key IS the idempotency guard: a deposit confirmation can be
// retried/resubmitted safely, since inserting a row for a hash that's
// already been processed simply fails as a duplicate-key conflict.
// `tokenBaseUnits` is stored as a decimal string (not a number) to avoid
// float precision loss on real on-chain token amounts.
export const onchainTransactions = sqliteTable("onchain_transactions", {
  txHash: text("tx_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  direction: text("direction").notNull(), // "deposit" | "withdrawal"
  chips: integer("chips").notNull(),
  tokenBaseUnits: text("token_base_units").notNull(),
  ledgerEntryId: text("ledger_entry_id").notNull().references(() => ledgerEntries.id),
  status: text("status").notNull(), // "pending" | "confirmed" | "failed"
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
