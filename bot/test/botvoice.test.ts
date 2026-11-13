// 🔊 The bot speaks (plan 03), against a real Postgres, under the test's TestClock, with a fake voice
// connection and a fake speech engine: the plan's eleven edge cases, the four moments (the lone
// early bird's rules one by one), the 🔇 toggle, and the clip cache.
//
// How the clock is driven: everything up to the join (the toggle, the line's draw, the clip cache)
// is real database work, so a test waits for the join on the real clock; from the join on, a visit
// only sleeps and talks to the fake, so TestClock.adjust replays it exactly and the gaps are exact.
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Clock, ConfigProvider, Effect, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { BotVoice, JINGLES, type Part } from "../src/botvoice.js";
import { VoiceConnector, VoiceFailed } from "../src/voiceconn.js";
import { VoiceLink } from "../src/voicelink.js";
import { Tts, TtsUnavailable, LT_VOICE } from "../src/tts.js";
import { Clips } from "../src/clips.js";
import { Presence } from "../src/presence.js";
import { Alerts } from "../src/alerts.js";
import { Live } from "../src/live.js";
import { LateSlips } from "../src/late.js";
import { GameNight } from "../src/gamenight.js";
import { Spontaneous } from "../src/spontaneous.js";
import { Activity } from "../src/activity.js";
import { Interactions } from "../src/interactions.js";
import { readConfig } from "../src/config.js";
import { Db } from "../src/db/db.js";
import { EARLY, EARLY_PERSONAL, LATE, LOBBY, START, family, fill, spans } from "../src/lines.js";
import {
  earlyBirds,
  fleeting,
  gameAliases,
  gameNights,
  games,
  lobbyPrompts,
  nightAttendance,
  readyRooms,
  roastBags,
  rooms,
  sessions,
  settings,
  voiceClips,
  voiceSegments,
} from "../src/db/schema.js";
import { harness, routes } from "./fx.js";

// ---------------------------------------------------------------- the fakes

type Ev = { at: number; what: string; detail: string };
const fake = {
  events: [] as Ev[],
  readyAfter: 500 as number | null, // ms from join to ready; null: never ready
  clipMs: 1000 as number | null, // how long each clip plays; null: playback hangs
  joinFails: null as string | null,
  synthFails: false,
  synths: [] as string[],
  reset() {
    Object.assign(fake, { events: [], readyAfter: 500, clipMs: 1000, joinFails: null, synthFails: false, synths: [] });
  },
};
const T0 = Date.parse("2026-11-13T15:00:00Z"); // Friday 17:00 in Vilnius
const DAY = "2026-11-13";
const enc = new TextEncoder();
const label = (clip: Uint8Array) =>
  clip === JINGLES.night ? "♪night" : clip === JINGLES.beep ? "♪beep" : new TextDecoder().decode(clip);
const note = (what: string, detail: string) => Effect.flatMap(Clock.currentTimeMillis, (t) => Effect.sync(() => void fake.events.push({ at: t - T0, what, detail })));

const FakeVoice = Layer.succeed(
  VoiceConnector,
  VoiceConnector.of({
    join: (channel) =>
      Effect.gen(function* () {
        yield* note("join", channel);
        if (fake.joinFails) return yield* new VoiceFailed({ detail: fake.joinFails });
        const readyAfter = fake.readyAfter;
        const clipMs = fake.clipMs;
        return {
          ready: readyAfter === null ? Effect.never : Effect.andThen(Effect.sleep(readyAfter), note("ready", channel)),
          play: (clip: Uint8Array) =>
            Effect.gen(function* () {
              yield* note("play", label(clip));
              if (clipMs === null) return yield* Effect.never;
              yield* Effect.sleep(clipMs);
              yield* note("end", label(clip));
            }),
          leave: note("leave", channel),
        };
      }),
  }),
);
const FakeTts = Layer.succeed(
  Tts,
  Tts.of({
    synth: (text, voice) =>
      fake.synthFails
        ? Effect.fail(new TtsUnavailable({ engine: "edge", detail: "Edge is down" }))
        : Effect.sync(() => {
            fake.synths.push(text);
            return enc.encode(`${voice === LT_VOICE ? "lt" : "en"}:${text}`);
          }),
  }),
);

