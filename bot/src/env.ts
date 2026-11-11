// Configuration from the environment, plus the shared handles every module gets as `env`.
import type { Db } from "./db/index.js";

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
  /** Set by the admin test routes so simulated runs don't notify anyone. */
  QUIET?: boolean;
}

export type Config = Omit<Env, "db" | "QUIET"> & { DATABASE_URL: string; PORT: number };

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

export function loadConfig(e: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((k) => !e[k]);
  if (missing.length) throw new Error(`missing environment: ${missing.join(", ")}`);
  return {
    DATABASE_URL: e.DATABASE_URL!,
    PORT: Number(e.PORT ?? 3000),
    DISCORD_TOKEN: e.DISCORD_TOKEN!,
    DISCORD_PUBLIC_KEY: e.DISCORD_PUBLIC_KEY!,
    DISCORD_APP_ID: e.DISCORD_APP_ID!,
    INGEST_SECRET: e.INGEST_SECRET!,
    ADMIN_SECRET: e.ADMIN_SECRET!,
    GUILD_ID: e.GUILD_ID!,
    CHANNEL_ID: e.CHANNEL_ID!,
    SUBREDDIT: e.SUBREDDIT ?? "ProgrammerHumor",
    POST_HOUR_UTC: e.POST_HOUR_UTC ?? "10",
    GAME_CHANNEL_ID: e.GAME_CHANNEL_ID!,
    PLAYERS: e.PLAYERS!,
    TIMEZONE: e.TIMEZONE ?? "Europe/Vilnius",
    GAME_POLL_HOUR: e.GAME_POLL_HOUR ?? "17",
    GAME_POLL_HOUR_WEEKEND: e.GAME_POLL_HOUR_WEEKEND ?? "14",
    LOBBY_CHANNEL_ID: e.LOBBY_CHANNEL_ID!,
    VOICE_CATEGORY_ID: e.VOICE_CATEGORY_ID!,
    ALERT_USER_ID: e.ALERT_USER_ID || undefined,
    PRESENCES: e.PRESENCES === "1",
  };
}
