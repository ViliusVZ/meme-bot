// 📊 Stats maths: calls, time together, game time, periods.   node test/activity.test.mjs
// Bundles src/activity.ts with esbuild and feeds it a fake D1 holding hand-made voice segments.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "act-")), "act.mjs");
const res = await build({ entryPoints: ["src/activity.ts"], bundle: true, format: "esm", write: false });
writeFileSync(out, res.outputFiles[0].text);
const act = await import(pathToFileURL(out).href);

const H = 3600;
const T0 = Date.parse("2026-11-06T17:00:00Z") / 1000; // Friday 19:00 in Vilnius
const at = (h) => T0 + Math.round(h * H); // hours after Friday 19:00
const LOBBY = "lobby";
const REPO = "repo-room";
let nextId = 1;
// a segment from h1 to h2 (hours after 19:00); last_seen is one check (60 s) before the end
const seg = (user, channel, h1, h2, game = null) => ({ id: nextId++, user_id: user, channel_id: channel, game, started_at: at(h1), last_seen: at(h2) - 60, open: 0 });

function env(segs, nights = [], claimed = new Set()) {
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...a) {
          args = a;
          return this;
        },
        async run() {
          // recaps claim: INSERT OR IGNORE INTO recaps (period, …) / DELETE FROM recaps WHERE period = ?
          if (sql.includes("INSERT OR IGNORE INTO recaps")) {
            const fresh = !claimed.has(args[0]);
            claimed.add(args[0]);
            return { meta: { changes: fresh ? 1 : 0 } };
          }
          if (sql.includes("DELETE FROM recaps")) claimed.delete(args[0]);
          return { meta: { changes: 0 } };
        },
        async all() {
          if (sql.includes("voice_segments")) return { results: segs };
          if (sql.includes("game_nights")) return { results: nights };
          if (sql.includes("FROM games")) return { results: [{ name: "R.E.P.O.", emoji: "📦" }] };
          return { results: [] };
        },
        async first() {
          return sql.includes("MIN(started_at)") ? { t: null } : null;
        },
      };
    },
  };
  return { DB: db, PLAYERS: "a,b,c", TIMEZONE: "Europe/Vilnius", GAME_CHANNEL_ID: "gn", DISCORD_TOKEN: "x" };
}