const h = harness({
  tables: [voiceClips, earlyBirds, roastBags, settings, gameNights, rooms, voiceSegments, lobbyPrompts, sessions, nightAttendance, fleeting, readyRooms, gameAliases, games],
  discord: { firstId: 70000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "test",
  env: { BOT_VOICE: true },
  voice: FakeVoice,
  tts: FakeTts,
});

// ---------------------------------------------------------------- helpers

const real = (ms = 15) => TestClock.withLive(Effect.sleep(ms));
/** Wait on the real clock (database work) until `cond` holds. */
const until = (cond: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      if (cond()) return;
      yield* real();
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });
const count = (what: string) => fake.events.filter((e) => e.what === what).length;
const joined = (n = 1) => until(() => count("join") >= n, `join #${n}`);
const timeline = () => fake.events.map((e) => [e.at, e.what, e.detail] as const);
/** The queue worked for a leader's term (the test's scope). */
const speaking = <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.scoped(Effect.andThen(BotVoice.use((v) => v.run), body));
const start = Effect.andThen(TestClock.setTime(T0), Effect.sync(() => fake.reset()));
const inVoice = (states: Record<string, string>) => Presence.use((p) => p.snapshot(Object.entries(states).map(([user_id, channel_id]) => ({ user_id, channel_id }))));
const line = (text: string): Part => ({ _tag: "Line", line: text });
const spoken = (text: string) => spans(text).map((s) => `${s.voice === LT_VOICE ? "lt" : "en"}:${s.text}`);
const dms = () => h.calls.filter((c) => c.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(c.path) && JSON.stringify(c.body ?? "").includes("🚨"));
const logged = (s: string) => h.logs.some((l) => l.includes(s));

// ---------------------------------------------------------------- the eleven edge cases

it.effect("1. join → ready → 3 s → play → end → 3 s → leave, in that order with those gaps (a night's start: the jingle, then its line)", () =>
  Effect.gen(function* () {
    yield* start;
    yield* inVoice({ a: "room" });
    yield* speaking(
      Effect.gen(function* () {
        yield* BotVoice.use((v) => v.nightStarted(DAY, "room", "World of Warcraft"));
        yield* joined();
        yield* TestClock.adjust(60_000);
      }),
    );
    const ev = fake.events;
    const at = (what: string) => ev.filter((e) => e.what === what).map((e) => e.at);
    expect(at("join")).toEqual([0]);
    expect(at("ready")).toEqual([500]);
    expect(at("play")[0] - at("ready")[0]).toBe(3000); // ready → 3 s → the first sound
    const plays = ev.filter((e) => e.what === "play").map((e) => e.detail);
    expect(plays[0]).toBe("♪night");
    // the rest is one of the start lines, about this game, span by span
    expect(START.map((l) => spoken(fill(l, { game: "World of Warcraft" })))).toContainEqual(plays.slice(1));
    for (let i = 1; i < plays.length; i++) expect(at("play")[i]).toBe(at("end")[i - 1]); // back to back
    expect(at("leave")[0] - at("end").at(-1)!).toBe(3000); // the last sound → 3 s → leave
    expect(ev.map((e) => e.what)).toEqual(["join", "ready", ...plays.flatMap(() => ["play", "end"]), "leave"]);
  }).pipe(h.provide),
);

it.effect("2. a connection that never becomes ready is given up at 10 s, with one alert; the caller never waited", () =>
  Effect.gen(function* () {
    yield* start;
    yield* Alerts.use((a) => a.setOwner("owner"));
    fake.readyAfter = null;
    yield* inVoice({ a: "room" });
    yield* speaking(
      Effect.gen(function* () {
        const v = yield* BotVoice;
        yield* v.nightStarted(DAY, "room", "R.E.P.O.");
        expect(yield* Clock.currentTimeMillis).toBe(T0); // queued, and back at once
        yield* joined();
        yield* TestClock.adjust(15_000);
        // the next thing still gets its visit
        fake.readyAfter = 500;
        yield* v.say("room", [line("Still here.")], "test");
        yield* joined(2);
        yield* TestClock.adjust(30_000);
      }),
    );
    yield* Alerts.use((a) => a.settle);
    expect(timeline().slice(0, 2)).toEqual([
      [0, "join", "room"],
      [10_000, "leave", "room"],
    ]);
    expect(count("play")).toBe(1);
    expect(dms()).toHaveLength(1);
    expect(JSON.stringify(dms()[0].body)).toContain("speaking in voice");
  }).pipe(h.provide),
);

