-- Every image post the fetcher has seen. post_kind is NULL while it sits in the pool.
CREATE TABLE IF NOT EXISTS memes (
  id           TEXT PRIMARY KEY,   -- reddit id, e.g. t3_1xlrukx
  title        TEXT NOT NULL,
  image        TEXT NOT NULL,
  link         TEXT NOT NULL,
  author       TEXT NOT NULL,
  published    TEXT NOT NULL,      -- ISO, UTC
  rank         INTEGER,            -- position in reddit's weekly top at last fetch
  ingested_at  TEXT NOT NULL,
  post_kind    TEXT,               -- 'daily' | 'request'
  day          TEXT,               -- daily only: the reddit day it represents
  posted_at    TEXT,
  requested_by TEXT,
  channel_id   TEXT,
  message_id   TEXT
);
-- the dedupe guarantee: one daily meme per day, enforced by the database
CREATE UNIQUE INDEX IF NOT EXISTS one_daily_per_day ON memes(day) WHERE post_kind = 'daily';
CREATE INDEX IF NOT EXISTS memes_posted ON memes(posted_at) WHERE post_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS memes_pool ON memes(published) WHERE post_kind IS NULL;

CREATE TABLE IF NOT EXISTS votes (
  meme_id  TEXT NOT NULL REFERENCES memes(id),
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,          -- fire | lol | dead | mid
  voted_at TEXT NOT NULL,
  PRIMARY KEY (meme_id, user_id)
);
CREATE INDEX IF NOT EXISTS votes_user ON votes(user_id);

CREATE TABLE IF NOT EXISTS users (
  user_id        TEXT PRIMARY KEY,
  name           TEXT,
  streak         INTEGER NOT NULL DEFAULT 0,
  best_streak    INTEGER NOT NULL DEFAULT 0,
  last_vote_day  TEXT
);

-- one row per recap ever posted ('week:2026-11-08', 'month:2026-10'), so recaps never repeat
CREATE TABLE IF NOT EXISTS recaps (
  period    TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- game night
-- one row per day; the PRIMARY KEY is what guarantees a single poll per day
CREATE TABLE IF NOT EXISTS game_nights (
  day        TEXT PRIMARY KEY,       -- local (Europe/Vilnius) date
  stage      TEXT NOT NULL,          -- ask | game | time | set | off
  message_id TEXT,
  game       TEXT,
  start_at   INTEGER,                -- unix seconds
  event_id   TEXT,
  reminded   INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  nudge_id   TEXT,                   -- latest "your turn" ping, deleted when superseded
  started_by TEXT,                   -- player who ran /playtoday; NULL = the 17:00 schedule
  stage_at   INTEGER,                -- unix seconds the current stage began (time presets, re-nudges)
  renudged   TEXT,                   -- stage whose one-off "still waiting on you" ping went out
  conflict   TEXT,                   -- last start/leave-by clash we pinged about (one ping per clash)
  event_end  INTEGER                 -- the Discord event's current end, pushed back while people still play
);

CREATE TABLE IF NOT EXISTS game_night_votes (
  day      TEXT NOT NULL,
  stage    TEXT NOT NULL,            -- ask (yes/no) | game (name) | time (unix seconds)
  user_id  TEXT NOT NULL,
  choice   TEXT NOT NULL,
  voted_at TEXT NOT NULL,
  PRIMARY KEY (day, stage, user_id)
);

CREATE TABLE IF NOT EXISTS games (
  name     TEXT PRIMARY KEY COLLATE NOCASE,
  emoji    TEXT,
  added_by TEXT,
  added_at TEXT NOT NULL,
  plays    INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO games (name, emoji, added_at) VALUES
  ('World of Warcraft', '⚔️', '2026-11-03'),
  ('R.E.P.O.', '📦', '2026-11-03'),
  ('Phasmophobia', '👻', '2026-11-03'),
  ('Demonologist', '😈', '2026-11-03'),
  ('Palworld', '🐑', '2026-11-03'),
  ('Enshrouded', '🌫️', '2026-11-03'),
  ('RuneScape: Dragonwilds', '🐉', '2026-11-03'),
  ('Counter-Strike 2', '🔫', '2026-11-03');
-- ---------------------------------------------------------------- polls
CREATE TABLE IF NOT EXISTS polls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  options    TEXT NOT NULL,          -- JSON array of answers
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at  TEXT,
  result     TEXT,                   -- win:<answer>
  channel_id TEXT,
  message_id TEXT
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id  INTEGER NOT NULL REFERENCES polls(id),
  user_id  TEXT NOT NULL,
  choice   INTEGER NOT NULL,         -- index into polls.options
  voted_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);
-- ---------------------------------------------------------------- tiebreakers (tiebreak.ts)
CREATE TABLE IF NOT EXISTS tiebreaks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,          -- night | poll
  ref        TEXT NOT NULL,          -- night day, or poll id
  options    TEXT NOT NULL,          -- JSON: the tied options
  contenders TEXT NOT NULL,          -- JSON {user: option they backed}
  alive      TEXT NOT NULL,          -- JSON users still in the rock-paper-scissors
  mode       TEXT,                   -- NULL (choosing) | wheel | rps
  round      INTEGER NOT NULL DEFAULT 1,
  hands      TEXT NOT NULL DEFAULT '{}',  -- JSON {user: r|p|s}, current round, secret
  history    TEXT NOT NULL DEFAULT '[]',  -- JSON lines, one per finished round
  result     TEXT,
  how        TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_tiebreak_per_host ON tiebreaks(kind, ref);
-- ---------------------------------------------------------------- game rooms (voice.ts)
CREATE TABLE IF NOT EXISTS rooms (
  channel_id  TEXT PRIMARY KEY,      -- the voice channel the bot opened
  game        TEXT NOT NULL,
  day         TEXT,                  -- game night that opened it, if any
  created_by  TEXT,
  created_at  INTEGER NOT NULL,      -- unix seconds
  last_seen   INTEGER,               -- last tick someone was in it
  archived_at INTEGER                -- moved to 🗄️ Recent games; deleted 3 days later
);
-- ---------------------------------------------------------------- latecomers (late.ts)
CREATE TABLE IF NOT EXISTS night_attendance (
  day        TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  state      TEXT NOT NULL,          -- arrived | late | eta | absent
  eta        INTEGER,                -- unix seconds, from the 🏃 buttons
  message_id TEXT,                   -- their late slip, if one was posted
  arrived_at INTEGER,
  PRIMARY KEY (day, user_id)
);

-- ---------------------------------------------------------------- 📊 voice time
-- one row per player per stretch in one voice channel, from the once-a-minute check (activity.ts)
CREATE TABLE IF NOT EXISTS voice_segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  game       TEXT,                   -- the game room's game; NULL = Lobby or another channel
  started_at INTEGER NOT NULL,       -- unix seconds, first seen there
  last_seen  INTEGER NOT NULL,       -- last check that saw them there
  open       INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_segments_one_open ON voice_segments (user_id) WHERE open = 1;
CREATE INDEX IF NOT EXISTS voice_segments_time ON voice_segments (started_at);
