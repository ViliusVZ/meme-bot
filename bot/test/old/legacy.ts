// The transition's bridge, for the tests (plan 05: it left src in phase 5, step 8). The old promise-
// style functions in test/old/ reach the app's services through the runtime the harness installs,
// one per test (fresh state each test; `restart` builds a new one mid-test: a deploy). Phase 6 makes
// the tests Effect-native and removes all of test/old/.
import { Cause, Context, Effect, Exit, Layer, type ManagedRuntime, Redacted } from "effect";
import type { Env } from "./env.js";
import { AppConfig, type AppConfigShape, Overrides } from "../../src/config.js";
import type { AppServices } from "../../src/runtime.js";
import { Spontaneous } from "../../src/spontaneous.js";
import { Gemini } from "../../src/gemini.js";

// the runtime of the test that's running (the harness installs it)
let runtime: ManagedRuntime.ManagedRuntime<AppServices, unknown> | null = null;
let restarter: (() => void) | null = null;

export function install(rt: ManagedRuntime.ManagedRuntime<AppServices, unknown> | null) {
  runtime = rt;
}

/** The harness: how to start a fresh runtime mid-test (what the old `_reset()` hooks now do). */
export function onRestart(fn: (() => void) | null) {
  restarter = fn;
}

/** A fresh runtime, as after a deploy: every in-memory state starts again. */
export function restart() {
  if (!restarter) throw new Error("legacy bridge: no harness to restart");
  restarter();
}

/** What survives a restart because production reads it from its configuration: the alert owner. */
export const sticky: { owner: string | undefined } = { owner: undefined };

const installed = () => {
  if (!runtime) throw new Error("legacy bridge: no runtime installed (the test harness)");
  return runtime;
};

/** The old `env` an Effect method can hand to a function that still takes one. */
export class LegacyEnv extends Context.Service<LegacyEnv, Env>()("meme-bot/test/old/legacy/LegacyEnv") {}

/** What an old `env` says about this call: `{ ...env, QUIET: true }`, `{ ...env, PLAYERS: … }`. */
const overridesOf = (env: Env) => ({ quiet: env.QUIET ?? false, players: env.PLAYERS.split(",").map((s) => s.trim()).filter(Boolean) });

/**
 * Game detection and the Gemini key, as an old `env` has them: tests set them per call
 * (`{ ...env, PRESENCES: true, GEMINI_API_KEY: "k" }`). A call whose env differs from the runtime's
 * configuration gets its own Spontaneous and Gemini (both hold no state of their own), built with that
 * configuration over the runtime's other services.
 */
const configured = <A, E, R>(env: Pick<Env, "PRESENCES" | "GEMINI_API_KEY">, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const c = yield* AppConfig;
    const presences = env.PRESENCES ?? false;
    const key = env.GEMINI_API_KEY;
    if (presences === c.presences && key === (c.geminiApiKey === undefined ? undefined : Redacted.value(c.geminiApiKey))) return yield* effect;
    const own: AppConfigShape = { ...c, presences, geminiApiKey: key === undefined ? undefined : Redacted.make(key) };
    const services = Layer.fresh(Spontaneous.layer).pipe(Layer.provideMerge(Layer.fresh(Gemini.layer)), Layer.provide(Layer.succeed(AppConfig, own)));
    return yield* Effect.provide(effect, services);
  });

/** An Effect test's call with game detection on (what `{ ...env, PRESENCES: true }` does for a bridge call). */
export const withPresences = <A, E, R>(effect: Effect.Effect<A, E, R>) => configured({ PRESENCES: true }, effect);
/** The same for any of the two: `withConfig({ PRESENCES: true, GEMINI_API_KEY: "k" })`. */
export const withConfig = (env: Pick<Env, "PRESENCES" | "GEMINI_API_KEY">) => <A, E, R>(effect: Effect.Effect<A, E, R>) => configured(env, effect);

const withEnv = <A, E, R>(env: Env, effect: Effect.Effect<A, E, R>) =>
  configured(env, effect).pipe(Effect.provideService(Overrides, overridesOf(env)), Effect.provideService(LegacyEnv, env));

/** Promise code calling Effect code: the overrides the old `env` carries come along. Rejects with the error itself. */
export async function run<A, E>(env: Env, effect: Effect.Effect<A, E, AppServices | LegacyEnv>): Promise<A> {
  const exit = await installed().runPromiseExit(withEnv(env, effect) as Effect.Effect<A, E, AppServices>);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Promise code calling Effect code that needs no per-call overrides. */
export async function runDetached<A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> {
  const exit = await installed().runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Promise code starting Effect code that runs until interrupted (the clock): its fiber. */
export function forkDetached<A, E>(env: Env, effect: Effect.Effect<A, E, AppServices | LegacyEnv>) {
  return installed().runFork(withEnv(env, effect) as Effect.Effect<A, E, AppServices>);
}

/** The same, for synchronous services (presence and channel lookups are synchronous in the old code). */
export function runSync<A, E>(effect: Effect.Effect<A, E, AppServices>): A {
  const exit = installed().runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** The installed runtime's services (the old app object builds its routes on them). */
export const appContext = () => installed().context();

/** Effect code calling a function that still takes `env`: it gets one carrying this call's overrides. */
export const legacyEnv = Effect.gen(function* () {
  const env = yield* LegacyEnv;
  const o = yield* Overrides;
  return { ...env, QUIET: o.quiet || undefined, PLAYERS: o.players ? o.players.join(",") : env.PLAYERS } as Env;
});

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
    appName: "meme-bot",
    revision: "dev",
  };
}