it.effect("3. everyone leaves while it's speaking: it stops and leaves at once", () =>
  Effect.gen(function* () {
    yield* start;
    fake.clipMs = 5000;
    yield* inVoice({ a: "room" });
    yield* speaking(
      Effect.gen(function* () {
        yield* BotVoice.use((v) => v.say("room", [line("A long line.")], "test"));
        yield* joined();
        yield* TestClock.adjust(4500); // a second into the clip
        yield* Presence.use((p) => p.update("a", null));
        yield* real(50);
        yield* TestClock.adjust(30_000);
      }),
    );
    expect(timeline()).toEqual([
      [0, "join", "room"],
      [500, "ready", "room"],
      [3500, "play", "en:A long line."],
      [4500, "leave", "room"],
    ]);
  }).pipe(h.provide),
);

it.effect("4. two things for two channels: one visit each, in order, never in two channels at once; two for one channel: one visit", () =>
  Effect.gen(function* () {
    yield* start;
    yield* inVoice({ a: "room1", b: "room2", c: "room0" });
    yield* speaking(
      Effect.gen(function* () {
        const v = yield* BotVoice;
        yield* v.say("room0", [line("Busy.")], "zero"); // under way while the rest comes in
        yield* joined();
        yield* v.say("room1", [line("First.")], "one");
        yield* v.say("room2", [line("Second.")], "two");
        yield* v.say("room1", [line("Also first.")], "three");
        yield* TestClock.adjust(10_000);
        yield* joined(2);
        yield* TestClock.adjust(8600); // room1 done at 18.5 s: room2's line is 18.6 s old, still fresh
        yield* joined(3);
        yield* TestClock.adjust(20_000);
      }),
    );
    const joins = fake.events.filter((e) => e.what === "join");
    const leaves = fake.events.filter((e) => e.what === "leave");
    expect(joins.map((e) => e.detail)).toEqual(["room0", "room1", "room2"]);
    expect(leaves.map((e) => e.detail)).toEqual(["room0", "room1", "room2"]);
    for (let i = 1; i < joins.length; i++) expect(joins[i].at).toBeGreaterThanOrEqual(leaves[i - 1].at);
    expect(fake.events.filter((e) => e.what === "play").map((e) => e.detail)).toEqual(["en:Busy.", "en:First.", "en:Also first.", "en:Second."]);
  }).pipe(h.provide),
);

it.effect("5. something queued more than 20 s before its turn is dropped; younger is still said", () =>
  Effect.gen(function* () {
    yield* start;
    fake.clipMs = 20_000;
    yield* inVoice({ a: "room1", b: "room2", c: "room3" });
    yield* speaking(
      Effect.gen(function* () {
        const v = yield* BotVoice;
        yield* v.say("room1", [line("A very long line.")], "long");
        yield* joined();
        yield* v.say("room2", [line("Too late.")], "stale"); // its turn comes at 26.5 s
        yield* TestClock.adjust(10_000);
        yield* v.say("room3", [line("In time.")], "fresh"); // queued at 10 s: 16.5 s old at its turn
        yield* TestClock.adjust(17_000);
        yield* joined(2);
        yield* TestClock.adjust(30_000);
      }),
    );
    expect(fake.events.filter((e) => e.what === "join").map((e) => e.detail)).toEqual(["room1", "room3"]);
    expect(logged("voice: dropped stale for room2, 27 s old")).toBe(true);
  }).pipe(h.provide),
);

