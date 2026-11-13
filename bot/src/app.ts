// HTTP: Discord interactions, meme intake from the GitHub fetcher, admin/test routes, health.
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { sql } from "drizzle-orm";
import { ByteSize, Cause, Clock, Context, Duration, Effect, Fiber, Layer, Match, Redacted, Schema } from "effect";
import { count, taps, tapTime, time as timeIt } from "./metrics.js";
import { HttpIncomingMessage, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { memes } from "./db/schema.js";
import { Db } from "./db/db.js";
import { AppConfig, withOverrides } from "./config.js";
import { Discord, EPHEMERAL, Response as R } from "./discord.js";
import { importPublicKey, SignatureUnreadable, verifySignature } from "./verify.js";
import { Background } from "./background.js";
import { Interactions } from "./interactions.js";
import { Memes, type Incoming } from "./memes.js";
import { memeMessage } from "./ui.js";
import { Jobs } from "./jobs.js";
import { GameNight } from "./gamenight.js";
import { Hub } from "./hub.js";
import { Polls } from "./polls.js";
import { Voice } from "./voice.js";
import { Activity, type Kind } from "./activity.js";
import { Spontaneous } from "./spontaneous.js";
import { ArticleInput, News, type NewsRefused } from "./news.js";
import { Downtime, ReplayInput } from "./downtime.js";
import { LateSlips } from "./late.js";
import { Attendances } from "./attendance.js";
import { Presence } from "./presence.js";
import { Alerts } from "./alerts.js";
import { Lifecycle } from "./lifecycle.js";
import { LocalTime } from "./localtime.js";
import { nowIso, nowSec } from "./clock.js";
import { Ticker } from "./scheduler.js";
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
/**
 * A failure as the old error handler printed it (`String(e)`): Discord's errors with the "Error: "
 * prefix the old thrown Errors had (QA and the owner's greps read these), our own wrapped text as is.
 */
const errorText = (e: unknown) => (e instanceof NotOurs ? e.text : e instanceof SignatureUnreadable ? e.detail : e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? `Error: ${e.message}` : String(e));
const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status, contentType: "application/json; charset=utf-8" });
const text = (body: string, status = 200) => HttpServerResponse.text(body, { status, contentType: "text/plain; charset=utf-8" });
const nope = text("nope", 401);

/** Paths match as Fastify matched them: case matters, and a trailing slash is another path. */
export const ROUTER_CONFIG = { caseSensitive: true, ignoreTrailingSlash: false } as const;

/** The body as text, within the limit (a larger one is the sender's problem, as Fastify had it). */
const bodyText = (req: HttpServerRequest.HttpServerRequest) =>
  req.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, BODY_LIMIT),
    Effect.mapError(() => new NotOurs({ text: "FastifyError [FST_ERR_CTP_BODY_TOO_LARGE]: Request body is too large" })),
  );
/** A request body that isn't what the route takes: the sender's mistake, answered 400 (README difference 4; it used to become {}). */
export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", { message: Schema.String }) {}

const Text = Schema.String;
const Num = Schema.Union([Schema.Number, Schema.String]); // the code reads it with Number(), as before
const Seat = Schema.Record(Schema.String, Schema.NullOr(Schema.String)); // user → channel (null: not in voice)
/** What the admin and ingest routes read, every field optional (each action takes what it needs). */
const Input = Schema.Struct({
  action: Schema.optional(Text),
  user: Schema.optional(Text),
  clicker: Schema.optional(Text),
  day: Schema.optional(Text),
  choice: Schema.optional(Schema.Union([Text, Schema.Number])),
  value: Schema.optional(Schema.NullOr(Text)),
  players: Schema.optional(Text),
  t: Schema.optional(Num),
  offset: Schema.optional(Num),
  within: Schema.optional(Num),
  poll: Schema.optional(Num),
  kind: Schema.optional(Text),
  recaps: Schema.optional(Schema.Unknown),
  minute: Schema.optional(Schema.Unknown),
  track: Schema.optional(Seat),
  where: Schema.optional(Seat),
  answer: Schema.optional(Schema.Struct({ id: Num, user: Text, what: Text, game: Schema.optional(Text) })),
  change: Schema.optional(Schema.NullOr(Schema.Struct({ user: Text, from: Schema.NullOr(Text), to: Schema.NullOr(Text) }))), // QA sends null for none
  game: Schema.optional(Text),
  emoji: Schema.optional(Schema.NullOr(Text)),
  message: Schema.optional(Text),
  period: Schema.optional(Text),
  ids: Schema.optional(Schema.Array(Text)),
  // the meme fetcher's batch: passed on as it comes (its shape is the fetcher's)
  memes: Schema.optional(Schema.Array(Schema.Unknown)),
  post_daily: Schema.optional(Schema.Unknown),
  // ⚔️ /admin/news: a backtest's queues over the last days ({ days }), or "sheet" for its sheet
  backtest: Schema.optional(Schema.Union([Text, Schema.Struct({ days: Schema.optional(Schema.Number) })])),
  // 🛠️ /admin/news on the test bot: stand-ins for the downtime sources ({ notice, topics, realms }, { live: true } to stop)
  downtime: Schema.optional(ReplayInput),
  method: Schema.optional(Text),
  path: Schema.optional(Text),
  body: Schema.optional(Schema.Unknown),
});
type Input = typeof Input.Type;
/** A field an action needs: a missing one goes on as undefined, as it always did (the action answers for it). */
const given = (v: string | undefined) => v as string;
// (`value` likewise: QA sends null for none, and the action has always been handed it as is)

