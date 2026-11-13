// 🔊 The bot speaks (plan 03): it joins a voice channel, says one thing, and leaves.
//   1. A planned night starts: once its room is open and people are in, a jingle and the game.
//   2. A latecomer arrives in the night's room: a spoken roast with how late they are.
//   3. The Lobby question (spontaneous.ts): "Playing something?" aloud, as the card goes up.
//   4. The lone early bird: one of us alone in voice (the Lobby or the night's room) before a
//      locked-in night at most 3 h away, nobody else in voice, for a random 4 to 9 minutes: a beep
//      and one line. Once per person per night; not if anyone joins first.
//
// The owner's timing rule: after the connection is ready, 3 s before the first sound; after the
// last sound, 3 s before leaving (Discord's own join and leave sounds must never overlap speech).
// The rules: it never sits in a channel (30 s from join to leave whatever happens, at once if the
// channel empties, out of voice on shutdown, on losing leadership and on startup); one visit at a
// time, through a queue, and anything more than 20 s old is dropped (late speech is worse than
// none); two things for the same channel at once are one visit; the bot is not a person (nothing
// that counts people looks at it: they all count `players`); voice never hurts the planner (every
// moment only queues, after the room, the moves and the messages, and a failed visit is one alert);
// a 🔇 toggle on the HQ panel (`settings`), its default from BOT_VOICE.
//
// Leader only: the queue is worked inside the leader's term (`run`), and the moments do nothing
// when no term is running.
import { and, eq, gt, inArray, isNull, lte, max, sql } from "drizzle-orm";
import { Cause, Clock, Context, Duration, Effect, Layer, Option, PubSub, Random, Ref, Schema, type Scope } from "effect";
import { loneBirds, gameNights, rooms, settings, voiceSegments } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig, players } from "./config.js";
import { Presence } from "./presence.js";
import { Roasts } from "./roasts.js";
import { Clips, clipKey } from "./clips.js";
import { VoiceConnector, VoiceFailed } from "./voiceconn.js";
import { VoiceLink } from "./voicelink.js";
import { Alerts } from "./alerts.js";
import { nowSec } from "./clock.js";
import { EARLY, EARLY_PERSONAL, LATE, LATE_PERSONAL, LOBBY, START, family, fill, spans, type Span } from "./lines.js";
import { BEEP, NIGHT_JINGLE } from "./jingles.js";

export const READY_GAP = Duration.seconds(3); // connection ready → first sound
export const LEAVE_GAP = Duration.seconds(3); // last sound over → leave
export const READY_WITHIN = Duration.seconds(10); // a connection not ready by then is given up
export const VISIT_CAP = Duration.seconds(30); // join → leave, whatever happens
export const FRESH_FOR = 20_000; // ms: older than this when its turn comes, it's dropped
export const BIRD_MIN = 4 * 60; // the lone early bird: alone this long at least…
export const BIRD_MAX = 9 * 60; // …and at most (a random wait in between)
export const BIRD_WINDOW = 3 * 3600; // the night starts at most this far ahead
const PREWARM_BATCH = 4; // spans made per minute (the "voice" job), gently
const SYNTH_ALERT_EVERY = 6 * 3600_000; // ms: the speech engine failing is one DM per 6 h at most
const KEY = "bot_voice";
const VoiceSetting = Schema.Struct({ on: Schema.Boolean, by: Schema.optional(Schema.String) });

/** What one visit plays: a jingle, or a line (marked up, placeholders filled). */
export type Part = { readonly _tag: "Jingle"; readonly clip: "night" | "beep" } | { readonly _tag: "Line"; readonly line: string };
/** A thing to say, queued at `at` (ms). */
type Item = { readonly channel: string; readonly parts: ReadonlyArray<Part>; readonly at: number; readonly what: string };

const decode = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
export const JINGLES = { night: decode(NIGHT_JINGLE), beep: decode(BEEP) };

