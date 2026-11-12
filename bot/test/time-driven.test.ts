// Test group 15 (plan 05, verification.md §7): time-driven behaviour that only live QA could check
// before, now under TestClock, on the real services and database: a start on the exact second, the
// Lobby question after 30 s, a private copy let go after 14 minutes, alert throttling over 3 hours,
// the Reddit refill every 6 hours, the gateway-down alert after 5 minutes.
import { expect, it } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { gameNights, games, lobbyPrompts, panels as panelTable, recaps, settings } from "../src/db/schema.js";
import { GameNight } from "../src/gamenight.js";
import { Nights } from "../src/nights.js";
import { Live } from "../src/live.js";
import { Presence } from "../src/presence.js";
import { Panels } from "../src/panels.js";
import { Alerts } from "../src/alerts.js";
import { Reddit } from "../src/reddit.js";
import { Cleanup } from "../src/cleanup.js";
import { MemeShame } from "../src/memeshame.js";
import { Jobs } from "../src/jobs.js";
import { harness, json, routes } from "./fx.js";

const h = harness({
  tables: [lobbyPrompts, gameNights, panelTable, settings, recaps],
  discord: { firstId: 90000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "test",
});

const T0 = Date.parse("2026-11-10T17:00:00Z"); // Tuesday 19:00 in Vilnius
const sec = (ms: number) => Math.floor(ms / 1000);
/** Let the database and the stub answer (real I/O, on the live clock). */
const io = TestClock.withLive(Effect.sleep(Duration.millis(150)));
/** Move the test clock to `ms`, then let what that woke up do its I/O. */
const to = (ms: number) => Effect.andThen(TestClock.setTime(ms), io);
const posts = (path: string) => h.calls.filter((c) => c.method === "POST" && c.path === path);

it.effect("a night starts on the exact second: its room 10 s early, the ping on the dot", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    yield* Effect.promise(() => h.t.db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03", plays: 0 }).onConflictDoNothing());
    yield* Effect.promise(() => h.t.db.insert(gameNights).values({ day: "2026-11-10", stage: "set", game: "R.E.P.O.", start_at: sec(T0) + 60, message_id: "card" }));
    const n = (yield* Nights.use((x) => x.get("2026-11-10")))!;
    const start = yield* Effect.forkChild(GameNight.use((g) => g.startOnTime(n)));
    yield* io;
    yield* to(T0 + 49_900);
    expect(posts("/guilds/guild/channels")).toEqual([]); // no room yet
    yield* to(T0 + 50_000);
    expect(posts("/guilds/guild/channels")).toHaveLength(1); // the room, 10 s before the start
    yield* to(T0 + 59_900);
    expect(posts("/channels/gn/messages")).toEqual([]);
    yield* to(T0 + 60_000);
    expect(posts("/channels/gn/messages")).toHaveLength(1); // the ping, on the second
    expect(yield* Fiber.join(start)).toBe(true);
  }).pipe(h.provide),
);

it.effect("two of us in the Lobby: the question comes after 30 s, not before", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    yield* Live.use((l) => l.watch);
    yield* Presence.use((p) => p.snapshot([]));
    yield* io;
    yield* Presence.use((p) => p.snapshot([
      { user_id: "a", channel_id: "lobby" },
      { user_id: "b", channel_id: "lobby" },
    ]));
    yield* io;
    yield* to(T0 + 29_000);
    expect(posts("/channels/lobby/messages")).toEqual([]);
    yield* to(T0 + 31_000);
    expect(posts("/channels/lobby/messages")).toHaveLength(1);
  }).pipe(Effect.scoped, h.provide),
);

it.effect("a private copy follows its card for 14 minutes after the last tap, then it's let go", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const panels = yield* Panels;
    const edits = () => h.calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/messages/@original"));
    yield* panels.track("gn:2026-11-10", "a", "tok", "m1");
    const render = () => Effect.succeed({ flags: 0, content: "the card" });
    yield* TestClock.setTime(T0 + 14 * 60_000 - 1000);
    yield* panels.sync("gn:2026-11-10", render);
    expect(edits()).toHaveLength(1); // still followed
    yield* TestClock.setTime(T0 + 14 * 60_000 + 1000);
    yield* panels.sync("gn:2026-11-10", render);
    expect(edits()).toHaveLength(1); // let go: not edited again
    expect(yield* Effect.promise(() => h.t.db.select().from(panelTable))).toEqual([]);
  }).pipe(h.provide),
);

