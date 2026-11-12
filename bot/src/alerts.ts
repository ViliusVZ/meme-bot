// 🚨 When something breaks (a card that didn't post, a start that missed its second, a tap that
// errored, a crash), the bot DMs its owner (ALERT_USER_ID, set for production only) so they hear
// about it before the trio does. The same problem again within 3 hours is counted, not re-sent, and
// there's a cap overall, so a bad day is a handful of DMs, never a flood.
import { Clock, Context, Deferred, Effect, Layer, Queue, Ref } from "effect";
import { AppConfig } from "./config.js";
import { Discord } from "./discord.js";
import { Presence } from "./presence.js";

const QUIET_FOR = 3 * 3600_000; // the same problem again within this: counted, mentioned next time
const BURST = 5; // at most this many DMs…
const BURST_WINDOW = 10 * 60_000; // …in any 10 minutes
const GATEWAY_GRACE = 5 * 60; // seconds without the gateway before it's worth a DM (reconnects take seconds)

/** The DM itself: what broke, where, the error, and how to read the logs. */
export function alertMessage(what: string, detail: string, context: unknown[], again: string, app: string, nowMs: number) {
  const where = context.length ? ` · ${context.map(String).join(" · ")}` : "";
  const logs = app.replace(/-(blue|green)$/, ""); // app-logs covers both colours, across deploys
  const lines = detail.split("\n").slice(0, 6).join("\n").slice(0, 1200);
  return [
    `🚨 **${what}** failed${where}${again}`,
    "```",
    lines,
    "```",
    `-# ${app} · <t:${Math.floor(nowMs / 1000)}:f> · logs: \`ssh vps app-logs ${logs} 1h\``,
  ].join("\n");
}

/**
 * The error as the DM quotes it: its stack, or its text. A typed error's first line starts with its
 * tag ("DiscordUnavailable: POST … -> gave up: 500"); the DM keeps today's wording ("Error: …").
 */
const detailOf = (error: unknown) => {
  if (!(error instanceof Error)) return String(error);
  const text = error.stack ?? error.message;
  const tag = (error as { _tag?: unknown })._tag;
  return typeof tag === "string" && text.startsWith(`${tag}: `) ? `Error: ${text.slice(tag.length + 2)}` : text;
};

// `at`: when the problem was reported (the DM goes out a moment later, one at a time)
type Job = { what: string; detail: string; context: unknown[]; at: number; done: Deferred.Deferred<void> };

export class Alerts extends Context.Service<
  Alerts,
  {
    /** Log a failure the way we always have (`<what> failed …`), and DM the owner about it. Never fails. */
    failed(what: string, error: unknown, ...context: unknown[]): Effect.Effect<void>;
    /** DM the owner about a problem (logged by the caller). Never fails; DMs go out one at a time. */
    report(what: string, error: unknown, context?: unknown[]): Effect.Effect<void>;
    /** Who gets the DMs (main.ts: ALERT_USER_ID); none on the test bot and in tests. */
    setOwner(userId: string | undefined): Effect.Effect<void>;
    /** 🧪 The admin route's test: proves DMs reach someone (the owner by default). */
    test(to: string | undefined): Effect.Effect<{ sent: string } | { skipped: string }, import("./discord.js").DiscordError>;
    /** A minute job: say so if the gateway has been down 5 minutes (once per outage). */
    readonly watchGateway: Effect.Effect<{ gatewayDown?: number }>;
    /** Tests: wait for the DMs queued so far. */
    readonly settle: Effect.Effect<void>;
    /** Tests: forget throttles and the DM channel. */
  }
