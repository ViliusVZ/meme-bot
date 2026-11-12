// The one shared test setup (plan 05, verification.md §4): a throwaway schema, table cleanup, the
// Discord stub with per-test overrides, the fixed clock, a seeded Math.random, and the recorder.
//
// The recorder writes what the bot *did* in each test, independent of what the test asserts:
// every outbound HTTP request in order (method, full URL, a hash of the body), and the database
// when the test ends (per table, the row count and a hash of all rows). One file per test file in
// test/__recordings__/, committed; a test that behaves differently shows up in `git status`.
// RECORD=full also writes the bodies and rows themselves to test/__recordings__/full/ (ignored),
// to see *what* differs when a hash does.
import { createHash, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Env } from "./old/env.js";
import { drain } from "./old/background.js";
import { install, configFromEnv, onRestart, sticky } from "./old/legacy.js";
import { makeRuntime } from "./old/runtime.js";
import { testDb, testEnv, url } from "./pg.js";

export type Call = { method: string; path: string; body: any };
export type TestDb = Awaited<ReturnType<typeof testDb>>;
/** Answer a Discord call yourself: return a Response, or undefined to fall through. */
export type Route = (c: Call) => Response | undefined;

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** Routes several test files answer the same way. */
export const routes = {
  /** Nobody is in voice (Discord: Unknown Voice State). */
  noVoiceState: ((c) => (c.path.includes("/voice-states/") ? json({ message: "Unknown Voice State", code: 10065 }, 404) : undefined)) as Route,
  /** The guild has only the Lobby. */
  lobbyOnly: ((c) => (c.path.endsWith("/channels") && c.method === "GET" ? json([{ id: "lobby", type: 2, parent_id: "voice", position: 0, name: "Lobby" }]) : undefined)) as Route,
  /** GET /channels/<id> finds the channel. */
  channelExists: ((c) => (c.method === "GET" && /^\/channels\/\d+$/.test(c.path) ? json({ id: c.path.split("/")[2] }) : undefined)) as Route,
};

export type Options = {
  /** A throwaway schema with the migrations applied (default true). */
  db?: boolean;
  /** Emptied before each test, in this order. */
  tables?: PgTable[];
  /** Runs once after the schema is made. */
  setup?: (t: TestDb) => Promise<unknown>;
  /** Runs before each test, after the tables are emptied. */
  seed?: (t: TestDb) => Promise<unknown>;
  /** Fake Date, set to this before each test (ms since the epoch, or an ISO string). */
  clock?: number | string;
  /** The Discord stub: ids handed out from `firstId`, `routes` tried in order after the test's override. */
  discord?: { firstId: number; routes?: Route[]; answer?: (c: Call, id: () => string) => Response };
  /** Config fields for this file's env. */
  env?: Partial<Env>;
};

export const API = "https://discord.com/api/v10";

/**
 * JITTER=1: every stubbed Discord answer and every query is delayed by 0–4 ms, at random. A test
 * whose recording changes under jitter depends on timing, which the migration will change; such a
 * test is fixed (it waits for its background work, or declares its race) before it is trusted.
 */
const jitter = process.env.JITTER === "1";
const pause = () => new Promise((ok) => setTimeout(ok, randomInt(5)));

export type Harness = {
  t: TestDb;
  env: Env;
  /** Every Discord call of the current test, in order. */
  calls: Call[];
  /** This test's own answers; reset to null before each test. */
  override: Route | null;
  /** The app's runtime for this file (a test that forks a service call and interrupts it). */
  /** The app's runtime for this test (fresh each test; a restart mid-test builds a new one). */
  runtime: ReturnType<typeof makeRuntime>;
  /**
   * Declare that this test races on purpose (several callers at once, one wins), so which one wins
   * isn't fixed, nor how many calls it takes (two may both post, then the loser deletes its copy).
   * What doesn't depend on the winner is still recorded: a create the bot itself deletes again in
   * the same test is dropped together with its delete, ids in URLs are masked, the calls are
   * sorted, and the database is hashed with only the named winner-dependent columns masked
   * (`bodies: false` also drops body hashes, for bodies that name the winner; `calls: false` drops
   * the calls, for a race whose number of calls depends on timing). Give the reason;
   * each use is listed in STATUS.md under "Declared exceptions".
   */
  race(reason: string, opts?: { mask?: Record<string, string[]>; bodies?: boolean; calls?: boolean }): void;
  /** Wait for background work (followups, panel edits) to finish, as a real user's next tap would. */
  settle(): Promise<void>;
};

