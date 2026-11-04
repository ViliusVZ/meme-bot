// The whole database, as Drizzle tables. `npm run db:generate` turns changes here into a SQL
// migration in drizzle/, which the bot applies on startup (db/index.ts).
//
// Times: unix seconds are bigint (mode "number"); ISO strings stay text where the code compares
// them as strings (posted_at, voted_at…). Game names are citext, so "phasmophobia" and
// "Phasmophobia" are the same game, like they were in SQLite (COLLATE NOCASE).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const unix = (name: string) => bigint(name, { mode: "number" });

// ---------------------------------------------------------------- memes

/** Every image post the fetcher has seen. post_kind is null while it sits in the pool. */
export const memes = pgTable(
  "memes",
  {
    id: text().primaryKey(), // reddit id, e.g. t3_1xlrukx
    title: text().notNull(),
    image: text().notNull(),
    link: text().notNull(),
    author: text().notNull(),
    published: text().notNull(), // ISO, UTC
    rank: integer(), // position in reddit's weekly top at last fetch
    ingested_at: text().notNull(),
    post_kind: text().$type<"daily" | "request">(),
    day: text(), // daily only: the reddit day it represents
    posted_at: text(),
    requested_by: text(),
    channel_id: text(),
    message_id: text(),
  },
  (t) => [
    // the dedupe guarantee: one daily meme per day, enforced by the database
    uniqueIndex("one_daily_per_day").on(t.day).where(sql`${t.post_kind} = 'daily'`),
    index("memes_posted").on(t.posted_at).where(sql`${t.post_kind} IS NOT NULL`),
    index("memes_pool").on(t.published).where(sql`${t.post_kind} IS NULL`),
  ],
);

export const votes = pgTable(
  "votes",
  {
    meme_id: text()
      .notNull()
      .references(() => memes.id),
    user_id: text().notNull(),
    kind: text().notNull().$type<"fire" | "lol" | "dead" | "mid">(),
    voted_at: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.meme_id, t.user_id] }), index("votes_user").on(t.user_id)],
);

export const users = pgTable("users", {
  user_id: text().primaryKey(),
  name: text(),
  streak: integer().notNull().default(0),
  best_streak: integer().notNull().default(0),
  last_vote_day: text(),
});

/** One row per recap ever posted ('week:2026-11-08', 'games-week:2026-11-02'), so recaps never repeat. */
export const recaps = pgTable("recaps", {
  period: text().primaryKey(),
  posted_at: text().notNull(),
});

// ---------------------------------------------------------------- game night

export type Stage = "ask" | "game" | "time" | "set" | "off";

/** One row per local day; the primary key is what guarantees a single poll per day. */
export const gameNights = pgTable("game_nights", {
  day: text().primaryKey(), // local (Europe/Vilnius) date
  stage: text().notNull().$type<Stage>(),
  message_id: text(),
  game: text(),
  start_at: unix("start_at"),
  event_id: text(),
  reminded: boolean().notNull().default(false), // the start (room, moves, ping) has been claimed
  note: text(),
  nudge_id: text(), // latest "your turn" ping, deleted when superseded
  started_by: text(), // player who ran /playtoday; null = the 17:00 schedule
  stage_at: unix("stage_at"), // when the current stage began (time presets, re-nudges)
  renudged: text(), // stage whose one-off "still waiting on you" ping went out
  conflict: text(), // last start/leave-by clash we pinged about (one ping per clash)
  event_end: unix("event_end"), // the Discord event's current end, pushed back while people still play
  warned: text(), // stage whose "30 min left to vote" warning went out
  roast: jsonb().$type<Roast>(), // who sank the night and how (roasts.ts), set when it's called off
  roast_due: unix("roast_due"), // when to post the roast (held until morning if it happened at night)
  roasted_at: unix("roasted_at"), // posted (claimed) at
});

export type Reason = "no" | "ghost" | "out";
export type Roast = { who: Record<string, Reason>; stage: Stage };

export const gameNightVotes = pgTable(
  "game_night_votes",
  {
    day: text().notNull(),
    stage: text().notNull(), // ask (yes/no) | game (name) | time | until (unix seconds)
    user_id: text().notNull(),
    choice: text().notNull(),
    voted_at: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.stage, t.user_id] })],
);

