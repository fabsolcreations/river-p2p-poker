-- Betby Scout storage schema.
--
-- Two rules drive the design:
--
--   1. Nothing historical is ever destroyed. odds_snapshots and feed_bets are
--      append-only; corrections arrive as new rows, never as UPDATEs. That is
--      what makes closing-line value computable after the fact, and it is the
--      only defence against quietly rewriting history to make a signal look
--      better than it was.
--
--   2. Raw captures outlive our understanding of them. We will re-parse the
--      same payloads many times as the adapters improve, so raw_captures keeps
--      the original bytes and every derived row records which capture produced
--      it.
--
-- Engine: SQLite via node:sqlite (no native build step).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------
-- Raw layer
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collector_sessions (
  session_id     TEXT PRIMARY KEY,
  collector_kind TEXT NOT NULL,            -- extension | userscript
  version        TEXT NOT NULL,
  page_origin    TEXT NOT NULL,
  frame_origin   TEXT NOT NULL,
  is_top_frame   INTEGER NOT NULL,
  user_agent     TEXT,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  captures       INTEGER NOT NULL DEFAULT 0,
  dropped        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS raw_captures (
  capture_id     TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  ts_client      INTEGER NOT NULL,
  ts_server      INTEGER NOT NULL,
  transport      TEXT NOT NULL,            -- fetch | xhr | websocket | sse | dom | manual
  direction      TEXT NOT NULL,            -- inbound | outbound
  frame_url      TEXT NOT NULL,
  frame_origin   TEXT NOT NULL,
  is_top_frame   INTEGER NOT NULL,
  page_origin    TEXT NOT NULL,
  method         TEXT,
  url            TEXT NOT NULL,
  url_host       TEXT NOT NULL,
  url_path       TEXT NOT NULL,
  url_query      TEXT,
  status         INTEGER,
  duration_ms    INTEGER,
  req_headers    TEXT,                     -- JSON, redacted
  req_body       TEXT,                     -- redacted
  res_headers    TEXT,                     -- JSON, redacted
  content_type   TEXT,
  body           TEXT,                     -- redacted
  body_encoding  TEXT NOT NULL DEFAULT 'utf8',
  body_bytes     INTEGER NOT NULL DEFAULT 0,
  truncated      INTEGER NOT NULL DEFAULT 0,
  redacted       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  kind           TEXT NOT NULL DEFAULT 'unknown',
  confidence     REAL NOT NULL DEFAULT 0,
  adapter_id     TEXT,
  reasons        TEXT,                     -- JSON array of strings
  shape_fp       TEXT NOT NULL DEFAULT '',
  -- Set once a parser has successfully consumed this capture. Lets us re-run
  -- normalization over everything captured before an adapter existed.
  parsed_at      INTEGER,
  parser_version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES collector_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS ix_raw_ts        ON raw_captures(ts_server DESC);
CREATE INDEX IF NOT EXISTS ix_raw_kind      ON raw_captures(kind, ts_server DESC);
CREATE INDEX IF NOT EXISTS ix_raw_host      ON raw_captures(url_host, ts_server DESC);
CREATE INDEX IF NOT EXISTS ix_raw_shape     ON raw_captures(shape_fp, ts_server DESC);
CREATE INDEX IF NOT EXISTS ix_raw_session   ON raw_captures(session_id, seq);
CREATE INDEX IF NOT EXISTS ix_raw_unparsed  ON raw_captures(parsed_at) WHERE parsed_at IS NULL;

-- Iframe origins the collector observed. This is how we discover which host
-- actually serves the BETBY widget instead of assuming one.
CREATE TABLE IF NOT EXISTS observed_frames (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  top_origin   TEXT NOT NULL,
  frame_origin TEXT NOT NULL,
  frame_src    TEXT NOT NULL,
  depth        INTEGER NOT NULL,
  same_origin  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_frames_origin ON observed_frames(frame_origin);

-- ------------------------------------------------------------------
-- Reference layer
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sportsbooks (
  sportsbook_id TEXT PRIMARY KEY,          -- 'duel'
  label         TEXT NOT NULL,
  platform      TEXT NOT NULL,             -- 'betby'
  adapter_id    TEXT NOT NULL,
  origins       TEXT NOT NULL DEFAULT '[]',-- JSON array of origins seen
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_key       TEXT PRIMARY KEY,
  sportsbook_id   TEXT NOT NULL,
  source_event_id TEXT,
  sport           TEXT,
  league          TEXT,
  home            TEXT,
  away            TEXT,
  competitors     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  name            TEXT,
  start_time      INTEGER,
  live            INTEGER,
  status          TEXT,
  -- When the market for this event closed, i.e. the last price we recorded
  -- before kickoff. Filled in by the CLV job, never by the ingest path.
  closed_at       INTEGER,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  FOREIGN KEY (sportsbook_id) REFERENCES sportsbooks(sportsbook_id)
);
CREATE INDEX IF NOT EXISTS ix_events_source ON events(sportsbook_id, source_event_id);
CREATE INDEX IF NOT EXISTS ix_events_start  ON events(start_time);

CREATE TABLE IF NOT EXISTS markets (
  market_key       TEXT PRIMARY KEY,
  event_key        TEXT NOT NULL,
  sportsbook_id    TEXT NOT NULL,
  source_market_id TEXT,
  type             TEXT,
  name             TEXT,
  line             REAL,
  period           TEXT,
  status           TEXT,
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL,
  FOREIGN KEY (event_key) REFERENCES events(event_key)
);
CREATE INDEX IF NOT EXISTS ix_markets_event ON markets(event_key);

CREATE TABLE IF NOT EXISTS selections (
  selection_key       TEXT PRIMARY KEY,
  market_key          TEXT NOT NULL,
  event_key           TEXT NOT NULL,
  sportsbook_id       TEXT NOT NULL,
  source_selection_id TEXT,
  name                TEXT,
  side                TEXT,
  line                REAL,
  status              TEXT,
  first_seen          INTEGER NOT NULL,
  last_seen           INTEGER NOT NULL,
  FOREIGN KEY (market_key) REFERENCES markets(market_key)
);
CREATE INDEX IF NOT EXISTS ix_selections_market ON selections(market_key);

-- ------------------------------------------------------------------
-- Time series - append only
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sportsbook_id TEXT NOT NULL,
  event_key     TEXT NOT NULL,
  market_key    TEXT NOT NULL,
  selection_key TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  decimal_odds  REAL NOT NULL,
  line          REAL,
  status        TEXT,
  capture_id    TEXT
);
-- Dedupe identical consecutive prices at write time, not by deleting history.
CREATE UNIQUE INDEX IF NOT EXISTS ux_odds_point
  ON odds_snapshots(selection_key, ts, decimal_odds);
CREATE INDEX IF NOT EXISTS ix_odds_sel_ts ON odds_snapshots(selection_key, ts);
CREATE INDEX IF NOT EXISTS ix_odds_event  ON odds_snapshots(event_key, ts);

CREATE TABLE IF NOT EXISTS line_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_key  TEXT NOT NULL,
  event_key      TEXT NOT NULL,
  ts_from        INTEGER NOT NULL,
  ts_to          INTEGER NOT NULL,
  odds_from      REAL NOT NULL,
  odds_to        REAL NOT NULL,
  -- Probability delta, which is comparable across price ranges. Odds ratios
  -- are not: 1.10 -> 1.05 is a far bigger move than 11.0 -> 10.5.
  prob_delta     REAL NOT NULL,
  duration_ms    INTEGER NOT NULL,
  kind           TEXT NOT NULL,            -- steam | drift | reverse | stale | move
  detected_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_moves_sel ON line_movements(selection_key, ts_to DESC);

-- ------------------------------------------------------------------
-- Bets feed
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bettors (
  bettor_key    TEXT PRIMARY KEY,
  sportsbook_id TEXT NOT NULL,
  label         TEXT,                      -- masked handle exactly as shown
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_bets (
  bet_key       TEXT PRIMARY KEY,
  sportsbook_id TEXT NOT NULL,
  source_bet_id TEXT,
  ts            INTEGER NOT NULL,
  bettor_key    TEXT NOT NULL,
  stake         REAL,
  currency      TEXT,
  stake_usd     REAL,
  total_odds    REAL,
  potential_win REAL,
  type          TEXT NOT NULL DEFAULT 'unknown',  -- single | combo | system
  leg_count     INTEGER NOT NULL DEFAULT 0,
  live          INTEGER,
  status        TEXT NOT NULL DEFAULT 'unknown',
  -- Status can legitimately change (open -> won, won -> void on resettlement).
  -- We overwrite the current status here but append every transition to
  -- feed_bet_status_history, so the record of what we believed and when is
  -- never lost.
  settled_at    INTEGER,
  capture_id    TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  FOREIGN KEY (bettor_key) REFERENCES bettors(bettor_key)
);
CREATE INDEX IF NOT EXISTS ix_feedbets_ts     ON feed_bets(ts DESC);
CREATE INDEX IF NOT EXISTS ix_feedbets_bettor ON feed_bets(bettor_key, ts DESC);
CREATE INDEX IF NOT EXISTS ix_feedbets_status ON feed_bets(status, ts DESC);

CREATE TABLE IF NOT EXISTS feed_bet_status_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_key    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  status     TEXT NOT NULL,
  capture_id TEXT,
  FOREIGN KEY (bet_key) REFERENCES feed_bets(bet_key)
);
CREATE INDEX IF NOT EXISTS ix_betstatus_bet ON feed_bet_status_history(bet_key, ts);

CREATE TABLE IF NOT EXISTS feed_bet_legs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_key        TEXT NOT NULL,
  idx            INTEGER NOT NULL,
  event_key      TEXT,
  source_event_id TEXT,
  sport          TEXT,
  league         TEXT,
  event_name     TEXT,
  market_key     TEXT,
  market_name    TEXT,
  selection_key  TEXT,
  selection_name TEXT,
  line           REAL,
  odds_at_bet    REAL,
  current_odds   REAL,
  live           INTEGER,
  status         TEXT NOT NULL DEFAULT 'unknown',
  -- Closing price for this leg, written once the event starts. Null until then.
  closing_odds   REAL,
  clv_prob       REAL,
  FOREIGN KEY (bet_key) REFERENCES feed_bets(bet_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_legs ON feed_bet_legs(bet_key, idx);
CREATE INDEX IF NOT EXISTS ix_legs_sel   ON feed_bet_legs(selection_key);
CREATE INDEX IF NOT EXISTS ix_legs_event ON feed_bet_legs(event_key);

-- Rolled up per bettor. Recomputed, never incrementally patched, so a bad
-- increment can never become permanent.
CREATE TABLE IF NOT EXISTS bettor_stats (
  bettor_key        TEXT PRIMARY KEY,
  computed_at       INTEGER NOT NULL,
  bets              INTEGER NOT NULL DEFAULT 0,
  singles           INTEGER NOT NULL DEFAULT 0,
  parlays           INTEGER NOT NULL DEFAULT 0,
  settled           INTEGER NOT NULL DEFAULT 0,
  wins              INTEGER NOT NULL DEFAULT 0,
  losses            INTEGER NOT NULL DEFAULT 0,
  pushes            INTEGER NOT NULL DEFAULT 0,
  voids             INTEGER NOT NULL DEFAULT 0,
  amount_wagered    REAL NOT NULL DEFAULT 0,
  profit            REAL NOT NULL DEFAULT 0,
  roi               REAL,
  roi_stderr        REAL,
  win_rate          REAL,
  win_rate_lo       REAL,                  -- Wilson lower bound
  win_rate_hi       REAL,
  avg_odds          REAL,
  median_odds       REAL,
  avg_stake         REAL,
  median_stake      REAL,
  largest_stake     REAL,
  avg_legs          REAL,
  clv_avg           REAL,
  clv_n             INTEGER NOT NULL DEFAULT 0,
  sharpness         REAL,                  -- 0..100
  sharpness_conf    REAL,                  -- 0..1 confidence in the score
  sharpness_parts   TEXT,                  -- JSON: component breakdown
  warnings          TEXT,                  -- JSON array of bias warnings
  FOREIGN KEY (bettor_key) REFERENCES bettors(bettor_key)
);

CREATE TABLE IF NOT EXISTS bettor_segment_stats (
  bettor_key  TEXT NOT NULL,
  segment     TEXT NOT NULL,               -- 'sport' | 'league' | 'market' | 'odds_band'
  value       TEXT NOT NULL,
  bets        INTEGER NOT NULL DEFAULT 0,
  settled     INTEGER NOT NULL DEFAULT 0,
  staked      REAL NOT NULL DEFAULT 0,
  profit      REAL NOT NULL DEFAULT 0,
  roi         REAL,
  clv_avg     REAL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (bettor_key, segment, value)
);

-- ------------------------------------------------------------------
-- Signals, alerts, paper trades
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signals (
  signal_id     TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,             -- price_edge | sharp_follow | whale | ...
  sportsbook_id TEXT NOT NULL,
  event_key     TEXT,
  market_key    TEXT,
  selection_key TEXT,
  score         REAL NOT NULL,             -- 0..100
  components    TEXT NOT NULL DEFAULT '{}',-- JSON: per-factor sub-scores
  est_ev        REAL,
  est_fair_prob REAL,
  fair_source   TEXT,
  book_odds     REAL,
  reasons       TEXT NOT NULL DEFAULT '[]',
  warnings      TEXT NOT NULL DEFAULT '[]',
  -- Frozen at emit time so backtests grade the signal we actually fired, not a
  -- retro-fitted one.
  snapshot      TEXT NOT NULL DEFAULT '{}',
  resolved_at   INTEGER,
  outcome       TEXT,                      -- won | lost | push | void | unknown
  realized_pl   REAL,
  closing_odds  REAL,
  clv_prob      REAL
);
CREATE INDEX IF NOT EXISTS ix_signals_ts   ON signals(ts DESC);
CREATE INDEX IF NOT EXISTS ix_signals_type ON signals(type, ts DESC);
CREATE INDEX IF NOT EXISTS ix_signals_sel  ON signals(selection_key, ts DESC);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id    TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  signal_id   TEXT,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- Dedupe key: same key within the cooldown window is suppressed, not resent.
  dedupe_key  TEXT NOT NULL,
  delivered   INTEGER NOT NULL DEFAULT 0,
  read_at     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_alerts_dedupe ON alerts(dedupe_key, ts DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                -- bettor | event | team | league | market | selection
  value      TEXT NOT NULL,
  label      TEXT,
  conditions TEXT NOT NULL DEFAULT '{}',   -- JSON, e.g. {"minStake":500}
  created_at INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_watch ON watchlist(kind, value);

CREATE TABLE IF NOT EXISTS paper_trades (
  trade_id      TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  signal_id     TEXT,
  sportsbook_id TEXT NOT NULL,
  event_key     TEXT,
  selection_key TEXT,
  description   TEXT NOT NULL,
  stake         REAL NOT NULL,
  decimal_odds  REAL NOT NULL,
  est_fair_prob REAL,
  est_ev        REAL,
  status        TEXT NOT NULL DEFAULT 'open',
  settled_at    INTEGER,
  realized_pl   REAL,
  closing_odds  REAL,
  clv_prob      REAL,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS ix_paper_ts ON paper_trades(ts DESC);

-- ------------------------------------------------------------------
-- Housekeeping
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