/**
 * Unordered call groups (verification.md §2a): places where the bot sends several calls at once,
 * so their order isn't behaviour. Each is a run of consecutive calls matching the pattern, put in
 * URL order before recording; the sort is stable, so two edits of the same copy keep their order.
 * Every group is listed in STATUS.md under "Declared exceptions".
 */
const UNORDERED: { name: string; pattern: RegExp }[] = [
  // panels.ts push(): every live private copy of a card or poll is re-rendered and edited at once
  { name: "panel copies", pattern: /^PATCH https:\/\/discord\.com\/api\/v10\/webhooks\/[^/]+\/[^/]+\/messages\/@original / },
];
const urlOf = (call: string) => call.split(" ")[1];
/** The look-up of a private copy's message (interactions.ts / panels.ts, `originalMessage`). */
export const ORIGINAL = /^\/webhooks\/[^/]+\/[^/]+\/messages\/@original$/;
/**
 * Background reads (also declared in STATUS.md): after a tap, the copy's message is looked up in
 * the background (a GET with no body) while the tap's own work goes on, so where the read lands
 * among the other calls is timing. These reads are recorded as their own list, in their order,
 * after the other calls; everything they lead to (the panels row, later edits) is still recorded.
 */
const BACKGROUND_READ = /^GET https:\/\/discord\.com\/api\/v10\/webhooks\/[^/]+\/[^/]+\/messages\/@original -$/;
export function settleOrder(all: string[]): string[] {
  const calls = all.filter((c) => !BACKGROUND_READ.test(c));
  const reads = all.filter((c) => BACKGROUND_READ.test(c));
  const out: string[] = [];
  for (let i = 0; i < calls.length; ) {
    const g = UNORDERED.find((u) => u.pattern.test(calls[i]));
    if (!g) {
      out.push(calls[i++]);
      continue;
    }
    let j = i;
    while (j < calls.length && g.pattern.test(calls[j])) j++;
    out.push(...calls.slice(i, j).sort((a, b) => (urlOf(a) < urlOf(b) ? -1 : urlOf(a) > urlOf(b) ? 1 : 0)));
    i = j;
  }
  return reads.length ? [...out, "-- background reads --", ...reads] : out;
}

export type Entry = { method: string; url: string; hash: string; created?: string };
/** A declared race: drop creates the bot deleted again itself, mask ids, sort. */
export function raceCalls(calls: Entry[], bodies: boolean): string[] {
  const gone = new Set<number>();
  calls.forEach((c, i) => {
    if (c.method !== "DELETE") return;
    const id = c.url.split("/").pop();
    const made = calls.findIndex((x, j) => j < i && !gone.has(j) && x.created === id);
    if (made >= 0) gone.add(made).add(i);
  });
  return calls
    .filter((_, i) => !gone.has(i))
    .map((c) => `${c.method} ${c.url.replace(/\b\d{3,}\b/g, "<id>")} ${bodies ? c.hash : "<body>"}`)
    .sort();
}

/** A body as text, whatever form fetch was given it in. */
export function bodyText(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (body instanceof URLSearchParams) return body.toString();
  return `[${(body as object).constructor?.name ?? typeof body}]`;
}

