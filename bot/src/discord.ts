// Discord's REST API as a service: one typed method per endpoint the bot uses, today's retry rules
// as schedules, Discord's errors told apart by status and code (not by searching their text), and
// our own channel changes reported to the channel cache. Interaction webhooks (followups,
// @original) have their own rule. The signature check and the small helpers stay plain functions.
import { Context, Duration, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Env } from "./env.js";
import { AppConfig } from "./config.js";
import { Channels, type Channel } from "./channels.js";
import { run } from "./legacy.js"; // LEGACY-BRIDGE

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/ViliusVZ/meme-bot, 3.0)";

export const IS_COMPONENTS_V2 = 1 << 15;
export const EPHEMERAL = 1 << 6;

/** Interaction response types. */
export const Response = {
  Pong: 1,
  Message: 4,
  DeferredMessage: 5,
  DeferredUpdate: 6,
  UpdateMessage: 7,
  Autocomplete: 8,
  Modal: 9,
} as const;

const keys = new Map<string, Promise<import("node:crypto").webcrypto.CryptoKey>>();

/** Discord signs every interaction; anything that doesn't verify is rejected. */
export async function verifySignature(sig: string | undefined, ts: string | undefined, body: string, publicKey: string) {
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  if (!keys.has(publicKey)) keys.set(publicKey, crypto.subtle.importKey("raw", hex(publicKey), { name: "Ed25519" }, false, ["verify"]));
  return crypto.subtle.verify("Ed25519", await keys.get(publicKey)!, hex(sig), new TextEncoder().encode(ts + body));
}

function hex(s: string) {
  return new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
}

// ---------------------------------------------------------------- errors

/** Discord answered 404: the thing is gone (code: 10003 channel, 10008 message, 10065 voice state, 10070 event…). */
export class DiscordNotFound extends Schema.TaggedError<DiscordNotFound>()("DiscordNotFound", {
  method: Schema.String,
  path: Schema.String,
  code: Schema.optional(Schema.Number),
  discordMessage: Schema.String,
  text: Schema.String, // the raw answer, as today's error text carries it
}) {
  override get message() {
    return `${this.method} ${this.path} -> 404 ${this.text}`;
  }
}

/** Any other 4xx: permanent, retrying the same request can't work. `errors` is Discord's field tree. */
export class DiscordRejected extends Schema.TaggedError<DiscordRejected>()("DiscordRejected", {
  method: Schema.String,
  path: Schema.String,
  status: Schema.Number,
  code: Schema.optional(Schema.Number),
  discordMessage: Schema.String,
  errors: Schema.optional(Schema.Unknown),
  text: Schema.String,
}) {
  override get message() {
    return `${this.method} ${this.path} -> ${this.status} ${this.text}`;
  }
}

/** Gave up after the retries (network, timeout, 5xx, rate limit): a later attempt may work. */
export class DiscordUnavailable extends Schema.TaggedError<DiscordUnavailable>()("DiscordUnavailable", {
  method: Schema.String,
  path: Schema.String,
  last: Schema.String, // what the last attempt saw: a status, "rate limited", or the network error
}) {
  override get message() {
    return `${this.method} ${this.path} -> gave up: ${this.last}`;
  }
}

/** Discord answered 2xx with something we can't read (a field we use is missing or of another type). */
export class DiscordUnexpected extends Schema.TaggedError<DiscordUnexpected>()("DiscordUnexpected", {
  method: Schema.String,
  path: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `${this.method} ${this.path} -> unexpected answer: ${this.detail}`;
  }
}

export type DiscordError = DiscordNotFound | DiscordRejected | DiscordUnavailable | DiscordUnexpected;

/** Discord's answer when an event was ended (by us, by hand, or by Discord) or deleted. */
export const isFinished = (e: DiscordError) =>
  e._tag === "DiscordNotFound" ||
  (e._tag === "DiscordRejected" && JSON.stringify(e.errors ?? null).includes("INVALID_END_BY_STATUS"));

