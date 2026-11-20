// 🌅 The morning joke (jokes.ts): when it's due (09:00 on weekdays, 10:30 at weekends, Vilnius time,
// either side of the clock change), one joke a day however often the minute asks or the bot
// restarts, none when it's over two hours late or the stock is empty (a log line, nothing else),
// the vote buttons, and the writer's routes on the news key.
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { Jokes, jokeDue, normalized, STOCK_TARGET } from "../src/jokes.js";
import { Interactions } from "../src/interactions.js";
import { AppConfig, type AppConfigShape } from "../src/config.js";
import { AppStatus, ROUTER_CONFIG, routesOn } from "../src/app.js";
import { Db } from "../src/db/db.js";
import { jokes as jokeTable, jokeVotes } from "../src/db/schema.js";
import type { AppServices } from "../src/runtime.js";
import { harness, json } from "./fx.js";

const h = harness({
  tables: [jokeVotes, jokeTable],
  discord: { firstId: 500 },
  clock: "2026-11-19T06:00:00Z", // Thursday 08:00 in Vilnius
  env: { NEWS_WRITER_KEY: "w", JOKE_CHANNEL_ID: "jokes" },
});

const iso = (ms: number) => new Date(ms).toISOString();
const posts = () => h.calls.filter((c) => c.method === "POST" && c.path === "/channels/jokes/messages");
const add = (text: string, lang: "en" | "lt" = "en") => Jokes.use((j) => j.add({ text, lang, theme: "work", form: "one-liner" }));
const postDue = Jokes.use((j) => j.postDue);
/** The same call on a freshly built Jokes service: what a restarted bot would run. */
const afterRestart = Effect.provide(postDue, Layer.fresh(Jokes.layer));

it("due at 09:00 on weekdays and 10:30 at weekends, Vilnius time, on both sides of the clock change", () => {
  const due = (localNoonUtc: string) => iso(jokeDue("Europe/Vilnius", Date.parse(localNoonUtc)).at);
  expect(due("2026-07-15T10:00:00Z")).toBe("2026-07-15T06:00:00.000Z"); // Wednesday, summer time (UTC+3)
  expect(due("2026-07-18T10:00:00Z")).toBe("2026-07-18T07:30:00.000Z"); // Saturday, summer
  expect(due("2026-11-19T10:00:00Z")).toBe("2026-11-19T07:00:00.000Z"); // Thursday, winter time (UTC+2)
  expect(due("2026-11-22T10:00:00Z")).toBe("2026-11-22T08:30:00.000Z"); // Sunday, winter
  expect(due("2026-03-29T10:00:00Z")).toBe("2026-03-29T07:30:00.000Z"); // the Sunday summer time starts
  expect(due("2026-03-30T10:00:00Z")).toBe("2026-03-30T06:00:00.000Z"); // the Monday after
  expect(due("2026-10-25T10:00:00Z")).toBe("2026-10-25T08:30:00.000Z"); // the Sunday it ends
  expect(due("2026-10-23T10:00:00Z")).toBe("2026-10-23T06:00:00.000Z"); // the Friday before
  // just after local midnight is already the new day (still the previous one in UTC)
  expect(jokeDue("Europe/Vilnius", Date.parse("2026-11-20T22:30:00Z")).day).toBe("2026-11-21");
});

it("a repeat is the same text without case, accents, punctuation or spacing", () => {
  expect(normalized("  Šiemet vasara buvo   GRAŽI!")).toBe(normalized("siemet vasara, buvo graži"));
  expect(normalized("It's right behind you.")).not.toBe(normalized("It's right in front of you."));
});

