// The gateway as a scoped resource (plan 05, phase 5 step 6; architecture.md §11), under TestClock with
// a fake connection: a snapshot is the full picture of voice and the channels; an outage isn't
// "everyone left"; a resume restores trust; a failed connect is retried at 2 s doubling to 60 s; a
// connect that hangs is given up after 30 s; a refused presence intent (4014) is reported once and
// the next connect goes without it; the term's end disconnects and stops trusting what we had.
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Exit, Layer, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";
import { GatewayDispatchEvents, GatewayIntentBits } from "discord-api-types/v10";
import { Gateway, GatewayClient, GatewayUnavailable, type GatewayEvent } from "../src/gateway.js";
import { Presence } from "../src/presence.js";
import { Channels } from "../src/channels.js";
import { AppConfig } from "../src/config.js";
import { Alerts } from "../src/alerts.js";
import { configFromEnv } from "../src/legacy.js";
import { testEnv } from "./pg.js";

const T0 = Date.parse("2026-11-10T19:00:00Z");
const flush = Effect.repeat(Effect.yieldNow, { times: 200 });
const adjust = (d: Parameters<typeof TestClock.adjust>[0]) => Effect.andThen(Effect.andThen(flush, TestClock.adjust(d)), flush);

type Attempt = "ok" | "fail" | "hang";

const setup = (attempts: ReadonlyArray<Attempt>, presences = false) =>
  Effect.gen(function* () {
    const opens = yield* Ref.make<{ at: number; intents: number }[]>([]);
    const destroyed = yield* Ref.make(0);
    const failed = yield* Ref.make<string[]>([]);
    const snapshots = yield* Ref.make(0);
    let emit: (e: GatewayEvent) => void = () => {};
    const client = Layer.succeed(
      GatewayClient,
      GatewayClient.of({
        open: (intents, e) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            const n = (yield* Ref.updateAndGet(opens, (o) => [...o, { at, intents }])).length;
            emit = e;
            const how = attempts[Math.min(n, attempts.length) - 1];
            return {
              connect: how === "ok" ? Effect.void : how === "fail" ? Effect.fail(new GatewayUnavailable({ detail: "Error: boom" })) : Effect.never,
              destroy: Ref.update(destroyed, (d) => d + 1),
            };
          }),
      }),
    );
    const config = Layer.succeed(AppConfig, { ...configFromEnv(testEnv({} as never)), guildId: "g", presences });
    const layer = Gateway.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(Presence.layer, Channels.layer)),
      Layer.provide(Layer.mergeAll(client, config, Layer.mock(Alerts, { failed: (what: string) => Ref.update(failed, (f) => [...f, what]) }))),
    );
    return { layer, opens, destroyed, failed, snapshots, emit: (e: GatewayEvent) => emit(e) };
  });

const dispatch = (t: string, d: object): GatewayEvent => ({ _tag: "Dispatch", payload: { op: 0, s: 1, t, d } as never });
const guild = (voice: { user_id: string; channel_id: string }[]) =>
  dispatch(GatewayDispatchEvents.GuildCreate, { id: "g", voice_states: voice, channels: [{ id: "lobby", name: "Lobby", type: 2, position: 0 }], presences: [] });