it.effect("6. the 30-second cap fires even if playback hangs", () =>
  Effect.gen(function* () {
    yield* start;
    fake.clipMs = null;
    yield* inVoice({ a: "room" });
    yield* speaking(
      Effect.gen(function* () {
        yield* BotVoice.use((v) => v.say("room", [line("Stuck.")], "test"));
        yield* joined();
        yield* TestClock.adjust(29_999);
        expect(count("leave")).toBe(0);
        yield* TestClock.adjust(1);
      }),
    );
    expect(timeline()).toEqual([
      [0, "join", "room"],
      [500, "ready", "room"],
      [3500, "play", "en:Stuck."],
      [30_000, "leave", "room"],
    ]);
    expect(logged("the 30 s cap ended the visit")).toBe(true);
  }).pipe(h.provide),
);

it.effect("7. the term ends (shutdown, or leadership lost) while connected: it leaves first, and makes sure Discord has it out", () =>
  Effect.gen(function* () {
    yield* start;
    fake.clipMs = null;
    const link = yield* VoiceLink;
    const sent: unknown[] = [];
    yield* inVoice({ a: "room" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* link.attach((p) => Effect.sync(() => void sent.push(p)));
        yield* speaking(
          Effect.gen(function* () {
            yield* BotVoice.use((v) => v.say("room", [line("Bye.")], "test"));
            yield* joined();
            yield* link.selfState({ guild_id: "guild", user_id: "app", channel_id: "room" } as never); // Discord shows us there
            yield* TestClock.adjust(5000);
          }),
        ); // the term's scope closes here
        expect(timeline().at(-1)).toEqual([5000, "leave", "room"]);
        expect(sent).toEqual([{ op: 4, d: { guild_id: "guild", channel_id: null, self_mute: false, self_deaf: false } }]);
      }),
    );
    // and after the term, nothing more is queued
    expect(yield* BotVoice.use((v) => v.say("room", [line("Hello?")], "test"))).toBe(false);
  }).pipe(h.provide),
);

// 8. (startup while Discord still shows the bot in a channel) is in gateway.test.ts: it needs the gateway.

it.effect("9. the toggle is off: no joins at all, no lines drawn; the HQ panel's 🔇 flips it", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    yield* inVoice({ a: "room", b: "lobby" });
    yield* speaking(
      Effect.gen(function* () {
        const v = yield* BotVoice;
        expect(yield* v.enabled).toBe(true); // BOT_VOICE=on (the test bot)
        const tap = yield* Interactions.use((x) => x.handle({ type: 3, token: "tok", member: { user: { id: "a", username: "a" } }, message: { id: "m1", flags: 0 }, data: { custom_id: "hub:voice" } }));
        expect(JSON.stringify(tap)).toContain("Bot voice: off");
        expect(yield* v.enabled).toBe(false);
        yield* v.nightStarted(DAY, "room", "R.E.P.O.");
        yield* v.latecomer("room", "a", 12);
        yield* v.lobbyAsked;
        expect(yield* v.say("room", [line("Hi.")], "test")).toBe(false);
        yield* real(100);
        yield* TestClock.adjust(60_000);
        // someone taps it back on
        expect(yield* v.toggle("b")).toBe(true);
        expect(JSON.stringify(yield* Interactions.use((x) => x.handle({ type: 3, token: "tok", member: { user: { id: "stranger", username: "s" } }, message: { id: "m1", flags: 0 }, data: { custom_id: "hub:voice" } })))).toContain("for the trio");
        expect(yield* v.enabled).toBe(true);
      }),
    );
    expect(count("join")).toBe(0);
    expect(yield* db.select().from(roastBags)).toEqual([]);
    expect((yield* db.select().from(settings).where(eq(settings.key, "bot_voice")))[0].value).toEqual({ on: true, by: "b" });
  }).pipe(h.provide),
);