it.effect("the oldest joke goes out at 09:00, once, silent and with the vote buttons; again or after a restart, nothing", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* add("First joke in.");
    yield* h.setTime("2026-11-19T06:01:00Z");
    yield* add("Second joke in.");
    yield* h.setTime("2026-11-19T06:59:00Z"); // 08:59
    expect(yield* postDue).toEqual({ skipped: "too early" });
    yield* h.setTime("2026-11-19T07:00:00Z"); // 09:00
    const [first] = yield* db.select().from(jokeTable).where(eq(jokeTable.text, "First joke in."));
    expect(yield* postDue).toEqual({ posted: first.id, day: "2026-11-19" });
    expect(yield* postDue).toEqual({ skipped: "already posted", day: "2026-11-19" });
    yield* h.setTime("2026-11-19T07:30:00Z");
    expect(yield* afterRestart).toEqual({ skipped: "already posted", day: "2026-11-19" });
    expect(posts()).toHaveLength(1);
    const body = posts()[0].body as { flags: number; allowed_mentions: unknown; components: [{ components: { content?: string; components?: { custom_id: string }[] }[] }] };
    expect(body.flags).toBe(1 << 15); // with sound (the owner, 20 Nov)
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const parts = body.components[0].components;
    expect(parts[1].content).toBe("First joke in.");
    expect(parts.at(-1)!.components!.map((b) => b.custom_id)).toEqual(["fire", "lol", "dead", "mid"].map((k) => `joke:${first.id}:${k}`));
    const [row] = yield* db.select().from(jokeTable).where(eq(jokeTable.id, first.id));
    expect([row.day, row.channel_id, row.message_id]).toEqual(["2026-11-19", "jokes", "500"]);
  }).pipe(h.provide),
);

