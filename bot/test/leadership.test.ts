// Test 11 (plan 05, verification.md §7; architecture.md §13): of two copies on one database exactly one
// leads; when its lock connection is killed its term ends, everything in the term stops, and the
// other copy takes over. Real database and clock (the lock is Postgres's); stand-ins for what a term
// runs, so each copy's term can be watched starting and stopping.
import { expect, test } from "vitest";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { Reactivity } from "effect/reactivity";
import pg from "pg";
import { Leadership } from "../src/leadership.js";
import { Lifecycle } from "../src/lifecycle.js";
import { Live } from "../src/live.js";
import { Ticker } from "../src/scheduler.js";
import { Gateway } from "../src/gateway.js";
import { AppConfig } from "../src/config.js";
import { configFromEnv } from "./env.js";
import { testEnv, url } from "./pg.js";

const LEADER_LOCK = 4_242_002;

/** One copy of the bot, as far as leadership goes: what its terms ran, and whether it leads. */
function copy(name: string, log: string[]) {
  const record = (what: string) => Effect.sync(() => void log.push(`${name} ${what}`));
  const running = (what: string) => Effect.acquireRelease(record(`${what} on`), () => record(`${what} off`));
  const layer = Leadership.layer.pipe(
    Layer.provideMerge(Lifecycle.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AppConfig, { ...configFromEnv(testEnv({} as never), { databaseUrl: url() }), appName: `qa-leader-${name}` }),
        Reactivity.layer,
        Layer.succeed(Live, Live.of({ watch: Effect.as(running("live"), { resync: Effect.void }) })),
        Layer.succeed(Ticker, Ticker.of({ sinceTick: Effect.succeed(null), run: () => Effect.andThen(running("clock"), Effect.never) })),
        Layer.succeed(Gateway, Gateway.of({ hold: () => running("gateway") })),
      ),
    ),
  );
  const rt = ManagedRuntime.make(layer);
  const fiber = rt.runFork(Leadership.use((l) => l.lead()));
  return {
    leads: () => rt.runPromise(Lifecycle.use((l) => l.leader)),
    stop: async () => {
      await rt.runPromise(Fiber.interrupt(fiber));
      await rt.dispose();
    },
  };
}

const until = async (cond: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return false;
};

test("exactly one copy leads; a killed lock connection ends its term, and the other takes over", { timeout: 30_000 }, async () => {
  const log: string[] = [];
  const admin = new pg.Client({ connectionString: url() });
  await admin.connect();
  const a = copy("a", log);
  const b = copy("b", log);
  try {
    expect(await until(async () => (await a.leads()) || (await b.leads()), 5000)).toBe(true);
    await new Promise((ok) => setTimeout(ok, 1500)); // the other has asked again in the meantime
    const [first, second] = (await a.leads()) ? [a, b] : [b, a];
    expect([await first.leads(), await second.leads()]).toEqual([true, false]);
    const firstName = first === a ? "a" : "b";
    const secondName = first === a ? "b" : "a";
    expect(log.filter((l) => l.startsWith(secondName))).toEqual([]); // the other copy runs nothing
    expect(log.filter((l) => l.startsWith(firstName)).sort()).toEqual([`${firstName} clock on`, `${firstName} gateway on`, `${firstName} live on`]);

    // the leader's lock connection dies (as when its database connection is cut)
    const { rows } = await admin.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted", [LEADER_LOCK]);
    expect(rows).toHaveLength(1);
    expect(await until(async () => !(await first.leads()), 8000)).toBe(true); // noticed within one ping (5 s)
    expect(log.filter((l) => l.startsWith(firstName) && l.endsWith("off")).sort()).toEqual([`${firstName} clock off`, `${firstName} gateway off`, `${firstName} live off`]);
    expect(await until(() => second.leads(), 5000)).toBe(true);
    expect(log.filter((l) => l.startsWith(secondName)).sort()).toEqual([`${secondName} clock on`, `${secondName} gateway on`, `${secondName} live on`]);
  } finally {
    await a.stop();
    await b.stop();
    await admin.end();
  }
  // stopped: nobody holds the lock
  const check = new pg.Client({ connectionString: url() });
  await check.connect();
  const { rows } = await check.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted", [LEADER_LOCK]);
  await check.end();
  expect(rows[0].n).toBe(0);
});

test("a term ends in today's order: /health stops saying leader, then the gateway closes, then the clock and live voice stop", { timeout: 30_000 }, async () => {
  const log: string[] = [];
  // stand-ins that note, as each part stops, whether /health still says this copy leads
  const part = (what: string) =>
    Effect.map(Lifecycle, (l) => Effect.acquireRelease(Effect.void, () => Effect.flatMap(l.leader, (leads) => Effect.sync(() => void log.push(`${what} off, leader ${leads}`)))));
  const stands = Layer.mergeAll(
    Layer.effect(Live, Effect.map(part("live"), (p) => Live.of({ watch: Effect.as(p, { resync: Effect.void }) }))),
    Layer.effect(Ticker, Effect.map(part("clock"), (p) => Ticker.of({ sinceTick: Effect.succeed(null), run: () => Effect.andThen(p, Effect.never) }))),
    Layer.effect(Gateway, Effect.map(part("gateway"), (p) => Gateway.of({ hold: () => p }))),
  );
  const layer = Leadership.layer.pipe(
    Layer.provideMerge(stands),
    Layer.provideMerge(Lifecycle.layer),
    Layer.provide(Layer.mergeAll(Layer.succeed(AppConfig, { ...configFromEnv(testEnv({} as never), { databaseUrl: url() }), appName: "qa-leader-order" }), Reactivity.layer)),
  );
  const rt = ManagedRuntime.make(layer);
  const admin = new pg.Client({ connectionString: url() });
  await admin.connect();
  const fiber = rt.runFork(Leadership.use((l) => l.lead()));
  try {
    expect(await until(() => rt.runPromise(Lifecycle.use((l) => l.leader)), 5000)).toBe(true);
    await new Promise((ok) => setTimeout(ok, 300)); // the clock's fiber has started
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted", [LEADER_LOCK]);
    expect(await until(async () => log.length === 3, 8000)).toBe(true);
    expect(log[0]).toBe("gateway off, leader false");
    expect([...log.slice(1)].sort()).toEqual(["clock off, leader false", "live off, leader false"]);
  } finally {
    await rt.runPromise(Fiber.interrupt(fiber));
    await rt.dispose();
    await admin.end();
  }
});