it.effect("9. BOT_VOICE: on means on until someone taps it; unset or off means off (production ships off)", () =>
  Effect.gen(function* () {
    const base = { DATABASE_URL: "x", DISCORD_TOKEN: "x", DISCORD_PUBLIC_KEY: "x", DISCORD_APP_ID: "x", INGEST_SECRET: "x", ADMIN_SECRET: "x", GUILD_ID: "g", CHANNEL_ID: "c", GAME_CHANNEL_ID: "gn", PLAYERS: "a", LOBBY_CHANNEL_ID: "l", VOICE_CATEGORY_ID: "v" };
    const read = (env: Record<string, string>) => readConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))));
    expect((yield* read({ ...base, BOT_VOICE: "on" })).botVoice).toBe(true);
    expect((yield* read({ ...base, BOT_VOICE: "off" })).botVoice).toBe(false);
    expect((yield* read(base)).botVoice).toBe(false);
  }),
);

it.effect("10. the bot alone in a room: the room still wraps up on its 15 minutes, and plan 01 sees no gathering or session", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const presence = yield* Presence;
    const t = Math.floor(T0 / 1000);
    yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", created_at: t - 600, last_seen: t });
    yield* presence.snapshot([]);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Live.use((l) => l.watch);
        // the bot ("app", the application's own user) in the room alone, and in the Lobby with one of us
        yield* presence.snapshot([
          { user_id: "app", channel_id: "r1" },
          { user_id: "a", channel_id: "lobby" },
        ]);
        yield* real(300);
        yield* presence.update("app", "lobby"); // the bot moves to the Lobby: two "people" there, for a minute
        yield* real(300);
        yield* TestClock.adjust(60_000);
        yield* real(300);
        yield* presence.update("a", null);
        yield* presence.update("app", "r1"); // and back to the room, alone
        yield* real(300);
        yield* TestClock.adjust(14 * 60_000 - 1000);
        yield* real(300);
        expect((yield* db.select().from(rooms))[0].archived_at).toBeNull();
        yield* TestClock.adjust(2000);
        yield* real(500);
      }),
    );
    expect((yield* db.select().from(rooms))[0].archived_at).toBe(t + 15 * 60); // last_seen + 15 min, as if the bot weren't there
    expect(yield* db.select().from(sessions)).toEqual([]);
    expect(yield* db.select().from(lobbyPrompts)).toEqual([]);
    expect((yield* db.select().from(voiceSegments)).map((s) => s.user_id)).toEqual(["a"]); // not in voice stats
  }).pipe(h.provide),
);

it.effect("11. a clip that isn't cached and can't be made: no speech, no alert storm (one alert); a night's start plays its jingle alone", () =>
  Effect.gen(function* () {
    yield* start;
    yield* Alerts.use((a) => a.setOwner("owner"));
    fake.synthFails = true;
    yield* inVoice({ a: "room" });
    yield* speaking(
      Effect.gen(function* () {
        const v = yield* BotVoice;
        for (const n of [1, 2, 3]) yield* v.say("room", [line(`Line number ${n}.`)], `line ${n}`);
        yield* until(() => h.logs.filter((l) => l.includes("voice: nothing to say")).length >= 1, "the lines given up");
        yield* real(200);
        expect(count("join")).toBe(0);
        yield* v.nightStarted(DAY, "room", "R.E.P.O.");
        yield* joined();
        yield* TestClock.adjust(30_000);
      }),
    );
    yield* Alerts.use((a) => a.settle);
    expect(dms()).toHaveLength(1);
    expect(JSON.stringify(dms()[0].body)).toContain("making the bot's speech");
    expect(fake.events.filter((e) => e.what === "play").map((e) => e.detail)).toEqual(["♪night"]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- the moments, from where they happen

it.effect("moment 1: a night's start queues its jingle and line for the room, after the ping", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const t = Math.floor(T0 / 1000);
    yield* db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "x" });
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t - 5, message_id: "card" });
    yield* inVoice({ a: "elsewhere" });
    yield* speaking(
      Effect.gen(function* () {
        yield* GameNight.use((g) => g.maintain); // the start the timer missed
        yield* until(() => logged("voice: nobody in"), "the visit");
      }),
    );
    const [room] = yield* db.select().from(rooms);
    const ping = h.calls.findIndex((c) => c.method === "POST" && c.path === "/channels/gn/messages" && JSON.stringify(c.body).includes("starts now"));
    expect(ping).toBeGreaterThan(-1);
    expect(logged(`voice: queued night start ${DAY} for ${room.channel_id}`)).toBe(true);
    expect(logged(`voice: nobody in ${room.channel_id}, not joining`)).toBe(true); // nobody came, so no visit
    expect(count("join")).toBe(0);
  }).pipe(h.provide),
);

