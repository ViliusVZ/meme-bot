// HTTP: Discord interactions, meme intake from the GitHub fetcher, admin/test routes, health.
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { sql } from "drizzle-orm";
import { ByteSize, Cause, Clock, Context, Effect, Fiber, Layer, Match, Redacted, Schema } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import type { Env } from "./env.js";
import { memes } from "./db/index.js";
import { Db } from "./db/db.js";
import { AppConfig, withOverrides } from "./config.js";
import { Discord, EPHEMERAL, Response as R } from "./discord.js";
import { verifySignature } from "./verify.js";
import { Background } from "./background.js";
import { Interactions } from "./interactions.js";
import { Memes } from "./memes.js";
import { memeMessage } from "./ui.js";
import { Jobs } from "./jobs.js";
import { GameNight, type Deferred } from "./gamenight.js";
import { Hub } from "./hub.js";
import { Polls } from "./polls.js";
import { Voice } from "./voice.js";
import { Activity, type Kind } from "./activity.js";
import { Spontaneous } from "./spontaneous.js";
import { LateSlips } from "./late.js";
import { Attendances } from "./attendance.js";
import { Presence } from "./presence.js";
import { Alerts } from "./alerts.js";
import { Lifecycle } from "./lifecycle.js";
import { LocalTime } from "./localtime.js";
import { nowIso, nowSec } from "./clock.js";
import { Ticker } from "./scheduler.js";
import { appContext, runDetached } from "./legacy.js"; // LEGACY-BRIDGE
import type { AppServices } from "./runtime.js";

export const COMMANDS = [
  { name: "meme", description: "Summon a fresh top meme right now" },
  {
    name: "top",
    description: "The server's favourite memes",
    options: [
      {
        type: 3,
        name: "period",
        description: "Time range (default: this week)",
        choices: [
          { name: "This week", value: "week" },
          { name: "This month", value: "month" },
          { name: "All time", value: "all" },
        ],
      },
    ],
  },
  {
    name: "stats",
    description: "Meme voting stats, streak and persona",
    options: [{ type: 6, name: "user", description: "Whose stats (default: yours)" }],
  },
  { name: "hall-of-fame", description: "The 10 greatest memes this server has ever voted on" },
  { name: "playtoday", description: "Start today's game-night poll right now (counts as your yes)" },
  { name: "plan", description: "Plan a game night for any day this week" },
  { name: "snooze", description: "Pause the daily game-night poll for 3 days, a week or a month" },
  { name: "poll", description: "Ask the trio a question and let democracy decide" },
  { name: "games", description: "See, add or remove games in the game-night list" },
  { name: "room", description: "Open a voice room for a game and bring everyone from the Lobby" },
  { name: "gamestats", description: "Voice time, calls and games played: this week, month, year or all time" },
  { name: "help", description: "How to use Meme Bot 3000" },
];

/** What /health and the signature check read: whether we lead, whether we're shutting down, the key. */
export class AppStatus extends Context.Service<
  AppStatus,
  { readonly leader: Effect.Effect<boolean>; readonly shuttingDown: Effect.Effect<boolean>; readonly publicKey: string }
>()("meme-bot/app/AppStatus") {
  static readonly layer = Layer.effect(
    AppStatus,
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle;
      const config = yield* AppConfig;
      return AppStatus.of({ leader: lifecycle.leader, shuttingDown: lifecycle.shuttingDown, publicKey: config.discordPublicKey });
    }),
  );
}

/** Constant-time bearer check. */
function authorized(header: string | undefined, secret: string) {
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The request didn't get as far as our code (too large, unreadable): the sender's problem, not reported. */
class NotOurs extends Schema.TaggedError<NotOurs>()("NotOurs", { text: Schema.String }) {}

const BODY_LIMIT = ByteSize.mebibytes(1);
/** A failure as Fastify's error handler printed it (`String(e)`), which the 500 answer carries. */
const errorText = (e: unknown) => (e instanceof NotOurs ? e.text : e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? `Error: ${e.message}` : String(e));
const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const nope = HttpServerResponse.text("nope", { status: 401 });

/** The body as text, within the limit (a larger one is the sender's problem, as Fastify had it). */
const bodyText = (req: HttpServerRequest.HttpServerRequest) =>
  req.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, BODY_LIMIT),
    Effect.mapError(() => new NotOurs({ text: "FastifyError [FST_ERR_CTP_BODY_TOO_LARGE]: Request body is too large" })),
  );