const ErrorBody = Schema.Struct({ message: Schema.optional(Schema.String), code: Schema.optional(Schema.Number), errors: Schema.optional(Schema.Unknown) });
const decodeErrorBody = (text: string) =>
  Option.getOrElse(
    Option.flatMap(
      Option.liftThrowable(JSON.parse)(text),
      (j) => Option.fromNullishOr(Schema.decodeUnknownOption(ErrorBody)(j).pipe(Option.getOrUndefined)),
    ),
    () => ({ message: text, code: undefined, errors: undefined }) as typeof ErrorBody.Type,
  );

/** One attempt failed in a way a retry may fix (internal to the retry schedule). */
class Transient extends Schema.TaggedError<Transient>()("Transient", {
  kind: Schema.Literals(["network", "rate", "server"]),
  last: Schema.String,
  delayMs: Schema.Number,
}) {}

// ---------------------------------------------------------------- responses (only the fields the bot reads)

export const Message = Schema.Struct({ id: Schema.String, channel_id: Schema.optional(Schema.String) });
export const ChannelInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Number,
  position: Schema.Number,
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
});
export const Listed = Schema.Struct({
  id: Schema.String,
  author: Schema.Struct({ id: Schema.String }),
  pinned: Schema.optional(Schema.Boolean),
  timestamp: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  components: Schema.optional(Schema.Array(Schema.Unknown)),
});
export const WithId = Schema.Struct({ id: Schema.String });
export const VoiceState = Schema.Struct({ channel_id: Schema.optional(Schema.NullOr(Schema.String)) });

/** What an interaction webhook answered: the edit landed (2xx) or it didn't. null: no answer at all. */
export type WebhookResult = { readonly status: number; readonly ok: boolean; readonly text: string } | null;

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
const isMethod = (m: string): m is Method => m === "GET" || m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE";

// ---------------------------------------------------------------- the service

export class Discord extends Context.Service<
  Discord,
  {
    /** Any endpoint (the admin passthrough, and the old api() during the transition). */
    request(method: string, path: string, body?: unknown): Effect.Effect<unknown, DiscordError>;
    createMessage(channelId: string, body: unknown): Effect.Effect<typeof Message.Type, DiscordError>;
    editMessage(channelId: string, messageId: string, body: unknown): Effect.Effect<typeof Message.Type, DiscordError>;
    deleteMessage(channelId: string, messageId: string): Effect.Effect<void, DiscordError>;
    bulkDelete(channelId: string, messages: ReadonlyArray<string>): Effect.Effect<void, DiscordError>;
    listMessages(channelId: string, query: string): Effect.Effect<ReadonlyArray<typeof Listed.Type>, DiscordError>;
    createThread(channelId: string, messageId: string, body: unknown): Effect.Effect<typeof WithId.Type, DiscordError>;
    pins(channelId: string): Effect.Effect<unknown, DiscordError>;
    pin(channelId: string, messageId: string): Effect.Effect<void, DiscordError>;
    getChannel(channelId: string): Effect.Effect<typeof WithId.Type, DiscordError>;
    editChannel(channelId: string, body: unknown): Effect.Effect<void, DiscordError>;
    deleteChannel(channelId: string): Effect.Effect<void, DiscordError>;
    createChannel(body: unknown): Effect.Effect<typeof WithId.Type, DiscordError>;
    reorderChannels(moves: ReadonlyArray<{ id: string; position: number; parent_id?: string | null; lock_permissions?: boolean }>): Effect.Effect<void, DiscordError>;
    /** All channels: from the live cache, or over REST when we don't have one. */
    readonly listChannels: Effect.Effect<ReadonlyArray<Channel>, DiscordError>;
    moveMember(userId: string, channelId: string | null): Effect.Effect<void, DiscordError>;
    createEvent(body: unknown): Effect.Effect<typeof WithId.Type, DiscordError>;
    editEvent(eventId: string, body: unknown): Effect.Effect<unknown, DiscordError>;
    deleteEvent(eventId: string): Effect.Effect<void, DiscordError>;
    voiceState(userId: string): Effect.Effect<typeof VoiceState.Type, DiscordError>;
    registerCommands(commands: unknown): Effect.Effect<unknown, DiscordError>;
    createDm(userId: string): Effect.Effect<typeof WithId.Type, DiscordError>;
    readonly currentUser: Effect.Effect<typeof WithId.Type, DiscordError>;
    /** Interaction webhooks don't need the bot token; Discord may not have processed our reply yet. */
    followup(token: string, body: unknown): Effect.Effect<WebhookResult>;
    editOriginal(token: string, body: unknown): Effect.Effect<WebhookResult>;
    originalMessage(token: string): Effect.Effect<WebhookResult>;
  }