it.effect("moment 2: a latecomer in the night's room hears how late they are", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const t = Math.floor(T0 / 1000);
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t - 12 * 60 - 30, reminded: true, message_id: "card" });
    yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: t - 12 * 60 });
    yield* inVoice({ a: "r1" });
    yield* speaking(
      Effect.gen(function* () {
        expect(yield* LateSlips.use((l) => l.watch)).toMatchObject({ arrived: ["a"] });
        yield* joined();
        yield* TestClock.adjust(30_000);
        expect(yield* LateSlips.use((l) => l.watch)).toEqual({}); // once
        yield* real(100);
      }),
    );
    expect(count("join")).toBe(1);
    const said = fake.events.filter((e) => e.what === "play").map((e) => e.detail);
    expect(LATE.map((l) => spoken(fill(l, { who: "a", mins: 12 })))).toContainEqual(said);
  }).pipe(h.provide),
);

it.effect("moment 3: the Lobby question is asked aloud; on auto-move the bot stays silent", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const t = Math.floor(T0 / 1000);
    yield* db.insert(games).values({ name: "World of Warcraft", emoji: "🐉", added_at: "x", plays: 3 });
    yield* db.insert(voiceSegments).values([
      { user_id: "a", channel_id: "lobby", started_at: t - 60, last_seen: t },
      { user_id: "b", channel_id: "lobby", started_at: t - 60, last_seen: t },
    ]);
    const where = new Map([
      ["a", "lobby"],
      ["b", "lobby"],
    ]);
    yield* inVoice({ a: "lobby", b: "lobby" });
    yield* speaking(
      Effect.gen(function* () {
        yield* Spontaneous.use((s) => s.react(where, t));
        yield* joined();
        yield* TestClock.adjust(30_000);
        // the next gathering, all playing the same game: straight to its room, no voice
        yield* db.delete(lobbyPrompts);
        const p = yield* Presence;
        yield* p.setActivities("a", [{ type: 0, name: "World of Warcraft" }]);
        yield* p.setActivities("b", [{ type: 0, name: "World of Warcraft" }]);
        yield* h.withConfig({ presences: true })(Spontaneous.use((s) => s.react(where, t + 40)));
        yield* real(200);
      }),
    );
    expect((yield* db.select().from(lobbyPrompts))[0].state).toBe("moved");
    expect(fake.events.filter((e) => e.what === "join").map((e) => e.detail)).toEqual(["lobby"]);
    expect(LOBBY.map(spoken)).toContainEqual(fake.events.filter((e) => e.what === "play").map((e) => e.detail));
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- moment 4: the lone early bird

const night = (startsIn: number, day = DAY) =>
  Effect.flatMap(Db, (db) => db.insert(gameNights).values({ day, stage: "set", game: "R.E.P.O.", start_at: Math.floor(T0 / 1000) + startsIn, message_id: "card" }));
const segment = (user: string, channel: string, since: number, ended?: number) =>
  Effect.flatMap(Db, (db) =>
    db.insert(voiceSegments).values({ user_id: user, channel_id: channel, started_at: since, last_seen: ended ?? Math.floor(T0 / 1000), ended_at: ended ?? null, open: ended === undefined }),
  );
const bird = (where: Record<string, string | null>, t: number) => BotVoice.use((v) => v.earlyBird(new Map(Object.entries(where)), t));

it.effect("moment 4: alone before a locked-in night, for a random 4 to 9 minutes: a beep, then one line, for them", () =>
  Effect.gen(function* () {
    yield* start;
    const t = Math.floor(T0 / 1000);
    yield* night(2 * 3600);
    yield* segment("a", "lobby", t);
    yield* inVoice({ a: "lobby" });
    yield* speaking(
      Effect.gen(function* () {
        const due = (yield* bird({ a: "lobby" }, t))!;
        expect(due - t).toBeGreaterThanOrEqual(4 * 60);
        expect(due - t).toBeLessThanOrEqual(9 * 60);
        expect(yield* bird({ a: "lobby" }, t + 60)).toBe(due); // the same wait, however often it looks
        expect(yield* bird({ a: "lobby" }, due - 1)).toBe(due);
        expect(count("join")).toBe(0);
        expect(yield* bird({ a: "lobby" }, due)).toBeNull();
        yield* joined();
        yield* TestClock.adjust(30_000);
      }),
    );
    const plays = fake.events.filter((e) => e.what === "play").map((e) => e.detail);
    expect(plays[0]).toBe("♪beep");
    const { fits } = family(EARLY, EARLY_PERSONAL, "a");
    expect(fits.map((l) => spoken(fill(l, { who: "a" })))).toContainEqual(plays.slice(1));
  }).pipe(h.provide),
);

it.effect("moment 4: someone who sat alone before a restart is counted from when they got there; the night's room counts too", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const t = Math.floor(T0 / 1000);
    yield* night(3600);
    yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", created_at: t - 600 });
    yield* db.insert(rooms).values({ channel_id: "r2", game: "Other", created_at: t - 600 });
    yield* segment("b", "r1", t - 20 * 60); // in the night's room for 20 minutes
    yield* segment("c", "lobby", t - 30 * 60, t - 15 * 60); // left 15 minutes ago
    yield* inVoice({ b: "r1" });
    yield* speaking(
      Effect.gen(function* () {
        expect(yield* bird({ b: "r2" }, t)).toBeNull(); // another game's room isn't "here"
        expect(yield* bird({ b: "r1" }, t)).toBeNull(); // alone 15 min already: due, said now
        yield* joined();
        yield* TestClock.adjust(30_000);
      }),
    );
    expect(fake.events.filter((e) => e.what === "join").map((e) => e.detail)).toEqual(["r1"]);
  }).pipe(h.provide),
);

