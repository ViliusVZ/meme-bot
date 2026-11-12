// Configuration through Config (plan 05, verification.md §7 tests 1, 2 and 5): every missing
// variable named at once, secrets that can't be printed, and the per-call overrides of the admin
// routes reaching deep code and background work.
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Duration, Effect, FiberSet, Logger, Redacted } from "effect";
import { AppConfig, ConfigMissing, Overrides, allowedMentions, players, quiet, readConfig, withOverrides } from "../src/config.js";
import { Background } from "../src/background.js";
import { Discord } from "../src/discord.js";
import { loadConfig } from "./env.js";
import { harness } from "./fx.js";

const h = harness({ db: false, discord: { firstId: 100 } });
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

it.effect("every missing variable is named in one message, as before", () => Effect.gen(function* () {
  const e = yield* readConfig.pipe(from({ GUILD_ID: "g", PLAYERS: "" }), Effect.flip);
  expect(e).toBeInstanceOf(ConfigMissing);
  expect(e.message).toBe(
    "missing environment: DATABASE_URL, DISCORD_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APP_ID, INGEST_SECRET, ADMIN_SECRET, CHANNEL_ID, GAME_CHANNEL_ID, PLAYERS, LOBBY_CHANNEL_ID, VOICE_CATEGORY_ID",
  );
  expect(() => loadConfig({ GUILD_ID: "g" })).toThrow("missing environment: DATABASE_URL, DISCORD_TOKEN");
}));

it.effect("defaults, numbers and the player list; the old Env keeps its strings", () => Effect.gen(function* () {
  const c = yield* readConfig.pipe(from(full));
  expect([c.port, c.postHourUtc, c.gamePollHour, c.gamePollHourWeekend, c.timezone, c.subreddit]).toEqual([3000, 10, 17, 14, "Europe/Vilnius", "ProgrammerHumor"]);
  expect(c.players).toEqual(["a", "b", "c"]);
  expect([c.alertUserId, c.presences]).toEqual([undefined, false]);
  const old = loadConfig({ ...full, PRESENCES: "1", ALERT_USER_ID: "" });
  expect([old.PORT, old.POST_HOUR_UTC, old.GAME_POLL_HOUR, old.PLAYERS, old.PRESENCES, old.ALERT_USER_ID]).toEqual([3000, "10", "17", "a,b,c", true, undefined]);
}));

it.effect("a secret never appears in logs or when the config is printed", () => Effect.gen(function* () {
  const c = yield* readConfig.pipe(from(full));
  const lines: string[] = [];
  const capture = Logger.layer([Logger.map(Logger.formatLogFmt, (line) => void lines.push(line))]);
  yield* Effect.logInfo("config", c, `${c.discordToken}`).pipe(Effect.provide(capture));
  const printed = [String(c), JSON.stringify(c), String(c.databaseUrl), `${c.ingestSecret}`, lines.join("\n")].join("\n");
  for (const secret of ["pg-secret-pw", "discord-secret-token", "ingest-secret", "admin-secret", "gemini-secret"]) expect(printed).not.toContain(secret);
  expect(lines.join("\n")).toContain("<redacted>");
  expect(Redacted.value(c.discordToken)).toBe("discord-secret-token"); // still usable where it's needed
}));

it.effect("overrides reach background work: a quiet call's deferred ping is quiet too", () =>
  Effect.gen(function* () {
    // what an admin route does: provide the override around the call; the call defers work
    const seen: boolean[] = [];
    yield* Effect.gen(function* () {
      const set = yield* FiberSet.make();
      const call = Effect.gen(function* () {
        yield* FiberSet.run(set, Effect.sleep("20 millis").pipe(Effect.andThen(quiet), Effect.map((q) => void seen.push(q))));
      }).pipe(Effect.provideService(Overrides, { quiet: true }));
      yield* call;
      yield* FiberSet.run(set, quiet.pipe(Effect.map((q) => void seen.push(q)))); // outside the call
      yield* FiberSet.awaitEmpty(set);
    }).pipe(Effect.scoped);
    expect(seen.sort()).toEqual([false, true]);
  }).pipe(h.provide),
);

it.effect("overrides reach background work: a quiet call's deferred ping goes out with no mentions", () =>
  Effect.gen(function* () {
    // what a quiet admin call does: background work it starts posts a ping, after a moment
    const ping = Effect.gen(function* () {
      yield* Effect.sleep("20 millis");
      const discord = yield* Discord;
      yield* discord.createMessage("gn", { content: "<@a> it's on!", allowed_mentions: yield* allowedMentions(["a"]) });
    });
    const defer = Background.use((b) => b.run(ping, "the ping"));
    yield* withOverrides({ quiet: true })(defer);
    yield* defer; // the same, not quiet
    yield* Background.use((b) => b.drain(Duration.millis(5000)));
    const pings = h.calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages").map((c) => c.body.allowed_mentions);
    expect(pings).toEqual([{ parse: [] }, { users: ["a"] }]);
  }).pipe(h.provide),
);

it.effect("an inner override keeps the outer one's other fields", () =>
  Effect.gen(function* () {
    const seen = yield* withOverrides({ players: ["qa-1", "qa-2"] })(
      withOverrides({ quiet: true })(Effect.gen(function* () {
        return [yield* players, yield* quiet];
      })),
    );
    expect(seen).toEqual([["qa-1", "qa-2"], true]);
  }).pipe(h.provide),
);

it.effect("stand-in players given to an admin call are the players deep code sees", () =>
  Effect.gen(function* () {
    // an admin call's stand-ins, provided around the call
    const standIns = yield* withOverrides({ players: ["qa-1", "qa-2"] })(players);
    expect(standIns).toEqual(["qa-1", "qa-2"]);
    expect(yield* players).toEqual(["a", "b", "c"]);
    // and quiet with them: an inner call sees both (what the old bridge handed old code as its env)
    const o = yield* withOverrides({ players: ["qa-1"], quiet: true })(Overrides);
    const env = { PLAYERS: o.players?.join(","), QUIET: o.quiet };
    expect([env.PLAYERS, env.QUIET]).toEqual(["qa-1", true]);
    const real = yield* Effect.gen(function* () {
      return (yield* AppConfig).players;
    });
    expect(real).toEqual(["a", "b", "c"]);
  }).pipe(h.provide),
);
