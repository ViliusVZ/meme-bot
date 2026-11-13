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
  bytea,
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
  started_by: text(), // player who ran /playtoday; null = the daily schedule (17:00, 14:00 on weekends)
  stage_at: unix("stage_at"), // when the current stage began (time presets, re-nudges), or its round after a 🤔 hold
  renudged: text(), // stage whose one-off "still waiting on you" ping went out
  conflict: text(), // last start/leave-by clash we pinged about (one ping per clash)
  event_end: unix("event_end"), // the Discord event's current end, pushed back while people still play (null once it's over)
  warned: text(), // stage whose "30 min left to vote" warning went out
  roast: jsonb().$type<Roast>(), // who sank the night and how (roasts.ts), set when it's called off
  roast_due: unix("roast_due"), // when to post the roast (held until morning if it happened at night)
  roasted_at: unix("roasted_at"), // posted (claimed) at
  planned_start: unix("planned_start"), // the locked-in start, before anyone said they'd be late
  maybes: integer().notNull().default(0), // 🤔 how many times "are we playing?" was put on hold (max 2)
  paused_until: unix("paused_until"), // on hold for a 🤔 maybe until then; the unsure answer again after
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

/**
 * 🔒 Private copies of a card ("only you can see this" replies, panels.ts). Discord lets us edit one
 * for 15 minutes after the tap that made or last updated it, so they follow the card while that lasts.
 */