it.effect("moment 4: not with the night more than 3 h away, not with no night, not once it has started", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const t = Math.floor(T0 / 1000);
    yield* segment("a", "lobby", t);
    yield* speaking(
      Effect.gen(function* () {
        expect(yield* bird({ a: "lobby" }, t)).toBeNull(); // no night
        yield* night(3 * 3600 + 60);
        expect(yield* bird({ a: "lobby" }, t)).toBeNull(); // 3 h 1 min away
        expect(yield* bird({ a: "lobby" }, t + 61)).not.toBeNull(); // now 3 h away: in the window
        yield* db.update(gameNights).set({ reminded: true });
        expect(yield* bird({ a: "lobby" }, t + 61)).toBeNull(); // started
        yield* real(100);
      }),
    );
    expect(count("join")).toBe(0);
    expect(yield* db.select().from(earlyBirds)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("moment 4: once per person per night", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const t = Math.floor(T0 / 1000);
    yield* night(2 * 3600);
    yield* segment("a", "lobby", t - 3600);
    yield* inVoice({ a: "lobby" });
    yield* speaking(
      Effect.gen(function* () {
        expect(yield* bird({ a: "lobby" }, t)).toBeNull();
        yield* joined();
        yield* TestClock.adjust(30_000);
        // they leave and come back, alone again for an hour
        expect(yield* bird({}, t + 60)).toBeNull();
        expect(yield* bird({ a: "lobby" }, t + 3600)).toBeNull();
        expect(yield* bird({ a: "lobby" }, t + 2 * 3600 - 60)).toBeNull();
        // someone else still gets theirs
        yield* segment("b", "lobby", t + 3600);
        yield* Presence.use((p) => p.update("b", "lobby"));
        expect(yield* bird({ b: "lobby" }, t + 3600 + 9 * 60)).toBeNull();
        yield* joined(2);
        yield* TestClock.adjust(30_000);
      }),
    );
    expect(count("join")).toBe(2);
    expect((yield* db.select().from(earlyBirds)).map((b) => b.user_id).sort()).toEqual(["a", "b"]);
  }).pipe(h.provide),
);

