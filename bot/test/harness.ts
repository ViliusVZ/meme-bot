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
import type { Env } from "../src/env.js";
import { drain } from "../src/background.js";
import { testDb, testEnv } from "./pg.js";

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

type Options = {
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

const API = "https://discord.com/api/v10";

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
  /**
   * Declare that this test races on purpose (several callers at once, one wins), so which one wins
   * isn't fixed, nor how many calls it takes (two may both post, then one deletes): only the
   * database's row counts are recorded, which are the same whoever wins. Give the
   * reason; each use is listed in STATUS.md under "Declared exceptions".
   */
  race(reason: string): void;
  /** Wait for background work (followups, panel edits) to finish, as a real user's next tap would. */
  settle(): Promise<void>;
};

/**
 * Unordered call groups (verification.md §2a): places where the bot sends several calls at once,
 * so their order isn't behaviour. Each is a run of consecutive calls matching the pattern, sorted
 * before recording. Every group is listed in STATUS.md under "Declared exceptions".
 */
const UNORDERED: { name: string; pattern: RegExp }[] = [
  // panels.ts push(): every live private copy of a card is re-rendered and edited at once
  { name: "panel copies", pattern: /^PATCH https:\/\/discord\.com\/api\/v10\/webhooks\/[^/]+\/[^/]+\/messages\/@original / },
];
function settleOrder(calls: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < calls.length; ) {
    const g = UNORDERED.find((u) => u.pattern.test(calls[i]));
    if (!g) {
      out.push(calls[i++]);
      continue;
    }
    let j = i;
    while (j < calls.length && g.pattern.test(calls[j])) j++;
    out.push(...calls.slice(i, j).sort());
    i = j;
  }
  return out;
}

/** A body as text, whatever form fetch was given it in. */
function bodyText(body: unknown): string | undefined {
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
function canonical(text: string | undefined): string {
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
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** A small seeded generator (mulberry32), so shuffles are the same on every run. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (name: string) => parseInt(createHash("sha1").update(name).digest("hex").slice(0, 8), 16);

// Columns that take the database's own now(): not the bot's behaviour, so not recorded.
const NOW_COLUMNS: Record<string, string[]> = { roast_bags: ["updated_at"], settings: ["updated_at"] };

type Recording = { calls: string[]; db: Record<string, string> };
type Full = { calls: { method: string; url: string; body: unknown }[]; db: Record<string, unknown[]> };

export function harness(o: Options = {}): Harness {
  const file = basename(expect.getState().testPath ?? "unknown");
  const h = { calls: [] as Call[], override: null } as unknown as Harness;
  const full = process.env.RECORD === "full";
  const recordings: Record<string, Recording> = {};
  const fulls: Record<string, Full> = {};
  let current: { calls: string[]; full: Full["calls"] } = { calls: [], full: [] };
  let tables: string[] = [];
  let nextId = 0;
  let random: { mockRestore(): void } | undefined;
  let racing = false;
  h.settle = async () => {
    if ((await drain(10_000)) > 0) throw new Error("background work still running after 10 s");
  };
  h.race = (reason) => {
    if (!reason) throw new Error("race() needs a reason");
    racing = true;
  };

  // The recorder sits in front of whatever fetch a test installs (some tests swap it, or wrap the
  // one they find). Reading globalThis.fetch gives a recorder bound to the fetch in place at that
  // moment; only the outermost call of a chain is recorded (a wrapper calls its inner fetch
  // synchronously, before its first await).
  const realFetch = globalThis.fetch;
  let inner: typeof fetch = realFetch;
  let depth = 0;
  const recorder = (target: typeof fetch): typeof fetch => (input, init) => {
    if (depth === 0) {
      const req = input instanceof Request ? input : undefined;
      const url = req ? req.url : String(input);
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const text = bodyText(init?.body);
      current.calls.push(`${method} ${url} ${text === undefined ? "-" : hash(canonical(text))}`);
      if (full) current.full.push({ method, url, body: text === undefined ? null : JSON.parse(canonical(JSON.stringify(text))) });
    }
    depth++;
    try {
      return target(input, init);
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
    return o.discord!.answer ? o.discord!.answer(c, id) : json({ id: id() });
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
  });
  afterAll(async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: realFetch });
    const dir = fileURLToPath(new URL("./__recordings__/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    if (Object.keys(recordings).length) writeFileSync(`${dir}${file.replace(/\.ts$/, ".json")}`, JSON.stringify(recordings, null, 1) + "\n");
    if (full) {
      mkdirSync(`${dir}full`, { recursive: true });
      writeFileSync(`${dir}full/${file.replace(/\.ts$/, ".json")}`, JSON.stringify(fulls, null, 1) + "\n");
    }
    await h.t?.close();
  });

  beforeEach(async () => {
    if (h.t) for (const tbl of o.tables ?? []) await h.t.db.delete(tbl);
    if (h.t) await o.seed?.(h.t);
    h.calls.length = 0;
    h.override = null;
    nextId = o.discord?.firstId ?? 0;
    if (o.discord) inner = stub;
    random = vi.spyOn(Math, "random").mockImplementation(seeded(seedOf(expect.getState().currentTestName ?? "")));
    if (o.clock !== undefined) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(typeof o.clock === "string" ? Date.parse(o.clock) : o.clock);
    }
    current = { calls: [], full: [] };
    racing = false;
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
      const q = tables
        .map((tbl) => `SELECT '${tbl}' AS tbl, (to_jsonb(r)${(NOW_COLUMNS[tbl] ?? []).map((c) => ` - '${c}'`).join("")})::text AS row FROM "${tbl}" r`)
        .join(" UNION ALL ");
      const r = await h.t.pool.query<{ tbl: string; row: string }>(`SELECT tbl, row FROM (${q}) x ORDER BY tbl COLLATE "C", row COLLATE "C"`);
      const byTable = new Map<string, string[]>();
      for (const x of r.rows) byTable.set(x.tbl, [...(byTable.get(x.tbl) ?? []), x.row]);
      for (const [tbl, rows] of byTable) {
        db[tbl] = racing ? `${rows.length}` : `${rows.length}:${hash(rows.join("\n"))}`;
        if (full) dbFull[tbl] = rows.map((x) => JSON.parse(x));
      }
    }
    if (current.calls.length || Object.keys(db).length) recordings[key] = { calls: racing ? [] : settleOrder(current.calls), db };
    if (full) fulls[key] = { calls: current.full, db: dbFull };
    inner = realFetch;
    random?.mockRestore();
    vi.useRealTimers();
  });

  return h;
}