/** A JSON body, or {} for none or garbage (the admin and ingest routes always read it this way). */
const parse = (req: HttpServerRequest.HttpServerRequest) =>
  Effect.map(bodyText(req), (text): Record<string, any> => {
    if (!text) return {};
    const r = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text);
    return r._tag === "Some" && r.value && typeof r.value === "object" ? (r.value as Record<string, any>) : {};
  });

export const Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const db = yield* Db;
    const discord = yield* Discord;
    const status = yield* AppStatus;
    const background = yield* Background;
    const interactions = yield* Interactions;
    const memeService = yield* Memes;
    const jobs = yield* Jobs;
    const gameNight = yield* GameNight;
    const hub = yield* Hub;
    const polls = yield* Polls;
    const voice = yield* Voice;
    const activity = yield* Activity;
    const spontaneous = yield* Spontaneous;
    const late = yield* LateSlips;
    const attendances = yield* Attendances;
    const presence = yield* Presence;
    const ticker = yield* Ticker;
    const alerts = yield* Alerts;
    const time = yield* LocalTime;

    /**
     * Any failure a route lets through answers 500 { error } and is reported when it's ours, as
     * Fastify's error handler did (a route is a boundary for what its handler lets through).
     */
    const route = <E>(method: "GET" | "POST", path: HttpRouter.PathInput, handler: (req: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E>) =>
      router.add(method, path, (req) =>
        handler(req).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
            const e = Cause.squash(cause);
            return Effect.gen(function* () {
              yield* Effect.logInfo(`http error ${req.method} ${req.url} ${errorText(e)}`);
              if (!(e instanceof NotOurs)) yield* alerts.report(`${req.method} ${req.url.split("?")[0]}`, e);
              return json({ error: errorText(e) }, 500);
            });
          }),
        ),
      );
    /** An admin route: the bearer check first. */
    const admin = <E>(path: HttpRouter.PathInput, handler: (req: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E>) =>
      route("POST", path, (req) => (authorized(req.headers.authorization, Redacted.value(config.adminSecret)) ? handler(req) : Effect.succeed(nope)));
    const answer = (value: unknown) => (value === undefined ? HttpServerResponse.empty() : json(value));

    yield* route("GET", "/health", () =>
      Effect.gen(function* () {
        // ready to serve clicks: the database answers. (Leadership is separate: a follower serves too.)
        if (yield* status.shuttingDown) return json({ ok: false, shuttingDown: true }, 503);
        const failed = yield* db.execute(sql`SELECT 1`).pipe(
          Effect.as(null),
          Effect.catch((e) => Effect.succeed(String(e))),
        );
        if (failed) return json({ ok: false, db: failed }, 503);
        // the server's watchdog reads the rest: one copy should lead, and its clock should keep ticking
        return json({
          ok: true,
          leader: yield* status.leader,
          clock: yield* ticker.sinceTick,
          gateway: yield* presence.isReady,
          background: yield* background.inFlight,
          uptime: Math.round(process.uptime()),
          version: config.revision,
        });
      }),
    );

    yield* route("GET", "/", () => Effect.succeed(HttpServerResponse.text("Meme Bot 3000 🔥")));

    yield* route("POST", "/interactions", (req) =>
      Effect.gen(function* () {
        const body = yield* bodyText(req);
        const ok = yield* verifySignature(req.headers["x-signature-ed25519"], req.headers["x-signature-timestamp"], body, status.publicKey);
        if (!ok) return HttpServerResponse.text("bad signature", { status: 401 });
        const i = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body);
        const raw = (i ?? {}) as { type?: number; data?: { custom_id?: string; name?: string }; member?: { user?: { username?: string } }; user?: { username?: string }; message?: { flags?: number } };
        const what = raw.data?.custom_id ?? (raw.data?.name ? `/${raw.data.name}` : `type ${raw.type}`);
        const who = (raw.member?.user ?? raw.user)?.username;
        const t0 = yield* Clock.currentTimeMillis;
        // a tap is a boundary: whatever its handler lets through is reported, and they get an apology
        const out = yield* interactions.handle(i).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const ms = Math.round((yield* Clock.currentTimeMillis) - t0);
              // every tap/command with its handling time, who and where (three users: a few lines a day), slow ones flagged
              const where = (raw.message?.flags ?? 0) & EPHEMERAL ? "panel" : raw.message ? "public" : "";
              yield* Effect.logInfo(`${ms > 1500 ? "slow interaction" : "interaction"} ${ms} ms ${what} ${who} ${where}`);
              // past 3 s Discord has already shown them "This interaction failed"
              if (ms > 3000) yield* alerts.report(`a tap (${what})`, `took ${ms} ms, past Discord's 3-second limit, so ${who} saw "This interaction failed"`);
            }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.as(alerts.failed(`a tap (${what})`, Cause.squash(cause), who), {
                  type: R.Message,
                  data: { content: "Something went wrong on my end 🤕 Try again in a moment.", flags: EPHEMERAL },
                }),
          ),
        );
        return json(out);
      }),
    );

    yield* route("POST", "/ingest", (req) =>
      Effect.gen(function* () {
        if (!authorized(req.headers.authorization, Redacted.value(config.ingestSecret))) return nope;
        const input = yield* parse(req);
        const ingested = yield* memeService.ingest(input.memes ?? []);
        const daily = input.post_daily ? yield* jobs.postDaily : null;
        return json({ ingested, daily });
      }),
    );

    // ---------------------------------------------------------------- admin (maintenance + QA)

    // raw bot-token passthrough for maintenance scripts
    yield* admin("/admin/discord", (req) =>
      Effect.gen(function* () {
        const input = yield* parse(req);
        return answer(yield* discord.request(input.method ?? "GET", input.path, input.body ?? undefined).pipe(Effect.catch((e) => Effect.succeed({ error: errorText(e) }))));
      }),
    );

    yield* admin("/admin/register", () => Effect.map(discord.registerCommands(COMMANDS), answer));

    // redraw every posted meme with its current votes and who cast them (after a card change)
    yield* admin("/admin/refresh-memes", () =>
      Effect.gen(function* () {
        const posted = yield* db.select().from(memes).where(sql`${memes.message_id} IS NOT NULL AND ${memes.channel_id} IS NOT NULL`);
        const out = { updated: 0, failed: [] as string[] };
        for (const m of posted) {
          yield* Effect.gen(function* () {
            yield* discord.editMessage(m.channel_id!, m.message_id!, memeMessage(m, yield* memeService.tally(m.id), config.subreddit, yield* memeService.voters(m.id)));
            out.updated++;
          }).pipe(Effect.catch((e) => Effect.sync(() => void out.failed.push(`${m.id}: ${errorText(e).slice(0, 80)}`))));
        }
        return json(out);
      }),
    );

    yield* admin("/admin/recap", (req) => Effect.flatMap(parse(req), (input) => Effect.map(input.period === "month" ? jobs.monthlyRecap : jobs.weeklyRecap, answer)));

    // seed ids that were posted before the bot had a database
    yield* admin("/admin/mark-posted", (req) =>
      Effect.gen(function* () {
        const ids: string[] = (yield* parse(req)).ids ?? [];
        const at = yield* nowIso;
        if (ids.length)
          yield* db
            .insert(memes)
            .values(ids.map((id) => ({ id, title: "(posted before DB)", image: "", link: "", author: "", published: "", ingested_at: at, post_kind: "request" as const, posted_at: at })))
            .onConflictDoUpdate({
              target: memes.id,
              set: { post_kind: sql`COALESCE(${memes.post_kind}, 'request')`, posted_at: sql`COALESCE(${memes.posted_at}, excluded.posted_at)` },
            });
        return json({ ok: true });
      }),
    );

    // testing without pinging anyone
    yield* admin("/admin/gamenight", (req) =>
      Effect.gen(function* () {
        const input = yield* parse(req);
        const quiet = withOverrides({ quiet: true });
        // 📊🎮 QA with stand-in players, so real voice time is never touched
        const standIns = withOverrides({ quiet: true, ...(input.players ? { players: String(input.players).split(",").map((s) => s.trim()).filter(Boolean) } : {}) });
        const today = Effect.map(time.now, (l) => l.day);
        return yield* Match.value(String(input.action)).pipe(
          Match.when("start", () => Effect.map(quiet(gameNight.startNight(input.user, true)), answer)),
          Match.when("tick", () => Effect.map(quiet(jobs.minute), answer)),
          Match.when("stats", () =>
            standIns(
              Effect.gen(function* () {
                if (input.track) {
                  yield* activity.track(new Map(Object.entries(input.track as Record<string, string | null>)), Number(input.t));
                  return answer({ tracked: true });
                }
                if (input.recaps) return answer(yield* activity.recaps);
                return answer(yield* activity.statsPanel((input.kind ?? "week") as Kind, Number(input.offset ?? 0)));
              }),
            ),
          ),
          Match.when("lobby", () =>
            standIns(
              Effect.gen(function* () {
                // 🎮 where everyone is at `t`, then the bot's reaction to it
                const t = Number(input.t ?? (yield* nowSec));
                if (input.answer) return answer({ notice: yield* spontaneous.answer(Number(input.answer.id), input.answer.user, input.answer.what, input.answer.game) });
                if (input.minute) return answer(yield* spontaneous.minute(t));
                // "LOBBY" stands for the configured Lobby, so a script needn't know its id
                const where = new Map(Object.entries((input.where ?? {}) as Record<string, string | null>).map(([u, c]) => [u, c === "LOBBY" ? config.lobbyChannelId : c]));
                yield* activity.track(where, t);
                return answer({ due: yield* spontaneous.react(where, t, input.change) });
              }),
            ),
          ),
          Match.when("precise", () => quiet(Effect.flatMap(nowSec, (now) => Effect.map(gameNight.preciseStarts(now + Number(input.within ?? 120)), answer)))),
          Match.when("watch", () =>
            quiet(
              Effect.gen(function* () {
                // re-check open rooms against who's in voice right now
                const where = yield* voice.whereIs;
                if (!where) return answer({ error: "voice lookup failed" });
                return answer(yield* voice.checkRooms(new Set([...where.values()].filter((c): c is string => !!c))));
              }),
            ),
          ),
          Match.when("reset", () => Effect.flatMap(input.day ? Effect.succeed(String(input.day)) : today, (day) => Effect.map(gameNight.resetNight(day), answer))),
          Match.when("plan", () => Effect.map(quiet(gameNight.startNight(input.user, true, input.day)), answer)),
          Match.when("room", () => Effect.map(voice.openRoom(input.game, input.emoji ?? null, { by: input.user }), answer)),
          Match.when("rooms", () => Effect.map(voice.maintainRooms, answer)),
          Match.when("late", () =>
            Effect.gen(function* () {
              // simulate a late-slip click by its owner, then update the slip
              const r = yield* quiet(late.act(input.day, input.user, input.clicker ?? input.user, String(input.choice)));
              const row = yield* attendances.get(input.day, input.user);
              if (!r.notice && row?.message_id) yield* discord.editMessage(config.gameChannelId, row.message_id, yield* attendances.render(input.day, input.user));
              return answer({ ...r, row });
            }),
          ),
          Match.when("poll-vote", () =>
            quiet(
              Effect.gen(function* () {
                const r = yield* polls.act(Number(input.poll), input.user, String(input.choice));
                yield* polls.refresh(Number(input.poll));
                return answer(r);
              }),
            ),
          ),
          // 🚨 proves alert DMs arrive: to the owner, or to `user` (the test bot has no owner set)
          Match.when("alert-test", () => Effect.map(alerts.test(input.user), answer)),
          Match.when("poll-render", () => Effect.map(polls.render(Number(input.poll), input.user), answer)),
          // someone's private copy of a card (what they see after tapping it)
          Match.when("copy", () => Effect.flatMap(input.day ? Effect.succeed(String(input.day)) : today, (day) => Effect.map(gameNight.render(day, input.user), answer))),
          Match.when("hub", () =>
            Effect.gen(function* () {
              // update the pinned panel in place (the given one, or ours that's already pinned); only
              // post and pin a new one when there's none
              let existing: string | undefined = input.message;
              if (!existing) {
                const pins = (yield* discord.pins(config.gameChannelId)) as unknown;
                const list: { id?: string; author?: { id?: string }; components?: unknown[] }[] = Array.isArray(pins)
                  ? pins
                  : ((pins as { items?: { message: { id?: string } }[] } | null)?.items ?? []).map((p) => p.message);
                existing = list.find((m) => m?.author?.id === config.discordAppId && m.components?.length)?.id;
              }
              const panel = yield* hub.hubPanel;
              if (existing) return answer(yield* discord.editMessage(config.gameChannelId, existing, panel));
              const msg = yield* discord.createMessage(config.gameChannelId, panel);
              yield* discord.pin(config.gameChannelId, msg.id);
              return answer({ hub: msg.id });
            }),
          ),
          Match.when("vote", () =>
            quiet(
              Effect.gen(function* () {
                const day = input.day ?? (yield* today);
                // QA wants the side effects done before it looks: the tap's later work runs right here
                const pending: Parameters<Deferred>[0][] = [];
                const r = yield* gameNight.act(day, input.user, input.choice, input.value, (e) => Effect.sync(() => void pending.push(e)));
                yield* Effect.forEach(pending, (e) => Effect.ignore(e), { concurrency: "unbounded", discard: true });
                if (r.update) yield* gameNight.refresh(day);
                return answer(r);
              }),
            ),
          ),
          Match.orElse(() => Effect.succeed(json({ error: "action?" }, 400))),
        );
      }),
    );

    // an unknown route answers as Fastify did
    yield* router.add("*", "*", (req) =>
      Effect.succeed(json({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 }, 404)),
    );
  }),
);

