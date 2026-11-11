// Configuration through Config (plan 05, verification.md §7 tests 1, 2 and 5): every missing
// variable named at once, secrets that can't be printed, and the per-call overrides of the admin
// routes reaching deep code and background work.
import { expect, test } from "vitest";
import { ConfigProvider, Effect, FiberSet, Logger, Redacted } from "effect";
import { AppConfig, ConfigMissing, Overrides, players, quiet, readConfig } from "../src/config.js";
import { loadConfig } from "../src/env.js";
import { legacyEnv, run } from "../src/legacy.js";
import { harness } from "./harness.js";

const h = harness({ db: false });
const from = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)));
const full = {
  DATABASE_URL: "postgres://bot:pg-secret-pw@db/meme_bot",
  DISCORD_TOKEN: "discord-secret-token",
  DISCORD_PUBLIC_KEY: "ab12",
  DISCORD_APP_ID: "app",
  INGEST_SECRET: "ingest-secret",
  ADMIN_SECRET: "admin-secret",
  GUILD_ID: "g",
  CHANNEL_ID: "c",
  GAME_CHANNEL_ID: "gn",
  PLAYERS: "a, b,c",
  LOBBY_CHANNEL_ID: "l",
  VOICE_CATEGORY_ID: "v",
  GEMINI_API_KEY: "gemini-secret",
};

test("every missing variable is named in one message, as before", async () => {
  const e = await Effect.runPromise(readConfig.pipe(from({ GUILD_ID: "g", PLAYERS: "" }), Effect.flip));
  expect(e).toBeInstanceOf(ConfigMissing);
  expect(e.message).toBe(
    "missing environment: DATABASE_URL, DISCORD_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APP_ID, INGEST_SECRET, ADMIN_SECRET, CHANNEL_ID, GAME_CHANNEL_ID, PLAYERS, LOBBY_CHANNEL_ID, VOICE_CATEGORY_ID",
  );
  expect(() => loadConfig({ GUILD_ID: "g" })).toThrow("missing environment: DATABASE_URL, DISCORD_TOKEN");
});

test("defaults, numbers and the player list; the old Env keeps its strings", async () => {
  const c = await Effect.runPromise(readConfig.pipe(from(full)));
  expect([c.port, c.postHourUtc, c.gamePollHour, c.gamePollHourWeekend, c.timezone, c.subreddit]).toEqual([3000, 10, 17, 14, "Europe/Vilnius", "ProgrammerHumor"]);
  expect(c.players).toEqual(["a", "b", "c"]);
  expect([c.alertUserId, c.presences]).toEqual([undefined, false]);
  const old = loadConfig({ ...full, PRESENCES: "1", ALERT_USER_ID: "" });
  expect([old.PORT, old.POST_HOUR_UTC, old.GAME_POLL_HOUR, old.PLAYERS, old.PRESENCES, old.ALERT_USER_ID]).toEqual([3000, "10", "17", "a,b,c", true, undefined]);
});

test("a secret never appears in logs or when the config is printed", async () => {
  const c = await Effect.runPromise(readConfig.pipe(from(full)));
  const lines: string[] = [];
  const capture = Logger.layer([Logger.map(Logger.formatLogFmt, (line) => void lines.push(line))]);
  await Effect.runPromise(Effect.logInfo("config", c, `${c.discordToken}`).pipe(Effect.provide(capture)));
  const printed = [String(c), JSON.stringify(c), String(c.databaseUrl), `${c.ingestSecret}`, lines.join("\n")].join("\n");
  for (const secret of ["pg-secret-pw", "discord-secret-token", "ingest-secret", "admin-secret", "gemini-secret"]) expect(printed).not.toContain(secret);
  expect(lines.join("\n")).toContain("<redacted>");
  expect(Redacted.value(c.discordToken)).toBe("discord-secret-token"); // still usable where it's needed
});

test("overrides reach background work: a quiet call's deferred ping is quiet too", async () => {
  // what an admin route does: provide the override around the call; the call defers work
  const seen: boolean[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const set = yield* FiberSet.make();
      const call = Effect.gen(function* () {
        yield* FiberSet.run(set, Effect.sleep("20 millis").pipe(Effect.andThen(quiet), Effect.map((q) => void seen.push(q))));
      }).pipe(Effect.provideService(Overrides, { quiet: true }));
      yield* call;
      yield* FiberSet.run(set, quiet.pipe(Effect.map((q) => void seen.push(q)))); // outside the call
      yield* FiberSet.awaitEmpty(set);
    }).pipe(Effect.scoped),
  );
  expect(seen.sort()).toEqual([false, true]);
});

test("stand-in players given to an admin call are the players deep code sees", async () => {
  // old admin route style: { ...env, PLAYERS: "qa-1,qa-2" } through the bridge
  const standIns = await run({ ...h.env, PLAYERS: "qa-1,qa-2" }, players);
  expect(standIns).toEqual(["qa-1", "qa-2"]);
  expect(await run(h.env, players)).toEqual(["a", "b", "c"]);
  // and Effect code handing an env to old code passes them on, quiet included
  const env = await run({ ...h.env, PLAYERS: "qa-1", QUIET: true }, legacyEnv);
  expect([env.PLAYERS, env.QUIET]).toEqual(["qa-1", true]);
  const real = await run(h.env, Effect.gen(function* () {
    return (yield* AppConfig).players;
  }));
  expect(real).toEqual(["a", "b", "c"]);
});
