// Test 6 (plan 05, verification.md §7; architecture.md §15): a claim → post → record sequence that
// is interrupted at any step leaves either nothing done and no claim, or everything done. Never a
// claim given back with its post sent, never a post without its record. Each sequence is run in a
// fiber and interrupted before its claim, during the claim, while its post is out, and during the
// record (a statement held in the database by a trigger, or the Discord call held by the stub).
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Duration, Effect, Fiber } from "effect";
import { fleeting, gameNights, gameNightVotes, games, lobbyPrompts, memes as memeTable, nightAttendance, readyRooms, recaps, roastBags, rooms, sessions, voiceSegments, votes } from "../src/db/schema.js";
import { Voice, type RoomStillCreating } from "../src/voice.js";
import type { DbError } from "../src/db/db.js";
import type { DiscordError } from "../src/discord.js";
import type { AppServices } from "../src/runtime.js";
import { Spontaneous } from "../src/spontaneous.js";
import { Attendances } from "../src/attendance.js";
import { GameNight, type NightGone } from "../src/gamenight.js";
import { LateSlips } from "../src/late.js";
import { Activity } from "../src/activity.js";
import { MemeShame } from "../src/memeshame.js";
import { Cleanup, snowflakeAt } from "../src/cleanup.js";
import { LegacyPresences } from "../src/legacy.js";
import { Jobs } from "../src/jobs.js";
import * as presence from "../src/presence.js";
import * as channels from "../src/channels.js";
import { harness, json, routes, type TestDb } from "./harness.js";