export class BotVoice extends Context.Service<
  BotVoice,
  {
    /** Work the queue for a leader's term; when the scope closes, the bot leaves voice first. */
    readonly run: Effect.Effect<void, never, Scope.Scope>;
    /** 🔇 Is the bot's voice on? (the toggle, or BOT_VOICE until someone has tapped it) */
    readonly enabled: Effect.Effect<boolean, DbError>;
    /** 🔇 Flip it; gives back the new state. */
    toggle(by: string): Effect.Effect<boolean, DbError>;
    /** Queue something to say in a channel (nothing when off or not leading). */
    say(channel: string, parts: ReadonlyArray<Part>, what: string): Effect.Effect<boolean, DbError>;
    /** 1. The night's room is open and people are in. Never fails, never waits. */
    nightStarted(day: string, roomChannelId: string, game: string): Effect.Effect<void>;
    /** 2. A latecomer is in the night's room, `mins` late. Never fails, never waits. */
    latecomer(channelId: string, user: string, mins: number): Effect.Effect<void>;
    /** 3. The Lobby question just went up. Never fails, never waits. */
    readonly lobbyAsked: Effect.Effect<void>;
    /** 4. Where everyone is (live.ts, on every change): the lone early bird. Returns when to look again. */
    earlyBird(where: ReadonlyMap<string, string | null>, t: number): Effect.Effect<number | null, DbError>;
    /** A minute job: make the clips the bot will likely need, a few at a time (nothing while it's off). */
    readonly prewarm: Effect.Effect<number, DbError>;
  }