const realNow = Date.now;
let passed = 0;
const test = async (name, fn) => {
  try {
    Date.now = () => (T0 + 24 * H) * 1000; // "now" is the next day, so nothing is cut off at now
    await fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.stack}`);
    process.exitCode = 1;
  } finally {
    Date.now = realNow;
  }
};
const crunch = (segs, nights) => act.crunch(env(segs, nights), at(-10), at(20));

await test("Lobby → game room together is one call; game and hangout time split", async () => {
  const s = await crunch([
    seg("a", LOBBY, 0, 0.5),
    seg("b", LOBBY, 0.02, 0.5),
    seg("a", REPO, 0.5, 2, "R.E.P.O."),
    seg("b", REPO, 0.5, 2, "R.E.P.O."),
    seg("c", REPO, 1, 2, "R.E.P.O."),
  ]);
  assert.equal(s.calls.length, 1);
  assert.equal(s.total, at(2) - at(0.02)); // together from when b joined
  assert.equal(s.byGame.get("R.E.P.O."), 1.5 * H);
  assert.equal(s.hangout, at(0.5) - at(0.02));
  assert.deepEqual([...s.perUser], [["a", 2 * H], ["b", at(2) - at(0.02)], ["c", H]]);
  assert.equal(s.calls[0].firstIn, "a");
});

await test("a 10-minute break makes two calls; a 2-minute one doesn't", async () => {
  const two = await crunch([seg("a", LOBBY, 0, 1), seg("b", LOBBY, 0, 1), seg("a", LOBBY, 1 + 10 / 60, 2), seg("b", LOBBY, 1 + 10 / 60, 2)]);
  assert.equal(two.calls.length, 2);
  const one = await crunch([seg("a", LOBBY, 0, 1), seg("b", LOBBY, 0, 1), seg("a", LOBBY, 1 + 2 / 60, 2), seg("b", LOBBY, 1 + 2 / 60, 2)]);
  assert.equal(one.calls.length, 1);
});

await test("sitting in voice alone is voice time, not a call", async () => {
  const s = await crunch([seg("a", LOBBY, 0, 1)]);
  assert.equal(s.calls.length, 0);
  assert.equal(s.total, 0);
  assert.equal(s.perUser.get("a"), H);
});

await test("two people in different channels aren't together", async () => {
  const s = await crunch([seg("a", LOBBY, 0, 1), seg("b", REPO, 0, 1, "R.E.P.O.")]);
  assert.equal(s.total, 0);
});

await test("a call over the period boundary only counts the part inside", async () => {
  const s = await act.crunch(env([seg("a", LOBBY, 0, 4), seg("b", LOBBY, 0, 4)]), at(-10), at(3));
  assert.equal(s.total, 3 * H);
});

await test("outsiders' voice time is ignored", async () => {
  const s = await crunch([seg("a", LOBBY, 0, 1), seg("stranger", LOBBY, 0, 1)]);
  assert.equal(s.total, 0);
  assert.equal(s.perUser.has("stranger"), false);
});

await test("game nights are counted by game", async () => {
  const nights = [
    { day: "2026-11-06", stage: "set", game: "R.E.P.O.", start_at: at(0), reminded: 1 },
    { day: "2026-11-05", stage: "off", game: null, start_at: null, reminded: 0 },
    { day: "2026-11-07", stage: "set", game: "R.E.P.O.", start_at: at(24), reminded: 0 },
  ];
  const s = await crunch([], nights);
  assert.deepEqual([s.nights.played, s.nights.cancelled, s.nights.upcoming, s.nights.games.get("R.E.P.O.")], [1, 1, 1, 1]);
});

await test("the stats card reads right", async () => {
  const s = await crunch([seg("a", REPO, 0, 2.5, "R.E.P.O."), seg("b", REPO, 0, 2.5, "R.E.P.O."), seg("c", REPO, 0.5, 2.5, "R.E.P.O.")]);
  const text = (await act.statsBody(env([]), "This week", s)).join("\n");
  assert.match(text, /Together · \*\*2h 30m\*\*/);
  assert.match(text, /📦 R\.E\.P\.O\. \*\*2h 30m\*\*/);
  assert.match(text, /🥇 <@a> \*\*2h 30m\*\*/);
  assert.match(text, /busiest day \*\*Friday\*\*/);
  assert.match(text, /usually starting around \*\*19:00\*\*/);
});

await test("a quiet period says so", async () => {
  const text = (await act.statsBody(env([]), "This week", await crunch([]))).join("\n");
  assert.match(text, /Nothing yet/);
});

await test("durations", async () => {
  assert.deepEqual([act.dur(300), act.dur(3725), act.dur(36000)], ["5m", "1h 02m", "10h 00m"]);
});

await test("weeks run Monday 00:00 to Monday 00:00, local time", async () => {
  Date.now = () => Date.parse("2026-11-06T17:00:00Z"); // Friday
  const w = act.period(env([]), "week");
  assert.equal(w.from, Date.parse("2026-11-01T22:00:00Z") / 1000); // Mon 2 Nov 00:00 (UTC+2)
  assert.equal(w.to - w.from, 7 * 86400);
  const last = act.period(env([]), "week", -1);
  assert.equal(last.to, w.from);
});

await test("months and years, across DST", async () => {
  Date.now = () => Date.parse("2026-11-06T17:00:00Z");
  const oct = act.period(env([]), "month", -1);
  assert.equal(oct.from, Date.parse("2026-09-30T21:00:00Z") / 1000); // 1 Oct 00:00 summer time
  assert.equal(oct.to, Date.parse("2026-10-31T22:00:00Z") / 1000); // 1 Nov 00:00 winter time
  const jan = act.period(env([]), "month", 2);
  assert.equal(jan.from, Date.parse("2026-12-31T22:00:00Z") / 1000); // month overflow → next year
  const y = act.period(env([]), "year");
  assert.equal(y.from, Date.parse("2025-12-31T22:00:00Z") / 1000);
});

await test("Monday 10:00: last week's recap is posted once; quiet weeks are skipped", async () => {
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const claimed = new Set();
    const e = env([seg("a", REPO, 0, 2, "R.E.P.O."), seg("b", REPO, 0, 2, "R.E.P.O.")], [], claimed);
    Date.now = () => Date.parse("2026-11-09T07:30:00Z"); // Monday 09:30: too early
    assert.deepEqual(await act.recaps(e), {});
    Date.now = () => Date.parse("2026-11-09T08:05:00Z"); // Monday 10:05
    assert.deepEqual(await act.recaps(e), { "games-week:2026-11-02": "posted" });
    assert.equal(posts.length, 1);
    assert.match(JSON.stringify(posts[0].body), /Weekly recap · 2 Nov – 8 Nov/);
    assert.match(JSON.stringify(posts[0].body), /2h 00m/);
    assert.deepEqual(await act.recaps(e), {}); // the next tick doesn't post it again
    const quiet = env([], [], new Set());
    Date.now = () => Date.parse("2026-11-16T08:05:00Z");
    assert.deepEqual(await act.recaps(quiet), { "games-week:2026-11-09": "quiet, skipped" });
    assert.equal(posts.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
