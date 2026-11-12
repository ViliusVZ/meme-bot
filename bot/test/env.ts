// The tests' configuration, in the shape the tests have always described it (the old `env` object:
// GUILD_ID, PLAYERS, …), and its conversion to the app's AppConfigShape. Since plan 05 phase 6 the
// app reads AppConfig only; this is test setup.
import { Cause, ConfigProvider, Effect, Exit, Redacted } from "effect";
import { readConfig, type AppConfigShape } from "../src/config.js";

export interface Env {
  /** The throwaway schema's node-postgres database (test setup; the app has its own). */
  db: unknown;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  INGEST_SECRET: string; // the meme fetcher's /ingest
  ADMIN_SECRET: string; // /admin/* (maintenance and QA scripts)
  GUILD_ID: string;
  CHANNEL_ID: string; // #daily-memes
  SUBREDDIT: string;
  POST_HOUR_UTC: string;
  GAME_CHANNEL_ID: string; // #game-night
  PLAYERS: string; // comma-separated user ids
  TIMEZONE: string;
  GAME_POLL_HOUR: string; // local hour of the daily "are we playing?" card
  GAME_POLL_HOUR_WEEKEND: string; // the same on Saturdays and Sundays
  LOBBY_CHANNEL_ID: string; // 🛋️ Lobby: hang out here; game rooms pull people from it
  VOICE_CATEGORY_ID: string; // 🔊 Voice: where game rooms are opened
  ALERT_USER_ID?: string; // 🚨 who gets a DM when something breaks (alerts.ts); unset on the test bot
  /** 🎮 Ask Discord what people are playing (the presence intent, on in the Developer Portal too). */
  PRESENCES?: boolean;
  /** 🧠 Gemini, free tier (gemini.ts): judgment calls only; unset means none are made. */
  GEMINI_API_KEY?: string;
  /** ⚔️ Where WoW: Forever news goes (news.ts); unset means no news. */
  NEWS_CHANNEL_ID?: string;
  /** Set by the admin test routes so simulated runs don't notify anyone. */
  QUIET?: boolean;
}

export type Config = Omit<Env, "db" | "QUIET"> & { DATABASE_URL: string; PORT: number };


/** The environment, read by Config (config.ts); in the tests' shape. */
export function loadConfig(e: NodeJS.ProcessEnv = process.env): Config {
  const exit = Effect.runSyncExit(readConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(e)))));
  if (Exit.isFailure(exit)) {
    const e = Cause.squash(exit.cause);
    throw new Error(e instanceof Error ? e.message : String(e)); // "missing environment: A, B", as always
  }
  const c = exit.value;
  return { DATABASE_URL: Redacted.value(c.databaseUrl), PORT: c.port, ...envFields(c) };
}

/** The old Config fields, from AppConfig. */
export function envFields(c: AppConfigShape): Omit<Env, "db"> {
  return {
    DISCORD_TOKEN: Redacted.value(c.discordToken),
    DISCORD_PUBLIC_KEY: c.discordPublicKey,
    DISCORD_APP_ID: c.discordAppId,
    INGEST_SECRET: Redacted.value(c.ingestSecret),
    ADMIN_SECRET: Redacted.value(c.adminSecret),
    GUILD_ID: c.guildId,
    CHANNEL_ID: c.channelId,
    SUBREDDIT: c.subreddit,
    POST_HOUR_UTC: String(c.postHourUtc),
    GAME_CHANNEL_ID: c.gameChannelId,
    PLAYERS: c.players.join(","),
    TIMEZONE: c.timezone,
    GAME_POLL_HOUR: String(c.gamePollHour),
    GAME_POLL_HOUR_WEEKEND: String(c.gamePollHourWeekend),
    LOBBY_CHANNEL_ID: c.lobbyChannelId,
    VOICE_CATEGORY_ID: c.voiceCategoryId,
    ALERT_USER_ID: c.alertUserId,
    PRESENCES: c.presences,
    GEMINI_API_KEY: c.geminiApiKey === undefined ? undefined : Redacted.value(c.geminiApiKey),
    NEWS_CHANNEL_ID: c.newsChannelId,
  };
}

/** And the other way, for tests that build an `Env` by hand (test/pg.ts testEnv). */
export function configFromEnv(env: Env, extra: { databaseUrl?: string; port?: number } = {}): AppConfigShape {
  return {
    databaseUrl: Redacted.make(extra.databaseUrl ?? ""),
    port: extra.port ?? 3000,
    discordToken: Redacted.make(env.DISCORD_TOKEN),
    discordPublicKey: env.DISCORD_PUBLIC_KEY,
    discordAppId: env.DISCORD_APP_ID,
    ingestSecret: Redacted.make(env.INGEST_SECRET),
    adminSecret: Redacted.make(env.ADMIN_SECRET),
    guildId: env.GUILD_ID,
    channelId: env.CHANNEL_ID,
    subreddit: env.SUBREDDIT,
    postHourUtc: Number(env.POST_HOUR_UTC),
    gameChannelId: env.GAME_CHANNEL_ID,
    players: env.PLAYERS.split(",").map((s) => s.trim()).filter(Boolean),
    timezone: env.TIMEZONE,
    gamePollHour: Number(env.GAME_POLL_HOUR),
    gamePollHourWeekend: Number(env.GAME_POLL_HOUR_WEEKEND),
    lobbyChannelId: env.LOBBY_CHANNEL_ID,
    voiceCategoryId: env.VOICE_CATEGORY_ID,
    alertUserId: env.ALERT_USER_ID,
    presences: env.PRESENCES ?? false,
    geminiApiKey: env.GEMINI_API_KEY === undefined ? undefined : Redacted.make(env.GEMINI_API_KEY),
    newsChannelId: env.NEWS_CHANNEL_ID,
    appName: "meme-bot",
    revision: "dev",
  };
}
