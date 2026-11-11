// Test 6 (plan 05, verification.md §7; architecture.md §15): a claim → post → record sequence that
// is interrupted at any step leaves either nothing done and no claim, or everything done. Never a
// claim given back with its post sent, never a post without its record. Each sequence is run in a
// fiber and interrupted before its claim, during the claim, while its post is out, and during the
// record (a statement held in the database by a trigger, or the Discord call held by the stub).
import { afterAll, beforeAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { Effect, Fiber } from "effect";
import { gameNights, games, lobbyPrompts, nightAttendance, roastBags, rooms, sessions, voiceSegments } from "../src/db/schema.js";
import { Voice, type RoomStillCreating } from "../src/voice.js";
import type { DbError } from "../src/db/db.js";
import type { DiscordError } from "../src/discord.js";
import type { AppServices } from "../src/runtime.js";
import { Spontaneous } from "../src/spontaneous.js";
import { Attendances } from "../src/attendance.js";
import { GameNight } from "../src/gamenight.js";
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
  run: () => Effect.Effect<unknown, DbError | DiscordError | RoomStillCreating, AppServices>;
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
  h.override = (c) => {
    if (c.method !== s.post.method || c.path !== s.post.path) return undefined;
    arrived();
    return gate.then(() => json({ id: "held-post" })) as unknown as Response;
  };
  return { inFlight, release, done: async () => void (h.override = null) };
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
