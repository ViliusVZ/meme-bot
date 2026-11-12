// Test 6 (plan 05, verification.md §7; architecture.md §15): a claim → post → record sequence that
// is interrupted at any step leaves either nothing done and no claim, or everything done. Never a
// claim given back with its post sent, never a post without its record. Each sequence is run in a
// fiber and interrupted before its claim, during the claim, while its post is out, and during the
// record (a statement held in the database by a trigger, or the Discord call held by the stub).
import { expect, it } from "@effect/vitest";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Duration, Effect, Fiber } from "effect";
import { activityGuesses, fleeting, gameAliases, gameNights, gameNightVotes, games, lobbyPrompts, memes as memeTable, nightAttendance, readyRooms, recaps, roastBags, rooms, sessions, voiceSegments, votes } from "../src/db/schema.js";
import { Voice, type RoomStillCreating } from "../src/voice.js";
import { Db, type DbError } from "../src/db/db.js";
import type { DiscordError } from "../src/discord.js";
import type { AppServices } from "../src/runtime.js";
import { Spontaneous } from "../src/spontaneous.js";
import { Attendances } from "../src/attendance.js";
import { GameNight, type NightGone } from "../src/gamenight.js";
import { LateSlips } from "../src/late.js";
import { Activity } from "../src/activity.js";
import { MemeShame } from "../src/memeshame.js";
import { Cleanup, snowflakeAt } from "../src/cleanup.js";
import { Jobs } from "../src/jobs.js";
import { Presence } from "../src/presence.js";
import { Interactions } from "../src/interactions.js";
import { harness, json, routes, type TestDb } from "./fx.js";

