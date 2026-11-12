// Reacting to voice as it happens (leader only; presence.ts is fed by the gateway):
//   • every join, leave and move is recorded for 📊 stats right away, plus a heartbeat every
//     minute while anyone's in voice
//   • someone joining the Lobby during a game night is pulled into the game's room at once
//   • when a room empties, its 15-minute wrap-up timer starts; it fires exactly on time
//   • 🎮 spontaneous play (spontaneous.ts): the Lobby question, unplanned sessions, pulling people in
import { Cause, Clock, Context, Duration, Effect, Fiber, FiberHandle, Layer, PubSub, Queue, Schedule, type Scope } from "effect";
import { AppConfig, players } from "./config.js";
import { Presence } from "./presence.js";
import { Activity } from "./activity.js";
import { Voice } from "./voice.js";
import { LateSlips } from "./late.js";
import { Spontaneous, type Change } from "./spontaneous.js";
import { Alerts } from "./alerts.js";
import { Background } from "./background.js";
import { nowSec } from "./clock.js";
import { jsonText } from "./json.js";

const HEARTBEAT = Duration.minutes(1);
const RETRY = 60_000; // ms: a wrap-up already due means it just failed (Discord trouble): look again in a minute
const MAX_TIMER = 2 ** 31 - 1; // ms: setTimeout's limit, which the old timers kept to

/** One thing to handle, in order: Live's queue holds these. */
type LiveEvent =
  | { readonly _tag: "Moved"; readonly user: string; readonly from: string | null; readonly to: string | null; readonly at: number }
  | { readonly _tag: "Playing" }
  | { readonly _tag: "Heartbeat" }
  | { readonly _tag: "WrapUpDue" }
  | { readonly _tag: "LobbyDue" }
  | { readonly _tag: "Resync" }
  | { readonly _tag: "Stop" };

const labels: Record<LiveEvent["_tag"], string> = {
  Moved: "voice change",
  Playing: "playing",
  Heartbeat: "heartbeat",
  WrapUpDue: "wrap-up",
  LobbyDue: "lobby",
  Resync: "resync",
  Stop: "stop",
};

export class Live extends Context.Service<
  Live,
  {
    /**
     * Watch voice for a leader's term: changes are handled one at a time, in order, so a quick
     * leave-and-rejoin can't race itself; one change's failure is reported and the next is still
     * handled. Gives back `resync`, for when the gateway (re)connects with a fresh snapshot. When the
     * scope closes, nothing new is taken and what's queued is still handled; timers stop.
     */
    readonly watch: Effect.Effect<{ readonly resync: Effect.Effect<void> }, never, Scope.Scope>;
  }