/** The app's routes, on everything they need but the server and the status. */
const routesOn = (statusLayer: Layer.Layer<AppStatus>, context: Context.Context<AppServices>) =>
  Routes.pipe(Layer.provide(statusLayer), Layer.provide(Layer.succeedContext(context)));

export interface Status {
  leader: () => boolean;
  shuttingDown: () => boolean;
}

/**
 * The old app object, for the code that isn't on Effect yet: main.ts listens and closes it, the
 * tests inject requests (Fastify's `inject`, over the web handler).
 */
export function build(env: Env, status: Status) { // LEGACY-BRIDGE
  const statusLayer = Layer.succeed(AppStatus, AppStatus.of({ leader: Effect.sync(status.leader), shuttingDown: Effect.sync(status.shuttingDown), publicKey: env.DISCORD_PUBLIC_KEY })); // LEGACY-BRIDGE
  const webOn = (ctx: Context.Context<AppServices>) => HttpRouter.toWebHandler(routesOn(statusLayer, ctx).pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true }); // LEGACY-BRIDGE
  let web: Promise<ReturnType<typeof webOn>> | null = null; // LEGACY-BRIDGE
  let server: Fiber.Fiber<unknown, unknown> | null = null; // LEGACY-BRIDGE
  return { // LEGACY-BRIDGE
    async inject(o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) { // LEGACY-BRIDGE
      web ??= appContext().then(webOn); // LEGACY-BRIDGE
      const { handler } = await web; // LEGACY-BRIDGE
      const body = o.payload === undefined ? undefined : typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload); // LEGACY-BRIDGE
      const headers = { ...(body !== undefined && typeof o.payload !== "string" ? { "content-type": "application/json" } : {}), ...o.headers }; // LEGACY-BRIDGE
      const res = await handler(new Request(`http://local${o.url}`, { method: o.method, headers, body })); // LEGACY-BRIDGE
      const text = await res.text(); // LEGACY-BRIDGE
      return { statusCode: res.status, body: text, json: () => JSON.parse(text) }; // LEGACY-BRIDGE
    }, // LEGACY-BRIDGE
    async listen(o: { host: string; port: number }) { // LEGACY-BRIDGE
      const ctx = await appContext(); // LEGACY-BRIDGE
      const serve = HttpRouter.serve(routesOn(statusLayer, ctx), { disableLogger: true }).pipe(Layer.provide(NodeHttpServer.layer(createServer, { host: o.host, port: o.port, gracefulShutdownTimeout: "10 seconds" }))); // LEGACY-BRIDGE
      server = await runDetached(Effect.forkDetach(Layer.launch(serve))); // LEGACY-BRIDGE
    }, // LEGACY-BRIDGE
    async close() { // LEGACY-BRIDGE
      if (server) await runDetached(Fiber.interrupt(server)); // LEGACY-BRIDGE
    }, // LEGACY-BRIDGE
  }; // LEGACY-BRIDGE
} // LEGACY-BRIDGE
