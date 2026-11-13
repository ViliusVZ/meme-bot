// 🛠️ WoW Forever downtime alerts, against a real Postgres, with Blizzard's launcher notice, the EU
// Forever forum's listing, its threads, the realm status page and Discord stubbed (the harness's one
// outbound stub). The night it's built from: 2026-11-13, maintenance 20:00–21:00 CET (19:00–20:00 UTC).
import { expect, it } from "@effect/vitest";
import { beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Scope } from "effect";
import { Downtime, FORUM, FORUM_LATEST, LAUNCHER, REALMS, burstOf, isDowntimeNotice, spokenFor, noticeWindow, quotedNotice, type ForumTopic } from "../src/downtime.js";
import { AppConfig, type AppConfigShape } from "../src/config.js";
import { BotVoice } from "../src/botvoice.js";
import { Presence } from "../src/presence.js";
import { VoiceConnector } from "../src/voiceconn.js";
import { Tts } from "../src/tts.js";
import { IS_COMPONENTS_V2 } from "../src/discord.js";
import { Db } from "../src/db/db.js";
import { downtimes, newsStories, settings, voiceClips } from "../src/db/schema.js";
import { harness, json, type Call } from "./fx.js";

const EN_GB =
  "We will be performing maintenance beginning on Friday, 13 November, 20:00 (CET) and we expect the service to be available again at approximately 21:00 (CET). During this time the game will be unavailable for play.";
const EN_US =
  "We will be performing maintenance beginning on Friday, November 13th, 11:00 AM (PST) and we expect the service to be available again at approximately 12:00 PM (PST). During this time the game will be unavailable for play.";
const EXTENDED = EN_GB.replace("21:00 (CET)", "21:30 (CET)");
const sec = (iso: string) => Date.parse(iso) / 1000;
const S = sec("2026-11-13T19:00:00Z");
const E = sec("2026-11-13T20:00:00Z");

/** Tonight's real threads in the Forever forum (category 359), created (UTC) at: */
const TONIGHT: ForumTopic[] = [
  { id: 101, title: "Maintenance 11am pst = 8pm gmt+1, on a friday", created_at: sec("2026-11-13T18:42:00Z"), posts_count: 12, slug: "maintenance-11am-pst" },
  { id: 102, title: "Maintenance on a friday night?", created_at: sec("2026-11-13T18:59:00Z"), posts_count: 30, slug: "maintenance-on-a-friday-night" },
  { id: 103, title: "Server down in EU prime time", created_at: sec("2026-11-13T19:04:00Z"), posts_count: 8, slug: "server-down-in-eu-prime-time" },
  { id: 104, title: "Server maintenance on EU server on friday night", created_at: sec("2026-11-13T19:05:00Z"), posts_count: 4, slug: "server-maintenance-on-eu" },
  { id: 105, title: "EU Server Maintenance to address Faction Balance", created_at: sec("2026-11-13T19:06:00Z"), posts_count: 3, slug: "eu-server-maintenance" },
];
const QUOTE_POST =
  "<p>Got this in game just now: <blockquote>we've discovered an urgent server crash that we need to fix with restarts. All realms will come down in 30 minutes and be back quickly</blockquote> on a friday night, really?</p>";

// ---------------------------------------------------------------- what the outside world answers, per test

let notice: string | number = "";
let topics: ForumTopic[] = [];
let opening: Record<number, string> = {};
let realms: Array<{ name: string; online: boolean }> | number = [];
const iso = (s: number) => DateTime.formatIso(DateTime.makeUnsafe(s * 1000));

const outside = (c: Call) => {
  if (c.path === LAUNCHER) return typeof notice === "number" ? new Response("nope", { status: notice }) : new Response(notice, { status: 200, headers: { "content-type": "text/html" } });
  if (c.path === FORUM_LATEST) return json({ topic_list: { topics: topics.map((x) => ({ ...x, created_at: iso(x.created_at) })) } });
  const t = c.path.match(/^https:\/\/eu\.forums\.blizzard\.com\/en\/wow\/t\/(\d+)\.json$/);
  if (t) return opening[Number(t[1])] ? json({ post_stream: { posts: [{ cooked: opening[Number(t[1])] }] } }) : new Response("no", { status: 404 });
  if (c.path === REALMS) return typeof realms === "number" ? new Response("no", { status: realms }) : json({ data: { Realms: realms } });
  return undefined;
};

