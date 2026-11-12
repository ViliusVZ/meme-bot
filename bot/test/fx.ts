// The Effect-native test harness (plan 05, phase 6): what test/harness.ts does, for tests written as
// `it.effect(…)`. A throwaway schema per file, the app's services fresh for every test, the outbound
// HTTP stub with per-test answers, a seeded Random, the clock, a test logger, and the recorder.
//
// A test runs its Effect through `h.provide`:
//   it.effect("…", () => Effect.gen(function* () { … }).pipe(h.provide))
// which gives it the app's services (built for this test, on the live clock: spike S7), the file's
// clock, a Random seeded from the test's name (the same sequence the old Math.random spy gave, so
// shuffles replay), and a logger that keeps every line in `h.logs` instead of printing it; at the
// end it waits for the test's background work, as a real user's next tap would.
//
// The recorder is the old harness's (test/harness.ts): every outbound request in order and the
// database when the test ends, one file per test file in test/__recordings__/.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { Clock, Duration, Effect, Layer, Logger, ManagedRuntime, Random, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { AppConfig, type AppConfigShape } from "../src/config.js";
import { appLayerFor, type AppServices } from "../src/runtime.js";
import { Background } from "../src/background.js";
import { Spontaneous } from "../src/spontaneous.js";
import { Gemini } from "../src/gemini.js";
import { configFromEnv } from "./old/legacy.js";
import type { Env } from "./old/env.js";
import { testDb, testEnv, url } from "./pg.js";
import {
  API,
  ORIGINAL,
  bodyText,
  canonical,
  hash,
  json,
  maskNow,
  raceCalls,
  seeded,
  seedOf,
  settleOrder,
  type Call,
  type Entry,
  type Full,
  type Options as OldOptions,
  type Recording,
  type Route,
  type TestDb,
} from "./harness.js";

export { json, routes, type Call, type Route, type TestDb } from "./harness.js";

export type Options = Omit<OldOptions, "clock"> & {
  /**
   * The clock the app reads. A time (ms since the epoch, or an ISO string): frozen there for each
   * test, moved only by `h.setTime`, sleeps still taking real time (the old fake Date, exactly).
   * "test": the test's own TestClock (the test drives it). None: the live clock.
   */
  clock?: number | string | "test";
};

type Runtime = ManagedRuntime.ManagedRuntime<AppServices, unknown>;

export type Harness = {
  /** The throwaway schema, through node-postgres (setup rows; the recorder reads the tables with it). */
  t: TestDb;
  /** This file's configuration, as the old `env` (testEnv and the file's own fields). */
  env: Env;
  /** This file's configuration. */
  config: AppConfigShape;
  /** Every outbound call of the current test, in order (Discord's API paths without the base URL). */
  calls: Call[];
  /** This test's own answers; reset to null before each test. */
  override: Route | null;
  /** The fetch behind the recorder: replace it to answer every outbound call yourself (reset per test). */
  fetch: typeof fetch;
  /** The current test's log lines, as the app's logfmt logger would print them. */
  logs: string[];
  /** Run a test's Effect with the app's services (see the top of this file). */
  provide: <A, E>(self: Effect.Effect<A, E, AppServices>) => Effect.Effect<A, E | StillRunning>;
  /** Move the frozen clock (files with a `clock` time). */
  setTime(at: number | string): Effect.Effect<void>;
  /** Game detection and the Gemini key for one call, as `{ ...env, PRESENCES: true, GEMINI_API_KEY: "k" }` did. */
  withConfig(change: { readonly presences?: boolean; readonly geminiApiKey?: string }): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Wait for background work (followups, panel edits) to finish, as a real user's next tap would. */
  settle: Effect.Effect<void, StillRunning, Background>;
  /** Declare a race (as in test/harness.ts; listed in STATUS.md under "Declared exceptions"). */
  race(reason: string, opts?: { mask?: Record<string, string[]>; bodies?: boolean; calls?: boolean }): void;
  /** The current test's runtime (a test that forks a service call and interrupts it). */
  runtime: Runtime;
};

/** Background work still running 10 s after a test (or after `h.settle`). */
export class StillRunning extends Schema.TaggedError<StillRunning>()("StillRunning", { left: Schema.Number }) {}

const at = (v: number | string) => (typeof v === "string" ? Date.parse(v) : v);

