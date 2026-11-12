// The Discord service (plan 05, verification.md §7 tests 3 and 4): Discord's real error answers
// become the right typed errors, and today's retry rules hold to the millisecond under TestClock.
import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { AppConfig } from "../src/config.js";
import { Channels } from "./old/channels.js";
import { Discord, isFinished } from "./old/discord.js";
import { configFromEnv } from "../src/legacy.js";
import { testEnv } from "./pg.js";

type Fixture = { request: { method: string; path: string }; status: number; body: Record<string, unknown> };
const dir = new URL("./fixtures/discord-errors/", import.meta.url);
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));


type Seen = { method: string; url: string; at: number };
/** A Discord that answers from `answer` (a status and body, or "network" for a failed connection, or "hang"). */
type Answer = { status: number; body?: unknown; raw?: string; stall?: boolean } | "network" | "hang";
const fake = (answer: (call: Seen, n: number) => Answer) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<Seen[]>([]);
    const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest, url: URL) =>
      Effect.gen(function* () {
        const call = { method: request.method, url: url.toString(), at: Number(yield* Clock.currentTimeMillis) };
        const n = (yield* Ref.getAndUpdate(seen, (s) => [...s, call])).length;
        const a = answer(call, n);
        if (a === "hang") return yield* Effect.never;
        if (a === "network") return yield* new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "connection reset" }) });
        // `stall`: the headers arrive, the body never finishes; `raw`: a body that isn't JSON
        const body = a.stall ? new ReadableStream({ start() {} }) : a.raw !== undefined ? a.raw : a.body === undefined ? null : JSON.stringify(a.body);
        return HttpClientResponse.fromWeb(request, new Response(body, { status: a.status }));
      }),
    );
    const layer = Discord.layer.pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), Layer.succeed(AppConfig, configFromEnv(testEnv({} as never))), Channels.layer)),
    );
    return { seen, layer };
  });

describe("Discord's errors, typed (from the captures in test/fixtures/discord-errors)", () => {
  const cases: [string, string, Partial<Record<"code" | "status", number>>, boolean][] = [
    ["unknown-voice-state", "DiscordNotFound", { code: 10065 }, true],
    ["unknown-channel", "DiscordNotFound", { code: 10003 }, true],
    ["unknown-message", "DiscordNotFound", { code: 10008 }, true],
    ["unknown-guild", "DiscordNotFound", { code: 10004 }, true],
    ["deleted-event-extend", "DiscordNotFound", { code: 10070 }, true],
    ["missing-access", "DiscordRejected", { status: 403, code: 50001 }, false],
    ["ended-event-end", "DiscordRejected", { status: 403, code: 180000 }, false],
    ["ended-event-extend", "DiscordRejected", { status: 400, code: 50035 }, true],
  ];
  for (const [name, tag, fields, finished] of cases)
    it.effect(`${name} → ${tag}${finished ? ", finished" : ""}`, () =>
      Effect.gen(function* () {
        const f = fixture(name);
        const { layer } = yield* fake(() => ({ status: f.status, body: f.body }));
        const e = yield* Discord.use((d) => d.request(f.request.method, "/x")).pipe(Effect.asVoid, Effect.flip, Effect.provide(layer));
        assert.strictEqual(e._tag, tag);
        if (e._tag === "DiscordNotFound" || e._tag === "DiscordRejected") {
          if (fields.code !== undefined) assert.strictEqual(e.code, fields.code);
          if (e._tag === "DiscordRejected" && fields.status !== undefined) assert.strictEqual(e.status, fields.status);
          assert.strictEqual(e.discordMessage, f.body.message);
          assert.strictEqual(isFinished(e), finished);
        }
      }),
    );

  it.effect("a 403 whose path holds 10065 is a refusal, not 'not in voice'", () =>
    Effect.gen(function* () {
      const f = fixture("missing-access");
      const { layer } = yield* fake(() => ({ status: f.status, body: f.body }));
      const e = yield* Discord.use((d) => d.voiceState("10065")).pipe(Effect.flip, Effect.provide(layer));
      assert.strictEqual(e._tag, "DiscordRejected");
    }),
  );

  it.effect("an expired interaction token: the webhook answer says it didn't land, after one attempt", () =>
    Effect.gen(function* () {
      const f = fixture("expired-interaction-token");
      const { layer, seen } = yield* fake(() => ({ status: f.status, body: f.body }));
      const r = yield* Discord.use((d) => d.editOriginal("tok", { content: "x" })).pipe(Effect.provide(layer));
      assert.deepStrictEqual([r?.ok, r?.status], [false, 401]);
      assert.strictEqual((yield* Ref.get(seen)).length, 1);
    }),
  );

  it.effect("today's error text survives for the old callers (404 with Discord's raw answer)", () =>
    Effect.gen(function* () {
      const f = fixture("unknown-voice-state");
      const { layer } = yield* fake(() => ({ status: f.status, body: f.body }));
      const e = yield* Discord.use((d) => d.request("GET", "/guilds/g/voice-states/u")).pipe(Effect.asVoid, Effect.flip, Effect.provide(layer));
      assert.match(e.message, /^GET \/guilds\/g\/voice-states\/u -> 404 \{"message":"Unknown Voice State","code":10065\}$/);
    }),
  );
});