>()("meme-bot/discord") {
  static readonly layer = Layer.effect(
    Discord,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const http = yield* HttpClient.HttpClient;
      const channels = yield* Channels;

      /**
       * One attempt, with the bot token; a 4xx is final, the rest may be retried. The timeout covers
       * the whole attempt, reading the answer included (as AbortSignal.timeout did).
       */
      const attempt = (method: Method, path: string, body: unknown) =>
        Effect.gen(function* () {
          let req = HttpClientRequest.make(method)(API + path).pipe(
            HttpClientRequest.setHeaders({ Authorization: `Bot ${Redacted.value(config.discordToken)}`, "Content-Type": "application/json", "User-Agent": USER_AGENT }),
          );
          if (body !== undefined) req = HttpClientRequest.bodyText(req, JSON.stringify(body), "application/json");
          const res = yield* http.execute(req).pipe(Effect.catch((e) => Effect.fail(new Transient({ kind: "network", last: String(e), delayMs: 0 }))));
          if (res.status === 429) {
            const j = (yield* res.json.pipe(Effect.orElseSucceed(() => ({})))) as { retry_after?: number };
            const retryAfter = typeof j?.retry_after === "number" ? j.retry_after : 1;
            return yield* new Transient({ kind: "rate", last: "rate limited", delayMs: Math.min(retryAfter, 10) * 1000 + 100 });
          }
          if (res.status >= 500) return yield* new Transient({ kind: "server", last: `${res.status}`, delayMs: 0 });
          if (res.status >= 400) {
            const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
            const e = decodeErrorBody(text);
            if (res.status === 404) return yield* new DiscordNotFound({ method, path, code: e.code, discordMessage: e.message ?? text, text });
            return yield* new DiscordRejected({ method, path, status: res.status, code: e.code, discordMessage: e.message ?? text, errors: e.errors, text });
          }
          if (res.status === 204) return null;
          // a 2xx we can't read is final (the old code threw at once; the request did go through)
          return (yield* res.json.pipe(Effect.catch((e) => Effect.fail(new DiscordUnexpected({ method, path, detail: String(e).slice(0, 300) }))))) as unknown;
        }).pipe(
          Effect.timeout(ATTEMPT_TIMEOUT),
          Effect.catchTag("TimeoutError", (e) => Effect.fail(new Transient({ kind: "network", last: String(e), delayMs: 0 }))),
        );

      /**
       * Rate limits are always retried, after Discord's retry_after (capped at 10 s) plus 100 ms. 5xx
       * and network errors are retried too, 300 ms × 2ⁿ apart, except for POST: a POST that failed
       * with a 5xx may still have gone through, and retrying would duplicate a message, channel or
       * event. Callers of POST handle failure themselves. At most 4 attempts.
       */
      const retries = (method: Method) =>
        Schedule.recurs(MAX_ATTEMPTS - 1).pipe(
          // a 4xx (DiscordNotFound, DiscordRejected) is final: only Transient failures are retried
          Schedule.setInputType<Transient | DiscordNotFound | DiscordRejected | DiscordUnexpected>(),
          Schedule.while(({ input }) => input._tag === "Transient" && (input.kind === "rate" || method !== "POST")),
          Schedule.modifyDelay(({ input, attempt: n }) =>
            Effect.succeed(input._tag === "Transient" && input.kind === "rate" ? Duration.millis(input.delayMs) : Duration.millis(BACKOFF_MS * 2 ** (n - 1))),
          ),
        );

      /** Our own channel changes go straight into the channel cache (their gateway events follow later). */
      const noteChannels = (method: Method, path: string, body: unknown, data: unknown) =>
        Effect.gen(function* () {
          if (path === `/guilds/${config.guildId}/channels`) {
            if (method === "POST") yield* channels.upsert(data as Channel);
            if (method === "PATCH" && Array.isArray(body)) yield* channels.reposition(body as { id: string; position: number }[]);
            return;
          }
          const m = path.match(/^\/channels\/(\d+)$/);
          if (!m) return;
          if (method === "PATCH") yield* channels.upsert(data as Channel);
          if (method === "DELETE") yield* channels.remove(m[1]);
        });

      const call = Effect.fnUntraced(function* (method: Method, path: string, body?: unknown) {
        const data = yield* attempt(method, path, body).pipe(
          Effect.retry(retries(method)),
          Effect.catchTag("Transient", (t) => Effect.fail(new DiscordUnavailable({ method, path, last: t.last }))),
        );
        yield* noteChannels(method, path, body, data);
        return data;
      });

      /** A response we read fields from: decoded, keeping only the fields we use. */
      const read = <A>(method: Method, path: string, schema: Schema.Decoder<A>, body?: unknown) =>
        call(method, path, body).pipe(
          Effect.flatMap((data) => Schema.decodeUnknownEffect(schema)(data)),
          Effect.catchTag("SchemaError", (e) => Effect.fail(new DiscordUnexpected({ method, path, detail: e.message.slice(0, 300) }))),
        );

      const guild = `/guilds/${config.guildId}`;
      const request = Effect.fn("Discord.request")(function* (raw: string, path: string, body?: unknown) {
        const method = raw.toUpperCase(); // `dc.py get …` works, as it did through fetch
        if (!isMethod(method)) return yield* new DiscordRejected({ method, path, status: 405, discordMessage: "method?", text: "" });
        return yield* call(method, path, body);
      });

      /** Interaction webhooks: up to 4 attempts, 400 ms × attempt apart, while Discord says 404 (not yet), 429 or 5xx. */
      const webhook = (method: Method, url: string, body?: unknown) =>
        Effect.gen(function* () {
          const once = Effect.gen(function* () {
            let req = HttpClientRequest.make(method)(url);
            if (body !== undefined) req = HttpClientRequest.bodyText(req, JSON.stringify(body), "application/json");
            // no answer at all, or none within 10 s (reading it included): null, tried again like a 404
            const got = yield* Effect.gen(function* () {
              const res = yield* http.execute(req);
              return { status: res.status, ok: res.status >= 200 && res.status < 300, text: yield* res.text } as WebhookResult;
            }).pipe(Effect.timeout(ATTEMPT_TIMEOUT), Effect.option);
            return Option.getOrNull(got);
          });
          const notYet = (r: WebhookResult) => !r || r.status === 404 || r.status === 429 || r.status >= 500;
          const r = yield* once.pipe(
            Effect.repeat(
              Schedule.recurs(MAX_ATTEMPTS - 1).pipe(
                Schedule.setInputType<WebhookResult>(),
                Schedule.while(({ input }) => notYet(input)),
                Schedule.modifyDelay(({ attempt: n }) => Effect.succeed(Duration.millis(WEBHOOK_STEP_MS * n))),
                Schedule.passthrough,
              ),
            ),
          );
          if (r && !r.ok) yield* Effect.logWarning(`webhook failed ${method} ${url.split("/webhooks/")[1]?.slice(0, 30)} ${r.status}`);
          return r;
        });
      const hook = (token: string) => `${API}/webhooks/${config.discordAppId}/${token}`;

      return Discord.of({
        request,
        createMessage: Effect.fn("Discord.createMessage")((channelId: string, body: unknown) => read("POST", `/channels/${channelId}/messages`, Message, body)),
        editMessage: Effect.fn("Discord.editMessage")((channelId: string, messageId: string, body: unknown) =>
          read("PATCH", `/channels/${channelId}/messages/${messageId}`, Message, body),
        ),
        deleteMessage: Effect.fn("Discord.deleteMessage")((channelId: string, messageId: string) => Effect.asVoid(call("DELETE", `/channels/${channelId}/messages/${messageId}`))),
        bulkDelete: Effect.fn("Discord.bulkDelete")((channelId: string, messages: ReadonlyArray<string>) => Effect.asVoid(call("POST", `/channels/${channelId}/messages/bulk-delete`, { messages }))),
        listMessages: Effect.fn("Discord.listMessages")((channelId: string, query: string) =>
          read("GET", `/channels/${channelId}/messages${query}`, Schema.Array(Listed)),
        ),
        createThread: Effect.fn("Discord.createThread")((channelId: string, messageId: string, body: unknown) =>
          read("POST", `/channels/${channelId}/messages/${messageId}/threads`, WithId, body),
        ),
        pins: Effect.fn("Discord.pins")((channelId: string) => call("GET", `/channels/${channelId}/pins`)),
        pin: Effect.fn("Discord.pin")((channelId: string, messageId: string) => Effect.asVoid(call("PUT", `/channels/${channelId}/pins/${messageId}`))),
        getChannel: Effect.fn("Discord.getChannel")((channelId: string) => read("GET", `/channels/${channelId}`, WithId)),
        editChannel: Effect.fn("Discord.editChannel")((channelId: string, body: unknown) => Effect.asVoid(call("PATCH", `/channels/${channelId}`, body))),
        deleteChannel: Effect.fn("Discord.deleteChannel")((channelId: string) => Effect.asVoid(call("DELETE", `/channels/${channelId}`))),
        createChannel: Effect.fn("Discord.createChannel")((body: unknown) => read("POST", `${guild}/channels`, WithId, body)),
        reorderChannels: Effect.fn("Discord.reorderChannels")((moves) => Effect.asVoid(call("PATCH", `${guild}/channels`, moves))),
        listChannels: Effect.gen(function* () {
          const cached = yield* channels.cached;
          if (cached) return cached;
          return (yield* read("GET", `${guild}/channels`, Schema.Array(ChannelInfo))) as ReadonlyArray<Channel>;
        }).pipe(Effect.withSpan("Discord.listChannels")),
        moveMember: Effect.fn("Discord.moveMember")((userId: string, channelId: string | null) => Effect.asVoid(call("PATCH", `${guild}/members/${userId}`, { channel_id: channelId }))),
        createEvent: Effect.fn("Discord.createEvent")((body: unknown) => read("POST", `${guild}/scheduled-events`, WithId, body)),
        editEvent: Effect.fn("Discord.editEvent")((eventId: string, body: unknown) => call("PATCH", `${guild}/scheduled-events/${eventId}`, body)),
        deleteEvent: Effect.fn("Discord.deleteEvent")((eventId: string) => Effect.asVoid(call("DELETE", `${guild}/scheduled-events/${eventId}`))),
        voiceState: Effect.fn("Discord.voiceState")((userId: string) => read("GET", `${guild}/voice-states/${userId}`, VoiceState)),
        registerCommands: Effect.fn("Discord.registerCommands")((commands: unknown) => call("PUT", `/applications/${config.discordAppId}${guild}/commands`, commands)),
        createDm: Effect.fn("Discord.createDm")((userId: string) => read("POST", "/users/@me/channels", WithId, { recipient_id: userId })),
        currentUser: read("GET", "/users/@me", WithId).pipe(Effect.withSpan("Discord.currentUser")),
        followup: Effect.fn("Discord.followup")((token: string, body: unknown) => webhook("POST", hook(token), body)),
        editOriginal: Effect.fn("Discord.editOriginal")((token: string, body: unknown) => webhook("PATCH", `${hook(token)}/messages/@original`, body)),
        originalMessage: Effect.fn("Discord.originalMessage")((token: string) => webhook("GET", `${hook(token)}/messages/@original`)),
      });
    }),
  );
}