const voiceSaid: string[] = [];
const FakeVoice = Layer.succeed(VoiceConnector, VoiceConnector.of({ join: () => Effect.succeed({ ready: Effect.void, play: () => Effect.void, leave: Effect.void }) }));
const FakeTts = Layer.succeed(
  Tts,
  Tts.of({ synth: (text) => Effect.sync(() => (voiceSaid.push(text), { audio: new TextEncoder().encode(text), engine: "edge" as const })) }),
);

const h = harness({
  tables: [downtimes, newsStories, settings, voiceClips],
  discord: { firstId: 500, routes: [outside] },
  clock: "2026-11-13T17:00:00Z",
  env: { NEWS_CHANNEL_ID: "news", BOT_VOICE: true },
  voice: FakeVoice,
  tts: FakeTts,
});

const ONLINE = ["Normal", "PvP", "Roleplay", "Roleplay PvP"].map((name) => ({ name, online: true }));
beforeEach(() => {
  notice = "";
  topics = [];
  opening = {};
  realms = ONLINE;
  voiceSaid.length = 0;
});

const poll = (at: number) => Effect.andThen(h.setTime(at * 1000), Downtime.use((d) => d.poll({ at, force: true })));
const posts = () => h.calls.filter((c) => c.method === "POST" && c.path === "/channels/news/messages");
const edits = () => h.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/news/messages/"));
const textOf = (c: Call) => String(c.body.components?.[0]?.components?.[0]?.content ?? c.body.content);
const rows = Effect.flatMap(Db, (db) => db.select().from(downtimes));

/** A Downtime with nothing in memory (a restart, or the other copy), its configuration changed. */
const fresh = (change: Partial<AppConfigShape> = {}) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const layer = Layer.fresh(Downtime.layer).pipe(Layer.provide(Layer.succeed(AppConfig, { ...config, ...change })));
    return Context.get(yield* Layer.buildWithScope(layer, yield* Scope.make()), Downtime);
  });

// ---------------------------------------------------------------- the rules

it.effect("tonight's launcher notice, en-gb and en-us, reads as 19:00–20:00 UTC; other shapes too", () =>
  Effect.sync(() => {
    const now = sec("2026-11-13T17:00:00Z");
    expect(noticeWindow(EN_GB, now)).toEqual({ start: S, end: E });
    expect(noticeWindow(EN_US, now)).toEqual({ start: S, end: E });
    // summer time, an end with its own date, a December notice read in December for January
    expect(noticeWindow("Maintenance on 2 July, 06:00 (CEST) until 3 July, 01:00 (CEST).", sec("2026-06-30T12:00:00Z"))).toEqual({ start: sec("2026-07-02T04:00:00Z"), end: sec("2026-07-02T23:00:00Z") });
    expect(noticeWindow("Maintenance beginning on 2 January, 07:00 (CET) until 09:00 (CET).", sec("2026-12-30T12:00:00Z"))).toEqual({ start: sec("2027-01-02T06:00:00Z"), end: sec("2027-01-02T08:00:00Z") });
    // an end past midnight without its own date is the next day's
    expect(noticeWindow("Starting 13 November, 23:00 (CET), back at approximately 01:00 (CET).", now)).toEqual({ start: sec("2026-11-13T22:00:00Z"), end: sec("2026-11-14T00:00:00Z") });
    // no time with a zone: no window (the card still goes out, without times)
    expect(noticeWindow("We are investigating connection issues.", now)).toBeNull();
    expect(noticeWindow("Rolling restarts at 20:00 tonight.", now)).toBeNull();
  }),
);

