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