/** Each attempt gives up after this; then the retry rules decide. */
export const ATTEMPT_TIMEOUT = Duration.seconds(10);
export const MAX_ATTEMPTS = 4;
/** 5xx and network errors (not on POST): 300 ms, 600 ms, 1.2 s. */
export const BACKOFF_MS = 300;
/** Interaction webhooks: 400 ms, 800 ms, 1.2 s. */
export const WEBHOOK_STEP_MS = 400;

// ---------------------------------------------------------------- the old functions, for code that isn't on Effect yet

/** Today's error, as text: "<METHOD> <path> -> 404 <body>" etc., which old callers match on. */
const asOldError = (e: DiscordError) => new Error(e.message); // LEGACY-BRIDGE

/** Discord REST call with the bot token (the Discord service's rules). */
export async function api(env: Env, method: string, path: string, body?: unknown): Promise<any> { // LEGACY-BRIDGE
  return run(env, Discord.use((d) => d.request(method, path, body)).pipe(Effect.mapError(asOldError))); // LEGACY-BRIDGE
} // LEGACY-BRIDGE

/** All channels: from the live cache, or over REST when we don't have one. */
export async function listChannels(env: Env): Promise<Channel[]> { // LEGACY-BRIDGE
  return run(env, Discord.use((d) => d.listChannels).pipe(Effect.mapError(asOldError))) as Promise<Channel[]>; // LEGACY-BRIDGE
} // LEGACY-BRIDGE