it.effect("moment 4: not if someone else joins first", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const t = Math.floor(T0 / 1000);
    yield* night(2 * 3600);
    yield* segment("a", "lobby", t);
    yield* speaking(
      Effect.gen(function* () {
        const due = (yield* bird({ a: "lobby" }, t))!;
        expect(yield* bird({ a: "lobby", b: "lobby" }, due - 10)).toBeNull(); // b joined before the bot came
        expect(yield* bird({ a: "lobby", b: "elsewhere" }, due)).toBeNull(); // anyone in voice counts, anywhere
        yield* real(100);
      }),
    );
    expect(count("join")).toBe(0);
    expect(yield* db.select().from(earlyBirds)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("moment 4: off with the toggle", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const t = Math.floor(T0 / 1000);
    yield* night(2 * 3600);
    yield* segment("a", "lobby", t - 3600);
    yield* speaking(
      Effect.gen(function* () {
        yield* BotVoice.use((v) => v.toggle("a"));
        expect(yield* bird({ a: "lobby" }, t)).toBeNull();
        yield* real(100);
      }),
    );
    expect(count("join")).toBe(0);
    expect(yield* db.select().from(earlyBirds)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("moment 4: nothing at all while no term is running (another copy leads)", () =>
  Effect.gen(function* () {
    yield* start;
    const t = Math.floor(T0 / 1000);
    yield* night(2 * 3600);
    yield* segment("a", "lobby", t - 3600);
    expect(yield* bird({ a: "lobby" }, t)).toBeNull();
    yield* BotVoice.use((v) => v.nightStarted(DAY, "room", "R.E.P.O."));
    expect(yield* Effect.flatMap(Db, (db) => db.select().from(roastBags))).toEqual([]);
    expect(yield* Effect.flatMap(Db, (db) => db.select().from(earlyBirds))).toEqual([]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- the clip cache, and making clips ahead

it.effect("a span is made once and cached; ahead of time, the likely lines are made a few a minute (none while off)", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    const clips = yield* Clips;
    const span = { voice: LT_VOICE, text: "Labas." };
    expect(yield* clips.cached(span)).toBeNull();
    expect(new TextDecoder().decode(yield* clips.get(span))).toBe("lt:Labas.");
    expect(new TextDecoder().decode(yield* clips.get(span))).toBe("lt:Labas.");
    expect(fake.synths).toEqual(["Labas."]);
    const [row] = yield* db.select().from(voiceClips);
    expect([row.voice, row.text, row.engine]).toEqual([LT_VOICE, "Labas.", "edge"]);

    yield* night(3600);
    const v = yield* BotVoice;
    expect(yield* v.prewarm).toBe(4);
    expect(yield* v.prewarm).toBe(4);
    expect(fake.synths).toHaveLength(9); // never the same span twice
    yield* v.toggle("a");
    expect(yield* v.prewarm).toBe(0);
    const made = (yield* db.select().from(voiceClips)).map((c) => c.text);
    expect(made).toContain("Playing something?"); // the Lobby lines first
  }).pipe(h.provide),
);

it.effect("a line already in the cache plays even with the speech engine down", () =>
  Effect.gen(function* () {
    yield* start;
    const db = yield* Db;
    yield* inVoice({ a: "room" });
    // already in the cache from an earlier night: plays even with the engine down
    const cached = spans(fill(START[2], { game: "R.E.P.O." }));
    yield* Effect.forEach(cached, (s) => Clips.use((c) => c.get(s)));
    fake.synthFails = true;
    const [bag] = [START[2]];
    yield* db.insert(roastBags).values({ pool: "voice:start", queue: [bag], last_line: null });
    yield* speaking(
      Effect.gen(function* () {
        yield* BotVoice.use((v) => v.nightStarted(DAY, "room", "R.E.P.O."));
        yield* joined();
        yield* TestClock.adjust(30_000);
      }),
    );
    expect(fake.events.filter((e) => e.what === "play").map((e) => e.detail)).toEqual(["♪night", ...spoken(fill(START[2], { game: "R.E.P.O." }))]);
  }).pipe(h.provide),
);
