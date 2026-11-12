// 🎮 Spontaneous play: when nothing's planned and we end up playing anyway.
//   • Two or more of us sit in the 🛋️ Lobby for 30 s with no game night on: the bot asks in the
//     Lobby's chat "🎮 Playing something?". One tap opens that game's room (an archived one comes
//     back) and brings the Lobby along. "Just hanging out" (or no answer in 10 min) keeps it quiet
//     until that gathering breaks up.
//   • Two or more of us in a game room that isn't a started planned night is a session, however we
//     got there. Two minutes in, if someone's missing, a silent line in #game-night says where we
//     are; ten minutes in it counts as a game night (stats, and the game's play count). When it's
//     over the line says how long it went.
//   • Anyone joining the Lobby while exactly one game room has any of us in it is pulled in once,
//     with a note that offers the way back.
//   • With game detection on (PRESENCES=1): two of us in the Lobby playing the same game skip the
//     question and go straight to its room (↩ to undo). A name Discord uses that isn't one of our
//     games is put to Gemini once, in the background ("World of Warcraft: Forever" → World of
//     Warcraft); when Gemini can't say, one tap teaches it instead. And two of us playing a game before anyone's in voice gets its room ready
//     under the Lobby, silently (it archives itself after an hour if nobody comes).
// Nothing here pings or notifies anyone, and everything it posts it tidies away again.
import { and, desc, eq, gt, inArray, isNull, lte, not, like, sql } from "drizzle-orm";
import { Context, Effect, Layer, Match, Schema } from "effect";
import type { Env } from "./env.js";
import { activityGuesses, fleeting, gameAliases, gameNights, games as gameTable, lobbyPrompts, readyRooms, rooms, sessions, voiceSegments } from "./db/index.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig, players } from "./config.js";
import { Discord, type DiscordError, IS_COMPONENTS_V2 } from "./discord.js";
import { LocalTime } from "./localtime.js";
import { Games } from "./games.js";
import { Voice } from "./voice.js";
import { Presence } from "./presence.js";
import { Gemini } from "./gemini.js";
import { Alerts } from "./alerts.js";
import { nowSec } from "./clock.js";
import { LegacyGeminiKey, LegacyPresences } from "./legacy.js"; // LEGACY-BRIDGE

export const GATHER_AFTER = 30; // two of us in the Lobby this long → ask
export const PROMPT_TTL = 10 * 60; // an unanswered question goes away after this
const PLANNED_SOON = 15 * 60; // a planned night starting within this owns the Lobby
const NIGHT_LIVE = 6 * 3600; // a started night's room is the night's for this long (while it's open)
const NIGHT_ON = 3 * 3600; // a night this recently started is on, room or no room (late.ts watches this long)
export const LINE_AFTER = 2 * 60; // a session this old with someone missing gets its quiet line
export const COUNT_AFTER = 10 * 60; // together this long → it counts as a game night
export const END_GRACE = 15 * 60; // fewer than two for this long → the session's over
export const NOTE_TTL = 2 * 60; // the "pulled you in" note removes itself after this
const UNDO_QUIET = 60; // a ↩ undo keeps the Lobby quiet even while people trickle back in
const SILENT = 1 << 12; // SUPPRESS_NOTIFICATIONS: no sound, no badge
const RETRY_GUESS = 86400; // Gemini couldn't answer: ask about that name again a day later
const mention = (u: string) => `<@${u}>`;
const real = not(like(rooms.channel_id, "pending:%"));

export type Where = ReadonlyMap<string, string | null>;
export type Change = { user: string; from: string | null; to: string | null };
type Room = typeof rooms.$inferSelect;
type Session = typeof sessions.$inferSelect;
type Prompt = typeof lobbyPrompts.$inferSelect;
type Planned = { soon: boolean; on: boolean; rooms: Set<string> };

/** What to tell the tapper privately: a line, or a whole message (with buttons). */
export type Notice = string | { content: string; components: unknown[] } | null;

/** Gemini's answer about a name Discord shows. */
const Guess = Schema.Struct({ game: Schema.optional(Schema.NullOr(Schema.String)) });

/** "A", "A and B", "A, B and C". */
export function names(users: ReadonlyArray<string>) {
  const m = users.map(mention);
  return m.length <= 1 ? (m[0] ?? "") : `${m.slice(0, -1).join(", ")} and ${m[m.length - 1]}`;
}