>()("meme-bot/live") {
  static readonly layer = Layer.effect(
    Live,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const presence = yield* Presence;
      const activity = yield* Activity;
      const voice = yield* Voice;
      const late = yield* LateSlips;
      const spontaneous = yield* Spontaneous;
      const alerts = yield* Alerts;
      const background = yield* Background;

      const watch = Effect.gen(function* () {
        const ps = new Set(yield* Effect.provideService(players, AppConfig, config)); // the stand-ins of an admin call, or the trio
        const queue = yield* Queue.unbounded<LiveEvent>();
        const heartbeat = yield* FiberHandle.make();
        const wrapUp = yield* FiberHandle.make();
        const lobbyTimer = yield* FiberHandle.make();
        const offer = (e: LiveEvent) => Queue.offer(queue, e);
        /** A timer that queues `e` in `ms`; setting one replaces the one before. */
        const timer = (handle: FiberHandle.FiberHandle, ms: number, e: LiveEvent) =>
          FiberHandle.run(handle, Effect.sleep(Duration.millis(Math.min(ms, MAX_TIMER))).pipe(Effect.andThen(offer(e))));

        const where = Effect.map(
          Effect.forEach([...ps], (p) => Effect.map(presence.lastKnown(p), (c) => [p, c] as const)),
          (pairs) => new Map(pairs),
        );
        const occupied = Effect.map(where, (w) => new Set([...w.values()].filter((c): c is string => !!c)));

        /** Re-check rooms now, and set a timer for the next empty room's wrap-up. */
        const checkRooms = Effect.gen(function* () {
          if (!(yield* presence.isReady)) return;
          const { archived, nextDue } = yield* voice.checkRooms(yield* occupied);
          if (archived.length) yield* Effect.logInfo(`rooms wrapped up ${archived.join(", ")}`);
          yield* FiberHandle.clear(wrapUp);
          if (nextDue === null) return;
          const now = yield* Clock.currentTimeMillis;
          yield* timer(wrapUp, nextDue * 1000 <= now ? RETRY : nextDue * 1000 - now + 500, { _tag: "WrapUpDue" });
        });

        /** 🎮 Spontaneous play, and a timer for whatever it says is due next (the question's 30 s, say). */
        const lobby = (change?: Change) =>
          Effect.gen(function* () {
            if (!(yield* presence.isReady)) return;
            const due = yield* spontaneous.react(yield* where, yield* nowSec, change);
            yield* FiberHandle.clear(lobbyTimer);
            if (due === null) return;
            yield* timer(lobbyTimer, Math.max(1000, due * 1000 - (yield* Clock.currentTimeMillis) + 500), { _tag: "LobbyDue" });
          });

        const beat = Effect.gen(function* () {
          if (!(yield* presence.isReady)) return; // never record "nobody's here" just because we can't see
          const w = yield* where;
          yield* activity.track(w, yield* nowSec);
          const anyone = [...w.values()].some(Boolean);
          if (anyone) yield* FiberHandle.run(heartbeat, Effect.repeat(Effect.delay(offer({ _tag: "Heartbeat" }), HEARTBEAT), Schedule.forever), { onlyIfMissing: true });
          else yield* FiberHandle.clear(heartbeat);
          // busy rooms: keep their last_seen fresh (and their night's event alive)
          if (anyone) yield* checkRooms;
          if (anyone) yield* lobby();
        });

        const handle = (e: LiveEvent) => {
          switch (e._tag) {
            case "Moved":
              return Effect.gen(function* () {
                if (!(yield* presence.hasSnapshot)) return;
                if (e.from) yield* voice.leftRoom(e.from, e.at);
                if (e.to === config.lobbyChannelId) {
                  const r = yield* late.watch;
                  if (Object.keys(r).length) yield* Effect.logInfo(`late ${jsonText(r)}`);
                }
                yield* activity.track(yield* where, e.at);
                yield* beat;
                yield* checkRooms;
                yield* lobby({ user: e.user, from: e.from, to: e.to });
              });
            case "Playing":
            case "LobbyDue":
              return lobby();
            case "Heartbeat":
              return beat;
            case "WrapUpDue":
              return checkRooms;
            case "Resync":
              return Effect.gen(function* () {
                yield* beat;
                yield* checkRooms;
                yield* lobby();
              });
            case "Stop":
              return Effect.void;
          }
        };

        // the voice event loop: one event at a time; a failure is reported (architecture §6) and the loop goes on
        const consumer = yield* Effect.forkScoped(
          Effect.gen(function* () {
            for (;;) {
              const e = yield* Queue.take(queue);
              if (e._tag === "Stop") return;
              yield* handle(e).pipe(
                Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : alerts.failed(`live voice (${labels[e._tag]})`, Cause.squash(cause)))),
              );
            }
          }),
        );

        // presence's changes, as events for the players
        const changes = yield* presence.changes;
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const c = yield* PubSub.take(changes);
              if (!ps.has(c.user)) return;
              if (c._tag === "Moved") return yield* offer(c);
              yield* Effect.logInfo(`playing ${c.user} ${c.names.length ? c.names.join(" | ") : "(nothing)"}`); // what Discord calls each game
              // what someone's playing changed: it may be time to get a room ready
              yield* offer({ _tag: "Playing" });
              // a name we don't know: Gemini may place it, in the background (it can take minutes; nothing
              // waits, and it isn't cut short when the term ends: background work drains at shutdown)
              yield* background.run(
                spontaneous.learn(c.names).pipe(
                  Effect.tap((l) => (l.length ? Effect.logInfo(`learned ${jsonText(l)}`) : Effect.void)),
                  Effect.catch((e) => Effect.logInfo(`learning a game name failed ${e}`)),
                ),
                "learning a game name",
              );
            }),
          ),
        );

        // the term's end: what's queued is still handled (this runs first: a Stop goes in behind it and
        // the loop is waited for; the subscription and the timers close after)
        yield* Effect.addFinalizer(() => Effect.andThen(offer({ _tag: "Stop" }), Fiber.await(consumer)));

        return { resync: Effect.asVoid(offer({ _tag: "Resync" })) };
      });

      return Live.of({ watch });
    }),
  );
}