/** The JSON object a route was sent ({} for no body); anything else is a 400. */
const decode = (body: string) =>
  body ? Schema.decodeUnknownEffect(Schema.fromJsonString(Input))(body).pipe(Effect.mapError((e) => new BadRequest({ message: String(e) }))) : Effect.succeed<Input>({});

/** Fastify's 404, word for word. */
const notFound = (req: HttpServerRequest.HttpServerRequest) => json({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 }, 404);

export const Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const db = yield* Db;
    const discord = yield* Discord;
    const status = yield* AppStatus;
    // imported on the first signed request, then kept (a key that can't be read stays unreadable)
    const publicKey = yield* Effect.cached(importPublicKey(status.publicKey));
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
    const news = yield* News;
    const downtime = yield* Downtime;
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
      Effect.gen(function* () {
        const handled = (req: HttpServerRequest.HttpServerRequest) =>
          handler(req).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
              const e = Cause.squash(cause);
              if (e instanceof BadRequest) return Effect.succeed(json({ error: e.message }, 400));
              return Effect.gen(function* () {
                yield* Effect.logInfo(`http error ${req.method} ${req.url} ${errorText(e)}`);
                if (!(e instanceof NotOurs)) yield* alerts.report(`${req.method} ${req.url.split("?")[0]}`, e);
                return json({ error: errorText(e) }, 500);
              });
            }),
          );
        // a request runs to the end even when the caller hangs up (as Fastify's handlers did): a tap's
        // timing line and its 3 s alert are for exactly the slow ones
        yield* router.add(method, path, handled, { uninterruptible: true });
        // Fastify answered HEAD for every GET route; this router has no HEAD, so the catch-all below does
        if (method === "GET") heads.set(path, handled);
      });
    const heads = new Map<string, (req: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse>>();
    /**
     * A route that takes a bearer token and a JSON body: the body is read first (a body over the limit
     * is answered before the token is looked at, as Fastify read bodies before its handlers), then
     * the token, then the body's schema.
     */
    const withToken = <E>(secret: Redacted.Redacted<string>, path: HttpRouter.PathInput, handler: (input: Input) => Effect.Effect<HttpServerResponse.HttpServerResponse, E>) =>
      route("POST", path, (req) =>
        Effect.gen(function* () {
          const body = yield* bodyText(req);
          if (!authorized(req.headers.authorization, Redacted.value(secret))) return nope;
          return yield* handler(yield* decode(body));
        }),
      );
    /** An admin route (maintenance and QA scripts). */
    const admin = <E>(path: HttpRouter.PathInput, handler: (input: Input) => Effect.Effect<HttpServerResponse.HttpServerResponse, E>) => withToken(config.adminSecret, path, handler);
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

    yield* route("GET", "/", () => Effect.succeed(text("Meme Bot 3000 🔥")));

    yield* route("POST", "/interactions", (req) =>
      Effect.gen(function* () {
        // Discord's signature covers the exact bytes, so the raw text is what's checked (and then parsed)
        const body = yield* bodyText(req);
        const ok = yield* verifySignature(req.headers["x-signature-ed25519"], req.headers["x-signature-timestamp"], body, publicKey);
        if (!ok) return text("bad signature", 401);
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
              yield* count(taps, { outcome: "ok" });
              yield* timeIt(tapTime, Duration.millis(ms));
              // past 3 s Discord has already shown them "This interaction failed"
              if (ms > 3000) yield* alerts.report(`a tap (${what})`, `took ${ms} ms, past Discord's 3-second limit, so ${who} saw "This interaction failed"`);
            }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : // a private apology beats Discord's generic "This interaction failed"
                Effect.as(Effect.andThen(count(taps, { outcome: "failed" }), alerts.failed(`a tap (${what})`, Cause.squash(cause), who)), {
                  type: R.Message,
                  data: { content: "Something went wrong on my end 🤕 Try again in a moment.", flags: EPHEMERAL },
                }),
          ),
        );
        return json(out);
      }),
    );

    yield* withToken(config.ingestSecret, "/ingest", (input) =>
      Effect.gen(function* () {
        const ingested = yield* memeService.ingest((input.memes ?? []) as ReadonlyArray<Incoming>);
        const daily = input.post_daily ? yield* jobs.postDaily : null;
        return json({ ingested, daily });
      }),
    );

    // ---------------------------------------------------------------- admin (maintenance + QA)

    // raw bot-token passthrough for maintenance scripts
    yield* admin("/admin/discord", (input) =>
      Effect.gen(function* () {
        return answer(yield* discord.request(input.method ?? "GET", input.path ?? "", input.body ?? undefined).pipe(Effect.catch((e) => Effect.succeed({ error: errorText(e) }))));
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

    yield* admin("/admin/recap", (input) => Effect.map(input.period === "month" ? jobs.monthlyRecap : jobs.weeklyRecap, answer));

    // ⚔️ one WoW news run now, without waiting for the hour (it takes minutes: Reddit allows one
    // request a minute); no channel configured: {}. `backtest: { days }` builds each of the last days'
    // queues in the background (posting nothing), for GET /news/queue?day=… on the test bot;
    // `backtest: "sheet"` answers its sheet (each day's queue and what the writer made of it), as markdown.
    // 🛠️ `downtime: { notice, topics, realms }` (the test bot only, else 404): what the downtime poll
    // sees instead of Blizzard's launcher, the forum's listing and the realm status page (each one
    // given replaces that source until `{ live: true }`), then one poll now; it answers what that did.
    yield* admin("/admin/news", (input) =>
      Effect.gen(function* () {
        if (input.downtime !== undefined) {
          const r = yield* downtime.replay(input.downtime);
          return r === null ? json({ error: "no downtime replay here (NEWS_BACKTEST_POST is the test bot's)" }, 404) : json(r);
        }
        const b = input.backtest;
        if (b === "sheet") {
          const sheet = yield* news.sheet;
          return sheet === null ? json({ sheet: null }) : HttpServerResponse.text(sheet, { contentType: "text/markdown; charset=utf-8" });
        }
        if (b !== undefined) return json(yield* news.startBacktest(typeof b === "string" ? {} : { days: b.days }));
        return answer(yield* news.run());
      }),
    );

    // ⚔️ the news's outside writer (a scheduled Claude agent, plan 06): the stories waiting for a
    // write-up, and one write-up (or skip) at a time, behind its own key. No key configured: neither
    // route is there. A refusal answers its status with { error }.
    const writerKey = config.newsWriterKey;
    const refused = (e: NewsRefused) => Effect.succeed(json({ error: e.reason }, e.status));
    yield* route("GET", "/news/queue", (req) =>
      Effect.gen(function* () {
        if (writerKey === undefined) return notFound(req);
        if (!authorized(req.headers.authorization, Redacted.value(writerKey))) return nope;
        const day = new URL(req.url, "http://local").searchParams.get("day") ?? undefined;
        if (day !== undefined && !/^\d{4}-\d\d-\d\d$/.test(day)) return json({ error: "day: YYYY-MM-DD" }, 400);
        return yield* news.queue(day).pipe(Effect.map((q) => json(q)), Effect.catchTag("NewsRefused", refused));
      }),
    );
    yield* route("POST", "/news/article", (req) =>
      Effect.gen(function* () {
        const body = yield* bodyText(req);
        if (writerKey === undefined) return notFound(req);
        if (!authorized(req.headers.authorization, Redacted.value(writerKey))) return nope;
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ArticleInput))(body).pipe(Effect.mapError((e) => new BadRequest({ message: String(e) })));
        if (input.day !== undefined && !/^\d{4}-\d\d-\d\d$/.test(input.day)) return json({ error: "day: YYYY-MM-DD" }, 400);
        return yield* news.article(input).pipe(Effect.map((r) => json(r)), Effect.catchTag("NewsRefused", refused));
      }),
    );

    // seed ids that were posted before the bot had a database
    yield* admin("/admin/mark-posted", (input) =>
      Effect.gen(function* () {
        const ids = input.ids ?? [];
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
    yield* admin("/admin/gamenight", (input) =>
      Effect.gen(function* () {
        const quiet = withOverrides({ quiet: true });
        // 📊🎮 QA with stand-in players, so real voice time is never touched
        const standIns = withOverrides({ quiet: true, ...(input.players !== undefined ? { players: input.players.split(",").map((s) => s.trim()).filter(Boolean) } : {}) });
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
                // as live.ts does: the early birds first (⚔️ all three here before a locked-in night), then spontaneous play
                const early = yield* gameNight.early(where, t);
                return answer({ due: yield* spontaneous.react(where, t, input.change ?? undefined), early });
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
          Match.when("reset", () => Effect.flatMap(input.day !== undefined ? Effect.succeed(input.day) : today, (day) => Effect.map(gameNight.resetNight(day), answer))),
          Match.when("plan", () => Effect.map(quiet(gameNight.startNight(input.user, true, input.day)), answer)),
          Match.when("room", () => Effect.map(voice.openRoom(given(input.game), input.emoji ?? null, { by: input.user }), answer)),
          Match.when("rooms", () => Effect.map(voice.maintainRooms, answer)),
          Match.when("late", () =>
            Effect.gen(function* () {
              // simulate a late-slip click by its owner, then update the slip
              const r = yield* quiet(late.act(given(input.day), given(input.user), given(input.clicker ?? input.user), String(input.choice)));
              const row = yield* attendances.get(given(input.day), given(input.user));
              if (!r.notice && row?.message_id) yield* discord.editMessage(config.gameChannelId, row.message_id, yield* attendances.render(given(input.day), given(input.user)));
              return answer({ ...r, row });
            }),
          ),
          Match.when("poll-vote", () =>
            quiet(
              Effect.gen(function* () {
                const r = yield* polls.act(Number(input.poll), given(input.user), String(input.choice));
                yield* polls.refresh(Number(input.poll));
                return answer(r);
              }),
            ),
          ),
          // 🚨 proves alert DMs arrive: to the owner, or to `user` (the test bot has no owner set)
          Match.when("alert-test", () => Effect.map(alerts.test(input.user ?? config.alertUserId), answer)),
          Match.when("poll-render", () => Effect.map(polls.render(Number(input.poll), input.user), answer)),
          // someone's private copy of a card (what they see after tapping it)
          Match.when("copy", () => Effect.flatMap(input.day !== undefined ? Effect.succeed(input.day) : today, (day) => Effect.map(gameNight.render(day, input.user), answer))),
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
              if (existing) return answer(yield* discord.request("PATCH", `/channels/${config.gameChannelId}/messages/${existing}`, panel)); // Discord's whole answer, as before
              const msg = yield* discord.createMessage(config.gameChannelId, panel);
              yield* discord.pin(config.gameChannelId, msg.id);
              return answer({ hub: msg.id });
            }),
          ),
          Match.when("vote", () =>
            quiet(
              Effect.gen(function* () {
                const day = input.day ?? (yield* today);
                // QA wants the side effects done before it looks: the tap's later work starts at once, as a
                // tap's would, and the answer waits for all of it
                const pending: Fiber.Fiber<void>[] = [];
                const r = yield* gameNight.act(day, given(input.user), given(input.choice === undefined ? undefined : String(input.choice)), input.value as string | undefined, (e) =>
                  Effect.map(Effect.forkDetach(Effect.ignore(e), { startImmediately: true }), (f) => void pending.push(f)),
                );
                yield* Effect.forEach(pending, Fiber.join, { discard: true });
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
    yield* router.add(
      "*",
      "*",
      (req) => {
        const head = req.method === "HEAD" ? heads.get(req.url.split("?")[0]) : undefined;
        return head ? head(req) : Effect.succeed(notFound(req));
      },
      { uninterruptible: true },
    );
  }),
);

/** The app's routes, on everything they need but the server and the status. */
export const routesOn = (statusLayer: Layer.Layer<AppStatus>, context: Context.Context<AppServices>) =>
  Routes.pipe(Layer.provide(statusLayer), Layer.provide(Layer.succeedContext(context)));

/** The HTTP server on its port, over the app's services and its Lifecycle (main.ts builds it in a scope it closes at shutdown). */
export const server = (o: { host: string; port: number }) =>
  HttpRouter.serve(Routes.pipe(Layer.provide(AppStatus.layer)), { disableLogger: true, disableListenLog: true, routerConfig: ROUTER_CONFIG }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host: o.host, port: o.port, gracefulShutdownTimeout: "10 seconds" })),
  );

export interface Status {
  leader: () => boolean;
  shuttingDown: () => boolean;
}