export const panels = pgTable(
  "panels",
  {
    message_id: text().primaryKey(), // the ephemeral message
    card: text().notNull(), // what it's a copy of: gn:<day> | poll:<id>
    user_id: text().notNull(),
    token: text().notNull(), // the latest tap's interaction token: edits the copy via @original
    tapped_at: unix("tapped_at").notNull(), // the token works for 15 minutes from here
  },
  (t) => [index("panels_card").on(t.card)],
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
  pool: text().primaryKey(), // solo | duo | trio | memes: one shared bag per family
  queue: jsonb().notNull().$type<unknown[]>(), // the lines still to come this cycle
  last_line: text(), // the line drawn last (a fresh cycle never opens with it)
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Small app-wide settings, key → JSON (😴 the planning snooze, say). */
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull().$type<unknown>(),
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

// ---------------------------------------------------------------- game rooms (voice.ts)

export const rooms = pgTable("rooms", {
  channel_id: text().primaryKey(), // the voice channel the bot opened ("pending:<game>" while creating)
  game: citext("game").notNull(),
  day: text(), // game night that opened it, if any
  created_by: text(),
  created_at: unix("created_at").notNull(),
  last_seen: unix("last_seen"), // last time someone was in it
  archived_at: unix("archived_at"), // moved to 🗄️ Recent games; deleted 3 days later
  pulled: jsonb().notNull().$type<string[]>().default([]), // pulled in from the Lobby (once each, spontaneous.ts)
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
    roast: text(), // 🔥 the line they got for bailing after the start (kept, so re-renders don't reroll it)
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

// ---------------------------------------------------------------- 🎮 spontaneous play (spontaneous.ts)

/**
 * The Lobby question ("🎮 Playing something?"), one per gathering (two or more of us in the Lobby).
 * The open gathering's row is `current`; at most one can be, so a restart or a racing check can't
 * ask twice. It stays until the gathering breaks up, which is how a dismissed or expired question
 * stays quiet for the rest of that gathering.
 */
export const lobbyPrompts = pgTable(
  "lobby_prompts",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    current: boolean().notNull().default(true),
    created_at: unix("created_at").notNull(),
    // open | picked | dismissed | expired | failed | undone (silenced by ↩) | moved (auto-move)
    state: text().notNull().$type<"open" | "picked" | "dismissed" | "expired" | "failed" | "undone" | "moved">(),
    message_id: text(), // the question in the Lobby's chat (null: not posted)
    posted_at: unix("posted_at"),
    by: text(), // who answered
    game: citext("game"),
    activity: text(), // a game two of them were playing that we don't know by that name (learnable)
    ended_at: unix("ended_at"),
  },
  (t) => [uniqueIndex("lobby_prompts_current").on(t.current).where(sql`${t.current}`)],
);

/**
 * An unplanned session: two or more of us in a game room that isn't serving a planned night that
 * has started. One per game per day (the key is what stops a second line or a second count).
 */
export const sessions = pgTable(
  "sessions",
  {
    day: text().notNull(), // local day it started
    game: citext("game").notNull(),
    channel_id: text().notNull(),
    started_at: unix("started_at").notNull(),
    active_since: unix("active_since"), // two or more are in since then (null: fewer right now)
    idle_since: unix("idle_since"), // fewer than two since then
    together_secs: integer().notNull().default(0), // time with two or more, before active_since
    who: jsonb().notNull().$type<string[]>().default([]), // everyone who took part
    message_id: text(), // the quiet line in #game-night ("posting" while it's being sent)
    line: text(), // what the line says now (edited only when this changes)
    counted: boolean().notNull().default(false), // counts as a game night (and a play of the game)
    finished: boolean().notNull().default(false), // wrapped up: the line says how long it went
    absorbed: boolean().notNull().default(false), // the day's planned night for the same game took it over
  },
  (t) => [primaryKey({ columns: [t.day, t.game] })],
);

/**
 * ⚔️ An early-bird card (plan 07): the gathering's row in lobby_prompts is the night's card instead of
 * the question ("you're early: want the room already?"). Its night, and the start it shows (it follows
 * the night's start until it's answered, the gathering breaks up, or the night starts or is off).
 */
export const nightCards = pgTable("night_cards", {
  prompt_id: integer().primaryKey(), // lobby_prompts.id
  day: text().notNull(), // the night's day
  start_at: unix("start_at").notNull(), // the start the card shows
});

/** Bot messages that remove themselves (the "pulled you in" notes): deleted once due, restarts or not. */
export const fleeting = pgTable("fleeting", {
  message_id: text().primaryKey(),
  channel_id: text().notNull(),
  delete_at: unix("delete_at").notNull(),
});

/** What Discord calls a game ("Playing …") → our game, learned with one tap. */
export const gameAliases = pgTable("game_aliases", {
  activity: citext("activity").primaryKey(),
  game: citext("game").notNull(),
  added_by: text(),
});

/** Rooms opened ahead because two of us were seen playing the game: once per game per day. */
export const readyRooms = pgTable(
  "ready_rooms",
  {
    day: text().notNull(),
    game: citext("game").notNull(),
    at: unix("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.game] })],
);

/**
 * 🧠 What Gemini said a Discord game name is (spontaneous.ts): asked once per name, in the
 * background. `game` null with `answered` = not one of ours; not answered = ask again after an hour.
 */
export const activityGuesses = pgTable("activity_guesses", {
  activity: citext("activity").primaryKey(),
  game: citext("game"),
  answered: boolean().notNull().default(false),
  at: unix("at").notNull(),
});

// ---------------------------------------------------------------- ⚔️ WoW: Forever news (news.ts)

/** One Blizzard forum topic with staff posts: seen once, judged once, posted at most once. */
export const newsItems = pgTable("news_items", {
  topic_id: integer().primaryKey(), // the forum topic (several staff posts can share one)
  title: text().notNull(),
  link: text().notNull(), // the staff post that brought it to us
  excerpt: text().notNull().default(""),
  section: text(), // the forum section it's in ("WoW: Forever General Discussion"), when we could tell
  published_at: unix("published_at").notNull(),
  seen_at: unix("seen_at").notNull(),
  // new (waiting to be judged) | post (judged news, waiting its turn) | skip | old (there before us) | posted
  state: text().notNull().$type<"new" | "post" | "skip" | "old" | "posted">(),
  summary: text(), // Gemini's one line, if it gave one
  last_post: integer().notNull().default(0), // the newest staff post number we've seen in the topic
  told_post: integer().notNull().default(0), // the newest one the channel has heard about
  message_id: text(), // ours in the news channel ("posting" while it's being sent)
  posted_at: unix("posted_at"),
  updated_day: text(), // the last day we said "updated" about it (once a day at most)
});

// ---------------------------------------------------------------- 🔊 the bot's voice (botvoice.ts)

/**
 * Every line the bot has spoken, as audio (WebM Opus, tens of kilobytes): made once per text and
 * voice, kept for good (deploys, backups), so a line already said plays even if the speech engine
 * is gone. `key` is a hash of the voice and the text.
 */
export const voiceClips = pgTable("voice_clips", {
  key: text().primaryKey(),
  voice: text().notNull(),
  text: text().notNull(),
  audio: bytea().notNull(),
  engine: text().notNull(), // edge | gemini
  created_at: unix("created_at").notNull(),
});

/** 🐦 The lone early bird: the bot dropped in on one of us waiting alone, once per person per night. */
export const loneBirds = pgTable(
  "lone_birds",
  {
    day: text().notNull(),
    user_id: text().notNull(),
    at: unix("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.user_id] })],
);
