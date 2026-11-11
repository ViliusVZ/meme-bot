// The transition (plan 05, phases 3-5): old promise code and new Effect code share one runtime, so
// they see the same services and the same state. Everything here goes in phase 5.
import { Cause, Context, Effect, Exit, ManagedRuntime, Redacted } from "effect"; // LEGACY-BRIDGE
import type { Env } from "./env.js"; // LEGACY-BRIDGE
import { type AppConfigShape, Overrides } from "./config.js"; // LEGACY-BRIDGE
import type { AppServices } from "./runtime.js"; // LEGACY-BRIDGE

// the app's one runtime (main.ts installs it; in tests, the harness, per test file)
let runtime: ManagedRuntime.ManagedRuntime<AppServices, unknown> | null = null; // LEGACY-BRIDGE

export function install(rt: ManagedRuntime.ManagedRuntime<AppServices, unknown> | null) { // LEGACY-BRIDGE
  runtime = rt; // LEGACY-BRIDGE
} // LEGACY-BRIDGE

const installed = () => { // LEGACY-BRIDGE
  if (!runtime) throw new Error("legacy bridge: no runtime installed (main.ts, or the test harness)"); // LEGACY-BRIDGE
  return runtime; // LEGACY-BRIDGE
}; // LEGACY-BRIDGE

/** The old `env` an Effect method can hand to a function that still takes one. */
export class LegacyEnv extends Context.Service<LegacyEnv, Env>()("meme-bot/legacy/LegacyEnv") {} // LEGACY-BRIDGE

/** What an old `env` says about this call: `{ ...env, QUIET: true }`, `{ ...env, PLAYERS: … }`. */
const overridesOf = (env: Env) => ({ quiet: env.QUIET ?? false, players: env.PLAYERS.split(",").map((s) => s.trim()).filter(Boolean) }); // LEGACY-BRIDGE

/** The Gemini key an old `env` carries (tests set one per call: `{ ...env, GEMINI_API_KEY: "k" }`). */
export const LegacyGeminiKey = Context.Reference<string | undefined | null>("meme-bot/legacy/LegacyGeminiKey", { defaultValue: () => null }); // LEGACY-BRIDGE

/** Game detection as an old `env` has it (tests turn it on per call: `{ ...env, PRESENCES: true }`). */
export const LegacyPresences = Context.Reference<boolean | null>("meme-bot/legacy/LegacyPresences", { defaultValue: () => null }); // LEGACY-BRIDGE

const withEnv = <A, E, R>(env: Env, effect: Effect.Effect<A, E, R>) => // LEGACY-BRIDGE
  effect.pipe(Effect.provideService(Overrides, overridesOf(env)), Effect.provideService(LegacyEnv, env), Effect.provideService(LegacyGeminiKey, env.GEMINI_API_KEY), Effect.provideService(LegacyPresences, env.PRESENCES ?? false)); // LEGACY-BRIDGE

/** Promise code calling Effect code: the overrides the old `env` carries come along. Rejects with the error itself. */
export async function run<A, E>(env: Env, effect: Effect.Effect<A, E, AppServices | LegacyEnv>): Promise<A> { // LEGACY-BRIDGE
  const exit = await installed().runPromiseExit(withEnv(env, effect)); // LEGACY-BRIDGE
  if (Exit.isSuccess(exit)) return exit.value; // LEGACY-BRIDGE
  throw Cause.squash(exit.cause); // LEGACY-BRIDGE
} // LEGACY-BRIDGE

/** Promise code calling Effect code that needs no per-call overrides (tests' helpers, shutdown). */
export async function runDetached<A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> { // LEGACY-BRIDGE
  const exit = await installed().runPromiseExit(effect); // LEGACY-BRIDGE
  if (Exit.isSuccess(exit)) return exit.value; // LEGACY-BRIDGE
  throw Cause.squash(exit.cause); // LEGACY-BRIDGE
} // LEGACY-BRIDGE

/** The same, for synchronous services (presence and channel lookups are synchronous in the old code). */
export function runSync<A, E>(effect: Effect.Effect<A, E, AppServices>): A { // LEGACY-BRIDGE
  const exit = installed().runSyncExit(effect); // LEGACY-BRIDGE
  if (Exit.isSuccess(exit)) return exit.value; // LEGACY-BRIDGE
  throw Cause.squash(exit.cause); // LEGACY-BRIDGE
} // LEGACY-BRIDGE

/** The installed runtime's services (the old app object builds its routes on them). */
export const appContext = () => installed().context(); // LEGACY-BRIDGE

/** Effect code calling a function that still takes `env`: it gets one carrying this call's overrides. */
export const legacyEnv = Effect.gen(function* () { // LEGACY-BRIDGE
  const env = yield* LegacyEnv; // LEGACY-BRIDGE
  const o = yield* Overrides; // LEGACY-BRIDGE
  return { ...env, QUIET: o.quiet || undefined, PLAYERS: o.players ? o.players.join(",") : env.PLAYERS } as Env; // LEGACY-BRIDGE
}); // LEGACY-BRIDGE

