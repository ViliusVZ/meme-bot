// Configuration from the environment, plus the shared handles every module gets as `env`.
import { Cause, ConfigProvider, Effect, Exit, Redacted } from "effect"; // LEGACY-BRIDGE
import type { Db } from "./db/index.js";
import { readConfig } from "./config.js"; // LEGACY-BRIDGE
import { envFields } from "./legacy.js"; // LEGACY-BRIDGE

export interface Env {
  db: Db;
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
  /** Set by the admin test routes so simulated runs don't notify anyone. */
  QUIET?: boolean;
}

export type Config = Omit<Env, "db" | "QUIET"> & { DATABASE_URL: string; PORT: number };

/** The environment, read by Config (config.ts); the old shape, for the code that still takes `env`. */
export function loadConfig(e: NodeJS.ProcessEnv = process.env): Config { // LEGACY-BRIDGE
  const exit = Effect.runSyncExit(readConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(e))))); // LEGACY-BRIDGE
  if (Exit.isFailure(exit)) { // LEGACY-BRIDGE
    const e = Cause.squash(exit.cause); // LEGACY-BRIDGE
    throw new Error(e instanceof Error ? e.message : String(e)); // "missing environment: A, B", as always // LEGACY-BRIDGE
  } // LEGACY-BRIDGE
  const c = exit.value; // LEGACY-BRIDGE
  return { DATABASE_URL: Redacted.value(c.databaseUrl), PORT: c.port, ...envFields(c) }; // LEGACY-BRIDGE
} // LEGACY-BRIDGE

/** The trio's user ids (moved here from gamenight.ts: everything below it needs them). */
export const players = (env: Env) => env.PLAYERS.split(",").map((s) => s.trim()).filter(Boolean);
