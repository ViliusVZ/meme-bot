// The recorder's pieces (plan 05, verification.md §2a), shared by the test harness (test/fx.ts): what
// a test did, as recorded in test/__recordings__/ (every outbound request in order, the database at
// the end), with the declared looser spots (unordered groups, background reads, races).
import { createHash } from "node:crypto";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Env } from "./env.js";
import type { testDb } from "./pg.js";

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