export const games = pgTable("games", {
  name: citext("name").primaryKey(),
  emoji: text(),
  added_by: text(),
  added_at: text().notNull(),
  plays: integer().notNull().default(0),
  seq: integer().generatedAlwaysAsIdentity(), // insertion order, the tie-break after plays
});

/** 🔥 Shuffle-bags for roast lines (roasts.ts): what's left of each pool, so nothing repeats too soon. */
export const roastBags = pgTable("roast_bags", {
  pool: text().primaryKey(), // solo:<id> | duo:<id>+<id> | trio
  queue: jsonb().notNull().$type<number[]>(), // line indices still to come
  last: integer(), // the line used last (a fresh bag never starts with it)
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- polls

export const polls = pgTable("polls", {
  id: integer().primaryKey().generatedByDefaultAsIdentity(),
  question: text().notNull(),
  options: jsonb().notNull().$type<string[]>(),
  created_by: text().notNull(),
  created_at: text().notNull(),
  closed_at: text(),
  result: text(), // win:<answer>
  channel_id: text(),
  message_id: text(),
});

export const pollVotes = pgTable(
  "poll_votes",
  {
    poll_id: integer()
      .notNull()
      .references(() => polls.id),
    user_id: text().notNull(),
    choice: integer().notNull(), // index into polls.options
    voted_at: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.poll_id, t.user_id] })],
);

// ---------------------------------------------------------------- tiebreakers (tiebreak.ts)

export const tiebreaks = pgTable(
  "tiebreaks",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    kind: text().notNull().$type<"night" | "poll">(),
    ref: text().notNull(), // night day, or poll id
    options: jsonb().notNull().$type<string[]>(), // the tied options
    contenders: jsonb().notNull().$type<Record<string, string>>(), // user → option they backed
    alive: jsonb().notNull().$type<string[]>(), // users still in the rock-paper-scissors
    mode: text().$type<"wheel" | "rps">(), // null while choosing
    round: integer().notNull().default(1),
    hands: jsonb()
      .notNull()
      .$type<Record<string, "r" | "p" | "s">>()
      .default(sql`'{}'::jsonb`), // current round, secret
    history: jsonb()
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'::jsonb`), // one line per finished round
    result: text(),
    how: text(),
    created_at: text().notNull(),
  },
  (t) => [uniqueIndex("one_tiebreak_per_host").on(t.kind, t.ref)],
);

// ---------------------------------------------------------------- game rooms (voice.ts)

export const rooms = pgTable("rooms", {
  channel_id: text().primaryKey(), // the voice channel the bot opened ("pending:<game>" while creating)
  game: citext("game").notNull(),
  day: text(), // game night that opened it, if any
  created_by: text(),
  created_at: unix("created_at").notNull(),
  last_seen: unix("last_seen"), // last time someone was in it
  archived_at: unix("archived_at"), // moved to 🗄️ Recent games; deleted 3 days later
});

// ---------------------------------------------------------------- latecomers (late.ts)

export const nightAttendance = pgTable(
  "night_attendance",
  {
    day: text().notNull(),
    user_id: text().notNull(),
    state: text().notNull().$type<"arrived" | "late" | "eta" | "absent">(),
    eta: unix("eta"), // from the 🏃 buttons
    message_id: text(), // their late slip, if one was posted
    arrived_at: unix("arrived_at"),
  },
  (t) => [primaryKey({ columns: [t.day, t.user_id] })],
);

// ---------------------------------------------------------------- 📊 voice time (activity.ts)

/** One row per player per stretch in one voice channel. */
export const voiceSegments = pgTable(
  "voice_segments",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    user_id: text().notNull(),
    channel_id: text().notNull(),
    game: text(), // the game room's game; null = Lobby or another channel
    started_at: unix("started_at").notNull(), // first seen there
    last_seen: unix("last_seen").notNull(), // last time we knew they were there
    // when they left, if we saw it happen (gateway). Null on segments that ended unseen (a bot
    // restart) or that came from the old minute-by-minute checks: those count until last_seen + 60 s.
    ended_at: unix("ended_at"),
    open: boolean().notNull().default(true),
  },
  (t) => [
    uniqueIndex("voice_segments_one_open").on(t.user_id).where(sql`${t.open}`),
    index("voice_segments_time").on(t.started_at),
  ],
);