export function harness(o: Options = {}): Harness {
  const file = basename(expect.getState().testPath ?? "unknown");
  const h = { calls: [] as Call[], override: null, logs: [] as string[] } as unknown as Harness;
  const full = process.env.RECORD === "full";
  const recordings: Record<string, Recording> = {};
  const fulls: Record<string, Full> = {};
  let current: { calls: Entry[]; full: Full["calls"] } = { calls: [], full: [] };
  let tables: string[] = [];
  let nextId = 0;
  let nextCopyId = 0;
  let racing: { mask: Record<string, string[]>; bodies: boolean; calls: boolean } | null = null;
  let runtime: Runtime | undefined;
  let now = 0; // the frozen clock's time (files with a `clock` time)

  // ---------------------------------------------------------------- outbound HTTP
  // The recorder sits in front of whatever fetch the test has put behind it; only the outermost
  // call of a chain is recorded (a wrapper calls its inner fetch synchronously, before its first await).
  const unanswered: typeof fetch = async (input) => {
    throw new Error(`no answer for ${String(input)} (this file has no Discord stub)`);
  };
  let inner: typeof fetch = unanswered;
  let depth = 0;
  const recorder: typeof fetch = (input, init) => {
    let entry: Entry | undefined;
    if (depth === 0) {
      const req = input instanceof Request ? input : undefined;
      const href = req ? req.url : String(input);
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const text = bodyText(init?.body);
      entry = { method, url: href, hash: text === undefined ? "-" : hash(canonical(text)) };
      current.calls.push(entry);
      if (full) current.full.push({ method, url: href, body: text === undefined ? null : JSON.parse(canonical(JSON.stringify(text))) });
    }
    depth++;
    try {
      const res = inner(input, init);
      const made = entry?.method === "POST" ? entry : undefined;
      if (made)
        void Promise.resolve(res)
          .then((r) => r.clone().json() as Promise<{ id?: unknown } | null>)
          .then((d) => void (made.created = typeof d?.id === "string" ? d.id : undefined))
          .catch(() => {});
      return res;
    } finally {
      depth--;
    }
  };
  const stub: typeof fetch = async (target, init = {}) => {
    const path = String(target).replace(API, "");
    const text = bodyText(init.body);
    const c: Call = { method: init.method ?? "GET", path, body: text ? JSON.parse(text) : undefined };
    h.calls.push(c);
    const mine = h.override?.(c);
    if (mine) return mine;
    for (const r of o.discord!.routes ?? []) {
      const res = r(c);
      if (res) return res;
    }
    const id = () => String(nextId++);
    if (o.discord!.answer) return o.discord!.answer(c, id);
    // a private copy's message, looked up in the background right after the tap: its ids come from
    // their own range, so when the lookup lands doesn't shift the ids of everything else
    if (c.method === "GET" && ORIGINAL.test(c.path)) return json({ id: String(nextCopyId++) });
    return json({ id: id() });
  };
  Object.defineProperty(h, "fetch", { get: () => inner, set: (f: typeof fetch) => void (inner = f) });
  const http = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, ((input, init) => recorder(input, init)) as typeof fetch)));

  // ---------------------------------------------------------------- the clock, Random, the logger
  const live = Effect.runSync(Clock.clockWith(Effect.succeed));
  const frozen: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (d) => live.sleep(d),
  };
  const clockFor = <A, E, R>(self: Effect.Effect<A, E, R>) => (o.clock === "test" ? self : Effect.provideService(self, Clock.Clock, o.clock === undefined ? live : frozen));
  const randomFor = (name: string): Random.Random => {
    const next = seeded(seedOf(name));
    return { nextDoubleUnsafe: next, nextIntUnsafe: () => Math.floor(next() * (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1)) + Number.MIN_SAFE_INTEGER };
  };
  const logger = Logger.layer([Logger.map(Logger.formatLogFmt, (line) => void h.logs.push(line))]);

  h.settle = Effect.flatMap(Background.use((b) => b.drain(Duration.seconds(10))), (left) => (left > 0 ? Effect.fail(new StillRunning({ left })) : Effect.void));

  h.provide = <A, E>(self: Effect.Effect<A, E, AppServices>) =>
    Effect.gen(function* () {
      const rt = runtime!;
      const context = yield* Effect.promise(() => rt.context());
      const name = expect.getState().currentTestName ?? "";
      const body = Effect.tap(self, () => h.settle).pipe(Effect.provide(logger), Effect.provideService(Random.Random, randomFor(name)));
      return yield* clockFor(Effect.provideContext(body, context));
    });

  h.setTime = (v) => Effect.sync(() => void (now = at(v)));

  h.withConfig = (change) => (self) =>
    Effect.gen(function* () {
      const c = yield* AppConfig;
      const own: AppConfigShape = {
        ...c,
        presences: change.presences ?? c.presences,
        geminiApiKey: change.geminiApiKey === undefined ? c.geminiApiKey : Redacted.make(change.geminiApiKey),
      };
      // Spontaneous and Gemini hold no state of their own: this call gets its own, with that configuration
      const services = Layer.fresh(Spontaneous.layer).pipe(Layer.provideMerge(Layer.fresh(Gemini.layer)), Layer.provide(Layer.succeed(AppConfig, own)));
      return yield* Effect.provide(self, services);
    }) as never;

  h.race = (reason, opts = {}) => {
    if (!reason) throw new Error("race() needs a reason");
    racing = { mask: opts.mask ?? {}, bodies: opts.bodies ?? true, calls: opts.calls ?? true };
  };

  // ---------------------------------------------------------------- per file, per test
  const fresh = () =>
    ManagedRuntime.make(appLayerFor(h.config, { http, ...(h.t ? { db: { startupOptions: `-c search_path=${h.t.schema},public` } } : {}) })) as Runtime;

  beforeAll(async () => {
    if (o.db !== false) {
      h.t = await testDb();
      h.env = testEnv(h.t.db, o.env);
      const r = await h.t.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`);
      tables = r.rows.map((x: { table_name: string }) => x.table_name);
      await o.setup?.(h.t);
    } else h.env = testEnv({} as never, o.env);
    h.config = configFromEnv(h.env, { databaseUrl: url() });
  });
  afterAll(async () => {
    await runtime?.dispose();
    const dir = fileURLToPath(new URL("./__recordings__/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    // always written, even empty: a test file that stops recording must show up as a change
    writeFileSync(`${dir}${file.replace(/\.ts$/, ".json")}`, JSON.stringify(recordings, null, 1) + "\n");
    if (full) {
      mkdirSync(`${dir}full`, { recursive: true });
      writeFileSync(`${dir}full/${file.replace(/\.ts$/, ".json")}`, JSON.stringify(fulls, null, 1) + "\n");
    }
    await h.t?.close();
  });

  beforeEach(async () => {
    // every test starts with fresh services; the last test's runtime is closed first
    await runtime?.dispose();
    runtime = fresh();
    h.runtime = runtime;
    await runtime.context();
    if (h.t) for (const tbl of o.tables ?? []) await h.t.db.delete(tbl);
    if (h.t) await o.seed?.(h.t);
    h.calls.length = 0;
    h.logs.length = 0;
    h.override = null;
    nextId = o.discord?.firstId ?? 0;
    nextCopyId = (o.discord?.firstId ?? 0) + 700_000;
    inner = o.discord ? stub : unanswered;
    if (o.clock !== undefined && o.clock !== "test") now = at(o.clock);
    current = { calls: [], full: [] };
    racing = null;
  });
  afterEach(async () => {
    // the recording is of a finished test: let deferred work (followups, panel edits) land first
    if ((await runtime!.runPromise(Background.use((b) => b.drain(Duration.seconds(10))))) > 0) throw new Error("background work still running 10 s after the test");
    const name = expect.getState().currentTestName ?? "?";
    let key = name;
    for (let i = 2; key in recordings; i++) key = `${name} #${i}`;
    const db: Record<string, string> = {};
    const dbFull: Record<string, unknown[]> = {};
    if (tables.length) {
      const masked = (tbl: string) => (racing?.mask[tbl] ?? []).map((c) => ` - '${c}'`).join("");
      const q = tables.map((tbl) => `SELECT '${tbl}' AS tbl, (to_jsonb(r)${masked(tbl)})::text AS row FROM "${tbl}" r`).join(" UNION ALL ");
      const r = await h.t.pool.query<{ tbl: string; row: string }>(`SELECT tbl, row FROM (${q}) x ORDER BY tbl COLLATE "C", row COLLATE "C"`);
      const byTable = new Map<string, string[]>();
      for (const x of r.rows) byTable.set(x.tbl, [...(byTable.get(x.tbl) ?? []), maskNow(x.tbl, x.row)]);
      for (const [tbl, unsorted] of byTable) {
        const rows = [...unsorted].sort();
        db[tbl] = `${rows.length}:${hash(rows.join("\n"))}`;
        if (full) dbFull[tbl] = rows.map((x) => JSON.parse(x));
      }
    }
    const calls = racing ? (racing.calls ? raceCalls(current.calls, racing.bodies) : []) : settleOrder(current.calls.map((c) => `${c.method} ${c.url} ${c.hash}`));
    recordings[key] = { calls, db };
    if (full) fulls[key] = { calls: current.full, db: dbFull };
  });

  return h;
}