/** True when an api() error is Discord's 404 (the thing is gone). */
export const isNotFound = (e: unknown) => / -> 404 /.test(String(e)); // LEGACY-BRIDGE

const asResponse = (r: WebhookResult) => (r ? new globalThis.Response(r.status === 204 || r.status === 205 || r.status === 304 ? null : r.text, { status: r.status }) : null); // LEGACY-BRIDGE

/** Interaction webhooks (followups, @original) don't need the bot token. */
export function followup(env: Env, token: string, body: unknown) { // LEGACY-BRIDGE
  return run(env, Discord.use((d) => d.followup(token, body))).then(asResponse); // LEGACY-BRIDGE
} // LEGACY-BRIDGE

/** Fill in a deferred ("thinking…") interaction response. */
export function editOriginal(env: Env, token: string, body: unknown) { // LEGACY-BRIDGE
  return run(env, Discord.use((d) => d.editOriginal(token, body))).then(asResponse); // LEGACY-BRIDGE
} // LEGACY-BRIDGE

export async function originalMessage(env: Env, token: string): Promise<{ id: string; channel_id: string }> { // LEGACY-BRIDGE
  const r = await run(env, Discord.use((d) => d.originalMessage(token))); // LEGACY-BRIDGE
  if (!r?.ok) throw new Error(`@original -> ${r?.status}`); // LEGACY-BRIDGE
  return JSON.parse(r.text) as { id: string; channel_id: string }; // LEGACY-BRIDGE
} // LEGACY-BRIDGE

export function messageLink(guildId: string, channelId: string, messageId: string) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function avatarUrl(user: { id: string; avatar?: string | null }) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}

/** Escape markdown so meme titles like `*args` or `__init__` render literally. */
export function esc(s: string) {
  return s.replace(/([\\*_~`|>\[\]()#-])/g, "\\$1");
}
