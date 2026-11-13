// Configuration from the environment (Config), with the secrets kept as Redacted values, and the
// per-call overrides the admin routes use (Overrides). Same variable names, defaults and required
// set as env.ts always had; numbers are numbers here and the players are a list.
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

/** The environment is incomplete: startup fails, naming every missing variable at once. */
export class ConfigMissing extends Schema.TaggedError<ConfigMissing>()("ConfigMissing", {
  missing: Schema.Array(Schema.String),
}) {
  override get message() {
    return `missing environment: ${this.missing.join(", ")}`;
  }
}

export interface AppConfigShape {
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly port: number;
  readonly discordToken: Redacted.Redacted<string>;
  readonly discordPublicKey: string; // public, so not redacted
  readonly discordAppId: string;
  readonly ingestSecret: Redacted.Redacted<string>; // the meme fetcher's /ingest
  readonly adminSecret: Redacted.Redacted<string>; // /admin/* (maintenance and QA scripts)
  readonly guildId: string;
  readonly channelId: string; // #daily-memes
  readonly subreddit: string;
  readonly postHourUtc: number;
  readonly gameChannelId: string; // #game-night
  readonly players: ReadonlyArray<string>;
  readonly timezone: string;
  readonly gamePollHour: number; // local hour of the daily "are we playing?" card
  readonly gamePollHourWeekend: number; // the same on Saturdays and Sundays
  readonly lobbyChannelId: string; // 🛋️ Lobby: hang out here; game rooms pull people from it
  readonly voiceCategoryId: string; // 🔊 Voice: where game rooms are opened
  readonly alertUserId: string | undefined; // 🚨 who gets a DM when something breaks; unset on the test bot
  /** 🎮 Ask Discord what people are playing (the presence intent, on in the Developer Portal too). */
  readonly presences: boolean;
  /** 🧠 Gemini, free tier: judgment calls only; unset means none are made. */
  readonly geminiApiKey: Redacted.Redacted<string> | undefined;
  /** ⚔️ Where WoW: Forever news goes (news.ts); unset means no news. */
  readonly newsChannelId: string | undefined;
  /** ⚔️ The subreddits the news reads (plan 06), each judged against its own usual level. */
  readonly newsSubreddits: ReadonlyArray<string>;
  /** ⚔️ At most this many news cards a day. */
  readonly newsDailyPosts: number;
  /** ⚔️ Who the write-ups are for, in one line (the writer's prompt). */
  readonly newsAudience: string;
  /** ⚔️ The models the news's write-ups ask, in turn (gemini.ts: each has its own daily budget). */
  readonly newsWriteModels: ReadonlyArray<string>;
  /** ⚔️ The models the news's triage asks, in turn. */
  readonly newsTriageModels: ReadonlyArray<string>;
  /** ⚔️ At most this many stories written up in one request. */
  readonly newsWriteBatch: number;
  /** ⚔️ The backtest's cards may be posted to the news channel (the test bot only: dev.env). */
  readonly newsBacktestPost: boolean;
  /**
   * ⚔️ The least time between two requests to Reddit's feeds: it allows about one a minute from the
   * server (plan 06, Step 0). Not from the environment; the tests set it to 0.
   */
  readonly newsRedditGapMs: number;
  /**
   * 🔊 The bot's voice (botvoice.ts) until someone taps the 🔇 toggle on the HQ panel: BOT_VOICE=on
   * (the test bot); unset or "off" means off (production, until the owner has listened).
   */
  readonly botVoice: boolean;
  readonly appName: string;
  readonly revision: string;
  /** 📡 Where logs, metrics and spans go over OTLP (architecture §14); unset everywhere for now, so none go. */
  readonly otlpUrl?: string | undefined;
}

/** Who the news is written for, unless NEWS_AUDIENCE says otherwise. */
export const NEWS_AUDIENCE = "three friends who play WoW: Forever together on EU realms a few evenings a week";
/** The news's model lists, unless NEWS_WRITE_MODELS / NEWS_TRIAGE_MODELS say otherwise (plan 06). */
export const NEWS_WRITE_MODELS = "gemini-3.6-flash,gemini-3.7-flash,gemini-3.5-flash";
export const NEWS_TRIAGE_MODELS = "gemini-3.5-flash-lite,gemini-3.6-flash";
/** A comma-separated list, trimmed, without empty entries. */
export const listOf = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
/** 65 s: Reddit's feeds allow one request a minute from the server, with a margin. */
export const REDDIT_GAP_MS = 65_000;

const REQUIRED = [
  "DATABASE_URL",
  "DISCORD_TOKEN",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_APP_ID",
  "INGEST_SECRET",
  "ADMIN_SECRET",
  "GUILD_ID",
  "CHANNEL_ID",
  "GAME_CHANNEL_ID",
  "PLAYERS",
  "LOBBY_CHANNEL_ID",
  "VOICE_CATEGORY_ID",
] as const;
type Required = (typeof REQUIRED)[number];

// an empty variable counts as missing, as it always has
const optional = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.filter((v) => v !== "")),
  );