/**
 * Key order is not behaviour: hash JSON with its keys sorted. Nor are stack frames (an alert DM
 * quotes the error's stack, whose "at …" lines depend on timing and on the code's shape): they are
 * dropped from every string before hashing; the error's own message line stays.
 */
export function canonical(text: string | undefined): string {
  if (text === undefined) return "";
  const frames = /\n[ \t]+at [^\n]*/g;
  try {
    return JSON.stringify(JSON.parse(text), (_k, v) =>
      typeof v === "string" ? v.replace(frames, "") : v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
    );
  } catch {
    return text;
  }
}
export const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** A small seeded generator (mulberry32), so shuffles are the same on every run. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const seedOf = (name: string) => parseInt(createHash("sha1").update(name).digest("hex").slice(0, 8), 16);

// Columns that default to the database's own now() (one update in roasts.ts also sets now()). That
// value is the real time, not the bot's behaviour, so it is masked; when the bot writes the column
// itself (gemini.ts, reddit.ts and snooze.ts set it from the fake clock) the value is kept.
const NOW_COLUMNS: Record<string, string[]> = { roast_bags: ["updated_at"], settings: ["updated_at"] };
// Date is faked in most tests; this is the wall clock the database's now() follows
const realNow = () => performance.timeOrigin + performance.now();
export function maskNow(tbl: string, row: string): string {
  const cols = NOW_COLUMNS[tbl];
  if (!cols) return row;
  const r = JSON.parse(row) as Record<string, unknown>;
  for (const c of cols) if (typeof r[c] === "string" && Math.abs(Date.parse(r[c] as string) - realNow()) < 10 * 60_000) r[c] = "<the database's now()>";
  return JSON.stringify(r);
}

export type Recording = { calls: string[]; db: Record<string, string> };
export type Full = { calls: { method: string; url: string; body: unknown }[]; db: Record<string, unknown[]> };