it.effect("the same problem within 3 hours is counted, not re-sent; after 3 hours it's sent with the count", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const alerts = yield* Alerts;
    yield* alerts.setOwner("owner");
    const dms = () => h.calls.filter((c) => c.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(c.path)).map((c) => String(c.body?.content));
    yield* alerts.failed("posting the card", new Error("boom"));
    yield* alerts.settle;
    yield* TestClock.setTime(T0 + 3600_000);
    yield* alerts.failed("posting the card", new Error("boom"));
    yield* alerts.settle;
    expect(dms()).toHaveLength(1); // counted, not sent
    yield* TestClock.setTime(T0 + 3 * 3600_000 + 1000);
    yield* alerts.failed("posting the card", new Error("boom"));
    yield* alerts.settle;
    expect(dms()).toHaveLength(2);
    expect(dms()[1]).toContain("1 more time since the last DM about it");
  }).pipe(h.provide),
);

const FEED = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_a</id><title>A meme</title><link href="https://reddit.com/r/memes/a"/><author><name>u</name></author><published>2026-11-10T10:00:00Z</published><content type="html">&lt;img src="https://i.redd.it/a.png"&gt;</content></entry></feed>`;

it.effect("Reddit is fetched again 6 hours after the last good refill, and not before", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    let fetched = 0;
    h.fetch = (async (url: string) => (String(url).includes("reddit.com") ? (fetched++, new Response(FEED, { status: 200 })) : json({ id: "1" }))) as typeof fetch;
    const reddit = yield* Reddit;
    const idle = Effect.gen(function* () {
      for (let i = 0; i < 100 && (yield* reddit.refilling); i++) yield* io;
    });
    expect(yield* reddit.maybeRefill).toEqual({ refilling: true });
    yield* idle;
    yield* TestClock.setTime(T0 + 6 * 3600_000 - 1000);
    expect(yield* reddit.maybeRefill).toEqual({});
    yield* TestClock.setTime(T0 + 6 * 3600_000 + 1000);
    expect(yield* reddit.maybeRefill).toEqual({ refilling: true });
    yield* idle;
    expect(fetched).toBe(2);
  }).pipe(h.provide),
);

it.effect("the gateway down for 5 minutes is worth one DM, not before, and once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const alerts = yield* Alerts;
    yield* alerts.setOwner("owner");
    expect(yield* alerts.watchGateway).toEqual({}); // down since now
    yield* TestClock.setTime(T0 + 5 * 60_000 - 1000);
    expect(yield* alerts.watchGateway).toEqual({});
    yield* TestClock.setTime(T0 + 5 * 60_000);
    expect(yield* alerts.watchGateway).toEqual({ gatewayDown: 5 });
    yield* TestClock.setTime(T0 + 20 * 60_000);
    expect(yield* alerts.watchGateway).toEqual({}); // once per outage
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- what the forced soak can't force (README: proven here)

it.effect("the 03:00 sweep runs once a night: not at 02:59, once at 03:00, not again, not after a restart", () =>
  Effect.gen(function* () {
    h.override = (c) => (c.method === "GET" && c.path.startsWith("/channels/gn/messages") ? json([]) : undefined);
    const claims = () => Effect.promise(() => h.t.pool.query("SELECT period FROM recaps WHERE period LIKE 'cleanup%'").then((r) => r.rows.map((x) => x.period)));
    yield* TestClock.setTime(Date.parse("2026-11-11T00:59:00Z")); // 02:59 in Vilnius
    expect(yield* Cleanup.use((c) => c.nightly)).toEqual({});
    yield* TestClock.setTime(Date.parse("2026-11-11T01:00:00Z")); // 03:00
    expect(yield* Cleanup.use((c) => c.nightly)).toEqual({ deleted: 0, kept: 0 });
    expect((yield* claims()).length).toBe(1);
    yield* TestClock.setTime(Date.parse("2026-11-11T01:01:00Z"));
    expect(yield* Cleanup.use((c) => c.nightly)).toEqual({});
    // a restart: the services built again from scratch; the night's claim is in the database
    expect(yield* Cleanup.use((c) => c.nightly).pipe(Effect.provide(Layer.fresh(Cleanup.layer)))).toEqual({});
    expect((yield* claims()).length).toBe(1);
  }).pipe(h.provide),
);

it.effect("the 19:00 meme-shame call-out runs once a day: not at 18:59, once at 19:00, not again, not after a restart", () =>
  Effect.gen(function* () {
    const claims = () => Effect.promise(() => h.t.pool.query("SELECT period FROM recaps WHERE period = 'meme-shame:2026-11-11'").then((r) => r.rows.length));
    yield* TestClock.setTime(Date.parse("2026-11-11T16:59:00Z")); // 18:59 in Vilnius
    yield* MemeShame.use((m) => m.evening);
    expect(yield* claims()).toBe(0);
    yield* TestClock.setTime(Date.parse("2026-11-11T17:00:00Z")); // 19:00
    yield* MemeShame.use((m) => m.evening);
    expect(yield* claims()).toBe(1);
    yield* MemeShame.use((m) => m.evening);
    yield* MemeShame.use((m) => m.evening).pipe(Effect.provide(Layer.fresh(MemeShame.layer)));
    expect(yield* claims()).toBe(1);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- test 16: a job that hangs

it.effect("a job that hangs is cut off after 60 s and reported once; the jobs after it still run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-11T10:00:00Z")); // 12:00 in Vilnius: no daily poll or call-out due
    yield* Alerts.use((a) => a.setOwner("owner"));
    h.override = (c) => (c.method === "GET" && c.path.startsWith("/channels/gn/messages") ? json([]) : undefined); // the day's sweep: nothing to sweep
    const dms = () => h.calls.filter((c) => c.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(c.path) && String(c.body?.content).includes("🚨"));
    // the spontaneous job reads the Lobby questions: another connection holds their table
    const lock = yield* Effect.acquireRelease(
      Effect.promise(() => h.t.pool.connect().then(async (c) => (await c.query("BEGIN; LOCK TABLE lobby_prompts IN ACCESS EXCLUSIVE MODE"), c))),
      (c) => Effect.promise(() => c.query("ROLLBACK").then(() => c.release())),
    );
    const pid = yield* Effect.promise(() => lock.query("SELECT pg_backend_pid() AS pid").then((r) => r.rows[0].pid as number));
    // (only what this lock holds up: other test runs may share the Postgres)
    const waiting = () => Effect.promise(() => h.t.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]).then((r) => r.rows[0].n as number));
    const minute = Effect.gen(function* () {
      const run = yield* Effect.forkChild(Jobs.use((j) => j.minute));
      for (let i = 0; i < 100 && (yield* waiting()) === 0; i++) yield* io;
      expect(yield* waiting()).toBe(1); // stuck on the lock
      yield* to((yield* Clock.currentTimeMillis) + 59_000);
      expect(run.pollUnsafe()).toBeUndefined(); // not cut off before its minute is up
      yield* to((yield* Clock.currentTimeMillis) + 1000);
      return yield* Fiber.join(run);
    });
    const first = yield* minute;
    expect(first.spontaneous).toEqual({ error: expect.stringContaining("the “spontaneous” job took over 1m and was cut off") });
    expect(first).toHaveProperty("recaps"); // the jobs after it ran
    expect(first).toHaveProperty("gateway");
    expect(yield* waiting()).toBe(0); // its query was given up, not left waiting
    yield* Alerts.use((a) => a.settle);
    expect(dms()).toHaveLength(1);
    expect(String(dms()[0].body?.content)).toContain("the “spontaneous” job");
    // still stuck the next minute: cut off again, counted, not DMed again
    const second = yield* minute;
    expect(second.spontaneous).toEqual({ error: expect.stringContaining("cut off") });
    yield* Alerts.use((a) => a.settle);
    expect(dms()).toHaveLength(1);
    void lock;
  }).pipe(Effect.scoped, h.provide),
);