describe("the gateway (TestClock)", () => {
  it.effect("a snapshot is the full picture; a move is seen; an outage and a drop stop the trust; a resume restores it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup(["ok"]);
      yield* Effect.gen(function* () {
        const p = yield* Presence;
        const ch = yield* Channels;
        yield* Gateway.use((g) => g.hold(Ref.update(s.snapshots, (n) => n + 1)));
        yield* flush;
        assert.strictEqual(yield* p.channelOf("a"), undefined); // nothing yet: lookups fall back to REST
        s.emit(guild([{ user_id: "a", channel_id: "lobby" }]));
        yield* flush;
        assert.strictEqual(yield* p.channelOf("a"), "lobby");
        assert.strictEqual(yield* Ref.get(s.snapshots), 1);
        assert.strictEqual((yield* ch.cached)?.length, 1);
        s.emit(dispatch(GatewayDispatchEvents.VoiceStateUpdate, { guild_id: "g", user_id: "a", channel_id: "room" }));
        s.emit(dispatch(GatewayDispatchEvents.VoiceStateUpdate, { guild_id: "elsewhere", user_id: "a", channel_id: "x" }));
        yield* flush;
        assert.strictEqual(yield* p.channelOf("a"), "room");
        s.emit({ _tag: "Closed", code: 1006 });
        yield* flush;
        assert.strictEqual(yield* p.channelOf("a"), undefined);
        s.emit({ _tag: "Resumed" });
        yield* flush;
        assert.strictEqual(yield* p.channelOf("a"), "room");
        s.emit(dispatch(GatewayDispatchEvents.GuildCreate, { id: "g", unavailable: true }));
        yield* flush;
        assert.strictEqual(yield* p.channelOf("a"), undefined); // an outage isn't "everyone left"
        assert.strictEqual(yield* ch.cached, null);
        assert.strictEqual(yield* Ref.get(s.snapshots), 1);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("a failed connect is retried at 2 s, doubling to a minute, each failed attempt torn down", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup(["fail", "fail", "fail", "fail", "fail", "fail", "fail", "ok"]);
      yield* Effect.gen(function* () {
        yield* Gateway.use((g) => g.hold(Effect.void));
        for (let i = 0; i < 10; i++) yield* adjust("1 minute");
        const gaps = (yield* Ref.get(s.opens)).map((o, i, all) => (i ? (o.at - all[i - 1].at) / 1000 : 0));
        assert.deepStrictEqual(gaps, [0, 2, 4, 8, 16, 32, 60, 60]);
        assert.strictEqual(yield* Ref.get(s.destroyed), 7);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("a connect that hangs is given up after 30 s and tried again", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup(["hang", "ok"]);
      yield* Effect.gen(function* () {
        yield* Gateway.use((g) => g.hold(Effect.void));
        yield* adjust("29 seconds");
        assert.strictEqual((yield* Ref.get(s.opens)).length, 1);
        assert.strictEqual(yield* Ref.get(s.destroyed), 0);
        yield* adjust("1 second");
        assert.strictEqual(yield* Ref.get(s.destroyed), 1);
        yield* adjust("2 seconds");
        assert.deepStrictEqual((yield* Ref.get(s.opens)).map((o) => (o.at - T0) / 1000), [0, 32]);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("a refused presence intent is reported once, and the next connect goes without it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup(["ok"], true);
      yield* Effect.gen(function* () {
        const term = yield* Scope.make();
        yield* Gateway.use((g) => g.hold(Effect.void)).pipe(Scope.provide(term));
        yield* flush;
        s.emit({ _tag: "Closed", code: 4014 });
        s.emit({ _tag: "Closed", code: 4014 });
        yield* flush;
        assert.deepStrictEqual(yield* Ref.get(s.failed), ["connecting with the presence intent"]);
        yield* Scope.close(term, Exit.void);
        yield* Gateway.use((g) => g.hold(Effect.void));
        yield* flush;
        const [first, second] = (yield* Ref.get(s.opens)).map((o) => o.intents);
        assert.isTrue((first & GatewayIntentBits.GuildPresences) !== 0);
        assert.strictEqual(second, GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("the term's end disconnects and stops trusting what we had", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup(["ok"]);
      yield* Effect.gen(function* () {
        const p = yield* Presence;
        const term = yield* Scope.make();
        yield* Gateway.use((g) => g.hold(Effect.void)).pipe(Scope.provide(term));
        yield* flush;
        s.emit(guild([{ user_id: "a", channel_id: "lobby" }]));
        yield* flush;
        assert.strictEqual(yield* p.channelOf("a"), "lobby");
        yield* Scope.close(term, Exit.void);
        assert.strictEqual(yield* Ref.get(s.destroyed), 1);
        assert.strictEqual(yield* p.channelOf("a"), undefined);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );
});