export function harness(o: Options = {}): Harness {
  const file = basename(expect.getState().testPath ?? "unknown");
  const h = { calls: [] as Call[], override: null } as unknown as Harness;
  const full = process.env.RECORD === "full";
  const recordings: Record<string, Recording> = {};
  const fulls: Record<string, Full> = {};
  let current: { calls: Entry[]; full: Full["calls"] } = { calls: [], full: [] };
  let tables: string[] = [];
  let nextId = 0;
  let runtime: ReturnType<typeof makeRuntime> | undefined;
  let fresh: () => ReturnType<typeof makeRuntime> = () => {
    throw new Error("no runtime before beforeAll");
  };
  const closing: Promise<void>[] = [];
  const use = (rt: ReturnType<typeof makeRuntime>) => {
    runtime = rt;
    h.runtime = rt;
    install(rt);
  };
  let nextCopyId = 0;
  let random: { mockRestore(): void } | undefined;
  let racing: { mask: Record<string, string[]>; bodies: boolean; calls: boolean } | null = null;
  h.settle = async () => {
    if ((await drain(10_000)) > 0) throw new Error("background work still running after 10 s");
  };
  h.race = (reason, opts = {}) => {
    if (!reason) throw new Error("race() needs a reason");
    racing = { mask: opts.mask ?? {}, bodies: opts.bodies ?? true, calls: opts.calls ?? true };
  };

  // The recorder sits in front of whatever fetch a test installs (some tests swap it, or wrap the
  // one they find). Reading globalThis.fetch gives a recorder bound to the fetch in place at that
  // moment; only the outermost call of a chain is recorded (a wrapper calls its inner fetch
  // synchronously, before its first await).
  const realFetch = globalThis.fetch;
  let inner: typeof fetch = realFetch;
  let depth = 0;
  const recorder = (target: typeof fetch): typeof fetch => (input, init) => {
    let entry: Entry | undefined;
    if (depth === 0) {
      const req = input instanceof Request ? input : undefined;
      const url = req ? req.url : String(input);
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const text = bodyText(init?.body);
      entry = { method, url, hash: text === undefined ? "-" : hash(canonical(text)) };
      current.calls.push(entry);
      if (full) current.full.push({ method, url, body: text === undefined ? null : JSON.parse(canonical(JSON.stringify(text))) });
    }
    depth++;
    try {
      const res = target(input, init);
      // what a POST created (in a declared race, a create the bot deletes again cancels out)
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

  const stub: typeof fetch = async (url, init = {}) => {
    if (jitter) await pause();
    const path = String(url).replace(API, "");
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

  beforeAll(async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => recorder(inner), set: (f) => void (inner = f) });
    if (o.db !== false) {
      h.t = await testDb();
      if (jitter) {
        // every query waits a moment first, as it would through the tunnel or under load
        const query = h.t.pool.query.bind(h.t.pool) as (...a: unknown[]) => Promise<unknown>;
        (h.t.pool as unknown as { query: unknown }).query = async (...a: unknown[]) => (await pause(), query(...a));
      }
      h.env = testEnv(h.t.db, o.env);
      const r = await h.t.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`);
      tables = r.rows.map((x: { table_name: string }) => x.table_name);
      await o.setup?.(h.t);
    } else h.env = testEnv({} as never, o.env);
    // the app's services for this file (plan 05 transition: old code reaches them through legacy.ts)
    // (on this file's throwaway schema, the same one the old pool uses)
    fresh = () => makeRuntime(configFromEnv({ ...h.env, ALERT_USER_ID: sticky.owner ?? h.env.ALERT_USER_ID }, { databaseUrl: url() }), h.t ? { db: { startupOptions: `-c search_path=${h.t.schema},public` } } : {});
    use(fresh());
    await runtime!.context();
    // a restart mid-test (the old `_reset()` hooks: a deploy): a new runtime with fresh state, the old one closed
    onRestart(() => {
      const old = runtime;
      use(fresh());
      if (old) closing.push(old.dispose());
    });
  });
  afterAll(async () => {
    onRestart(null);
    install(null);
    await runtime?.dispose();
    await Promise.all(closing.splice(0));
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: realFetch });
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
    // every test starts with fresh services (plan 05, phase 5 step 8: the reset hooks are gone); the
    // last test's runtime is closed first, so none of its work can land in this test
    sticky.owner = undefined;
    const previous = runtime;
    use(fresh());
    await previous?.dispose();
    await Promise.all(closing.splice(0));
    if (h.t) for (const tbl of o.tables ?? []) await h.t.db.delete(tbl);
    if (h.t) await o.seed?.(h.t);
    h.calls.length = 0;
    h.override = null;
    nextId = o.discord?.firstId ?? 0;
    nextCopyId = (o.discord?.firstId ?? 0) + 700_000;
    if (o.discord) inner = stub;
    random = vi.spyOn(Math, "random").mockImplementation(seeded(seedOf(expect.getState().currentTestName ?? "")));
    if (o.clock !== undefined) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(typeof o.clock === "string" ? Date.parse(o.clock) : o.clock);
    }
    current = { calls: [], full: [] };
    racing = null;
  });
  afterEach(async () => {
    // the recording is of a finished test: let deferred work (followups, panel edits) land first
    if ((await drain(10_000)) > 0) throw new Error("background work still running 10 s after the test");
    const name = expect.getState().currentTestName ?? "?";
    let key = name;
    for (let i = 2; key in recordings; i++) key = `${name} #${i}`;
    const db: Record<string, string> = {};
    const dbFull: Record<string, unknown[]> = {};
    if (tables.length) {
      // one round trip for every table: the tunnel's latency adds up over 580 tests
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
    // every test gets an entry, even one that did nothing: "nothing" is behaviour too
    recordings[key] = { calls, db };
    if (full) fulls[key] = { calls: current.full, db: dbFull };
    inner = realFetch;
    random?.mockRestore();
    vi.useRealTimers();
  });

  return h;
}