/** Read the environment; fails with every missing required variable named in one message. */
export const readConfig = Effect.gen(function* () {
  const req = {} as Record<Required, string | undefined>;
  for (const k of REQUIRED) req[k] = Option.getOrUndefined(yield* optional(k));
  const missing = REQUIRED.filter((k) => req[k] === undefined);
  if (missing.length) return yield* new ConfigMissing({ missing });
  const get = (k: Required) => req[k]!;
  const or = (name: string, fallback: string) => optional(name).pipe(Config.map(Option.getOrElse(() => fallback)));
  const alertUserId = Option.getOrUndefined(yield* optional("ALERT_USER_ID"));
  const geminiApiKey = Option.getOrUndefined(yield* optional("GEMINI_API_KEY"));
  const newsChannelId = Option.getOrUndefined(yield* optional("NEWS_CHANNEL_ID"));
  const config: AppConfigShape = {
    databaseUrl: Redacted.make(get("DATABASE_URL")),
    port: Number(yield* or("PORT", "3000")),
    discordToken: Redacted.make(get("DISCORD_TOKEN")),
    discordPublicKey: get("DISCORD_PUBLIC_KEY"),
    discordAppId: get("DISCORD_APP_ID"),
    ingestSecret: Redacted.make(get("INGEST_SECRET")),
    adminSecret: Redacted.make(get("ADMIN_SECRET")),
    guildId: get("GUILD_ID"),
    channelId: get("CHANNEL_ID"),
    subreddit: yield* or("SUBREDDIT", "ProgrammerHumor"),
    postHourUtc: Number(yield* or("POST_HOUR_UTC", "10")),
    gameChannelId: get("GAME_CHANNEL_ID"),
    players: get("PLAYERS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timezone: yield* or("TIMEZONE", "Europe/Vilnius"),
    gamePollHour: Number(yield* or("GAME_POLL_HOUR", "17")),
    gamePollHourWeekend: Number(yield* or("GAME_POLL_HOUR_WEEKEND", "14")),
    lobbyChannelId: get("LOBBY_CHANNEL_ID"),
    voiceCategoryId: get("VOICE_CATEGORY_ID"),
    alertUserId,
    presences: (yield* or("PRESENCES", "")) === "1",
    geminiApiKey: geminiApiKey === undefined ? undefined : Redacted.make(geminiApiKey),
    newsChannelId,
    newsSubreddits: (yield* or("NEWS_SUBREDDITS", "wowforever,classicwow,wow"))
      .split(",")
      .map((s) => s.trim().replace(/^\/?r\//, ""))
      .filter(Boolean),
    newsDailyPosts: Number(yield* or("NEWS_DAILY_POSTS", "3")),
    newsAudience: yield* or("NEWS_AUDIENCE", NEWS_AUDIENCE),
    newsWriteModels: listOf(yield* or("NEWS_WRITE_MODELS", NEWS_WRITE_MODELS)),
    newsTriageModels: listOf(yield* or("NEWS_TRIAGE_MODELS", NEWS_TRIAGE_MODELS)),
    newsWriteBatch: Math.max(1, Number(yield* or("NEWS_WRITE_BATCH", "3")) || 1),
    newsBacktestPost: (yield* or("NEWS_BACKTEST_POST", "")) === "1",
    newsRedditGapMs: REDDIT_GAP_MS,
    botVoice: (yield* or("BOT_VOICE", "off")) === "on",
    appName: yield* or("APP_NAME", "meme-bot"),
    revision: yield* or("REVISION", "dev"),
    otlpUrl: Option.getOrUndefined(yield* optional("OTLP_URL")),
  };
  return config;
});

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("meme-bot/config/AppConfig") {
  static readonly layer = Layer.effect(AppConfig, readConfig);
}

/**
 * Per-call overrides (the admin routes): `quiet` sends nothing that notifies anyone, and `players`
 * stands in for the trio (QA with stand-in ids). Read inside a method at call time, never when a
 * layer is built, so a value provided around one call is the one that call (and the background
 * work it starts) sees.
 */
export const Overrides = Context.Reference<{ readonly quiet: boolean; readonly players?: ReadonlyArray<string> }>("meme-bot/config/Overrides", {
  defaultValue: () => ({ quiet: false }),
});

/** The players for this call: the stand-ins of an admin call, or the trio. */
export const players = Effect.gen(function* () {
  const o = yield* Overrides;
  return o.players ?? (yield* AppConfig).players;
});

/**
 * Run `effect` with some overrides changed and the rest kept: an inner quiet call keeps the stand-in
 * players an outer call gave (providing Overrides replaces the whole value).
 */
export const withOverrides =
  (change: { readonly quiet?: boolean; readonly players?: ReadonlyArray<string> }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const o = yield* Overrides;
      return yield* Effect.provideService(effect, Overrides, { ...o, ...change });
    });

/** Who a message may ping: nobody on a quiet call (the admin test routes), else these people. */
export const allowedMentions = (users: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return (yield* Overrides).quiet ? { parse: [] as string[] } : { users: [...users] };
  });

/** Whether this call must not notify anyone. */
export const quiet = Effect.gen(function* () {
  return (yield* Overrides).quiet;
});