it.effect("the players' burst: tonight's five threads fire by 19:05, not before; one grumble, two threads or threads spread over hours never do", () =>
  Effect.sync(() => {
    const upTo = (iso: string) => TONIGHT.filter((x) => x.created_at <= sec(iso));
    expect(burstOf(upTo("2026-11-13T19:04:30Z"), sec("2026-11-13T19:04:30Z"))).toBeNull();
    const b = burstOf(upTo("2026-11-13T19:05:00Z"), sec("2026-11-13T19:05:00Z"));
    expect(b && { count: b.count, first: b.first, busiest: b.busiest.id }).toEqual({ count: 3, first: sec("2026-11-13T18:59:00Z"), busiest: 102 });
    expect(burstOf(TONIGHT, sec("2026-11-13T19:10:00Z"))?.count).toBe(4);
    // two hours on, it's over
    expect(burstOf(TONIGHT, sec("2026-11-13T21:10:00Z"))).toBeNull();
    const quiet = (titles: string[], minutesApart: number) => titles.map((title, i) => ({ id: i + 1, title, created_at: sec("2026-11-13T19:00:00Z") + i * minutesApart * 60, posts_count: 1, slug: "x" }));
    const at = sec("2026-11-13T19:30:00Z");
    expect(burstOf(quiet(["So much lag tonight", "Forced to level as Shadow Priest", "Lag in Orgrimmar again"], 2), at)).toBeNull();
    expect(burstOf(quiet(["Disconnected again", "Forced to level as Shadow Priest"], 1), at)).toBeNull();
    expect(burstOf(quiet(["Maintenance on Tuesday?", "Maintenance length", "Why maintenance at all"], 40), sec("2026-11-13T20:30:00Z"))).toBeNull();
    // the titles: what counts as the servers being down
    for (const t of ["Servers down?", "server crashed", "Can't log in", "Login issues EU", "Downtime again", "Rolling restarts"]) expect(burstOf(quiet([t, t, t], 1), at)?.count).toBe(3);
  }),
);

it.effect("the in-game notice players quote; Blizzard's titles that are downtime notices", () =>
  Effect.sync(() => {
    expect(quotedNotice("Got this in game just now: we've discovered an urgent server crash that we need to fix with restarts. All realms will come down in 30 minutes and be back quickly. on a friday night")).toBe(
      "we've discovered an urgent server crash that we need to fix with restarts. All realms will come down in 30 minutes and be back quickly.",
    );
    expect(quotedNotice("lag is terrible, servers are bad")).toBeNull();
    expect(isDowntimeNotice("Scheduled Maintenance - 17 November")).toBe(true);
    expect(isDowntimeNotice("Realm Restarts Tonight")).toBe(true);
    expect(isDowntimeNotice("PvP Faction Balance Updates - 11 November")).toBe(false);
  }),
);

// ---------------------------------------------------------------- the card