it.effect("two copies asking at once post one joke", () =>
  Effect.gen(function* () {
    yield* add("One.");
    yield* add("Two.");
    yield* h.setTime("2026-11-19T07:00:00Z");
    const both = yield* Effect.all([postDue, afterRestart], { concurrency: "unbounded" });
    expect(both.filter((r) => "posted" in r)).toHaveLength(1);
    expect(both.filter((r) => r.skipped === "already posted")).toHaveLength(1);
    expect(posts()).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("late after a restart: posted under two hours late, skipped at two hours (the weekend's 10:30)", () =>
  Effect.gen(function* () {
    yield* add("Saturday's.");
    yield* add("Sunday's.");
    yield* h.setTime("2026-11-21T10:29:00Z"); // Saturday 12:29, 1 h 59 min late
    expect(yield* afterRestart).toMatchObject({ day: "2026-11-21", posted: expect.any(Number) });
    yield* h.setTime("2026-11-22T10:30:00Z"); // Sunday 12:30, two hours late
    expect(yield* afterRestart).toEqual({ skipped: "too late", day: "2026-11-22" });
    yield* h.setTime("2026-11-22T21:00:00Z");
    expect(yield* postDue).toEqual({ skipped: "too late", day: "2026-11-22" });
    expect(posts()).toHaveLength(1);
    expect(h.logs.join("\n")).not.toContain("none in stock");
  }).pipe(h.provide),
);

it.effect("an empty stock posts nothing and logs it once, at info, with no alert", () =>
  Effect.gen(function* () {
    yield* h.setTime("2026-11-19T07:00:00Z");
    expect(yield* postDue).toEqual({ skipped: "no joke in stock", day: "2026-11-19" });
    yield* h.setTime("2026-11-19T07:01:00Z");
    expect(yield* postDue).toEqual({ skipped: "no joke in stock", day: "2026-11-19" });
    const said = h.logs.filter((l) => l.includes("none in stock"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("level=INFO");
    expect(h.calls).toEqual([]); // no post, no DM
  }).pipe(h.provide),
);

it.effect("a post that fails gives the joke back, and the next minute posts it", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* add("Back in stock.");
    yield* h.setTime("2026-11-19T07:00:00Z");
    h.override = (c) => (c.method === "POST" ? json({ message: "boom" }, 500) : undefined);
    yield* h.promise(postDue, (p) => expect(p).rejects.toThrow("500"));
    expect((yield* db.select().from(jokeTable)).map((j) => j.day)).toEqual([null]);
    h.override = null;
    yield* h.setTime("2026-11-19T07:01:00Z");
    expect(yield* postDue).toMatchObject({ posted: expect.any(Number), day: "2026-11-19" });
  }).pipe(h.provide),
);

it.effect("no JOKE_CHANNEL_ID: the feature is off", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    yield* add("Never posted.");
    yield* h.setTime("2026-11-19T07:00:00Z");
    const off = yield* Effect.provide(postDue, Layer.fresh(Jokes.layer).pipe(Layer.provide(Layer.succeed(AppConfig, { ...config, jokeChannelId: undefined }))));
    expect(off).toEqual({ skipped: "off" });
    expect(h.calls).toEqual([]);
  }).pipe(h.provide),
);

it.effect("the vote buttons count, toggle and show who voted", () =>
  Effect.gen(function* () {
    yield* add("Vote on me.");
    yield* h.setTime("2026-11-19T07:00:00Z");
    const { posted } = yield* postDue;
    type Answer = { type: number; data: { content?: string; components: [{ components: { content?: string; components?: { label: string }[] }[] }] } };
    const tap = (custom_id: string, id: string) =>
      Interactions.use((x) => Effect.map(x.handle({ type: 3, token: "tok", member: { user: { id, username: id } }, message: { id: "500", flags: 0 }, data: { custom_id } }), (r) => r as Answer));
    const labels = (r: Answer) => r.data.components[0].components.at(-1)!.components!.map((b) => b.label);
    const one = yield* tap(`joke:${posted}:lol`, "a");
    expect(one.type).toBe(7);
    expect(labels(one)).toEqual(["0", "1", "0", "0"]);
    const two = yield* tap(`joke:${posted}:lol`, "b");
    expect(labels(two)).toEqual(["0", "2", "0", "0"]);
    expect(two.data.components[0].components[3].content).toContain("<@a> <@b>");
    const again = yield* tap(`joke:${posted}:lol`, "a"); // the same button again takes the vote back
    expect(labels(again)).toEqual(["0", "1", "0", "0"]);
    const changed = yield* tap(`joke:${posted}:fire`, "b");
    expect(labels(changed)).toEqual(["1", "0", "0", "0"]);
    const gone = yield* tap("joke:99999:lol", "a");
    expect(gone.data).toMatchObject({ content: "That joke has left the building 🫥" });
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- the writer's routes

const app = (change: Partial<AppConfigShape> = {}) =>
  Effect.gen(function* () {
    const base = yield* Effect.context<AppServices>();
    const config = yield* AppConfig;
    const ctx = Context.add(base, AppConfig, { ...config, ...change });
    const statusLayer = Layer.succeed(AppStatus, AppStatus.of({ leader: Effect.succeed(true), shuttingDown: Effect.succeed(false), publicKey: h.env.DISCORD_PUBLIC_KEY }));
    const { handler } = HttpRouter.toWebHandler(routesOn(statusLayer, ctx).pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true, routerConfig: ROUTER_CONFIG });
    return (method: "GET" | "POST", path: string, payload?: unknown, token = "w") =>
      Effect.promise(async () => {
        const res = await handler(
          new Request(`http://local${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }) }),
          ctx,
        );
        return { statusCode: res.status, body: await res.text() };
      });
  });

it.effect("GET /jokes/stock and POST /jokes: the news writer's key, the stock it tops up, 400 for the shape or length, 409 for a repeat", () =>
  Effect.gen(function* () {
    const http = yield* app();
    const joke = { text: "I changed my password to \"incorrect\".", lang: "en", theme: "technology", form: "one-liner" };
    expect((yield* http("GET", "/jokes/stock", undefined, "x")).statusCode).toBe(401);
    expect((yield* http("POST", "/jokes", joke, "x")).statusCode).toBe(401);
    const empty = yield* http("GET", "/jokes/stock");
    expect([empty.statusCode, JSON.parse(empty.body)]).toEqual([200, { in_stock: 0, target: STOCK_TARGET, need: STOCK_TARGET, recent: [] }]);
    const ok = yield* http("POST", "/jokes", joke);
    expect([ok.statusCode, JSON.parse(ok.body)]).toEqual([200, { ok: true, id: expect.any(Number) }]);
    const repeat = yield* http("POST", "/jokes", { ...joke, text: "i changed my PASSWORD to incorrect!!", theme: "work" });
    expect([repeat.statusCode, JSON.parse(repeat.body)]).toEqual([409, { error: "that joke is already in the stock or was posted" }]);
    expect((yield* http("POST", "/jokes", { ...joke, text: "x".repeat(601) })).statusCode).toBe(400);
    expect((yield* http("POST", "/jokes", { ...joke, text: "   " })).statusCode).toBe(400);
    expect((yield* http("POST", "/jokes", { ...joke, text: "Another.", lang: "de" })).statusCode).toBe(400);
    expect((yield* http("POST", "/jokes", { ...joke, text: "Another.", theme: "" })).statusCode).toBe(400);
    expect((yield* http("POST", "/jokes", { text: "No theme." })).statusCode).toBe(400);
    expect((yield* http("POST", "/jokes", "not json")).statusCode).toBe(400);
    const lt = yield* http("POST", "/jokes", { text: "Šiemet vasara buvo graži. Gaila, kad tą dieną dirbau.", lang: "lt", theme: "weather", form: "one-liner" });
    expect(lt.statusCode).toBe(200);
    const stock = JSON.parse((yield* http("GET", "/jokes/stock")).body);
    expect(stock).toEqual({
      in_stock: 2,
      target: STOCK_TARGET,
      need: STOCK_TARGET - 2,
      recent: [
        { text: "Šiemet vasara buvo graži. Gaila, kad tą dieną dirbau.", lang: "lt", theme: "weather", form: "one-liner", posted: null },
        { text: joke.text, lang: "en", theme: "technology", form: "one-liner", posted: null },
      ],
    });
  }).pipe(h.provide),
);

it.effect("the stock shows the writer how each posted joke landed: its day and its votes", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [a] = yield* db.insert(jokeTable).values({ text: "A posted one.", norm: "a posted one", lang: "en", theme: "work", form: "one-liner", added_at: "2026-11-18T10:00:00Z", day: "2026-11-19", posted_at: "2026-11-19T07:00:00Z" }).returning({ id: jokeTable.id });
    yield* db.insert(jokeTable).values({ text: "Not yet.", norm: "not yet", lang: "en", theme: "food", form: "story", added_at: "2026-11-19T10:00:00Z" });
    yield* db.insert(jokeVotes).values([
      { joke_id: a!.id, user_id: "x", kind: "fire", voted_at: "2026-11-19T07:05:00Z" },
      { joke_id: a!.id, user_id: "y", kind: "fire", voted_at: "2026-11-19T07:06:00Z" },
      { joke_id: a!.id, user_id: "z", kind: "mid", voted_at: "2026-11-19T07:07:00Z" },
    ]);
    const http = yield* app();
    const stock = JSON.parse((yield* http("GET", "/jokes/stock")).body);
    expect(stock.recent).toEqual([
      { text: "Not yet.", lang: "en", theme: "food", form: "story", posted: null },
      { text: "A posted one.", lang: "en", theme: "work", form: "one-liner", posted: "2026-11-19", votes: { fire: 2, mid: 1 } },
    ]);
  }).pipe(h.provide),
);

it.effect("no writer key configured: the joke routes are 404", () =>
  Effect.gen(function* () {
    const http = yield* app({ newsWriterKey: undefined });
    expect((yield* http("GET", "/jokes/stock")).statusCode).toBe(404);
    expect((yield* http("POST", "/jokes", { text: "a", lang: "en", theme: "t", form: "f" })).statusCode).toBe(404);
  }).pipe(h.provide),
);