/** The old Config fields, from AppConfig (the old `Env` is still built, from it). */
export function envFields(c: AppConfigShape): Omit<Env, "db"> { // LEGACY-BRIDGE
  return { // LEGACY-BRIDGE
    DISCORD_TOKEN: Redacted.value(c.discordToken), // LEGACY-BRIDGE
    DISCORD_PUBLIC_KEY: c.discordPublicKey, // LEGACY-BRIDGE
    DISCORD_APP_ID: c.discordAppId, // LEGACY-BRIDGE
    INGEST_SECRET: Redacted.value(c.ingestSecret), // LEGACY-BRIDGE
    ADMIN_SECRET: Redacted.value(c.adminSecret), // LEGACY-BRIDGE
    GUILD_ID: c.guildId, // LEGACY-BRIDGE
    CHANNEL_ID: c.channelId, // LEGACY-BRIDGE
    SUBREDDIT: c.subreddit, // LEGACY-BRIDGE
    POST_HOUR_UTC: String(c.postHourUtc), // LEGACY-BRIDGE
    GAME_CHANNEL_ID: c.gameChannelId, // LEGACY-BRIDGE
    PLAYERS: c.players.join(","), // LEGACY-BRIDGE
    TIMEZONE: c.timezone, // LEGACY-BRIDGE
    GAME_POLL_HOUR: String(c.gamePollHour), // LEGACY-BRIDGE
    GAME_POLL_HOUR_WEEKEND: String(c.gamePollHourWeekend), // LEGACY-BRIDGE
    LOBBY_CHANNEL_ID: c.lobbyChannelId, // LEGACY-BRIDGE
    VOICE_CATEGORY_ID: c.voiceCategoryId, // LEGACY-BRIDGE
    ALERT_USER_ID: c.alertUserId, // LEGACY-BRIDGE
    PRESENCES: c.presences, // LEGACY-BRIDGE
    GEMINI_API_KEY: c.geminiApiKey === undefined ? undefined : Redacted.value(c.geminiApiKey), // LEGACY-BRIDGE
  }; // LEGACY-BRIDGE
} // LEGACY-BRIDGE

/** And the other way, for tests that build an `Env` by hand (test/pg.ts testEnv). */
export function configFromEnv(env: Env, extra: { databaseUrl?: string; port?: number } = {}): AppConfigShape { // LEGACY-BRIDGE
  return { // LEGACY-BRIDGE
    databaseUrl: Redacted.make(extra.databaseUrl ?? ""), // LEGACY-BRIDGE
    port: extra.port ?? 3000, // LEGACY-BRIDGE
    discordToken: Redacted.make(env.DISCORD_TOKEN), // LEGACY-BRIDGE
    discordPublicKey: env.DISCORD_PUBLIC_KEY, // LEGACY-BRIDGE
    discordAppId: env.DISCORD_APP_ID, // LEGACY-BRIDGE
    ingestSecret: Redacted.make(env.INGEST_SECRET), // LEGACY-BRIDGE
    adminSecret: Redacted.make(env.ADMIN_SECRET), // LEGACY-BRIDGE
    guildId: env.GUILD_ID, // LEGACY-BRIDGE
    channelId: env.CHANNEL_ID, // LEGACY-BRIDGE
    subreddit: env.SUBREDDIT, // LEGACY-BRIDGE
    postHourUtc: Number(env.POST_HOUR_UTC), // LEGACY-BRIDGE
    gameChannelId: env.GAME_CHANNEL_ID, // LEGACY-BRIDGE
    players: env.PLAYERS.split(",").map((s) => s.trim()).filter(Boolean), // LEGACY-BRIDGE
    timezone: env.TIMEZONE, // LEGACY-BRIDGE
    gamePollHour: Number(env.GAME_POLL_HOUR), // LEGACY-BRIDGE
    gamePollHourWeekend: Number(env.GAME_POLL_HOUR_WEEKEND), // LEGACY-BRIDGE
    lobbyChannelId: env.LOBBY_CHANNEL_ID, // LEGACY-BRIDGE
    voiceCategoryId: env.VOICE_CATEGORY_ID, // LEGACY-BRIDGE
    alertUserId: env.ALERT_USER_ID, // LEGACY-BRIDGE
    presences: env.PRESENCES ?? false, // LEGACY-BRIDGE
    geminiApiKey: env.GEMINI_API_KEY === undefined ? undefined : Redacted.make(env.GEMINI_API_KEY), // LEGACY-BRIDGE
    appName: "meme-bot", // LEGACY-BRIDGE
    revision: "dev", // LEGACY-BRIDGE
  }; // LEGACY-BRIDGE
} // LEGACY-BRIDGE