const CLOCK = "2026-11-10T19:00:00Z"; // Tuesday 21:00 in Vilnius
const h = harness({
  tables: [lobbyPrompts, sessions, nightAttendance, voiceSegments, rooms, gameNights],
  discord: { firstId: 20000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: CLOCK,
});
const calls = h.calls;
let t: TestDb;
beforeAll(async () => {
  ({ t } = h);
  await t.pool.query(`CREATE OR REPLACE FUNCTION qa_hold() RETURNS trigger AS $$ BEGIN PERFORM set_config('application_name', 'qa_hold ' || current_schema(), true); PERFORM pg_sleep(0.3); RETURN NEW; END $$ LANGUAGE plpgsql`);
});
afterAll(() => t.pool.query("DROP FUNCTION IF EXISTS qa_hold() CASCADE"));

// the frozen clock's time, as this file reads it (the harness sets it back to CLOCK before each test)
let clock = Date.parse(CLOCK);
beforeEach(() => void (clock = Date.parse(CLOCK)));
const setTime = (ms: number) => Effect.andThen(Effect.sync(() => void (clock = ms)), h.setTime(ms));

const DAY = "2026-11-10";
const now = () => Math.floor(clock / 1000);

type Step = Effect.Effect<void, DbError, AppServices>;
type Sequence = {
  /** The service call that runs the sequence. */
  run: () => Effect.Effect<unknown, DbError | DiscordError | RoomStillCreating | NightGone, AppServices>;
  /** Its claim and its record, as trigger conditions: `BEFORE <op> ON <table> … WHEN (<when>)`. */
  claim: { table: string; op: "INSERT" | "UPDATE"; when?: string };
  /** (none: the post is the last step) */
  record?: { table: string; op: "INSERT" | "UPDATE"; when?: string };
  /** Its post. */
  post: { method: string; path: string };
  setup?: () => Step;
  nothing: () => Step;
  everything: () => Step;
};

const posts = (s: Sequence) => calls.filter((c) => c.method === s.post.method && c.path === s.post.path);

type Held = { inFlight: Effect.Effect<void>; release: () => void; done: Effect.Effect<unknown> };

const hold = (on: Sequence["claim"]) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => t.pool.query(`CREATE TRIGGER qa_hold BEFORE ${on.op} ON ${on.table} FOR EACH ROW ${on.when ? `WHEN (${on.when})` : ""} EXECUTE FUNCTION qa_hold()`));
    const held: Held = {
      inFlight: Effect.gen(function* () {
        for (let i = 0; i < 300; i++) {
          const { rows } = yield* Effect.promise(() => t.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND application_name = $1 AND query ILIKE '%${on.table}%'`, [`qa_hold ${t.schema}`]));
          if (rows[0].n) return;
          yield* Effect.sleep(Duration.millis(10));
        }
        return yield* Effect.die(new Error(`the ${on.op} on ${on.table} never ran`));
      }),
      release: () => {},
      done: Effect.promise(() => t.pool.query(`DROP TRIGGER IF EXISTS qa_hold ON ${on.table}`)),
    };
    return held;
  });

function holdPost(s: Sequence): Held {
  let arrived!: () => void;
  let release!: () => void;
  const inFlight = new Promise<void>((ok) => (arrived = ok));
  const gate = new Promise<void>((ok) => (release = ok));
  // (a case's own answers, set in its setup, still answer everything else)
  const theirs = h.override;
  h.override = (c) => {
    if (c.method !== s.post.method || c.path !== s.post.path) return theirs?.(c);
    arrived();
    return gate.then(() => json({ id: "held-post" })) as unknown as Response;
  };
  return { inFlight: Effect.promise(() => inFlight), release, done: Effect.sync(() => void (h.override = theirs)) };
}

/** Run the sequence, interrupt it at `step`, let the step finish, and wait for the fiber to end. */
function interruptAt(s: Sequence, step: "before" | "claim" | "post" | "record") {
  return Effect.gen(function* () {
    if (s.setup) yield* s.setup();
    calls.length = 0;
    const held = step === "claim" ? yield* hold(s.claim) : step === "record" ? yield* hold(s.record!) : step === "post" ? holdPost(s) : null;
    // (in this test's fiber: the frozen clock and the rest of what h.provide gives come along)
    const fiber = yield* Effect.forkChild(s.run(), { startImmediately: true });
    if (held) yield* held.inFlight;
    const stopped = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
    held?.release();
    yield* Fiber.join(stopped);
    if (held) yield* held.done;
  });
}

const sequences: Record<string, Sequence> = {
  "a new game room (placeholder → channel → its id)": {
    run: () => Voice.use((v) => v.openRoom("Palworld", "🐑", {})),
    claim: { table: "rooms", op: "INSERT" },
    record: { table: "rooms", op: "UPDATE", when: "OLD.channel_id LIKE 'pending:%'" },
    post: { method: "POST", path: "/guilds/guild/channels" },
    nothing: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        expect(yield* db.select().from(rooms)).toEqual([]);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      }),
    everything: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        const [r] = yield* db.select().from(rooms);
        expect([r.game, r.channel_id.startsWith("pending:")]).toEqual(["Palworld", false]);
      }),
  },
  "the Lobby question (claim → post → its message id)": {
    setup: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(voiceSegments).values([
          { user_id: "a", channel_id: "lobby", started_at: now() - 60, last_seen: now() },
          { user_id: "b", channel_id: "lobby", started_at: now() - 50, last_seen: now() },
        ]);
      }),
    run: () => Spontaneous.use((s) => s.react(new Map([["a", "lobby"], ["b", "lobby"]]), now())),
    claim: { table: "lobby_prompts", op: "INSERT" },
    record: { table: "lobby_prompts", op: "UPDATE", when: "NEW.message_id IS NOT NULL" },
    post: { method: "POST", path: "/channels/lobby/messages" },
    nothing: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        expect(yield* db.select().from(lobbyPrompts)).toEqual([]);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      }),
    everything: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        const [p] = yield* db.select().from(lobbyPrompts);
        expect([p.state, !!p.message_id, p.posted_at]).toEqual(["open", true, now()]);
      }),
  },
  "a late slip (the ETA → the slip → its id)": {
    setup: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 600, reminded: true, message_id: "card" });
      }),
    run: () => Attendances.use((a) => a.declare(DAY, "b", 15)),
    claim: { table: "night_attendance", op: "INSERT" },
    record: { table: "night_attendance", op: "UPDATE", when: "NEW.message_id IS NOT NULL" },
    post: { method: "POST", path: "/channels/gn/messages" },
    nothing: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        expect(yield* db.select().from(nightAttendance)).toEqual([]);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      }),
    everything: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        const [r] = yield* db.select().from(nightAttendance);
        expect([r.state, r.eta, !!r.message_id]).toEqual(["eta", now() + 900, true]);
      }),
  },
  "a session's quiet line (claim → post → its message id)": {
    setup: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: now() - 86400 });
        yield* db.insert(sessions).values({ day: DAY, game: "World of Warcraft", channel_id: "wow", started_at: now() - 200, active_since: now() - 200, who: ["a", "b"] });
      }),
    run: () => Spontaneous.use((s) => s.react(new Map([["a", "wow"], ["b", "wow"]]), now())),
    claim: { table: "sessions", op: "UPDATE", when: "NEW.message_id = 'posting'" },
    record: { table: "sessions", op: "UPDATE", when: "OLD.message_id = 'posting' AND NEW.message_id IS DISTINCT FROM 'posting'" },
    post: { method: "POST", path: "/channels/gn/messages" },
    nothing: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        const [s] = yield* db.select().from(sessions);
        expect([s.message_id, s.line]).toEqual([null, null]);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      }),
    everything: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        const [s] = yield* db.select().from(sessions).where(eq(sessions.game, "World of Warcraft"));
        expect([s.message_id === null || s.message_id === "posting", s.line]).toEqual([false, "🎮 <@a> and <@b> are in **World of Warcraft** → <#wow>"]);
      }),
  },
};

/** Game night's sequences (gamenight 5/5). */
function nightSequences(): Record<string, Sequence> {
  return {
    "the game-night card (the day's claim → the card → its message id)": {
      run: () => GameNight.use((g) => g.startNight(undefined, true)),
      claim: { table: "game_nights", op: "INSERT" },
      record: { table: "game_nights", op: "UPDATE", when: "OLD.message_id IS NULL AND NEW.message_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(gameNights)).toEqual([]);
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          const [n] = yield* db.select().from(gameNights);
          expect([n.day, n.stage, !!n.message_id]).toEqual([DAY, "ask", true]);
        }),
    },
    "the start (its claim → the start ping → the night counted as played)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          // (games and roast_bags aren't emptied between this file's tests: the cases set their own rows)
          yield* db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03", plays: 2 }).onConflictDoUpdate({ target: games.name, set: { plays: 2 } });
          yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now(), message_id: "card" });
        }),
      run: () => GameNight.use((g) => Effect.flatMap(g.upcomingStarts(now() + 60), () => g.maintain)),
      claim: { table: "game_nights", op: "UPDATE", when: "NEW.reminded AND NOT OLD.reminded" },
      record: { table: "games", op: "UPDATE" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0].reminded).toBe(false);
          expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0].reminded).toBe(true);
          expect((yield* db.select().from(games).where(eq(games.name, "R.E.P.O.")))[0].plays).toBe(3);
        }),
    },
    "the roast (the due roasts read → its claim → the roast)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.delete(roastBags);
          yield* db.insert(gameNights).values({ day: DAY, stage: "off", message_id: "card", roast: { who: { a: "no" }, stage: "ask" }, roast_due: now() - 60 });
        }),
      run: () => GameNight.use((g) => g.dueRoasts),
      claim: { table: "game_nights", op: "UPDATE", when: "OLD.roasted_at IS NULL AND NEW.roasted_at IS NOT NULL" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0].roasted_at).toBeNull();
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0].roasted_at).toBe(now());
        }),
    },
  };
}
Object.assign(sequences, nightSequences());

/** The late watcher's slip (LateSlips). */
function lateSequences(): Record<string, Sequence> {
  return {
    "the late watcher's slip (its claim → the slip → its id)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 900, reminded: true, message_id: "card" });
          yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: now() - 1000 });
        }),
      run: () => LateSlips.use((l) => l.watch),
      claim: { table: "night_attendance", op: "INSERT" },
      record: { table: "night_attendance", op: "UPDATE", when: "NEW.message_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(nightAttendance)).toEqual([]);
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          const slips = (yield* db.select().from(nightAttendance)).filter((r) => r.message_id);
          expect(slips.map((r) => r.state)).toEqual(["late"]);
        }),
    },
  };
}
Object.assign(sequences, lateSequences());

/** The sequences the phase 4 audit found without an entry. */
function auditSequences(): Record<string, Sequence> {
  // (these tables aren't emptied between this file's tests: each case clears what it uses)
  const fresh = Effect.gen(function* () {
    const db = yield* Db;
    for (const tbl of [recaps, votes, memeTable, roastBags, readyRooms, fleeting, gameNightVotes]) yield* db.delete(tbl);
  });
  const aMoment = Effect.sleep(Duration.millis(1)); // the job's own start, before its claim
  const quickOne = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.andThen(aMoment, e);
  const twoPlaying = Effect.forEach(["b", "c"], (u) => Presence.use((p) => p.setActivities(u, [{ type: 0, name: "World of Warcraft" }])), { discard: true });
  const wow = Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(games).values({ name: "World of Warcraft", emoji: "🐉", added_at: "2026-11-03" }).onConflictDoNothing();
  });
  const roomMade = () =>
    Effect.gen(function* () {
      const db = yield* Db;
      const r = (yield* db.select().from(rooms)).find((x) => x.game === "World of Warcraft");
      expect([!!r, r?.channel_id.startsWith("pending:")]).toEqual([true, false]);
    });
  return {
    "the weekly recap (its claim → the recap)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          yield* setTime(Date.parse("2026-11-09T08:05:00Z")); // Monday 10:05
          const at = Date.parse("2026-11-06T17:00:00Z") / 1000;
          yield* db.insert(voiceSegments).values([
            { user_id: "a", channel_id: "r1", game: "R.E.P.O.", started_at: at, last_seen: at + 7200, ended_at: at + 7200, open: false },
            { user_id: "b", channel_id: "r1", game: "R.E.P.O.", started_at: at, last_seen: at + 7200, ended_at: at + 7200, open: false },
          ]);
        }),
      run: () => quickOne(Activity.use((a) => a.recaps)),
      claim: { table: "recaps", op: "INSERT" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(recaps)).toEqual([]);
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(recaps)).map((r) => r.period)).toEqual(["games-week:2026-11-02"]);
        }),
    },
    "the meme call-out (the day's claim → the person's claim → the call-out)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          for (let i = 0; i < 5; i++) {
            const day = `2026-11-0${5 - i}`;
            yield* db.insert(memeTable).values({ id: `t3_d${i}`, title: "d", image: "i", link: "l", author: "u", published: `${day}T08:00:00Z`, ingested_at: "x", post_kind: "daily", day, posted_at: `${day}T10:00:00.000Z`, channel_id: "memes", message_id: `msg${i}` });
            for (const u of ["a", "c"]) yield* db.insert(votes).values({ meme_id: `t3_d${i}`, user_id: u, kind: "lol", voted_at: `${day}T11:00:00.000Z` });
          }
          yield* setTime(Date.parse("2026-11-06T17:05:00Z")); // Friday 19:05: b hasn't voted on any
        }),
      run: () => quickOne(MemeShame.use((m) => m.evening)),
      claim: { table: "recaps", op: "INSERT", when: "NEW.period LIKE 'meme-shame:%'" },
      post: { method: "POST", path: "/channels/memes/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(recaps)).toEqual([]);
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(recaps)).map((r) => r.period).sort()).toEqual(["meme-shame:2026-11-06", "meme-shamed:b:2026-11-06"]);
        }),
    },
    "the 03:00 sweep (its claim → the deletes → the cleared ids)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          yield* setTime(Date.parse("2026-11-06T01:05:00Z")); // Friday 03:05
          const card = snowflakeAt(Date.parse("2026-11-05T15:00:00Z"), 1);
          yield* db.insert(gameNights).values({ day: "2026-11-05", stage: "off", message_id: card });
          h.override = (c) => {
            if (c.path === "/users/@me") return json({ id: "bot" });
            if (c.method === "GET" && c.path.startsWith("/channels/gn/messages")) return json([{ id: card, author: { id: "bot" } }]);
            return undefined;
          };
        }),
      run: () => quickOne(Cleanup.use((c) => c.nightly)),
      claim: { table: "recaps", op: "INSERT" },
      record: { table: "game_nights", op: "UPDATE", when: "OLD.message_id IS NOT NULL AND NEW.message_id IS NULL" },
      post: { method: "DELETE", path: `/channels/gn/messages/${snowflakeAt(Date.parse("2026-11-05T15:00:00Z"), 1)}` },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(recaps)).toEqual([]);
          expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0].message_id).toBeNull();
        }),
    },
    "a room got ready ahead (its claim → the room → its id)": {
      setup: () =>
        Effect.gen(function* () {
          yield* fresh;
          yield* wow;
          yield* twoPlaying;
        }),
      run: () => Spontaneous.use((s) => s.react(new Map(), now())).pipe(h.withConfig({ presences: true })),
      claim: { table: "ready_rooms", op: "INSERT" },
      record: { table: "rooms", op: "UPDATE", when: "OLD.channel_id LIKE 'pending:%'" },
      post: { method: "POST", path: "/guilds/guild/channels" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(readyRooms)).toEqual([]);
          expect(yield* db.select().from(rooms)).toEqual([]);
        }),
      everything: roomMade,
    },
    "an auto-move (its claim → the room → its id)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          yield* wow;
          yield* twoPlaying;
          yield* db.insert(voiceSegments).values([
            { user_id: "b", channel_id: "lobby", started_at: now() - 60, last_seen: now() },
            { user_id: "c", channel_id: "lobby", started_at: now() - 50, last_seen: now() },
          ]);
        }),
      run: () => Spontaneous.use((s) => s.react(new Map([["b", "lobby"], ["c", "lobby"]]), now())).pipe(h.withConfig({ presences: true })),
      claim: { table: "lobby_prompts", op: "INSERT" },
      record: { table: "rooms", op: "UPDATE", when: "OLD.channel_id LIKE 'pending:%'" },
      post: { method: "POST", path: "/guilds/guild/channels" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(lobbyPrompts)).toEqual([]);
          expect(yield* db.select().from(rooms)).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(lobbyPrompts)).map((p) => p.state)).toEqual(["moved"]);
          yield* roomMade();
        }),
    },
    "a pull-in (its claim → the move → the note)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: now() - 600 });
        }),
      run: () => Spontaneous.use((s) => s.react(new Map([["a", "lobby"], ["b", "wow"]]), now(), { user: "a", from: null, to: "lobby" })),
      claim: { table: "rooms", op: "UPDATE", when: "NEW.pulled IS DISTINCT FROM OLD.pulled" },
      record: { table: "fleeting", op: "INSERT" },
      post: { method: "PATCH", path: "/guilds/guild/members/a" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(rooms))[0].pulled).toEqual([]);
          expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(rooms))[0].pulled).toEqual(["a"]);
          expect(yield* db.select().from(fleeting)).toHaveLength(1);
        }),
    },
    "a pick on the Lobby question (the pick → the room → its id)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          yield* db.insert(lobbyPrompts).values({ created_at: now() - 60, state: "open", message_id: "q1", posted_at: now() - 60 });
        }),
      run: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          const [p] = yield* db.select().from(lobbyPrompts);
          return yield* Spontaneous.use((s) => s.answer(p.id, "a", "g", "World of Warcraft"));
        }),
      claim: { table: "lobby_prompts", op: "UPDATE", when: "NEW.state = 'picked'" },
      record: { table: "rooms", op: "UPDATE", when: "OLD.channel_id LIKE 'pending:%'" },
      post: { method: "POST", path: "/guilds/guild/channels" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(lobbyPrompts))[0].state).toBe("open");
          expect(yield* db.select().from(rooms)).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(lobbyPrompts))[0].state).toBe("picked");
          yield* roomMade();
        }),
    },
    "a night locked in (the stage → the event → its id → the ping)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          yield* db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03" }).onConflictDoNothing();
          yield* db.insert(gameNights).values({ day: DAY, stage: "time", game: "R.E.P.O.", message_id: "card", stage_at: now() - 600 });
          const at = String(Date.parse("2026-11-10T20:30:00Z") / 1000); // 22:30
          for (const u of ["a", "b"]) yield* db.insert(gameNightVotes).values({ day: DAY, stage: "time", user_id: u, choice: at, voted_at: "x" });
        }),
      // (the tap's slow work runs right in the tap here, so lock-in is part of what's interrupted)
      run: () =>
        Effect.flatMap(Effect.context<AppServices>(), (ctx) =>
          GameNight.use((g) =>
            g.act(DAY, "c", "time", String(Date.parse("2026-11-10T20:30:00Z") / 1000), (later) => later.pipe(Effect.orElseSucceed(() => undefined), Effect.asVoid, Effect.provideContext(ctx))),
          ),
        ),
      claim: { table: "game_nights", op: "UPDATE", when: "NEW.stage = 'set' AND OLD.stage = 'time'" },
      record: { table: "game_nights", op: "UPDATE", when: "NEW.event_id IS NOT NULL AND OLD.event_id IS NULL" },
      post: { method: "POST", path: "/guilds/guild/scheduled-events" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0].stage).toBe("time");
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0]).toMatchObject({ stage: "set", event_id: expect.any(String) });
          expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages" && c.body.content.includes("it's on!"))).toHaveLength(1);
        }),
    },
    "a re-nudge (its claim → the ping → its id)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          yield* db.insert(gameNights).values({ day: DAY, stage: "ask", message_id: "card", stage_at: now() - 7200, started_by: "a" });
          yield* db.insert(gameNightVotes).values({ day: DAY, stage: "ask", user_id: "a", choice: "yes", voted_at: "x" });
        }),
      run: () => GameNight.use((g) => g.maintain),
      claim: { table: "game_nights", op: "UPDATE", when: "NEW.renudged IS NOT NULL AND OLD.renudged IS NULL" },
      record: { table: "game_nights", op: "UPDATE", when: "NEW.nudge_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0]).toMatchObject({ renudged: null, nudge_id: null });
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0]).toMatchObject({ renudged: "ask", nudge_id: expect.any(String) });
        }),
    },
  };
}
Object.assign(sequences, auditSequences());

/** The daily meme and the meme recaps (Jobs, phase 5). */
function jobSequences(): Record<string, Sequence> {
  const fresh = Effect.gen(function* () {
    const db = yield* Db;
    for (const tbl of [recaps, votes, memeTable]) yield* db.delete(tbl);
  });
  const meme = (id: string, published: string) => ({ id, title: id, image: "i", link: "l", author: "u", published, ingested_at: "x", rank: 1 });
  return {
    "the daily meme (its claim → the post → its id)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          yield* setTime(Date.parse("2026-11-10T11:00:00Z")); // after POST_HOUR_UTC
          yield* db.insert(memeTable).values(meme("t3_daily", "2026-11-09T08:00:00Z"));
        }),
      run: () => Jobs.use((j) => j.postDaily),
      claim: { table: "memes", op: "UPDATE", when: "OLD.post_kind IS NULL AND NEW.post_kind IS NOT NULL" },
      record: { table: "memes", op: "UPDATE", when: "OLD.message_id IS NULL AND NEW.message_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/memes/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(memeTable))[0]).toMatchObject({ post_kind: null, message_id: null });
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(memeTable))[0]).toMatchObject({ post_kind: "daily", message_id: expect.any(String) });
        }),
    },
    "the Meme of the Week (its claim → the post)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* fresh;
          yield* setTime(Date.parse("2026-11-08T18:30:00Z")); // Sunday after 18:00 UTC
          yield* db.insert(memeTable).values({ ...meme("t3_week", "2026-11-05T08:00:00Z"), post_kind: "daily", day: "2026-11-05", posted_at: "2026-11-05T10:00:00.000Z" });
          yield* db.insert(votes).values({ meme_id: "t3_week", user_id: "a", kind: "fire", voted_at: "2026-11-05T11:00:00.000Z" });
        }),
      run: () => Effect.andThen(Effect.sleep(Duration.millis(1)), Jobs.use((j) => j.weeklyRecap)),
      claim: { table: "recaps", op: "INSERT" },
      post: { method: "POST", path: "/channels/memes/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(recaps)).toEqual([]);
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(recaps)).map((r) => r.period)).toEqual(["week:2026-11-08"]);
        }),
    },
  };
}
Object.assign(sequences, jobSequences());

/** From the phase 7 walk of architecture §15 (STATUS: interruption audit): the Lobby question itself. */
function lobbySequences(): Record<string, Sequence> {
  return {
    "the Lobby question (its claim → the question → its id)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          // two of us in the Lobby for a minute already: past the 30 s, so this reaction asks
          yield* db.insert(voiceSegments).values([
            { user_id: "a", channel_id: "lobby", game: null, started_at: now() - 60, last_seen: now(), open: true },
            { user_id: "b", channel_id: "lobby", game: null, started_at: now() - 60, last_seen: now(), open: true },
          ]);
        }),
      run: () => Spontaneous.use((s) => s.react(new Map([["a", "lobby"], ["b", "lobby"], ["c", null]]), now())),
      claim: { table: "lobby_prompts", op: "INSERT" },
      record: { table: "lobby_prompts", op: "UPDATE", when: "NEW.message_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/lobby/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(lobbyPrompts)).toEqual([]);
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(lobbyPrompts)).map((p) => [p.state, !!p.message_id])).toEqual([["open", true]]);
        }),
    },
    "the Lobby question closed when the gathering ends (its claim → the message gone)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.insert(lobbyPrompts).values({ created_at: now() - 120, state: "open", message_id: "q1", posted_at: now() - 120, current: true });
        }),
      run: () => Spontaneous.use((s) => s.react(new Map([["a", null], ["b", null], ["c", null]]), now())), // everyone left the Lobby
      claim: { table: "lobby_prompts", op: "UPDATE", when: "NEW.state = 'expired'" },
      post: { method: "DELETE", path: "/channels/lobby/messages/q1" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(lobbyPrompts))[0].state).toBe("open");
          expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(lobbyPrompts))[0].state).toBe("expired");
        }),
    },
    "an ETA on a late slip (the ETA → the slip → its id)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 900, reminded: true, message_id: "card" });
        }),
      run: () => Attendances.use((a) => a.declare(DAY, "a", 15)),
      claim: { table: "night_attendance", op: "INSERT" },
      record: { table: "night_attendance", op: "UPDATE", when: "NEW.message_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect(yield* db.select().from(nightAttendance)).toEqual([]);
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(nightAttendance)).map((r) => [r.state, !!r.message_id])).toEqual([["eta", true]]);
        }),
    },
    "a hold resumed (its claim → the re-ask ping → its id)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.delete(gameNightVotes); // (not emptied between this file's tests)
          yield* db.insert(gameNights).values({ day: DAY, stage: "ask", message_id: "card", stage_at: now() - 3 * 3600, maybes: 1, paused_until: now() - 60 });
          for (const [u, c] of [["a", "yes"], ["b", "yes"], ["c", "maybe"]]) yield* db.insert(gameNightVotes).values({ day: DAY, stage: "ask", user_id: u, choice: c, voted_at: "x" });
        }),
      run: () => GameNight.use((g) => g.maintain),
      claim: { table: "game_nights", op: "UPDATE", when: "NEW.paused_until IS NULL AND OLD.paused_until IS NOT NULL" },
      record: { table: "game_nights", op: "UPDATE", when: "NEW.nudge_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0].paused_until).not.toBeNull();
          expect(calls.filter((c) => c.method === "POST")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(gameNights))[0]).toMatchObject({ paused_until: null, nudge_id: expect.any(String) });
          expect((yield* db.select().from(gameNightVotes)).map((v) => v.choice).sort()).toEqual(["yes", "yes"]);
        }),
    },
  };
}

// (every test starts on a fresh runtime, so the old presence/channels resets have nothing left to do)
function define(name: string, s: Sequence) {
  it.effect(`${name}: interrupted before its claim, nothing is done`, () =>
    Effect.gen(function* () {
      yield* interruptAt(s, "before");
      yield* s.nothing();
    }).pipe(h.provide),
  );
  for (const step of s.record ? (["claim", "post", "record"] as const) : (["claim", "post"] as const)) {
    it.effect(`${name}: interrupted during the ${step}, everything is done, once`, () =>
      Effect.gen(function* () {
        yield* interruptAt(s, step);
        yield* s.everything();
        expect(posts(s)).toHaveLength(1);
      }).pipe(h.provide),
    );
  }
}
for (const [name, s] of Object.entries(sequences)) define(name, s);

it.effect("a name Gemini placed: interrupted while its answer is written, the alias is written too (phase 5 audit)", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.delete(gameAliases);
    yield* db.delete(activityGuesses);
    yield* db.insert(games).values({ name: "World of Warcraft", emoji: "🐉", added_at: "2026-11-03" }).onConflictDoNothing();
    const theirs = h.override;
    h.override = (c) =>
      c.path.includes("generativelanguage.googleapis.com") ? json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ game: "World of Warcraft" }) }] } }] }) : theirs?.(c);
    yield* Effect.gen(function* () {
      const held = yield* hold({ table: "activity_guesses", op: "UPDATE", when: "NEW.answered" });
      const fiber = yield* Effect.forkChild(Spontaneous.use((s) => s.learn(["World of Warcraft: Forever"], now())).pipe(h.withConfig({ presences: true, geminiApiKey: "k" })), { startImmediately: true });
      yield* held.inFlight;
      const stopped = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
      held.release();
      yield* Fiber.join(stopped);
      yield* held.done;
    }).pipe(Effect.ensuring(Effect.sync(() => void (h.override = theirs))));
    expect((yield* db.select().from(activityGuesses)).map((g) => [g.activity, g.answered])).toEqual([["World of Warcraft: Forever", true]]);
    expect((yield* db.select().from(gameAliases)).map((a) => [a.activity, a.game])).toEqual([["World of Warcraft: Forever", "World of Warcraft"]]);
  }).pipe(h.provide),
);

// (after every earlier test: these leave rows in tables this file doesn't empty between tests, and
// the earlier tests' recordings mustn't see them)
for (const [name, s] of Object.entries(lobbySequences())) define(name, s);

// ---------------------------------------------------------------- the phase 7 interruption audit
// (after every earlier test, for the same reason as above)

/** The protected regions §15's walk found without an entry: the two deadline warnings, a session wrapped up. */
function auditSequences7(): Record<string, Sequence> {
  const night = (stage: "ask" | "game", votes: ReadonlyArray<[string, string]>) =>
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.delete(gameNightVotes); // (not emptied between this file's tests)
      // voting opened 2 h 40 min ago: 20 minutes to the 3-hour deadline, inside the last 30
      yield* db.insert(gameNights).values({ day: DAY, stage, message_id: "card", stage_at: now() - 9600, started_by: "a" });
      for (const [u, c] of votes) yield* db.insert(gameNightVotes).values({ day: DAY, stage, user_id: u, choice: c, voted_at: "x" });
    });
  const warning = (stage: "ask" | "game", votes: ReadonlyArray<[string, string]>): Sequence => ({
    setup: () => night(stage, votes),
    run: () => GameNight.use((g) => g.maintain),
    claim: { table: "game_nights", op: "UPDATE", when: "NEW.warned IS NOT NULL AND OLD.warned IS NULL" },
    record: { table: "game_nights", op: "UPDATE", when: "NEW.nudge_id IS NOT NULL" },
    post: { method: "POST", path: "/channels/gn/messages" },
    nothing: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        expect((yield* db.select().from(gameNights))[0]).toMatchObject({ warned: null, nudge_id: null });
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      }),
    everything: () =>
      Effect.gen(function* () {
        const db = yield* Db;
        expect((yield* db.select().from(gameNights))[0]).toMatchObject({ warned: stage, nudge_id: expect.any(String) });
      }),
  });
  return {
    "the last call (its claim → the ping → its id)": warning("ask", [["a", "yes"], ["b", "yes"]]),
    "a split's last call (its claim → the ping → its id)": warning("game", [["a", "R.E.P.O."], ["b", "Phasmophobia"], ["c", "Palworld"]]),
    "an unplanned session wrapped up (its claim → the count → the line)": {
      setup: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.delete(sessions);
          yield* db.insert(games).values({ name: "Valheim", emoji: "🪓", added_at: "2026-11-03", plays: 0 }).onConflictDoNothing();
          yield* db.update(games).set({ plays: 0 }).where(eq(games.name, "Valheim"));
          // its room is gone, and the two of us were together for 15 minutes
          yield* db.insert(sessions).values({ day: DAY, game: "Valheim", channel_id: "gone", started_at: now() - 1200, active_since: now() - 900, who: ["a", "b"], message_id: "line-v", line: "🎮 <@a> and <@b> are in **Valheim**" });
        }),
      run: () => Spontaneous.use((s) => s.minute(now())),
      claim: { table: "sessions", op: "UPDATE", when: "NEW.finished AND NOT OLD.finished" },
      record: { table: "sessions", op: "UPDATE", when: "NEW.line IS DISTINCT FROM OLD.line" },
      post: { method: "PATCH", path: "/channels/gn/messages/line-v" },
      nothing: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          expect((yield* db.select().from(sessions))[0]).toMatchObject({ finished: false, counted: false });
          expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
        }),
      everything: () =>
        Effect.gen(function* () {
          const db = yield* Db;
          const [s] = yield* db.select().from(sessions);
          expect([s.finished, s.counted, s.line]).toEqual([true, true, "🎮 <@a> and <@b> played **Valheim** for 15 min"]);
          expect((yield* db.select().from(games).where(eq(games.name, "Valheim")))[0].plays).toBe(1);
        }),
    },
  };
}
for (const [name, s] of Object.entries(auditSequences7())) define(name, s);

it.effect("an unplanned session counted: interrupted during its claim, the play is counted too (phase 7 audit)", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.delete(sessions);
    yield* db.insert(games).values({ name: "Valheim", emoji: "🪓", added_at: "2026-11-03", plays: 0 }).onConflictDoNothing();
    const plays = (yield* db.select().from(games).where(eq(games.name, "Valheim")))[0].plays;
    yield* db.insert(rooms).values({ channel_id: "val", game: "Valheim", created_at: now() - 86400 }).onConflictDoNothing();
    // together for 11 minutes already, its line posted: the next look counts it
    yield* db.insert(sessions).values({ day: DAY, game: "Valheim", channel_id: "val", started_at: now() - 700, active_since: now() - 660, who: ["a", "b"], message_id: "line-c", line: "x" });
    const held = yield* hold({ table: "sessions", op: "UPDATE", when: "NEW.counted AND NOT OLD.counted" });
    const fiber = yield* Effect.forkChild(Spontaneous.use((s) => s.react(new Map([["a", "val"], ["b", "val"]]), now())), { startImmediately: true });
    yield* held.inFlight;
    const stopped = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
    yield* Fiber.join(stopped);
    yield* held.done;
    expect((yield* db.select().from(sessions))[0].counted).toBe(true);
    expect((yield* db.select().from(games).where(eq(games.name, "Valheim")))[0].plays).toBe(plays + 1);
  }).pipe(h.provide),
);

it.effect("/meme: interrupted during its claim, the reply's message id is still recorded (phase 7 audit)", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    for (const tbl of [recaps, votes, memeTable]) yield* db.delete(tbl);
    yield* db.insert(memeTable).values({ id: "t3_ask", title: "t3_ask", image: "i", link: "l", author: "u", published: "2026-11-07T08:00:00Z", ingested_at: "x", rank: 1 });
    const held = yield* hold({ table: "memes", op: "UPDATE", when: "OLD.post_kind IS NULL AND NEW.post_kind IS NOT NULL" });
    const i = { type: 2, token: "tok", data: { name: "meme" }, member: { user: { id: "a", username: "a" } } };
    const fiber = yield* Effect.forkChild(Interactions.use((x) => x.handle(i)), { startImmediately: true });
    yield* held.inFlight;
    const stopped = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
    yield* Fiber.join(stopped);
    yield* held.done;
    yield* h.settle; // the record runs after the reply
    expect((yield* db.select().from(memeTable))[0]).toMatchObject({ post_kind: "request", requested_by: "a", message_id: expect.any(String) });
  }).pipe(h.provide),
);