const h = harness({
  tables: [lobbyPrompts, sessions, nightAttendance, voiceSegments, rooms, gameNights],
  discord: { firstId: 20000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "2026-11-10T19:00:00Z", // Tuesday 21:00 in Vilnius
});
const calls = h.calls;
let t: TestDb;
beforeAll(async () => {
  ({ t } = h);
  await t.pool.query(`CREATE OR REPLACE FUNCTION qa_hold() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$ LANGUAGE plpgsql`);
});
afterAll(() => t.pool.query("DROP FUNCTION IF EXISTS qa_hold() CASCADE"));

const DAY = "2026-11-10";
const now = () => Math.floor(Date.now() / 1000);

type Sequence = {
  /** The service call that runs the sequence. */
  run: () => Effect.Effect<unknown, DbError | DiscordError | RoomStillCreating | NightGone, AppServices>;
  /** Its claim and its record, as trigger conditions: `BEFORE <op> ON <table> … WHEN (<when>)`. */
  claim: { table: string; op: "INSERT" | "UPDATE"; when?: string };
  /** (none: the post is the last step) */
  record?: { table: string; op: "INSERT" | "UPDATE"; when?: string };
  /** Its post. */
  post: { method: string; path: string };
  setup?: () => Promise<void>;
  nothing: () => Promise<void>;
  everything: () => Promise<void>;
};

const posts = (s: Sequence) => calls.filter((c) => c.method === s.post.method && c.path === s.post.path);

async function hold(on: Sequence["claim"]) {
  await t.pool.query(`CREATE TRIGGER qa_hold BEFORE ${on.op} ON ${on.table} FOR EACH ROW ${on.when ? `WHEN (${on.when})` : ""} EXECUTE FUNCTION qa_hold()`);
  return {
    inFlight: (async () => {
      for (let i = 0; i < 300; i++) {
        const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query ILIKE '%${on.table}%'`);
        if (rows[0].n) return;
        await new Promise((ok) => setTimeout(ok, 10));
      }
      throw new Error(`the ${on.op} on ${on.table} never ran`);
    })(),
    release: () => {},
    done: () => t.pool.query(`DROP TRIGGER IF EXISTS qa_hold ON ${on.table}`),
  };
}

function holdPost(s: Sequence) {
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
  return { inFlight, release, done: async () => void (h.override = theirs) };
}

/** Run the sequence, interrupt it at `step`, let the step finish, and wait for the fiber to end. */
async function interruptAt(s: Sequence, step: "before" | "claim" | "post" | "record") {
  await s.setup?.();
  calls.length = 0;
  const held = step === "claim" ? await hold(s.claim) : step === "record" ? await hold(s.record!) : step === "post" ? holdPost(s) : null;
  const fiber = h.runtime.runFork(s.run());
  if (held) await held.inFlight;
  const stopped = h.runtime.runPromise(Fiber.interrupt(fiber));
  held?.release();
  await stopped;
  await held?.done();
}

const sequences: Record<string, Sequence> = {
  "a new game room (placeholder → channel → its id)": {
    run: () => Voice.use((v) => v.openRoom("Palworld", "🐑", {})),
    claim: { table: "rooms", op: "INSERT" },
    record: { table: "rooms", op: "UPDATE", when: "OLD.channel_id LIKE 'pending:%'" },
    post: { method: "POST", path: "/guilds/guild/channels" },
    nothing: async () => {
      expect(await t.db.select().from(rooms)).toEqual([]);
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    },
    everything: async () => {
      const [r] = await t.db.select().from(rooms);
      expect([r.game, r.channel_id.startsWith("pending:")]).toEqual(["Palworld", false]);
    },
  },
  "the Lobby question (claim → post → its message id)": {
    setup: async () => {
      await t.db.insert(voiceSegments).values([
        { user_id: "a", channel_id: "lobby", started_at: now() - 60, last_seen: now() },
        { user_id: "b", channel_id: "lobby", started_at: now() - 50, last_seen: now() },
      ]);
    },
    run: () => Spontaneous.use((s) => s.react(new Map([["a", "lobby"], ["b", "lobby"]]), now())),
    claim: { table: "lobby_prompts", op: "INSERT" },
    record: { table: "lobby_prompts", op: "UPDATE", when: "NEW.message_id IS NOT NULL" },
    post: { method: "POST", path: "/channels/lobby/messages" },
    nothing: async () => {
      expect(await t.db.select().from(lobbyPrompts)).toEqual([]);
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    },
    everything: async () => {
      const [p] = await t.db.select().from(lobbyPrompts);
      expect([p.state, !!p.message_id, p.posted_at]).toEqual(["open", true, now()]);
    },
  },
  "a late slip (the ETA → the slip → its id)": {
    setup: async () => {
      await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 600, reminded: true, message_id: "card" });
    },
    run: () => Attendances.use((a) => a.declare(DAY, "b", 15)),
    claim: { table: "night_attendance", op: "INSERT" },
    record: { table: "night_attendance", op: "UPDATE", when: "NEW.message_id IS NOT NULL" },
    post: { method: "POST", path: "/channels/gn/messages" },
    nothing: async () => {
      expect(await t.db.select().from(nightAttendance)).toEqual([]);
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    },
    everything: async () => {
      const [r] = await t.db.select().from(nightAttendance);
      expect([r.state, r.eta, !!r.message_id]).toEqual(["eta", now() + 900, true]);
    },
  },
  "a session's quiet line (claim → post → its message id)": {
    setup: async () => {
      await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: now() - 86400 });
      await t.db.insert(sessions).values({ day: DAY, game: "World of Warcraft", channel_id: "wow", started_at: now() - 200, active_since: now() - 200, who: ["a", "b"] });
    },
    run: () => Spontaneous.use((s) => s.react(new Map([["a", "wow"], ["b", "wow"]]), now())),
    claim: { table: "sessions", op: "UPDATE", when: "NEW.message_id = 'posting'" },
    record: { table: "sessions", op: "UPDATE", when: "OLD.message_id = 'posting' AND NEW.message_id IS DISTINCT FROM 'posting'" },
    post: { method: "POST", path: "/channels/gn/messages" },
    nothing: async () => {
      const [s] = await t.db.select().from(sessions);
      expect([s.message_id, s.line]).toEqual([null, null]);
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    },
    everything: async () => {
      const [s] = await t.db.select().from(sessions).where(eq(sessions.game, "World of Warcraft"));
      expect([s.message_id === null || s.message_id === "posting", s.line]).toEqual([false, "🎮 <@a> and <@b> are in **World of Warcraft** → <#wow>"]);
    },
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
      nothing: async () => {
        expect(await t.db.select().from(gameNights)).toEqual([]);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      },
      everything: async () => {
        const [n] = await t.db.select().from(gameNights);
        expect([n.day, n.stage, !!n.message_id]).toEqual([DAY, "ask", true]);
      },
    },
    "the start (its claim → the start ping → the night counted as played)": {
      setup: async () => {
        // (games and roast_bags aren't emptied between this file's tests: the cases set their own rows)
        await t.db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03", plays: 2 }).onConflictDoUpdate({ target: games.name, set: { plays: 2 } });
        await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now(), message_id: "card" });
      },
      run: () => GameNight.use((g) => Effect.flatMap(g.upcomingStarts(now() + 60), () => g.maintain)),
      claim: { table: "game_nights", op: "UPDATE", when: "NEW.reminded AND NOT OLD.reminded" },
      record: { table: "games", op: "UPDATE" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: async () => {
        expect((await t.db.select().from(gameNights))[0].reminded).toBe(false);
        expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(gameNights))[0].reminded).toBe(true);
        expect((await t.db.select().from(games).where(eq(games.name, "R.E.P.O.")))[0].plays).toBe(3);
      },
    },
    "the roast (the due roasts read → its claim → the roast)": {
      setup: async () => {
        await t.db.delete(roastBags);
        await t.db.insert(gameNights).values({ day: DAY, stage: "off", message_id: "card", roast: { who: { a: "no" }, stage: "ask" }, roast_due: now() - 60 });
      },
      run: () => GameNight.use((g) => g.dueRoasts),
      claim: { table: "game_nights", op: "UPDATE", when: "OLD.roasted_at IS NULL AND NEW.roasted_at IS NOT NULL" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: async () => {
        expect((await t.db.select().from(gameNights))[0].roasted_at).toBeNull();
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(gameNights))[0].roasted_at).toBe(now());
      },
    },
  };
}
Object.assign(sequences, nightSequences());

/** The late watcher's slip (LateSlips). */
function lateSequences(): Record<string, Sequence> {
  return {
    "the late watcher's slip (its claim → the slip → its id)": {
      setup: async () => {
        await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 900, reminded: true, message_id: "card" });
        await t.db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: now() - 1000 });
      },
      run: () => LateSlips.use((l) => l.watch),
      claim: { table: "night_attendance", op: "INSERT" },
      record: { table: "night_attendance", op: "UPDATE", when: "NEW.message_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: async () => {
        expect(await t.db.select().from(nightAttendance)).toEqual([]);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      },
      everything: async () => {
        const slips = (await t.db.select().from(nightAttendance)).filter((r) => r.message_id);
        expect(slips.map((r) => r.state)).toEqual(["late"]);
      },
    },
  };
}
Object.assign(sequences, lateSequences());

/** The sequences the phase 4 audit found without an entry. */
function auditSequences(): Record<string, Sequence> {
  // (these tables aren't emptied between this file's tests: each case clears what it uses)
  const fresh = async () => {
    for (const tbl of [recaps, votes, memeTable, roastBags, readyRooms, fleeting, gameNightVotes]) await t.db.delete(tbl);
  };
  const aMoment = Effect.sleep(Duration.millis(1)); // the job's own start, before its claim
  const quickOne = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.andThen(aMoment, e);
  const twoPlaying = () => {
    for (const u of ["b", "c"]) presence.setActivities(u, [{ type: 0, name: "World of Warcraft" }]);
  };
  const wow = () => t.db.insert(games).values({ name: "World of Warcraft", emoji: "🐉", added_at: "2026-11-03" }).onConflictDoNothing();
  const roomMade = async () => {
    const r = (await t.db.select().from(rooms)).find((x) => x.game === "World of Warcraft");
    expect([!!r, r?.channel_id.startsWith("pending:")]).toEqual([true, false]);
  };
  return {
    "the weekly recap (its claim → the recap)": {
      setup: async () => {
        await fresh();
        vi.setSystemTime(Date.parse("2026-11-09T08:05:00Z")); // Monday 10:05
        const at = Date.parse("2026-11-06T17:00:00Z") / 1000;
        await t.db.insert(voiceSegments).values([
          { user_id: "a", channel_id: "r1", game: "R.E.P.O.", started_at: at, last_seen: at + 7200, ended_at: at + 7200, open: false },
          { user_id: "b", channel_id: "r1", game: "R.E.P.O.", started_at: at, last_seen: at + 7200, ended_at: at + 7200, open: false },
        ]);
      },
      run: () => quickOne(Activity.use((a) => a.recaps)),
      claim: { table: "recaps", op: "INSERT" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: async () => {
        expect(await t.db.select().from(recaps)).toEqual([]);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(recaps)).map((r) => r.period)).toEqual(["games-week:2026-11-02"]);
      },
    },
    "the meme call-out (the day's claim → the person's claim → the call-out)": {
      setup: async () => {
        await fresh();
        for (let i = 0; i < 5; i++) {
          const day = `2026-11-0${5 - i}`;
          await t.db.insert(memeTable).values({ id: `t3_d${i}`, title: "d", image: "i", link: "l", author: "u", published: `${day}T08:00:00Z`, ingested_at: "x", post_kind: "daily", day, posted_at: `${day}T10:00:00.000Z`, channel_id: "memes", message_id: `msg${i}` });
          for (const u of ["a", "c"]) await t.db.insert(votes).values({ meme_id: `t3_d${i}`, user_id: u, kind: "lol", voted_at: `${day}T11:00:00.000Z` });
        }
        vi.setSystemTime(Date.parse("2026-11-06T17:05:00Z")); // Friday 19:05: b hasn't voted on any
      },
      run: () => quickOne(MemeShame.use((m) => m.evening)),
      claim: { table: "recaps", op: "INSERT", when: "NEW.period LIKE 'meme-shame:%'" },
      post: { method: "POST", path: "/channels/memes/messages" },
      nothing: async () => {
        expect(await t.db.select().from(recaps)).toEqual([]);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(recaps)).map((r) => r.period).sort()).toEqual(["meme-shame:2026-11-06", "meme-shamed:b:2026-11-06"]);
      },
    },
    "the 03:00 sweep (its claim → the deletes → the cleared ids)": {
      setup: async () => {
        await fresh();
        vi.setSystemTime(Date.parse("2026-11-06T01:05:00Z")); // Friday 03:05
        const card = snowflakeAt(Date.parse("2026-11-05T15:00:00Z"), 1);
        await t.db.insert(gameNights).values({ day: "2026-11-05", stage: "off", message_id: card });
        h.override = (c) => {
          if (c.path === "/users/@me") return json({ id: "bot" });
          if (c.method === "GET" && c.path.startsWith("/channels/gn/messages")) return json([{ id: card, author: { id: "bot" } }]);
          return undefined;
        };
      },
      run: () => quickOne(Cleanup.use((c) => c.nightly)),
      claim: { table: "recaps", op: "INSERT" },
      record: { table: "game_nights", op: "UPDATE", when: "OLD.message_id IS NOT NULL AND NEW.message_id IS NULL" },
      post: { method: "DELETE", path: `/channels/gn/messages/${snowflakeAt(Date.parse("2026-11-05T15:00:00Z"), 1)}` },
      nothing: async () => {
        expect(await t.db.select().from(recaps)).toEqual([]);
        expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(gameNights))[0].message_id).toBeNull();
      },
    },
    "a room got ready ahead (its claim → the room → its id)": {
      setup: async () => {
        await fresh();
        await wow();
        twoPlaying();
      },
      run: () => Spontaneous.use((s) => s.react(new Map(), now())).pipe(Effect.provideService(LegacyPresences, true)),
      claim: { table: "ready_rooms", op: "INSERT" },
      record: { table: "rooms", op: "UPDATE", when: "OLD.channel_id LIKE 'pending:%'" },
      post: { method: "POST", path: "/guilds/guild/channels" },
      nothing: async () => {
        expect(await t.db.select().from(readyRooms)).toEqual([]);
        expect(await t.db.select().from(rooms)).toEqual([]);
      },
      everything: roomMade,
    },
    "an auto-move (its claim → the room → its id)": {
      setup: async () => {
        await fresh();
        await wow();
        twoPlaying();
        await t.db.insert(voiceSegments).values([
          { user_id: "b", channel_id: "lobby", started_at: now() - 60, last_seen: now() },
          { user_id: "c", channel_id: "lobby", started_at: now() - 50, last_seen: now() },
        ]);
      },
      run: () => Spontaneous.use((s) => s.react(new Map([["b", "lobby"], ["c", "lobby"]]), now())).pipe(Effect.provideService(LegacyPresences, true)),
      claim: { table: "lobby_prompts", op: "INSERT" },
      record: { table: "rooms", op: "UPDATE", when: "OLD.channel_id LIKE 'pending:%'" },
      post: { method: "POST", path: "/guilds/guild/channels" },
      nothing: async () => {
        expect(await t.db.select().from(lobbyPrompts)).toEqual([]);
        expect(await t.db.select().from(rooms)).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(lobbyPrompts)).map((p) => p.state)).toEqual(["moved"]);
        await roomMade();
      },
    },
    "a pull-in (its claim → the move → the note)": {
      setup: async () => {
        await fresh();
        await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: now() - 600 });
      },
      run: () => Spontaneous.use((s) => s.react(new Map([["a", "lobby"], ["b", "wow"]]), now(), { user: "a", from: null, to: "lobby" })),
      claim: { table: "rooms", op: "UPDATE", when: "NEW.pulled IS DISTINCT FROM OLD.pulled" },
      record: { table: "fleeting", op: "INSERT" },
      post: { method: "PATCH", path: "/guilds/guild/members/a" },
      nothing: async () => {
        expect((await t.db.select().from(rooms))[0].pulled).toEqual([]);
        expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(rooms))[0].pulled).toEqual(["a"]);
        expect(await t.db.select().from(fleeting)).toHaveLength(1);
      },
    },
    "a pick on the Lobby question (the pick → the room → its id)": {
      setup: async () => {
        await fresh();
        await t.db.insert(lobbyPrompts).values({ created_at: now() - 60, state: "open", message_id: "q1", posted_at: now() - 60 });
      },
      run: () => Effect.flatMap(Effect.promise(() => t.db.select().from(lobbyPrompts)), ([p]) => Spontaneous.use((s) => s.answer(p.id, "a", "g", "World of Warcraft"))),
      claim: { table: "lobby_prompts", op: "UPDATE", when: "NEW.state = 'picked'" },
      record: { table: "rooms", op: "UPDATE", when: "OLD.channel_id LIKE 'pending:%'" },
      post: { method: "POST", path: "/guilds/guild/channels" },
      nothing: async () => {
        expect((await t.db.select().from(lobbyPrompts))[0].state).toBe("open");
        expect(await t.db.select().from(rooms)).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(lobbyPrompts))[0].state).toBe("picked");
        await roomMade();
      },
    },
    "a night locked in (the stage → the event → its id → the ping)": {
      setup: async () => {
        await fresh();
        await t.db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03" }).onConflictDoNothing();
        await t.db.insert(gameNights).values({ day: DAY, stage: "time", game: "R.E.P.O.", message_id: "card", stage_at: now() - 600 });
        const at = String(Date.parse("2026-11-10T20:30:00Z") / 1000); // 22:30
        for (const u of ["a", "b"]) await t.db.insert(gameNightVotes).values({ day: DAY, stage: "time", user_id: u, choice: at, voted_at: "x" });
      },
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
      nothing: async () => {
        expect((await t.db.select().from(gameNights))[0].stage).toBe("time");
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(gameNights))[0]).toMatchObject({ stage: "set", event_id: expect.any(String) });
        expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages" && c.body.content.includes("it's on!"))).toHaveLength(1);
      },
    },
    "a re-nudge (its claim → the ping → its id)": {
      setup: async () => {
        await fresh();
        await t.db.insert(gameNights).values({ day: DAY, stage: "ask", message_id: "card", stage_at: now() - 7200, started_by: "a" });
        await t.db.insert(gameNightVotes).values({ day: DAY, stage: "ask", user_id: "a", choice: "yes", voted_at: "x" });
      },
      run: () => GameNight.use((g) => g.maintain),
      claim: { table: "game_nights", op: "UPDATE", when: "NEW.renudged IS NOT NULL AND OLD.renudged IS NULL" },
      record: { table: "game_nights", op: "UPDATE", when: "NEW.nudge_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/gn/messages" },
      nothing: async () => {
        expect((await t.db.select().from(gameNights))[0]).toMatchObject({ renudged: null, nudge_id: null });
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(gameNights))[0]).toMatchObject({ renudged: "ask", nudge_id: expect.any(String) });
      },
    },
  };
}
Object.assign(sequences, auditSequences());

/** The daily meme and the meme recaps (Jobs, phase 5). */
function jobSequences(): Record<string, Sequence> {
  const fresh = async () => {
    for (const tbl of [recaps, votes, memeTable]) await t.db.delete(tbl);
  };
  const meme = (id: string, published: string) => ({ id, title: id, image: "i", link: "l", author: "u", published, ingested_at: "x", rank: 1 });
  return {
    "the daily meme (its claim → the post → its id)": {
      setup: async () => {
        await fresh();
        vi.setSystemTime(Date.parse("2026-11-10T11:00:00Z")); // after POST_HOUR_UTC
        await t.db.insert(memeTable).values(meme("t3_daily", "2026-11-09T08:00:00Z"));
      },
      run: () => Jobs.use((j) => j.postDaily),
      claim: { table: "memes", op: "UPDATE", when: "OLD.post_kind IS NULL AND NEW.post_kind IS NOT NULL" },
      record: { table: "memes", op: "UPDATE", when: "OLD.message_id IS NULL AND NEW.message_id IS NOT NULL" },
      post: { method: "POST", path: "/channels/memes/messages" },
      nothing: async () => {
        expect((await t.db.select().from(memeTable))[0]).toMatchObject({ post_kind: null, message_id: null });
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(memeTable))[0]).toMatchObject({ post_kind: "daily", message_id: expect.any(String) });
      },
    },
    "the Meme of the Week (its claim → the post)": {
      setup: async () => {
        await fresh();
        vi.setSystemTime(Date.parse("2026-11-08T18:30:00Z")); // Sunday after 18:00 UTC
        await t.db.insert(memeTable).values({ ...meme("t3_week", "2026-11-05T08:00:00Z"), post_kind: "daily", day: "2026-11-05", posted_at: "2026-11-05T10:00:00.000Z" });
        await t.db.insert(votes).values({ meme_id: "t3_week", user_id: "a", kind: "fire", voted_at: "2026-11-05T11:00:00.000Z" });
      },
      run: () => Effect.andThen(Effect.sleep(Duration.millis(1)), Jobs.use((j) => j.weeklyRecap)),
      claim: { table: "recaps", op: "INSERT" },
      post: { method: "POST", path: "/channels/memes/messages" },
      nothing: async () => {
        expect(await t.db.select().from(recaps)).toEqual([]);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      },
      everything: async () => {
        expect((await t.db.select().from(recaps)).map((r) => r.period)).toEqual(["week:2026-11-08"]);
      },
    },
  };
}
Object.assign(sequences, jobSequences());

for (const [name, s] of Object.entries(sequences)) {
  test(`${name}: interrupted before its claim, nothing is done`, async () => {
    presence._reset();
    channels._reset();
    await interruptAt(s, "before");
    await s.nothing();
  });
  for (const step of s.record ? (["claim", "post", "record"] as const) : (["claim", "post"] as const)) {
    test(`${name}: interrupted during the ${step}, everything is done, once`, async () => {
      presence._reset();
      channels._reset();
      await interruptAt(s, step);
      await s.everything();
      expect(posts(s)).toHaveLength(1);
    });
  }
}