it.effect("the launcher's notice: one card that pings the three of us, edited as it changes (running, extended, back), never posted twice, a restart included", () =>
  Effect.gen(function* () {
    notice = EN_GB;
    yield* poll(sec("2026-11-13T17:00:00Z"));
    expect(posts()).toHaveLength(1);
    const card = posts()[0].body;
    // not silent: the alert reaches us, and nobody else can be pinged
    expect(card.flags).toBe(IS_COMPONENTS_V2);
    expect(card.allowed_mentions).toEqual({ parse: [], users: ["a", "b", "c"] });
    expect(textOf(posts()[0])).toBe(
      [
        "### 🛠️ WoW Forever: servers down for maintenance",
        `**When** <t:${S}:F> (<t:${S}:R>) until about <t:${E}:t>, roughly 1 hour`,
        `**Blizzard says** "${EN_GB}"`,
        "-# Blizzard's launcher notice · [server status](https://worldofwarcraft.blizzard.com/en-gb/game/status/eu)",
        "<@a> <@b> <@c>",
      ].join("\n"),
    );
    // the same notice again, and a restart (or the other copy) seeing it: nothing new
    yield* poll(sec("2026-11-13T17:01:00Z"));
    const other = yield* fresh();
    yield* Effect.andThen(h.setTime(sec("2026-11-13T17:02:00Z") * 1000), other.poll({ at: sec("2026-11-13T17:02:00Z"), force: true }));
    expect(posts()).toHaveLength(1);
    expect(edits()).toHaveLength(0);
    // 20:00 CET: down now (an edit, notifying nobody)
    yield* poll(S);
    expect(edits()).toHaveLength(1);
    expect(edits()[0].body.flags).toBe(IS_COMPONENTS_V2);
    expect(edits()[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(textOf(edits()[0])).toContain(`**Down now**, since <t:${S}:t>, back about <t:${E}:R>`);
    // Blizzard extends it: the same card, the new end
    notice = EXTENDED;
    yield* poll(S + 600);
    expect(textOf(edits()[1])).toContain(`back about <t:${E + 1800}:R>`);
    expect(textOf(edits()[1])).toContain(`"${EXTENDED}"`);
    // the notice goes: servers are back (an edit, no fresh message)
    notice = "";
    yield* poll(S + 4000);
    expect(textOf(edits()[2]).split("\n").slice(0, 2)).toEqual(["### ✅ WoW Forever: servers are back", `**Down** <t:${S}:t>–<t:${S + 4000}:t>`]);
    expect(posts().filter((c) => !c.body.message_reference)).toHaveLength(1);
    const [row] = yield* rows;
    expect({ key: row.key, state: row.state, closed_by: row.closed_by, end: row.end_at }).toEqual({ key: `notice:${S}`, state: "back", closed_by: "notice", end: E + 1800 });
    // a minute later, nothing more
    yield* poll(S + 4060);
    expect(edits()).toHaveLength(3);
    expect(posts()).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("a notice whose announced end has already passed never makes a card or a ping (Blizzard leaves notices up after the end)", () =>
  Effect.gen(function* () {
    notice = EN_GB;
    yield* poll(E + 60);
    yield* poll(E + 3600);
    expect([posts(), edits()]).toEqual([[], []]);
    // still running when first seen: that one is news
    yield* poll(S + 600);
    expect(posts()).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("Blizzard leaves its notice up after the end: 15 minutes past it, with no realm offline, the card says they should be back (an edit, no ping); the same text later changes nothing, a later end opens it again", () =>
  Effect.gen(function* () {
    notice = EN_GB;
    yield* poll(S - 600);
    yield* poll(E + 14 * 60);
    expect(edits()).toHaveLength(1); // down now
    yield* poll(E + 15 * 60 + 1);
    expect(edits()).toHaveLength(2);
    expect(textOf(edits()[1]).split("\n").slice(0, 2)).toEqual(["### ✅ WoW Forever: servers should be back", `**Down** <t:${S}:t>–about <t:${E}:t> (Blizzard's estimate)`]);
    expect(posts()).toHaveLength(1);
    // the same notice still up an hour later: nothing
    yield* poll(E + 3600);
    expect(edits()).toHaveLength(2);
    // Blizzard extends it to 21:30 CET: the card is down again, until 15 minutes past the new end
    notice = EXTENDED;
    yield* poll(E + 20 * 60);
    expect(textOf(edits()[2])).toContain(`**Down now**, since <t:${S}:t>, back about <t:${E + 1800}:R>`);
    expect(posts()).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("15 minutes past the end with a realm still offline: still down until the status page says otherwise", () =>
  Effect.gen(function* () {
    notice = EN_GB;
    realms = ONLINE.map((r) => ({ ...r, online: r.name !== "PvP" }));
    yield* poll(S);
    yield* poll(E + 30 * 60);
    expect((yield* rows).map((r) => r.state)).toEqual(["open"]);
    realms = ONLINE;
    yield* poll(E + 31 * 60);
    expect(textOf(edits().at(-1)!).split("\n")[0]).toBe("### ✅ WoW Forever: servers are back");
  }).pipe(h.provide),
);

it.effect("the reminder: an hour before a start the card announced well ahead, once (a restart included), pinging the three of us; none for a card posted late", () =>
  Effect.gen(function* () {
    notice = EN_GB;
    yield* poll(sec("2026-11-13T16:30:00Z")); // 2.5 hours ahead
    yield* poll(S - 3601);
    expect(posts()).toHaveLength(1);
    yield* poll(S - 3600);
    yield* poll(S - 3500);
    const other = yield* fresh();
    yield* other.poll({ at: S - 3400, force: true });
    const reminders = posts().filter((c) => c.body.message_reference);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].body).toEqual({
      content: `⏰ WoW Forever goes down <t:${S}:R> (<t:${S}:t>) for about 1 hour. <@a> <@b> <@c>`,
      allowed_mentions: { parse: [], users: ["a", "b", "c"] },
      message_reference: { message_id: "500", fail_if_not_exists: false },
    });
  }).pipe(h.provide),
);

it.effect("no reminder for a card that went out under 75 minutes before the start", () =>
  Effect.gen(function* () {
    notice = EN_GB;
    yield* poll(S - 70 * 60);
    yield* poll(S - 30 * 60);
    expect(posts()).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("players report it first: one card from their burst (busiest thread, the in-game notice they quote), pinging once; Blizzard's notice then edits it, never a second card", () =>
  Effect.gen(function* () {
    topics = TONIGHT.filter((x) => x.created_at <= sec("2026-11-13T19:05:00Z"));
    opening = { 102: QUOTE_POST };
    yield* poll(sec("2026-11-13T19:05:00Z"));
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body.allowed_mentions).toEqual({ parse: [], users: ["a", "b", "c"] });
    expect(textOf(posts()[0])).toBe(
      [
        "### ⚠️ WoW Forever: players report the servers going down",
        `From player reports, not from Blizzard: 3 threads on the EU forum since <t:${sec("2026-11-13T18:59:00Z")}:t>.`,
        `**Players quote the in-game notice** "we've discovered an urgent server crash that we need to fix with restarts. All realms will come down in 30 minutes and be back quickly"`,
        `-# [players' thread](${FORUM}/t/maintenance-on-a-friday-night/102) · [server status](https://worldofwarcraft.blizzard.com/en-gb/game/status/eu)`,
        "<@a> <@b> <@c>",
      ].join("\n"),
    );
    // only the busiest thread's opening post was read
    expect(h.calls.filter((c) => c.path.includes("/t/")).map((c) => c.path)).toEqual([`${FORUM}/t/102.json`]);
    // more threads, then Blizzard's notice: the same card, edited
    topics = TONIGHT;
    yield* poll(sec("2026-11-13T19:07:00Z"));
    notice = EN_GB;
    yield* poll(sec("2026-11-13T19:08:00Z"));
    expect(posts()).toHaveLength(1);
    expect(textOf(edits().at(-1)!).split("\n")[0]).toBe("### 🛠️ WoW Forever: servers down for maintenance");
    expect(textOf(edits().at(-1)!)).toContain("[players' thread]");
    expect((yield* rows).map((r) => [r.key, r.source])).toEqual([["forum:102", "launcher"]]);
  }).pipe(h.provide),
);

it.effect("a maintenance planned for next week doesn't swallow tonight's trouble: the players' burst gets its own card", () =>
  Effect.gen(function* () {
    notice = EN_GB.replace("13 November", "17 November").replace("Friday", "Tuesday");
    yield* poll(sec("2026-11-13T18:00:00Z"));
    topics = TONIGHT;
    yield* poll(sec("2026-11-13T19:10:00Z"));
    expect(posts().map((c) => textOf(c).split("\n")[0])).toEqual(["### 🛠️ WoW Forever: servers down for maintenance", "### ⚠️ WoW Forever: players report the servers going down"]);
  }).pipe(h.provide),
);

it.effect("the realm status page: a realm offline makes a card; all back online ends it", () =>
  Effect.gen(function* () {
    realms = ONLINE.map((r) => ({ ...r, online: r.name !== "PvP" }));
    yield* poll(sec("2026-11-13T21:00:00Z"));
    expect(posts()).toHaveLength(1);
    expect(textOf(posts()[0]).split("\n").slice(0, 2)).toEqual(["### ⚠️ WoW Forever: realms offline", `**Offline** PvP, since <t:${sec("2026-11-13T21:00:00Z")}:t>`]);
    realms = ONLINE;
    yield* poll(sec("2026-11-13T21:10:00Z"));
    expect(textOf(edits()[0]).split("\n")[0]).toBe("### ✅ WoW Forever: realms are back online");
    // the status page's query stops working: carry on without it
    realms = 500;
    yield* poll(sec("2026-11-13T21:12:00Z"));
    expect(posts()).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("Blizzard's forum post about maintenance (kept from the news) makes the card; the launcher's notice for the same window is the same card", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const link = "https://eu.forums.blizzard.com/en/wow/t/scheduled-maintenance/700/1";
    yield* db.insert(newsStories).values({
      id: "blizzard:700", source: "blizzard", sub: "blizzard", title: "Scheduled Maintenance", link,
      body: "Maintenance beginning on Friday, 13 November, 20:00 (CET) until approximately 21:00 (CET).",
      created_at: sec("2026-11-13T12:00:00Z"), first_seen: sec("2026-11-13T12:00:00Z"), last_seen: sec("2026-11-13T12:00:00Z"), state: "skip", reason: "downtime notice",
    });
    yield* poll(sec("2026-11-13T13:00:00Z"));
    expect(posts()).toHaveLength(1);
    expect(textOf(posts()[0])).toContain(`-# [Blizzard's forum post](${link})`);
    expect(textOf(posts()[0])).toContain(`**When** <t:${S}:F>`);
    notice = EN_GB;
    yield* poll(sec("2026-11-13T13:01:00Z"));
    expect(posts()).toHaveLength(1);
    expect(textOf(edits()[0])).toContain("-# Blizzard's launcher notice");
  }).pipe(h.provide),
);

it.effect("a notice we can't read times from still makes the card, without a When line", () =>
  Effect.gen(function* () {
    notice = "We are aware of players disconnecting from realms and are investigating.";
    yield* poll(sec("2026-11-13T19:30:00Z"));
    expect(textOf(posts()[0]).split("\n").slice(0, 2)).toEqual(["### 🛠️ WoW Forever: servers down for maintenance", `**Blizzard says** "${notice}"`]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- aloud

const speaking = <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.scoped(Effect.andThen(BotVoice.use((v) => v.run), body));
const inVoice = (states: Record<string, string>) => Presence.use((p) => p.snapshot(Object.entries(states).map(([user_id, channel_id]) => ({ user_id, channel_id }))));

it.effect("said aloud where we are when the card goes out, only with someone in voice and the 🔇 toggle on", () =>
  Effect.gen(function* () {
    notice = EN_GB;
    // nobody in voice: no line
    const quiet = yield* speaking(Effect.andThen(inVoice({}), poll(S - 40 * 60)));
    expect(quiet.spoken).toBeUndefined();
    // the next downtime, two of us in the Lobby: the line, there
    notice = EN_GB.replace(/13 November/, "14 November");
    const next = sec("2026-11-14T19:00:00Z");
    const said = yield* speaking(Effect.andThen(inVoice({ a: "lobby", b: "lobby", c: "room" }), poll(next - 30 * 60)));
    expect(said.spoken).toEqual([`notice:${next}`]);
    expect(h.logs.some((l) => l.includes(`voice: queued downtime notice:${next} for lobby`))).toBe(true);
    // toggled off: none
    yield* BotVoice.use((v) => v.toggle("a"));
    notice = EN_GB.replace(/13 November/, "15 November");
    const off = yield* speaking(Effect.andThen(inVoice({ a: "lobby" }), poll(sec("2026-11-15T18:30:00Z"))));
    expect(off.posted).toHaveLength(1);
    expect(off.spoken).toBeUndefined();
  }).pipe(h.provide),
);

it.effect("the spoken lines: plain, no emoji or markdown", () =>
  Effect.sync(() => {
    const base = { source: "launcher" as const, state: "open" as const, closed_by: null, notice: EN_GB, link: null, thread: null, reports: null, quote: null, realms: null, realms_down: false, start_at: S, end_at: E, back_at: null, last_seen: S };
    expect(spokenFor(base, S - 30 * 60)).toBe("Heads up: WoW servers go down for maintenance in about 30 minutes.");
    expect(spokenFor(base, S - 60 * 60)).toBe("Heads up: WoW servers go down for maintenance in about 1 hour.");
    expect(spokenFor(base, S + 60)).toBe("Heads up: WoW servers are down for maintenance right now.");
    expect(spokenFor(base, S - 5 * 3600)).toBe("Heads up: Blizzard announced WoW server maintenance. Details in the news channel.");
    expect(spokenFor({ ...base, notice: null, source: "forum" }, S)).toBe("Heads up: players say the WoW servers are going down.");
    for (const at of [S - 30 * 60, S + 60, S - 5 * 3600]) expect(spokenFor(base, at)).not.toMatch(/[*_#<>`\p{Extended_Pictographic}]/u);
  }),
);

// ---------------------------------------------------------------- the test bot's replay

it.effect("the replay (test bot only): the notice, then gone; elsewhere it isn't there", () =>
  Effect.gen(function* () {
    expect(yield* Downtime.use((d) => d.replay({ notice: EN_GB }))).toBeNull();
    const testBot = yield* fresh({ newsBacktestPost: true });
    yield* h.setTime(sec("2026-11-13T18:00:00Z") * 1000);
    notice = 503; // the real launcher isn't asked while a stand-in is given
    const r = yield* testBot.replay({ notice: EN_GB, topics: [{ id: 9, title: "Servers down?", minutes_ago: 1 }] });
    expect(r?.posted).toEqual([`notice:${S}`]);
    expect(h.calls.some((c) => c.path === LAUNCHER || c.path === FORUM_LATEST)).toBe(false);
    yield* h.setTime((S + 600) * 1000);
    const gone = yield* testBot.replay({ notice: "" });
    expect(gone?.notice).toBe("");
    expect(textOf(edits().at(-1)!).split("\n")[0]).toBe("### ✅ WoW Forever: servers are back");
    yield* testBot.replay({ live: true });
    const [kept] = yield* Effect.flatMap(Db, (db) => db.select().from(settings).where(eq(settings.key, "downtime_replay")));
    expect(kept).toBeUndefined();
  }).pipe(h.provide),
);