>()("meme-bot/botvoice") {
  static readonly layer = Layer.effect(
    BotVoice,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const presence = yield* Presence;
      const roasts = yield* Roasts;
      const clips = yield* Clips;
      const connector = yield* VoiceConnector;
      const link = yield* VoiceLink;
      const alerts = yield* Alerts;
      const trio = Effect.provideService(players, AppConfig, config);

      const active = yield* Ref.make(false); // a term is working the queue
      const pending = yield* Ref.make<ReadonlyArray<Item>>([]);
      const wake = yield* PubSub.sliding<void>(1);
      const lastSynthAlert = yield* Ref.make<number | null>(null);
      const bird = yield* Ref.make<{ user: string; since: number; due: number } | null>(null);
      const cachedKeys = new Set<string>(); // clips known to be in the cache (prewarm stops asking the database about them)

      // ---------------------------------------------------------------- the 🔇 toggle

      const enabled = Effect.gen(function* () {
        const [row] = yield* db.select().from(settings).where(eq(settings.key, KEY));
        return Option.match(Schema.decodeUnknownOption(VoiceSetting)(row?.value), { onNone: () => config.botVoice, onSome: (s) => s.on });
      }).pipe(Effect.withSpan("BotVoice.enabled"));

      const toggle = Effect.fn("BotVoice.toggle")(function* (by: string) {
        const on = !(yield* enabled);
        const value = { on, by };
        yield* db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updated_at: sql`now()` } });
        yield* Effect.logInfo(`voice: turned ${on ? "on" : "off"} by ${by}`);
        return on;
      });

      // ---------------------------------------------------------------- the queue

      const say = Effect.fn("BotVoice.say")(function* (channel: string, parts: ReadonlyArray<Part>, what: string) {
        if (!(yield* Ref.get(active))) return false;
        if (!(yield* enabled)) return false;
        const at = yield* Clock.currentTimeMillis;
        yield* Ref.update(pending, (p) => [...p, { channel, parts, at, what }]);
        yield* PubSub.publish(wake, undefined);
        yield* Effect.logInfo(`voice: queued ${what} for ${channel}`);
        return true;
      });

      /** A moment: only while leading and on, and never a failure for whoever called it. */
      const moment = (what: string, run: Effect.Effect<unknown, DbError>) =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(active))) return;
          yield* run;
        }).pipe(Effect.catch((e) => Effect.logWarning(`voice: ${what} not queued ${e}`)));

      /** Take everything queued for the first channel in line, in order. */
      const takeNext = Ref.modify(pending, (p): [ReadonlyArray<Item>, ReadonlyArray<Item>] => {
        if (!p.length) return [[], p];
        const ch = p[0].channel;
        return [p.filter((i) => i.channel === ch), p.filter((i) => i.channel !== ch)];
      });
      const takeFor = (channel: string) =>
        Ref.modify(pending, (p): [ReadonlyArray<Item>, ReadonlyArray<Item>] => [p.filter((i) => i.channel === channel), p.filter((i) => i.channel !== channel)]);

      const someoneIn = (channel: string) =>
        Effect.gen(function* () {
          for (const p of yield* trio) if ((yield* presence.lastKnown(p)) === channel) return true;
          return false;
        });

      /** Done once none of us is left in the channel. */
      const emptied = (channel: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* presence.changes;
            while (yield* someoneIn(channel)) yield* PubSub.take(changes);
            yield* Effect.logInfo(`voice: everyone left ${channel}, leaving at once`);
          }),
        );

      const synthFailed = Effect.fnUntraced(function* (span: Span, e: unknown) {
        yield* Effect.logWarning(`voice: no clip for "${span.text}" ${String(e)}`);
        const now = yield* Clock.currentTimeMillis;
        const last = yield* Ref.get(lastSynthAlert);
        if (last !== null && now - last < SYNTH_ALERT_EVERY) return;
        yield* Ref.set(lastSynthAlert, now);
        yield* alerts.failed("making the bot's speech", e, "lines already said still play; new ones are skipped");
      });

      /** One line's clips, from the cache or made in time for `deadline` (ms); null if any span can't be had. */
      const lineClips = Effect.fnUntraced(function* (line: string, deadline: number) {
        const left = deadline - (yield* Clock.currentTimeMillis);
        const out = yield* Effect.forEach(
          spans(line),
          (span) =>
            (left > 0 ? clips.get(span).pipe(Effect.timeoutOption(Duration.millis(left)), Effect.map(Option.getOrNull)) : clips.cached(span)).pipe(
              Effect.flatMap((clip) => (clip ? Effect.succeed(clip) : Effect.as(Effect.logWarning(`voice: no clip in time for "${span.text}"`), null))),
              Effect.catch((e) => Effect.as(synthFailed(span, e), null)),
            ),
          { concurrency: "unbounded" },
        );
        return out.every((c): c is Uint8Array => c !== null) && out.length ? out : null;
      });

      const prepare = Effect.fnUntraced(function* (parts: ReadonlyArray<Part>, deadline: number) {
        const out: Uint8Array[] = [];
        for (const p of parts) {
          if (p._tag === "Jingle") out.push(JINGLES[p.clip]);
          else out.push(...((yield* lineClips(p.line, deadline)) ?? []));
        }
        return out;
      });

      /** Join, wait for ready, 3 s, the clips, 3 s, leave; capped, and cut short if the channel empties. */
      const speakIn = Effect.fnUntraced(function* (channel: string, audio: ReadonlyArray<Uint8Array>, what: string) {
        const t0 = yield* Clock.currentTimeMillis;
        const since = Effect.map(Clock.currentTimeMillis, (t) => `${((t - t0) / 1000).toFixed(1)} s`);
        const visit = Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.logInfo(`voice: joining ${channel} for ${what}`);
            const conn = yield* Effect.acquireRelease(connector.join(channel), (c) =>
              Effect.andThen(c.leave, Effect.flatMap(since, (s) => Effect.logInfo(`voice: left ${channel} ${s} after joining`))),
            );
            yield* conn.ready.pipe(Effect.timeoutOrElse({ duration: READY_WITHIN, orElse: () => Effect.fail(new VoiceFailed({ detail: "the connection wasn't ready within 10 s" })) }));
            yield* Effect.flatMap(since, (s) => Effect.logInfo(`voice: ready in ${channel} ${s} after joining`));
            yield* Effect.sleep(READY_GAP);
            for (const clip of audio) yield* conn.play(clip);
            yield* Effect.flatMap(since, (s) => Effect.logInfo(`voice: done speaking in ${channel} ${s} after joining`));
            yield* Effect.sleep(LEAVE_GAP);
          }),
        );
        const capped = yield* visit.pipe(Effect.raceFirst(emptied(channel)), Effect.timeoutOption(VISIT_CAP));
        if (Option.isNone(capped)) yield* Effect.logWarning(`voice: the 30 s cap ended the visit to ${channel}`);
      });

      const visit = Effect.fnUntraced(function* (items: ReadonlyArray<Item>) {
        const channel = items[0].channel;
        const now = yield* Clock.currentTimeMillis;
        const fresh = items.filter((i) => now - i.at <= FRESH_FOR);
        for (const i of items.filter((x) => !fresh.includes(x))) yield* Effect.logInfo(`voice: dropped ${i.what} for ${channel}, ${Math.round((now - i.at) / 1000)} s old`);
        if (!fresh.length) return;
        if (!(yield* enabled)) return yield* Effect.logInfo(`voice: off, not saying ${fresh.map((i) => i.what).join(" + ")}`);
        if (!(yield* presence.isReady)) return yield* Effect.logInfo(`voice: can't see who's in voice, not joining ${channel}`);
        if (!(yield* someoneIn(channel))) return yield* Effect.logInfo(`voice: nobody in ${channel}, not joining`);
        const deadline = Math.min(...fresh.map((i) => i.at)) + FRESH_FOR;
        const audio = yield* prepare(
          fresh.flatMap((i) => i.parts),
          deadline,
        );
        // anything more for this channel that came in meanwhile goes in the same visit
        const more = yield* takeFor(channel);
        if (more.length) audio.push(...(yield* prepare(more.flatMap((i) => i.parts), deadline)));
        const what = [...fresh, ...more].map((i) => i.what).join(" + ");
        if (!audio.length) return yield* Effect.logInfo(`voice: nothing to say for ${what}`);
        yield* speakIn(channel, audio, what).pipe(Effect.catch((e) => alerts.failed("speaking in voice", e, channel, what)));
      });

      const prewarm = Effect.gen(function* () {
        if (!(yield* enabled)) return 0;
        const ps = yield* trio;
        const lines = [
          ...LOBBY,
          ...ps.flatMap((p) => family(EARLY, EARLY_PERSONAL, p).fits.map((l) => fill(l, { who: p }))),
        ];
        const t = yield* nowSec;
        const nights = yield* db
          .select({ game: gameNights.game })
          .from(gameNights)
          .where(and(eq(gameNights.stage, "set"), eq(gameNights.reminded, false), gt(gameNights.start_at, t), lte(gameNights.start_at, t + 86400)));
        for (const n of nights) if (n.game) lines.push(...START.map((l) => fill(l, { game: n.game! })));
        let made = 0;
        for (const span of lines.flatMap(spans)) {
          if (made >= PREWARM_BATCH) break;
          const key = clipKey(span);
          if (cachedKeys.has(key)) continue;
          if (yield* clips.cached(span)) {
            cachedKeys.add(key);
            continue;
          }
          made++;
          // Edge only: Gemini's few lines a day are for speech that's due now. Edge failing: try again next minute
          const ok = yield* clips.get(span, { spare: false }).pipe(
            Effect.as(true),
            Effect.catch((e) => Effect.as(synthFailed(span, e), false)),
          );
          if (!ok) break;
          cachedKeys.add(key);
        }
        if (made) yield* Effect.logInfo(`voice: made ${made} clip(s) ahead`);
        return made;
      }).pipe(Effect.withSpan("BotVoice.prewarm"));

      const run = Effect.gen(function* () {
        // the term's end: nothing new is taken, the visit under way is cut short (it leaves), and
        // whatever Discord still shows us in is left too (a crash can leave a ghost)
        yield* Effect.addFinalizer(() => Effect.andThen(Ref.set(active, false), link.leave));
        yield* Ref.set(pending, []);
        yield* Ref.set(active, true);
        const woken = yield* PubSub.subscribe(wake);
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const items = yield* takeNext;
              if (!items.length) return yield* PubSub.take(woken);
              // the voice boundary (architecture §6): a visit's bug is reported, and the next one still goes
              yield* visit(items).pipe(
                Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : alerts.failed("speaking in voice", Cause.squash(cause), items[0].channel))),
              );
            }),
          ),
        );
      });

      // ---------------------------------------------------------------- 4. the lone early bird

      /** Today's locked-in night that hasn't started and starts within 3 h. */
      const nightAhead = (t: number) =>
        Effect.map(
          db
            .select({ day: gameNights.day, game: gameNights.game })
            .from(gameNights)
            .where(and(eq(gameNights.stage, "set"), eq(gameNights.reminded, false), gt(gameNights.start_at, t), lte(gameNights.start_at, t + BIRD_WINDOW))),
          (rows) => rows[0] ?? null,
        );

      /** "Here": the Lobby, or an open room of the night's game. */
      const isHere = Effect.fnUntraced(function* (channel: string, game: string | null) {
        if (channel === config.lobbyChannelId) return true;
        if (!game) return false;
        const [room] = yield* db
          .select({ id: rooms.channel_id })
          .from(rooms)
          .where(and(eq(rooms.channel_id, channel), eq(rooms.game, game), isNull(rooms.archived_at)));
        return !!room;
      });

      /** Since when they've been alone: their time in this channel, or since the last of the others left. */
      const aloneSince = Effect.fnUntraced(function* (user: string, others: ReadonlyArray<string>, t: number) {
        const [mine] = yield* db
          .select({ since: voiceSegments.started_at })
          .from(voiceSegments)
          .where(and(eq(voiceSegments.user_id, user), eq(voiceSegments.open, true)));
        const [left] = others.length
          ? yield* db
              .select({ at: max(sql<number>`COALESCE(${voiceSegments.ended_at}, ${voiceSegments.last_seen})`) })
              .from(voiceSegments)
              .where(and(inArray(voiceSegments.user_id, [...others]), gt(voiceSegments.last_seen, t - BIRD_WINDOW)))
          : [];
        return Math.min(t, Math.max(mine?.since ?? t, Number(left?.at ?? 0)));
      });

      const earlyBird = Effect.fn("BotVoice.earlyBird")(function* (where: ReadonlyMap<string, string | null>, t: number) {
        if (!(yield* Ref.get(active))) return null;
        const ps = yield* trio;
        const inVoice = ps.filter((p) => where.get(p));
        const night = inVoice.length === 1 ? yield* nightAhead(t) : null;
        const user = inVoice[0];
        const channel = user ? where.get(user)! : null;
        if (!night || !channel || !(yield* isHere(channel, night.game)) || !(yield* enabled)) {
          yield* Ref.set(bird, null);
          return null;
        }
        const [done] = yield* db
          .select({ at: loneBirds.at })
          .from(loneBirds)
          .where(and(eq(loneBirds.day, night.day), eq(loneBirds.user_id, user)));
        if (done) return null;
        let b = yield* Ref.get(bird);
        if (b?.user !== user) {
          const since = yield* aloneSince(user, ps.filter((p) => p !== user), t);
          const wait = BIRD_MIN + Math.floor((yield* Random.next) * (BIRD_MAX - BIRD_MIN + 1));
          b = { user, since, due: since + wait };
          yield* Ref.set(bird, b);
          yield* Effect.logInfo(`voice: ${user} alone in ${channel} since ${since}, early bird due at ${b.due}`);
        }
        if (t < b.due) return b.due;
        yield* Ref.set(bird, null);
        // claim → queue, never cut short (architecture §15). Queuing can't fail here (leading and on
        // were checked above), and a visit that goes wrong later still used the night's one go
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const [claim] = yield* db.insert(loneBirds).values({ day: night.day, user_id: user, at: t }).onConflictDoNothing().returning({ day: loneBirds.day });
            if (!claim) return;
            const { all, fits } = family(EARLY, EARLY_PERSONAL, user);
            const line = fill(yield* roasts.draw("voice:early", all, fits), { who: user });
            yield* say(channel, [{ _tag: "Jingle", clip: "beep" }, { _tag: "Line", line }], "early bird");
          }),
        );
        return null;
      });

      return BotVoice.of({
        run,
        enabled,
        toggle,
        say,
        nightStarted: (day, roomChannelId, game) =>
          moment(
            "night start",
            Effect.gen(function* () {
              if (!(yield* enabled)) return;
              const line = fill(yield* roasts.draw("voice:start", START, START), { game });
              yield* say(roomChannelId, [{ _tag: "Jingle", clip: "night" }, { _tag: "Line", line }], `night start ${day}`);
            }),
          ),
        latecomer: (channelId, user, mins) =>
          moment(
            "latecomer",
            Effect.gen(function* () {
              if (mins < 1 || !(yield* enabled)) return;
              const { all, fits } = family(LATE, LATE_PERSONAL, user);
              const line = fill(yield* roasts.draw("voice:late", all, fits), { who: user, mins });
              yield* say(channelId, [{ _tag: "Line", line }], `latecomer ${user}`);
            }),
          ),
        lobbyAsked: moment(
          "lobby question",
          Effect.gen(function* () {
            if (!(yield* enabled)) return;
            yield* say(config.lobbyChannelId, [{ _tag: "Line", line: yield* roasts.draw("voice:lobby", LOBBY, LOBBY) }], "lobby question");
          }),
        ),
        earlyBird,
        prewarm,
      });
    }),
  );
}