/** Minutes, said plainly: "46 min", "1 h 20 min". */
export function minutes(sec: number) {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** The one game everyone who's playing something we know is playing (null: none, or a mix). */
function oneGame(of: Map<string, string>) {
  const gs = [...new Set([...of.values()].map((g) => g.toLowerCase()))];
  if (gs.length !== 1) return null;
  const g = [...of.values()][0];
  return { game: g, by: [...of].filter(([, x]) => x.toLowerCase() === gs[0]).map(([u]) => u) };
}

const together = (s: Session, t: number) => s.together_secs + (s.active_since ? t - s.active_since : 0);
const liveLine = (s: Session, here: ReadonlyArray<string>) => `🎮 ${names(here)} ${here.length === 1 ? "is" : "are"} in **${s.game}** → <#${s.channel_id}>`;
const doneLine = (s: Session, t: number) => `🎮 ${names(s.who)} played **${s.game}** for ${minutes(together(s, t))}`;

export class Spontaneous extends Context.Service<
  Spontaneous,
  {
    /**
     * React to where everyone is (live.ts calls this, one at a time, after every voice change, on the
     * heartbeat and on reconnect). `change` is the move that triggered it, if any. Returns when to look
     * again (unix seconds) for something that's due with nothing else to trigger it, or null.
     */
    react(where: Where, t?: number, change?: Change): Effect.Effect<number | null, DbError | DiscordError>;
    /**
     * Someone's playing something new to us: ask Gemini (once per name, in the background) whether
     * it's one of our games under another name. A yes becomes an alias, so the next time two of us
     * are in it, it just works. Returns what was learned, for logs and tests.
     */
    learn(names: ReadonlyArray<string>, t?: number): Effect.Effect<{ activity: string; game: string | null }[], DbError>;
    /** Up to three games, the ones we played most recently first, then the most played. */
    recentGames(n?: number): Effect.Effect<string[], DbError>;
    /**
     * A tap on the question: `lob:<id>:g:<game>` | `lob:<id>:other` | `lob:<id>:chill`, or the
     * follow-up offer `lob:<id>:alias`. Returns what to tell the tapper privately, if anything.
     */
    answer(id: number, user: string, what: string, game?: string): Effect.Effect<Notice, DbError>;
    /**
     * ↩ Back to the Lobby (from a note): whoever was moved goes back if they're still in that room, and
     * the Lobby stays quiet for this gathering. Returns what to tell the tapper.
     */
    goBack(channel: string, users: ReadonlyArray<string>, messageId: string | undefined, t?: number): Effect.Effect<string | null, DbError>;
    /**
     * The day's planned night just started with this game: a session of the same game that day is the
     * night now. It stops counting on its own (the night counts), and its line goes.
     */
    absorb(day: string, game: string): Effect.Effect<void, DbError>;
    /**
     * Every minute (the leader's clock): what needs doing even when nobody's in voice to trigger it.
     * Notes past their time go, questions past theirs go, sessions that have sat below two long enough
     * (or whose room went) wrap up.
     */
    minute(t?: number): Effect.Effect<Record<string, unknown>, DbError>;
    /** Unplanned nights that counted, by day (stats): [{ day, game }]. */
    counted(fromDay: string, toDay: string): Effect.Effect<{ day: string; game: string }[], DbError>;
  }
>()("meme-bot/spontaneous") {
  static readonly layer = Layer.effect(
    Spontaneous,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const time = yield* LocalTime;
      const games = yield* Games;
      const voice = yield* Voice;
      const presence = yield* Presence;
      const gemini = yield* Gemini;
      const alerts = yield* Alerts;
      const trio = Effect.provideService(players, AppConfig, config);
      const lobbyId = config.lobbyChannelId;
      const presencesOn = Effect.gen(function* () { // LEGACY-BRIDGE
        return (yield* LegacyPresences) ?? config.presences; // LEGACY-BRIDGE
      }); // LEGACY-BRIDGE
      const hasGeminiKey = Effect.gen(function* () { // LEGACY-BRIDGE
        const legacy = yield* LegacyGeminiKey; // LEGACY-BRIDGE
        return legacy === null ? !!config.geminiApiKey : !!legacy; // LEGACY-BRIDGE
      }); // LEGACY-BRIDGE
      const sessionIs = (s: { day: string; game: string }) => and(eq(sessions.day, s.day), eq(sessions.game, s.game));

      // ---------------------------------------------------------------- what's planned

      /**
       * The planned night that owns voice right now: `rooms` are open rooms of nights that started (for
       * NIGHT_LIVE), `on` means one started lately (even if its room didn't open), `soon` that one is
       * about to start (or is due and hasn't yet).
       */
      const planned = Effect.fnUntraced(function* (t: number) {
        const nights = yield* db
          .select({ day: gameNights.day, start_at: gameNights.start_at, reminded: gameNights.reminded })
          .from(gameNights)
          .where(and(eq(gameNights.stage, "set"), gt(gameNights.start_at, t - NIGHT_LIVE), lte(gameNights.start_at, t + PLANNED_SOON)));
        const soon = nights.some((n) => !n.reminded);
        const started = nights.filter((n) => n.reminded && n.start_at! <= t).map((n) => n.day);
        const open = started.length
          ? yield* db
              .select({ channel_id: rooms.channel_id })
              .from(rooms)
              .where(and(inArray(rooms.day, started), isNull(rooms.archived_at), real))
          : [];
        const on = nights.some((n) => n.reminded && n.start_at! <= t && n.start_at! > t - NIGHT_ON);
        return { soon, on, rooms: new Set(open.map((r) => r.channel_id)) } satisfies Planned;
      });

      // ---------------------------------------------------------------- 🎮 what we're playing (game detection)

      /**
       * What each of `users` is playing, as our games: Discord's name matched to a game (case aside) or
       * to a name we learned. `unknown` is a name two or more of them share that matches nothing.
       */
      const playingGames = Effect.fnUntraced(function* (users: ReadonlyArray<string>) {
        const seen = new Map<string, string[]>();
        for (const u of users) seen.set(u, yield* presence.playing(u));
        const all = [...new Set([...seen.values()].flat())];
        const game = new Map<string, string>(); // lower-case activity name → game
        if (all.length) {
          for (const g of yield* db.select({ name: gameTable.name }).from(gameTable).where(inArray(gameTable.name, all))) game.set(g.name.toLowerCase(), g.name);
          for (const a of yield* db.select().from(gameAliases).where(inArray(gameAliases.activity, all))) game.set(a.activity.toLowerCase(), a.game);
        }
        const of = new Map<string, string>();
        for (const [u, names] of seen) {
          const g = names.map((n) => game.get(n.toLowerCase())).find(Boolean);
          if (g) of.set(u, g);
        }
        // a name two of them share that we can't place (and Gemini didn't already rule out): worth a tap
        const notOurs = all.length
          ? new Set(
              (yield* db
                .select({ a: activityGuesses.activity })
                .from(activityGuesses)
                .where(and(inArray(activityGuesses.activity, all), eq(activityGuesses.answered, true)))).map((r) => r.a.toLowerCase()),
            )
          : new Set<string>();
        const shared = all.filter((n) => !game.has(n.toLowerCase()) && !notOurs.has(n.toLowerCase()) && users.filter((u) => seen.get(u)!.includes(n)).length >= 2);
        return { of, unknown: shared[0] ?? null };
      });

      const learn = Effect.fn("Spontaneous.learn")(function* (names: ReadonlyArray<string>, at?: number) {
        const t = at ?? (yield* nowSec);
        if (!(yield* hasGeminiKey) || !names.length) return [];
        const list = (yield* games.list(200)).map((g) => g.name);
        const known = new Set(list.map((g) => g.toLowerCase()));
        for (const a of yield* db.select().from(gameAliases).where(inArray(gameAliases.activity, [...names]))) known.add(a.activity.toLowerCase());
        const learned: { activity: string; game: string | null }[] = [];
        for (const name of names.filter((n) => !known.has(n.toLowerCase()))) {
          // claim the name, so a second presence update doesn't ask twice; a failed ask may retry tomorrow
          const [claim] = yield* db
            .insert(activityGuesses)
            .values({ activity: name, at: t })
            .onConflictDoUpdate({ target: activityGuesses.activity, set: { at: t }, setWhere: and(eq(activityGuesses.answered, false), lte(activityGuesses.at, t - RETRY_GUESS)) })
            .returning({ a: activityGuesses.activity });
          if (!claim) continue;
          const r = yield* gemini.ask(
            `Discord shows a friend "Playing ${JSON.stringify(name)}". Our friend group's game list: ${JSON.stringify(list)}.
Is it one of the games on the list? Answer that game's name exactly as written in the list only if it
is clearly the same game (an edition, expansion, client, launcher or longer name of it, like "World of
Warcraft Classic" for "World of Warcraft"). If it's anything else (another game, an app like an editor
or a browser, or you aren't sure), answer null.`,
            { type: "OBJECT", properties: { game: { type: "STRING", nullable: true } }, required: ["game"] },
            Guess,
          );
          if (!r) continue; // no answer to be had today: claimed, so tomorrow it's tried again
          const game = list.find((g) => g.toLowerCase() === r.game?.toLowerCase()) ?? null;
          yield* db.update(activityGuesses).set({ game, answered: true }).where(eq(activityGuesses.activity, name));
          if (game) yield* db.insert(gameAliases).values({ activity: name, game, added_by: "gemini" }).onConflictDoNothing();
          learned.push({ activity: name, game });
        }
        return learned;
      });

      // ---------------------------------------------------------------- posting and tidying

      const deleteMessage = (channel: string, id: string) =>
        discord.deleteMessage(channel, id).pipe(Effect.catch((e) => (e._tag === "DiscordNotFound" ? Effect.void : Effect.logInfo(`couldn't delete ${channel} ${id} ${e}`))));

      /** A self-removing note in a room's chat, with the way back to the Lobby for `moved`. */
      const note = Effect.fnUntraced(function* (channel: string, content: string, moved: ReadonlyArray<string>, t: number) {
        yield* Effect.gen(function* () {
          const msg = yield* discord.createMessage(channel, {
            content,
            flags: SILENT,
            allowed_mentions: { parse: [] },
            components: [{ type: 1, components: [{ type: 2, style: 2, label: "Back to the Lobby", emoji: { name: "↩️" }, custom_id: `lob:back:${moved.join(",")}`.slice(0, 100) }] }],
          });
          yield* db.insert(fleeting).values({ message_id: msg.id, channel_id: channel, delete_at: t + NOTE_TTL }).onConflictDoNothing();
        }).pipe(Effect.catch((e) => Effect.logInfo(`room note failed ${channel} ${e}`))); // the move itself happened; the note is a nicety
      });

      /**
       * Two of us playing the same game and nobody in voice yet: have its room waiting under the Lobby.
       * Once per game per day, silently; the room archives itself after an hour if nobody comes.
       */
      const readyRoom = Effect.fnUntraced(function* (where: Where, open: ReadonlyArray<Room>, plan: Planned, t: number) {
        if (!(yield* presencesOn) || plan.soon || plan.on || plan.rooms.size) return;
        // only those not in voice yet (in voice, the Lobby flow has them)
        const away = (yield* trio).filter((p) => !where.get(p));
        if (away.length < 2) return;
        const { of } = yield* playingGames(away);
        const counts = new Map<string, string[]>();
        for (const [u, g] of of) counts.set(g.toLowerCase(), [...(counts.get(g.toLowerCase()) ?? []), u]);
        const hit = [...counts.values()].find((us) => us.length >= 2);
        if (!hit) return;
        const game = of.get(hit[0])!;
        if (open.some((r) => r.game.toLowerCase() === game.toLowerCase())) return;
        const day = time.at(t).day;
        // claim → room, never cut short (architecture §15); the claim goes back only on a failure
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const [claim] = yield* db.insert(readyRooms).values({ day, game, at: t }).onConflictDoNothing().returning({ day: readyRooms.day });
            if (!claim) return;
            yield* Effect.gen(function* () {
              const r = yield* voice.openRoom(game, yield* games.emojiFor(game), { move: false });
              yield* Effect.logInfo(`room ready ahead ${game} ${r.channelId}`);
            }).pipe(
              Effect.catch((e) =>
                Effect.andThen(db.delete(readyRooms).where(and(eq(readyRooms.day, day), eq(readyRooms.game, game))), alerts.failed("getting a game room ready", e, game)),
              ),
            );
          }),
        );
      });

      /** Two of us in the Lobby playing the same game: straight to its room, with ↩ in case we're wrong. */
      const autoMove = (game: string, by: ReadonlyArray<string>, t: number) => Effect.uninterruptible(autoMoveOnce(game, by, t)); // claim → move → note (§15)
      const autoMoveOnce = Effect.fnUntraced(function* (game: string, by: ReadonlyArray<string>, t: number) {
        const [claim] = yield* db.insert(lobbyPrompts).values({ created_at: t, state: "moved", game }).onConflictDoNothing().returning({ id: lobbyPrompts.id });
        if (!claim) return;
        yield* Effect.gen(function* () {
          const r = yield* voice.openRoom(game, yield* games.emojiFor(game), { move: true });
          if (r.moved.length) yield* note(r.channelId, `🎮 Saw ${names(by)} in **${game}**, so I brought you over.`, r.moved, t);
        }).pipe(
          Effect.catch((e) =>
            Effect.andThen(db.update(lobbyPrompts).set({ state: "failed" }).where(eq(lobbyPrompts.id, claim.id)), alerts.failed("moving the Lobby into the game we're playing", e, game)),
          ),
        );
      });

      // ---------------------------------------------------------------- the Lobby question

      const recentGames = Effect.fn("Spontaneous.recentGames")(function* (n: number = 3) {
        const { rows } = yield* db.execute<{ game: string }>(sql`
    SELECT game FROM (
      SELECT game, created_at AS t FROM ${rooms} WHERE channel_id NOT LIKE 'pending:%'
      UNION ALL SELECT game, started_at FROM ${sessions}
      UNION ALL SELECT game, start_at FROM ${gameNights} WHERE stage = 'set' AND reminded AND game IS NOT NULL
    ) x GROUP BY game ORDER BY max(t) DESC LIMIT ${n}`);
        const out = rows.map((r) => r.game);
        for (const g of yield* games.list(n + out.length)) {
          if (out.length >= n) break;
          if (!out.some((x) => x.toLowerCase() === g.name.toLowerCase())) out.push(g.name);
        }
        return out;
      });

      const questionMessage = Effect.fnUntraced(function* (id: number, first: string | null) {
        const recent = yield* recentGames(3);
        // someone's playing it: that game first
        const list = first ? [first, ...recent.filter((g) => g.toLowerCase() !== first.toLowerCase())].slice(0, 3) : recent;
        const emoji = new Map((yield* games.list(100)).map((g) => [g.name.toLowerCase(), g.emoji ?? "🎮"]));
        const btn = (label: string, custom_id: string, e: string, style = 2) => ({ type: 2, style, label: label.slice(0, 80), custom_id, emoji: { name: e } });
        return {
          flags: IS_COMPONENTS_V2 | SILENT,
          allowed_mentions: { parse: [] },
          components: [
            {
              type: 17,
              accent_color: 0x57f287,
              components: [
                { type: 10, content: "### 🎮 Playing something?\n-# Tap the game: I'll open its room and bring everyone here along." },
                ...(list.length ? [{ type: 1, components: list.map((g) => btn(g, `lob:${id}:g:${g}`.slice(0, 100), emoji.get(g.toLowerCase()) ?? "🎮", 1)) }] : []),
                { type: 1, components: [btn("Other…", `lob:${id}:other`, "✏️"), btn("Just hanging out", `lob:${id}:chill`, "🛋️")] },
              ],
            },
          ],
        };
      });

      /**
       * Claim this gathering's question, then post it; a failed post leaves the gathering quiet.
       * Claim → post → record is never cut short (architecture §15).
       */
      const ask = (t: number, first: string | null, activity: string | null) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const [claim] = yield* db.insert(lobbyPrompts).values({ created_at: t, state: "open", activity }).onConflictDoNothing().returning({ id: lobbyPrompts.id });
            if (!claim) return;
            yield* Effect.gen(function* () {
              const msg = yield* discord.createMessage(lobbyId, yield* questionMessage(claim.id, first));
              yield* db.update(lobbyPrompts).set({ message_id: msg.id, posted_at: t }).where(eq(lobbyPrompts.id, claim.id));
            }).pipe(
              Effect.catch((e) =>
                Effect.andThen(db.update(lobbyPrompts).set({ state: "failed" }).where(eq(lobbyPrompts.id, claim.id)), alerts.failed("asking the Lobby what we're playing", e)),
              ),
            );
          }),
        );

      const closePrompt = (p: Prompt, state: "expired" | "dismissed") => Effect.uninterruptible(closePromptOnce(p, state)); // the claim → the message gone (§15)
      const closePromptOnce = Effect.fnUntraced(function* (p: Prompt, state: "expired" | "dismissed") {
        const done = yield* db
          .update(lobbyPrompts)
          .set({ state })
          .where(and(eq(lobbyPrompts.id, p.id), eq(lobbyPrompts.state, "open")))
          .returning({ id: lobbyPrompts.id });
        if (done.length && p.message_id) yield* deleteMessage(lobbyId, p.message_id);
      });

      const endGathering = Effect.fnUntraced(function* (p: Prompt, t: number) {
        if (p.state === "open") yield* closePrompt(p, "expired");
        yield* db.update(lobbyPrompts).set({ current: false, ended_at: t }).where(eq(lobbyPrompts.id, p.id));
      });

      const gathering = Effect.fnUntraced(function* (where: Where, open: ReadonlyArray<Room>, inRoom: (r: Room) => string[], plan: Planned, t: number) {
        const lobby = (yield* trio).filter((p) => where.get(p) === lobbyId);
        const [cur] = yield* db.select().from(lobbyPrompts).where(eq(lobbyPrompts.current, true));

        if (lobby.length < 2) {
          // the gathering broke up (an undo stays in force while people trickle back)
          if (cur && !(cur.state === "undone" && t - cur.created_at < UNDO_QUIET)) yield* endGathering(cur, t);
          return null;
        }
        if (cur) {
          if (cur.state !== "open" || !cur.posted_at) return null;
          if (t - cur.posted_at < PROMPT_TTL) return cur.posted_at + PROMPT_TTL;
          yield* closePrompt(cur, "expired");
          return null;
        }
        // a planned night owns the Lobby; and with someone already in a game room, joiners get pulled there
        if (plan.soon || plan.on || plan.rooms.size || open.some((r) => inRoom(r).length)) return null;

        // the gathering started when the second of us got here (their Lobby stretch, as tracked for stats)
        const segs = yield* db
          .select({ started_at: voiceSegments.started_at })
          .from(voiceSegments)
          .where(and(eq(voiceSegments.open, true), eq(voiceSegments.channel_id, lobbyId), inArray(voiceSegments.user_id, lobby)));
        const starts = segs.map((s) => s.started_at).sort((a, b) => a - b);
        const since = starts.length >= 2 ? starts[1] : t;
        if (t < since + GATHER_AFTER) return since + GATHER_AFTER;
        // game detection: two playing the same game and nobody playing another → no need to ask
        const seen = (yield* presencesOn) ? yield* playingGames(lobby) : { of: new Map<string, string>(), unknown: null };
        const one = oneGame(seen.of);
        if (one && one.by.length >= 2) {
          yield* autoMove(one.game, one.by, t);
          return null;
        }
        yield* ask(t, one?.game ?? null, seen.unknown);
        return t + PROMPT_TTL;
      });

      const answer = Effect.fn("Spontaneous.answer")(function* (id: number, user: string, what: string, game?: string) {
        const [p] = yield* db.select().from(lobbyPrompts).where(eq(lobbyPrompts.id, id));
        if (!p) return "That question's gone 🫥" as Notice;
        return yield* Match.value(what).pipe(
          Match.when("alias", () =>
            Effect.gen(function* () {
              if (!p.activity || !p.game) return "🤷";
              yield* db
                .insert(gameAliases)
                .values({ activity: p.activity, game: p.game, added_by: user })
                .onConflictDoUpdate({ target: gameAliases.activity, set: { game: p.game, added_by: user } });
              return `👍 From now on, two of you in *${p.activity}* go straight to **${p.game}**.`;
            }),
          ),
          Match.when("chill", () =>
            Effect.gen(function* () {
              if (p.state !== "open") return null;
              yield* db.update(lobbyPrompts).set({ by: user }).where(eq(lobbyPrompts.id, id));
              yield* closePrompt(p, "dismissed");
              return null;
            }),
          ),
          // a game: first tap wins; the pick → the room → the question gone is never cut short (§15)
          Match.orElse(() =>
            Effect.uninterruptible(Effect.gen(function* () {
              const [won] = yield* db
                .update(lobbyPrompts)
                .set({ state: "picked", by: user, game: game! })
                .where(and(eq(lobbyPrompts.id, id), eq(lobbyPrompts.state, "open")))
                .returning({ id: lobbyPrompts.id });
              if (!won) {
                const [now] = yield* db.select().from(lobbyPrompts).where(eq(lobbyPrompts.id, id));
                return now?.state === "picked" && now.game ? `${mention(now.by!)} already picked **${now.game}** 🙂` : "That question's closed.";
              }
              return yield* Effect.gen(function* () {
                const r = yield* voice.openRoom(game!, yield* games.emojiFor(game!), { by: user, move: true });
                if (p.message_id) yield* deleteMessage(lobbyId, p.message_id);
                if (p.activity) {
                  // they were all in a game Discord calls something we don't know: offer to remember it (never silently)
                  return {
                    content: `Discord says you were playing *${p.activity}*. Is that **${game}**?`,
                    components: [{ type: 1, components: [{ type: 2, style: 1, label: `Yes, always open ${game}`.slice(0, 80), custom_id: `lob:${id}:alias`, emoji: { name: "🧠" } }] }],
                  } as Notice;
                }
                return r.moved.length ? null : `🔊 Room's up: <#${r.channelId}>. Nobody was left in the Lobby to bring along.`;
              }).pipe(
                Effect.catch((e) =>
                  Effect.gen(function* () {
                    // give the question back, so someone can try again
                    yield* db.update(lobbyPrompts).set({ state: "open", by: null, game: null }).where(eq(lobbyPrompts.id, id));
                    yield* alerts.failed("opening a room from the Lobby question", e);
                    return "😵 Couldn't open the room just now. Try again in a moment.";
                  }),
                ),
              );
            })),
          ),
        );
      });

      // ---------------------------------------------------------------- pulling latecomers in

      /** Someone joined the Lobby: with exactly one game room in use (not a planned night's), bring them in, once. */
      const pullIn = Effect.fnUntraced(function* ({ user, from }: Change, open: ReadonlyArray<Room>, inRoom: (r: Room) => string[], plan: Planned, t: number) {
        if (plan.on || plan.rooms.size) return; // a planned night's latecomers are late.ts's
        const busy = open.filter((r) => inRoom(r).length);
        if (busy.length !== 1) return;
        const r = busy[0];
        // came out of that very room (to chat in the Lobby, say): that's on purpose
        if (r.pulled.includes(user) || from === r.channel_id) return;
        // claim first, so a quick out-and-back can't pull twice; claim → move → note is never cut short
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const claimed = yield* db
              .update(rooms)
              .set({ pulled: sql`${rooms.pulled} || ${JSON.stringify([user])}::jsonb` })
              .where(and(eq(rooms.channel_id, r.channel_id), not(sql`${rooms.pulled} ? ${user}`)))
              .returning({ id: rooms.channel_id });
            if (!claimed.length) return;
            yield* discord.moveMember(user, r.channel_id);
            yield* note(r.channel_id, `👋 Pulled ${mention(user)} in from the Lobby: ${names(inRoom(r))} ${inRoom(r).length === 1 ? "is" : "are"} here.`, [user], t);
          }),
        );
      });

      const goBack = Effect.fn("Spontaneous.goBack")(function* (channel: string, users: ReadonlyArray<string>, messageId: string | undefined, at?: number) {
        const t = at ?? (yield* nowSec);
        const back: string[] = [];
        for (const u of users) {
          if ((yield* voice.voiceChannel(u).pipe(Effect.catch(() => Effect.succeed(null)))) !== channel) continue;
          yield* discord.moveMember(u, lobbyId).pipe(
            Effect.andThen(Effect.sync(() => void back.push(u))),
            Effect.catch((e) => Effect.logInfo(`move back failed ${u} ${e}`)),
          );
        }
        // quiet for this gathering: a current row that isn't asking
        const [cur] = yield* db.select().from(lobbyPrompts).where(eq(lobbyPrompts.current, true));
        if (cur?.state === "open") yield* closePrompt(cur, "dismissed");
        if (cur) yield* db.update(lobbyPrompts).set({ state: "undone", created_at: t }).where(eq(lobbyPrompts.id, cur.id));
        else yield* db.insert(lobbyPrompts).values({ created_at: t, state: "undone" }).onConflictDoNothing();
        if (messageId) {
          yield* deleteMessage(channel, messageId);
          yield* db.delete(fleeting).where(eq(fleeting.message_id, messageId));
        }
        return back.length ? null : "Nobody to move back: they've already left that room.";
      });

      // ---------------------------------------------------------------- sessions

      /** It counts as a game night, unless the day's planned night was this same game (then it's that one). */
      const count = (s: Session) => Effect.uninterruptible(countOnce(s)); // the claim → the play counted (§15)
      const countOnce = Effect.fnUntraced(function* (s: Session) {
        const [night] = yield* db
          .select({ day: gameNights.day })
          .from(gameNights)
          .where(and(eq(gameNights.day, s.day), eq(gameNights.stage, "set"), eq(gameNights.reminded, true), eq(gameNights.game, s.game)));
        if (night) return;
        const claimed = yield* db
          .update(sessions)
          .set({ counted: true })
          .where(and(sessionIs(s), eq(sessions.counted, false)))
          .returning({ day: sessions.day });
        if (claimed.length) yield* db.update(gameTable).set({ plays: sql`${gameTable.plays} + 1` }).where(eq(gameTable.name, s.game));
        s.counted = true;
      });

      const editLine = Effect.fnUntraced(function* (s: Session, line: string) {
        if (s.line === line || !s.message_id || s.message_id === "posting") return;
        // swept away at 03:00, or deleted by hand: fine
        yield* discord
          .editMessage(config.gameChannelId, s.message_id, { content: line, allowed_mentions: { parse: [] } })
          .pipe(Effect.catchTag("DiscordNotFound", () => Effect.void));
        yield* db.update(sessions).set({ line }).where(sessionIs(s));
      });

      /** Claim → post → record, never cut short (architecture §15). */
      const postLine = (s: Session, here: ReadonlyArray<string>) => Effect.uninterruptible(postLineOnce(s, here));
      const postLineOnce = Effect.fnUntraced(function* (s: Session, here: ReadonlyArray<string>) {
        const claimed = yield* db
          .update(sessions)
          .set({ message_id: "posting" })
          .where(and(sessionIs(s), isNull(sessions.message_id)))
          .returning({ day: sessions.day });
        if (!claimed.length) return;
        const line = liveLine(s, here);
        yield* Effect.gen(function* () {
          const msg = yield* discord.createMessage(config.gameChannelId, { content: line, flags: SILENT, allowed_mentions: { parse: [] } });
          yield* db.update(sessions).set({ message_id: msg.id, line }).where(sessionIs(s));
        }).pipe(
          Effect.catch((e) =>
            Effect.andThen(db.update(sessions).set({ message_id: null }).where(sessionIs(s)), Effect.logInfo(`session line failed ${s.game} ${e}`)), // tried again next time
          ),
        );
      });

      /** A session for this room's game today, new or resumed (same game, same day = same session). */
      const startSession = Effect.fnUntraced(function* (r: Room, t: number) {
        const day = time.at(t).day;
        const [s] = yield* db
          .insert(sessions)
          .values({ day, game: r.game, channel_id: r.channel_id, started_at: t })
          .onConflictDoUpdate({
            target: [sessions.day, sessions.game],
            set: { channel_id: r.channel_id, finished: false, idle_since: null },
            setWhere: eq(sessions.absorbed, false),
          })
          .returning();
        if (s) return s;
        // absorbed into the day's planned night: it stays the night's, nothing more to track
        return (yield* db.select().from(sessions).where(and(eq(sessions.day, day), eq(sessions.game, r.game))))[0];
      });

      const stepSession = Effect.fnUntraced(function* (s: Session, here: ReadonlyArray<string>, t: number) {
        if (s.absorbed) return;
        const set: Partial<Session> = {};
        const who = [...new Set([...s.who, ...here])];
        if (who.length !== s.who.length) set.who = who;
        if (here.length >= 2 && !s.active_since) Object.assign(set, { active_since: t, idle_since: null });
        if (here.length < 2 && s.active_since) Object.assign(set, { active_since: null, idle_since: t, together_secs: s.together_secs + (t - s.active_since) });
        if (Object.keys(set).length) yield* db.update(sessions).set(set).where(sessionIs(s));
        const cur: Session = { ...s, ...set };

        if (!cur.counted && together(cur, t) >= COUNT_AFTER) yield* count(cur);
        // the quiet line: two minutes in, only if one of us isn't there
        const missing = (yield* trio).some((p) => !here.includes(p));
        if (!cur.message_id && here.length >= 2 && missing && t - cur.started_at >= LINE_AFTER) yield* postLine(cur, here);
        else if (cur.message_id && cur.message_id !== "posting" && here.length >= 2) yield* editLine(cur, liveLine(cur, here));
      });

      /** Over: the line says how long it went (or goes, if it never counted). */
      const finishSession = (s: Session, t: number) => Effect.uninterruptible(finishOnce(s, t)); // the claim → the count → the line (§15)
      const finishOnce = Effect.fnUntraced(function* (s: Session, t: number) {
        const end = s.active_since ? t : (s.idle_since ?? t);
        const final: Session = { ...s, together_secs: s.together_secs + (s.active_since ? t - s.active_since : 0), active_since: null };
        const done = yield* db
          .update(sessions)
          .set({ finished: true, active_since: null, idle_since: s.idle_since ?? end, together_secs: final.together_secs })
          .where(and(sessionIs(s), eq(sessions.finished, false)))
          .returning({ day: sessions.day });
        if (!done.length) return;
        if (!final.counted && final.together_secs >= COUNT_AFTER) yield* count(final);
        if (!s.message_id || s.message_id === "posting") return;
        if (final.counted) yield* editLine(final, doneLine(final, t));
        else {
          yield* deleteMessage(config.gameChannelId, s.message_id);
          yield* db.update(sessions).set({ message_id: null, line: null }).where(sessionIs(s));
        }
      });

      /** Sessions whose room went (archived, deleted) or that sat below two for END_GRACE wrap up. */
      const finishDue = Effect.fnUntraced(function* (open: ReadonlyArray<Room>, t: number) {
        const done: string[] = [];
        for (const s of yield* db.select().from(sessions).where(eq(sessions.finished, false))) {
          const roomOpen = open.some((r) => r.channel_id === s.channel_id);
          if (roomOpen && !(s.idle_since && t - s.idle_since >= END_GRACE)) continue;
          yield* finishSession(s, t).pipe(
            Effect.andThen(Effect.sync(() => void done.push(s.game))),
            Effect.catch((e) => alerts.failed("wrapping up an unplanned session", e, s.game)),
          );
        }
        return done;
      });

      const trackSessions = Effect.fnUntraced(function* (open: ReadonlyArray<Room>, inRoom: (r: Room) => string[], plan: Planned, t: number) {
        const live = yield* db.select().from(sessions).where(eq(sessions.finished, false));
        for (const r of open) {
          if (plan.rooms.has(r.channel_id)) continue; // a planned night: late.ts and the night's own count have it
          const here = inRoom(r);
          const found = live.find((x) => x.channel_id === r.channel_id) ?? null;
          if (!found && here.length < 2) continue;
          yield* Effect.gen(function* () {
            const s = found ?? (yield* startSession(r, t));
            yield* stepSession(s, here, t);
          }).pipe(Effect.catch((e) => alerts.failed("keeping track of an unplanned session", e, r.game)));
        }
        yield* finishDue(open, t);
      });

      return Spontaneous.of({
        react: Effect.fn("Spontaneous.react")(function* (where: Where, at?: number, change?: Change) {
          const t = at ?? (yield* nowSec);
          const plan = yield* planned(t);
          const open = yield* voice.openRooms;
          const ps = yield* trio;
          const inRoom = (r: Room) => ps.filter((p) => where.get(p) === r.channel_id);
          yield* trackSessions(open, inRoom, plan, t);
          if (change?.to === lobbyId && ps.includes(change.user)) yield* pullIn(change, open, inRoom, plan, t);
          yield* readyRoom(where, open, plan, t);
          return yield* gathering(where, open, inRoom, plan, t);
        }),
        learn,
        recentGames,
        answer,
        goBack,
        absorb: Effect.fn("Spontaneous.absorb")(function* (day: string, game: string) {
          const [s] = yield* db
            .update(sessions)
            .set({ absorbed: true, finished: true, active_since: null })
            .where(and(eq(sessions.day, day), eq(sessions.game, game), eq(sessions.absorbed, false)))
            .returning();
          if (!s) return;
          if (s.counted) {
            yield* db.update(sessions).set({ counted: false }).where(and(eq(sessions.day, day), eq(sessions.game, game)));
            yield* db.update(gameTable).set({ plays: sql`GREATEST(${gameTable.plays} - 1, 0)` }).where(eq(gameTable.name, game));
          }
          if (s.message_id && s.message_id !== "posting") yield* deleteMessage(config.gameChannelId, s.message_id);
        }),
        minute: Effect.fn("Spontaneous.minute")(function* (at?: number) {
          const t = at ?? (yield* nowSec);
          const out: Record<string, unknown> = {};
          const due = yield* db.select().from(fleeting).where(lte(fleeting.delete_at, t));
          for (const n of due) {
            yield* deleteMessage(n.channel_id, n.message_id);
            yield* db.delete(fleeting).where(eq(fleeting.message_id, n.message_id));
          }
          if (due.length) out.notes = due.length;

          const [cur] = yield* db.select().from(lobbyPrompts).where(and(eq(lobbyPrompts.current, true), eq(lobbyPrompts.state, "open")));
          if (cur?.posted_at && t - cur.posted_at >= PROMPT_TTL) {
            yield* closePrompt(cur, "expired");
            out.expired = cur.id;
          }

          const finished = yield* finishDue(yield* voice.openRooms, t);
          if (finished.length) out.finished = finished;
          return out;
        }),
        counted: Effect.fn("Spontaneous.counted")(function* (fromDay: string, toDay: string) {
          return yield* db
            .select({ day: sessions.day, game: sessions.game })
            .from(sessions)
            .where(and(eq(sessions.counted, true), sql`${sessions.day} BETWEEN ${fromDay} AND ${toDay}`))
            .orderBy(desc(sessions.day));
        }),
      });
    }),
  );
}