>()("meme-bot/alerts") {
  static readonly layer = Layer.effect(
    Alerts,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const discord = yield* Discord;
      const presence = yield* Presence;
      const owner = yield* Ref.make<string | undefined>(config.alertUserId);
      const fresh = () => ({ seen: new Map<string, { at: number; held: number }>(), recent: [] as number[], heldBack: 0, dmChannels: new Map<string, string>(), gatewayDown: null as number | null, gatewayReported: false });
      const state = yield* Ref.make(fresh());
      const queue = yield* Queue.unbounded<Job>();
      const last = yield* Ref.make<Deferred.Deferred<void> | null>(null);

      const dm = Effect.fnUntraced(function* (to: string, content: string) {
        let ch = (yield* Ref.get(state)).dmChannels.get(to);
        if (!ch) {
          const opened = (yield* discord.createDm(to)).id;
          ch = opened;
          yield* Ref.update(state, (s) => ({ ...s, dmChannels: new Map(s.dmChannels).set(to, opened) }));
        }
        return yield* discord.createMessage(ch, { content, allowed_mentions: { parse: [] } });
      });

      const send = Effect.fnUntraced(function* (job: Job) {
        const to = yield* Ref.get(owner);
        if (!to) return;
        // the same failure on another day or channel is still the same problem
        const key = `${job.what}|${job.detail.split("\n")[0].replace(/\d+/g, "#").slice(0, 160)}`;
        const now = job.at;
        const s = yield* Ref.get(state);
        const prev = s.seen.get(key);
        if (prev && now - prev.at < QUIET_FOR) {
          yield* Ref.update(state, (x) => ({ ...x, seen: new Map(x.seen).set(key, { ...prev, held: prev.held + 1 }) }));
          return;
        }
        const recent = s.recent.filter((t) => now - t < BURST_WINDOW);
        if (recent.length >= BURST) {
          yield* Ref.update(state, (x) => ({ ...x, recent, heldBack: x.heldBack + 1 }));
          return;
        }
        const again = prev?.held ? ` (${prev.held} more time${prev.held === 1 ? "" : "s"} since the last DM about it)` : "";
        const flood = s.heldBack ? `\n-# ${s.heldBack} other problem${s.heldBack === 1 ? " was" : "s were"} held back so this doesn't turn into a flood; the logs have them.` : "";
        yield* Ref.update(state, (x) => ({ ...x, recent: [...recent, now], seen: new Map(x.seen).set(key, { at: now, held: 0 }), heldBack: 0 }));
        yield* dm(to, alertMessage(job.what, job.detail, job.context, again, config.appName, now) + flood);
      });

      // one sender: DMs go out one at a time, in order; a failed DM is logged, never thrown into the caller
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const job = yield* Queue.take(queue);
            yield* send(job).pipe(Effect.catchCause((cause) => Effect.logWarning(`alert DM failed ${cause}`)));
            yield* Deferred.succeed(job.done, undefined);
          }),
        ),
      );

      const report = Effect.fn("Alerts.report")(function* (what: string, error: unknown, context: unknown[] = []) {
        if (!(yield* Ref.get(owner))) return;
        const done = yield* Deferred.make<void>();
        yield* Ref.set(last, done);
        yield* Queue.offer(queue, { what, detail: detailOf(error), context, at: yield* Clock.currentTimeMillis, done });
      });

      const failed = Effect.fn("Alerts.failed")(function* (what: string, error: unknown, ...context: unknown[]) {
        yield* Effect.logWarning(`${what} failed${context.length ? ` ${context.map(String).join(" ")}` : ""}`).pipe(Effect.annotateLogs({ error: detailOf(error) }));
        yield* report(what, error, context);
      });

      return Alerts.of({
        failed,
        report,
        setOwner: (userId) => Ref.set(owner, userId),
        test: Effect.fn("Alerts.test")(function* (to: string | undefined) {
          if (!to) return { skipped: "no ALERT_USER_ID and no user given" };
          yield* dm(to, "🧪 Test alert from Meme Bot 3000: if something breaks, I'll DM you here, like this. Nothing's wrong right now.");
          return { sent: to };
        }),
        /**
         * The leader holds the Discord gateway for live voice (Lobby pulls, room wrap-ups, stats). It
         * reconnects on its own within seconds; if it's still down after 5 minutes, say so.
         */
        watchGateway: Effect.gen(function* () {
          const t = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          if (yield* presence.isReady) {
            yield* Ref.update(state, (s) => ({ ...s, gatewayDown: null, gatewayReported: false }));
            return {};
          }
          const s = yield* Ref.updateAndGet(state, (x) => ({ ...x, gatewayDown: x.gatewayDown ?? t }));
          if (s.gatewayReported || t - s.gatewayDown! < GATEWAY_GRACE) return {};
          yield* Ref.update(state, (x) => ({ ...x, gatewayReported: true }));
          const mins = Math.round((t - s.gatewayDown!) / 60);
          yield* Effect.logWarning(`gateway down ${mins} min`);
          yield* report("staying connected to Discord", `no gateway connection for ${mins} min: Lobby pulls, room wrap-ups and voice stats fall back to slower checks until it's back`);
          return { gatewayDown: mins };
        }).pipe(Effect.withSpan("Alerts.watchGateway")),
        settle: Effect.gen(function* () {
          const d = yield* Ref.get(last);
          if (d) yield* Deferred.await(d);
        }),
      });
    }),
  );
}