/** Start `self`, then move the test clock in 100 ms steps until it's done (at most `limitMs`). */
const settle = <A, E, R>(self: Effect.Effect<A, E, R>, limitMs = 60_000) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.exit(self));
    for (let t = 0; t <= limitMs; t += 100) {
      const done = fiber.pollUnsafe();
      if (done) return yield* Fiber.join(fiber);
      yield* TestClock.adjust("100 millis");
    }
    return yield* Fiber.join(fiber);
  });
const gaps = (s: Seen[]) => s.slice(1).map((c, i) => c.at - s[i].at);

describe("the retry rules (TestClock)", () => {
  it.effect("a POST that gets a 5xx is sent once, and the caller hears it gave up", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake(() => ({ status: 502 }));
      const exit = yield* settle(Discord.use((d) => d.createMessage("c", { content: "x" })).pipe(Effect.provide(layer)));
      assert.strictEqual((yield* Ref.get(seen)).length, 1);
      assert.isTrue(exit._tag === "Failure" && String(exit.cause).includes("POST /channels/c/messages -> gave up: 502"));
    }),
  );

  it.effect("a POST whose connection fails is sent once too", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake(() => "network");
      yield* settle(Discord.use((d) => d.createMessage("c", { content: "x" })).pipe(Effect.provide(layer)));
      assert.strictEqual((yield* Ref.get(seen)).length, 1);
    }),
  );

  it.effect("a GET is tried 4 times, 300 ms, 600 ms and 1.2 s apart, then gives up", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake(() => ({ status: 503 }));
      const exit = yield* settle(Discord.use((d) => d.request("GET", "/channels/c")).pipe(Effect.provide(layer)));
      const s = yield* Ref.get(seen);
      assert.strictEqual(s.length, 4);
      assert.deepStrictEqual(gaps(s), [300, 600, 1200]);
      assert.isTrue(exit._tag === "Failure" && String(exit.cause).includes("GET /channels/c -> gave up: 503"));
    }),
  );

  it.effect("a GET recovers when a later attempt works", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake((_c, n) => (n < 2 ? "network" : { status: 200, body: { id: "c" } }));
      const exit = yield* settle(Discord.use((d) => d.getChannel("c")).pipe(Effect.provide(layer)));
      assert.strictEqual((yield* Ref.get(seen)).length, 3);
      assert.deepStrictEqual(exit._tag === "Success" ? exit.value : null, { id: "c" });
    }),
  );

  it.effect("a 429 waits retry_after plus 100 ms, capped at 10 s, also for a POST", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake((_c, n) => (n === 0 ? { status: 429, body: { retry_after: 2.5 } } : n === 1 ? { status: 429, body: { retry_after: 60 } } : { status: 200, body: { id: "m" } }));
      const exit = yield* settle(Discord.use((d) => d.createMessage("c", { content: "x" })).pipe(Effect.provide(layer)));
      assert.deepStrictEqual(gaps(yield* Ref.get(seen)), [2600, 10_100]);
      assert.strictEqual(exit._tag, "Success");
    }),
  );

  it.effect("a hung call times out at 10 s and counts as a failed attempt", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake((_c, n) => (n === 0 ? "hang" : { status: 200, body: { id: "c" } }));
      const exit = yield* settle(Discord.use((d) => d.getChannel("c")).pipe(Effect.provide(layer)));
      assert.deepStrictEqual(gaps(yield* Ref.get(seen)), [10_000 + 300]);
      assert.strictEqual(exit._tag, "Success");
    }),
  );

  it.effect("an answer that stalls after its headers times out at 10 s too, and is tried again", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake((_c, n) => (n === 0 ? { status: 200, stall: true } : { status: 200, body: { id: "c" } }));
      const exit = yield* settle(Discord.use((d) => d.getChannel("c")).pipe(Effect.provide(layer)));
      assert.deepStrictEqual(gaps(yield* Ref.get(seen)), [10_000 + 300]);
      assert.strictEqual(exit._tag, "Success");
    }),
  );

  it.effect("a 2xx we can't read fails at once, with no retry (the request did go through)", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake(() => ({ status: 200, raw: "<html>not json</html>" }));
      const exit = yield* settle(Discord.use((d) => d.request("PATCH", "/channels/c", { name: "x" })).pipe(Effect.provide(layer)));
      assert.strictEqual((yield* Ref.get(seen)).length, 1);
      assert.isTrue(exit._tag === "Failure" && String(exit.cause).includes("unexpected answer"));
    }),
  );

  it.effect("a 4xx is final: no retry", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake(() => ({ status: 404, body: { message: "Unknown Channel", code: 10003 } }));
      yield* settle(Discord.use((d) => d.getChannel("c")).pipe(Effect.provide(layer)));
      assert.strictEqual((yield* Ref.get(seen)).length, 1);
    }),
  );

  it.effect("interaction webhooks: a 404 (not processed yet) is tried again 400 ms, 800 ms, 1.2 s later", () =>
    Effect.gen(function* () {
      const { layer, seen } = yield* fake(() => ({ status: 404, body: { message: "Unknown Webhook" } }));
      const r = yield* settle(Discord.use((d) => d.editOriginal("tok", { content: "x" })).pipe(Effect.provide(layer)));
      const s = yield* Ref.get(seen);
      assert.deepStrictEqual(gaps(s), [400, 800, 1200]);
      assert.isTrue(r._tag === "Success" && r.value?.status === 404 && r.value.ok === false);
    }),
  );
});

