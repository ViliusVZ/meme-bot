// Dynamic game rooms. Hang out in the 🛋️ Lobby; when a game starts (a locked-in game night, or
// 🔊 Game room on the panel) the bot opens a voice room for that game and moves everyone in the
// Lobby into it. Once a room has sat empty for a while it moves to 🗄️ Recent games, and after a
// few days it's deleted. Someone rejoining an archived room brings it back.
//
// Who's where comes live from the gateway (presence.ts): the moment the last person leaves a room,
// its 15-minute wrap-up clock starts (live.ts sets a timer for it), and the room and its night's
// event wrap up right on time. Without the gateway (starting up, or a copy that isn't the leader)
// lookups fall back to REST, per player.
import { and, asc, desc, eq, isNull, like, not, sql } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer, Schema } from "effect";
import { gameNights, rooms } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig, players } from "./config.js";
import { Discord, type DiscordError, EPHEMERAL, IS_COMPONENTS_V2, isFinished } from "./discord.js";
import { Games } from "./games.js";
import { Presence } from "./presence.js";
import type { Channel } from "./channels.js";
import { Alerts } from "./alerts.js";
import { nowSec } from "./clock.js";

export type Room = typeof rooms.$inferSelect;
export type Opened = { channelId: string; moved: string[]; reused: boolean };

const EMPTY_GRACE = 15 * 60; // empty this long after the last person leaves → archive + end the event
const EVENT_MARGIN = 10 * 60; // still playing this close to the event's end → push the end back
const EVENT_EXTEND = 30 * 60;
const NEVER_JOINED_GRACE = 60 * 60; // opened but nobody came → archive after this
const ARCHIVE_TTL = 3 * 86400; // archived rooms are deleted after this
const ARCHIVE_NAME = "🗄️ Recent games";

/** While a room's channel is being created, its row holds a placeholder id ("pending:<game>"). */
const PENDING = "pending:";
const PENDING_TTL = 5 * 60; // a placeholder older than this is a crashed creation: drop it
// creating a channel and slotting it under the Lobby can take a few seconds under rate limits
const CLAIM_POLL = Duration.millis(700);
const CLAIM_POLLS = 20;
const real = not(like(rooms.channel_id, `${PENDING}%`));

/** Another tap is creating this game's room, and it didn't show up while we waited. */
export class RoomStillCreating extends Schema.TaggedError<RoomStillCreating>()("RoomStillCreating", { game: Schema.String }) {
  override get message() {
    return `room for ${this.game} is still being created`;
  }
}

export const isDiscordError = (e: { readonly _tag: string }): e is DiscordError => e._tag.startsWith("Discord");

/** When an open room's wrap-up is due if it stays empty (unix seconds). */
export const wrapUpAt = (r: Room) => (r.last_seen ? r.last_seen + EMPTY_GRACE : r.created_at + NEVER_JOINED_GRACE);

/** The result line after opening a room. */
export function roomLine(lobbyChannelId: string, r: Opened) {
  const moved = r.moved.length ? ` Moved ${r.moved.map((u) => `<@${u}>`).join(" ")} from the Lobby.` : ` Nobody was in <#${lobbyChannelId}> to move; hop in yourself.`;
  return `${r.reused ? "🔊 That room is already open:" : "🔊 Room's up:"} <#${r.channelId}>.${moved}`;
}

export const otherRoomModal = () => ({
  custom_id: "room:other",
  title: "Open a game room",
  components: [{ type: 1, components: [{ type: 4, custom_id: "value", style: 1, label: "Game or room name", placeholder: "Lethal Company", max_length: 60, required: true }] }],
});

export class Voice extends Context.Service<
  Voice,
  {
    /** The voice channel a user is in, or null. 404 "Unknown Voice State" means not in voice. */
    voiceChannel(user: string): Effect.Effect<string | null, DiscordError>;
    /** Rooms that are open (not archived, not mid-creation). */
    readonly openRooms: Effect.Effect<Room[], DbError>;
    /**
     * Opens (or reuses) the room for a game and moves everyone sitting in the Lobby into it.
     * Reusing means two "start a room" clicks, or a game night plus a manual room, never make two
     * Phasmophobia rooms: creation is claimed with a placeholder row first, and whoever loses the
     * claim waits for the winner's room instead of making its own.
     */
    openRoom(game: string, emoji: string | null, opts?: { day?: string; by?: string; move?: boolean }): Effect.Effect<Opened, DbError | DiscordError | RoomStillCreating>;
    /** Moves every player currently in the Lobby into a room, all at once. Returns who was moved. */
    moveFromLobby(channelId: string): Effect.Effect<string[], DbError>;
    /**
     * The same move, also saying who was already in that room (the same lookups: the start pings
     * only who isn't there yet).
     */
    bringIn(channelId: string): Effect.Effect<{ moved: string[]; already: string[] }, DbError>;
    /** Each player's voice channel right now (null: couldn't tell, so don't act on it). */
    readonly whereIs: Effect.Effect<Map<string, string | null> | null>;
    /**
     * Re-check open rooms against who's where: busy rooms are marked seen (and their event kept
     * alive), empty ones past their grace are wrapped up. Returns what was archived and when the next
     * empty room falls due (unix seconds, or null), so the caller can wake up right then.
     */
    checkRooms(occupied: ReadonlySet<string>, t?: number): Effect.Effect<{ archived: string[]; nextDue: number | null }, DbError>;
    /** Someone just left a room: its idle clock starts now, not at the last check. */
    leftRoom(channelId: string, t?: number): Effect.Effect<void, DbError>;
    /**
     * Every minute: who's in which room? Busy rooms stay (or come back from the archive), rooms empty past
     * their grace move to 🗄️ Recent games, and archived rooms past their TTL are deleted. The
     * archive category disappears when it's empty.
     */
    readonly maintainRooms: Effect.Effect<Record<string, string[]>, DbError | DiscordError>;
    /** 🔊 Game room: pick a game, get a room, and everyone in the Lobby comes with you. */
    readonly roomPicker: Effect.Effect<object, DbError>;
  }
>()("meme-bot/voice") {
  static readonly layer = Layer.effect(
    Voice,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const presence = yield* Presence;
      const games = yield* Games;
      const alerts = yield* Alerts;
      const trio = Effect.provideService(players, AppConfig, config);

      const voiceChannel = Effect.fn("Voice.voiceChannel")(function* (user: string) {
        const live = yield* presence.channelOf(user);
        if (live !== undefined) return live;
        return yield* discord.voiceState(user).pipe(
          Effect.map((s) => s.channel_id ?? null),
          Effect.catchTag("DiscordNotFound", () => Effect.succeed(null)),
        );
      });

      /** The game's most recent room, open or archived (an archived one gets brought back). */
      const latestRoom = Effect.fnUntraced(function* (game: string) {
        const [r] = yield* db
          .select()
          .from(rooms)
          .where(and(eq(rooms.game, game), real))
          .orderBy(asc(sql`${rooms.archived_at} IS NOT NULL`), desc(rooms.created_at))
          .limit(1);
        return r ?? null;
      });

      const openRooms = db.select().from(rooms).where(and(isNull(rooms.archived_at), real)).pipe(Effect.withSpan("Voice.openRooms"));

      /** New rooms go right under the Lobby, newest first. */
      const placeAfterLobby = Effect.fnUntraced(function* (channelId: string) {
        const all = yield* discord.listChannels;
        const voice = all.filter((c) => c.parent_id === config.voiceCategoryId && c.type === 2).sort((a, b) => a.position - b.position);
        const rest = voice.filter((c) => c.id !== config.lobbyChannelId && c.id !== channelId);
        const order = [config.lobbyChannelId, channelId, ...rest.map((c) => c.id)];
        yield* discord.reorderChannels(order.map((id, position) => ({ id, position })));
      });

      const archiveCategory = Effect.fnUntraced(function* (create: boolean) {
        const all = yield* discord.listChannels;
        const found = all.find((c) => c.type === 4 && c.name === ARCHIVE_NAME);
        if (found || !create) return found?.id ?? null;
        return (yield* discord.createChannel({ name: ARCHIVE_NAME, type: 4, position: 99 })).id;
      });

      /** Drop the 🗄️ Recent games category once nothing is left in it. */
      const tidyArchive = Effect.fnUntraced(function* (all: ReadonlyArray<Channel>) {
        const cat = all.find((c) => c.type === 4 && c.name === ARCHIVE_NAME);
        if (cat && !all.some((c) => c.parent_id === cat.id)) yield* discord.deleteChannel(cat.id).pipe(Effect.ignore);
      });

      /** An ended event can't come back: forget its end, so a revived room doesn't try to push it back. */
      const eventOver = (day: string) => db.update(gameNights).set({ event_end: null }).where(eq(gameNights.day, day));

      /** Empty past its grace? Then move the room to 🗄️ Recent games and end its night's event. */
      const archiveIfIdle = Effect.fnUntraced(function* (r: Room, t: number) {
        const idleSince = r.last_seen ?? r.created_at;
        const grace = r.last_seen ? EMPTY_GRACE : NEVER_JOINED_GRACE;
        if (t - idleSince < grace) return false;
        const cat = yield* archiveCategory(true);
        yield* discord.editChannel(r.channel_id, { parent_id: cat });
        yield* db.update(rooms).set({ archived_at: t }).where(and(eq(rooms.channel_id, r.channel_id), isNull(rooms.archived_at)));
        // the session's over: end its Discord event if it went live
        if (r.day) {
          const [n] = yield* db
            .select({ event_id: gameNights.event_id, event_end: gameNights.event_end })
            .from(gameNights)
            .where(and(eq(gameNights.day, r.day), eq(gameNights.stage, "set")));
          if (n?.event_id && n.event_end) {
            yield* discord.editEvent(n.event_id, { status: 3 }).pipe(Effect.ignore);
            yield* eventOver(r.day);
          }
        }
        return true;
      });

      /** Still playing near the event's planned end: push it back, so Discord doesn't end it under us. */
      const keepEventAlive = Effect.fnUntraced(function* (r: Room, t: number) {
        const day = r.day;
        if (!day) return;
        const [n] = yield* db
          .select({ event_id: gameNights.event_id, event_end: gameNights.event_end })
          .from(gameNights)
          .where(and(eq(gameNights.day, day), eq(gameNights.stage, "set"), eq(gameNights.reminded, true)));
        if (!n?.event_id || !n.event_end || n.event_end - t > EVENT_MARGIN) return;
        const end = t + EVENT_EXTEND;
        yield* discord.editEvent(n.event_id, { scheduled_end_time: DateTime.formatIso(DateTime.makeUnsafe(end * 1000)) }).pipe(
          Effect.andThen(db.update(gameNights).set({ event_end: end }).where(eq(gameNights.day, day))),
          Effect.catch((e) => (isDiscordError(e) && isFinished(e) ? eventOver(day) : alerts.failed("extending the Discord event", e))),
        );
      });

      const gather = Effect.fnUntraced(function* (channelId: string) {
        const ps = yield* trio;
        const went = yield* Effect.forEach(
          ps,
          (p) =>
            Effect.gen(function* () {
              const at = yield* voiceChannel(p).pipe(Effect.catch((e) => Effect.as(Effect.logInfo(`voice lookup failed ${p} ${e}`), null)));
              if (at === channelId) return "already" as const;
              if (at !== config.lobbyChannelId) return false;
              return yield* discord.moveMember(p, channelId).pipe(
                Effect.as(true),
                Effect.catch((e) => Effect.as(alerts.failed("moving someone into the game room", e, p), false)),
              );
            }),
          { concurrency: "unbounded" },
        );
        const moved = ps.filter((_, i) => went[i] === true); // stable order for the ping
        if (moved.length) yield* db.update(rooms).set({ last_seen: yield* nowSec }).where(eq(rooms.channel_id, channelId));
        return { moved, already: ps.filter((_, i) => went[i] === "already") };
      });
      const moveFromLobby = Effect.fn("Voice.moveFromLobby")(function* (channelId: string) {
        return (yield* gather(channelId)).moved;
      });

      const whereIs = Effect.gen(function* () {
        const ps = yield* trio;
        const at = yield* Effect.forEach(ps, voiceChannel, { concurrency: "unbounded" });
        return new Map(ps.map((p, i) => [p, at[i]]));
      }).pipe(
        Effect.catch((e) => Effect.as(Effect.logInfo(`voice lookup failed ${e}`), null)),
        Effect.withSpan("Voice.whereIs"),
      );

      /** The voice channels with a player in them right now (null: couldn't tell). */
      const occupancy = Effect.map(whereIs, (where) => where && new Set([...where.values()].filter((c): c is string => !!c)));

      const openRoom = Effect.fn("Voice.openRoom")(function* (game: string, emoji: string | null, opts: { day?: string; by?: string; move?: boolean } = {}) {
        let room: Room | null = yield* latestRoom(game);
        let reused = !!room;
        if (room) {
          // make sure it still exists (someone may have deleted it by hand); only a real 404 means gone
          const ch = yield* discord.getChannel(room.channel_id).pipe(Effect.catchTag("DiscordNotFound", () => Effect.succeed(null)));
          if (!ch) {
            yield* db.delete(rooms).where(eq(rooms.channel_id, room.channel_id));
            room = null;
            reused = false;
          } else if (room.archived_at) {
            // played this recently: bring the archived room back instead of making a twin
            yield* discord.editChannel(room.channel_id, { parent_id: config.voiceCategoryId });
            yield* placeAfterLobby(room.channel_id);
            yield* db
              .update(rooms)
              .set({ archived_at: null, last_seen: null, created_at: yield* nowSec, pulled: [], ...(opts.day ? { day: opts.day } : {}) })
              .where(eq(rooms.channel_id, room.channel_id));
            room = { ...room, archived_at: null };
          }
        }
        if (!room) {
          const placeholder = `${PENDING}${game.toLowerCase()}`;
          // claim → channel → real id is one piece that's never cut short (architecture §15): the
          // claim is given back only when Discord or the database said no
          const made = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const claim = yield* db
                .insert(rooms)
                .values({ channel_id: placeholder, game, day: opts.day ?? null, created_by: opts.by ?? null, created_at: yield* nowSec })
                .onConflictDoNothing()
                .returning({ id: rooms.channel_id });
              if (!claim.length) return { taken: true } as const;
              const raced = yield* latestRoom(game);
              if (raced) {
                // another click finished creating this game's room between our first look and our claim
                yield* db.delete(rooms).where(eq(rooms.channel_id, placeholder));
                return { raced } as const;
              }
              return yield* Effect.gen(function* () {
                const ch = yield* discord.createChannel({
                  name: `${emoji ?? "🎮"} ${game}`.slice(0, 100),
                  type: 2,
                  parent_id: config.voiceCategoryId,
                  bitrate: 96000,
                });
                yield* db.update(rooms).set({ channel_id: ch.id }).where(eq(rooms.channel_id, placeholder));
                return { channelId: ch.id } as const;
              }).pipe(Effect.tapError(() => db.delete(rooms).where(eq(rooms.channel_id, placeholder))));
            }),
          );
          if ("taken" in made) {
            // someone else is creating this game's room right now: use theirs
            for (let i = 0; i < CLAIM_POLLS && !room; i++) {
              yield* Effect.sleep(CLAIM_POLL);
              room = yield* latestRoom(game);
            }
            if (!room) return yield* new RoomStillCreating({ game });
            reused = true;
          } else if ("raced" in made) {
            room = made.raced;
            reused = true;
          } else {
            yield* placeAfterLobby(made.channelId);
            room = (yield* db.select().from(rooms).where(eq(rooms.channel_id, made.channelId)))[0];
          }
        }
        // a room reused for a game night belongs to that night now (late handling looks it up by day),
        // and its idle clock restarts so it isn't archived out from under the night
        if (reused && opts.day) {
          yield* db.update(rooms).set({ day: opts.day, last_seen: yield* nowSec }).where(eq(rooms.channel_id, room.channel_id));
        }
        // a game night opens its room a few seconds early and moves people on the dot itself
        const moved = opts.move === false ? [] : yield* moveFromLobby(room.channel_id);
        return { channelId: room.channel_id, moved, reused };
      });

      const checkRooms = Effect.fn("Voice.checkRooms")(function* (occupied: ReadonlySet<string>, at?: number) {
        const t = at ?? (yield* nowSec);
        const archived: string[] = [];
        for (const r of yield* openRooms) {
          yield* Effect.gen(function* () {
            if (occupied.has(r.channel_id)) {
              yield* db.update(rooms).set({ last_seen: t }).where(eq(rooms.channel_id, r.channel_id));
              yield* keepEventAlive(r, t);
            } else if (yield* archiveIfIdle(r, t)) {
              archived.push(r.game);
            }
          }).pipe(Effect.catch((e) => Effect.logInfo(`room check failed ${r.channel_id} ${e}`))); // the next check tries again
        }
        const still = (yield* openRooms).filter((r) => !occupied.has(r.channel_id));
        const due = still.map(wrapUpAt);
        return { archived, nextDue: due.length ? Math.min(...due) : null };
      });

      const maintainRooms = Effect.gen(function* () {
        let known = yield* db.select().from(rooms);
        const all = yield* discord.listChannels;
        const done: Record<string, string[]> = {};
        const note = (k: string, v: string) => (done[k] ??= []).push(v);

        // placeholders belong to a creation in progress; a stale one is a crashed creation
        const t0 = yield* nowSec;
        for (const r of known.filter((r) => r.channel_id.startsWith(PENDING) && t0 - r.created_at > PENDING_TTL)) {
          yield* db.delete(rooms).where(eq(rooms.channel_id, r.channel_id));
        }
        known = known.filter((r) => !r.channel_id.startsWith(PENDING));

        // rooms someone deleted by hand: forget them
        const live = new Set(all.map((c) => c.id));
        for (const r of known.filter((r) => !live.has(r.channel_id))) {
          yield* db.delete(rooms).where(eq(rooms.channel_id, r.channel_id));
          note("forgotten", r.game);
        }
        known = known.filter((r) => live.has(r.channel_id));

        yield* tidyArchive(all);
        if (!known.length) return done;
        const t = yield* nowSec;
        // never archive on a guess: if we can't see who's in voice, try again next minute
        const occupied = yield* occupancy;
        if (!occupied) return { ...done, skipped: ["voice lookup failed"] };

        for (const r of known) {
          yield* Effect.gen(function* () {
            if (occupied.has(r.channel_id)) {
              yield* db
                .update(rooms)
                .set({ last_seen: t, archived_at: null, ...(r.archived_at ? { pulled: [] } : {}) })
                .where(eq(rooms.channel_id, r.channel_id));
              if (r.archived_at) {
                yield* discord.editChannel(r.channel_id, { parent_id: config.voiceCategoryId });
                yield* placeAfterLobby(r.channel_id);
                note("revived", r.game);
              } else {
                yield* keepEventAlive(r, t);
              }
              return;
            }
            if (!r.archived_at) {
              if (yield* archiveIfIdle(r, t)) note("archived", r.game);
            } else if (t - r.archived_at >= ARCHIVE_TTL) {
              yield* discord.deleteChannel(r.channel_id).pipe(Effect.catchTag("DiscordNotFound", () => Effect.void)); // already gone is fine
              yield* db.delete(rooms).where(eq(rooms.channel_id, r.channel_id));
              note("deleted", r.game);
            }
          }).pipe(
            Effect.catch((e) =>
              Effect.gen(function* () {
                if (e._tag !== "DiscordNotFound") return yield* alerts.failed("game room upkeep", e, r.channel_id);
                // deleted by hand: forget it
                yield* db.delete(rooms).where(eq(rooms.channel_id, r.channel_id));
                note("forgotten", r.game);
              }),
            ),
          );
        }
        // rooms may have just been deleted: tidy against a fresh channel list (best effort)
        yield* discord.listChannels.pipe(
          Effect.flatMap(tidyArchive),
          Effect.catch((e) => alerts.failed("tidying 🗄️ Recent games", e)),
        );
        return done;
      }).pipe(Effect.withSpan("Voice.maintainRooms"));

      const roomPicker = Effect.gen(function* () {
        const list = yield* games.list(25);
        const active = yield* openRooms;
        return {
          flags: IS_COMPONENTS_V2 | EPHEMERAL,
          components: [
            {
              type: 17,
              accent_color: 0x5865f2,
              components: [
                { type: 10, content: `## 🔊 Open a game room\nPick the game. I'll open its voice room and move everyone in <#${config.lobbyChannelId}> into it.` },
                ...(active.length ? [{ type: 10, content: `-# Open now: ${active.map((r) => `<#${r.channel_id}>`).join(" · ")}` }] : []),
                // a dropdown needs at least one option
                ...(list.length
                  ? [
                      {
                        type: 1,
                        components: [
                          {
                            type: 3,
                            custom_id: "room:open",
                            placeholder: "🎮 Which game?",
                            options: list.slice(0, 25).map((g) => ({ label: g.name, value: g.name, emoji: { name: g.emoji ?? "🎮" } })),
                          },
                        ],
                      },
                    ]
                  : []),
                { type: 1, components: [{ type: 2, style: 2, emoji: { name: "✏️" }, label: "Something else", custom_id: "room:other" }] },
                { type: 10, content: "-# Rooms tidy themselves: 15 min after the last person leaves → 🗄️ Recent games, deleted after 3 days." },
              ],
            },
          ],
        };
      }).pipe(Effect.withSpan("Voice.roomPicker"));

      return Voice.of({
        voiceChannel,
        openRooms,
        openRoom,
        moveFromLobby,
        bringIn: Effect.fn("Voice.bringIn")(function* (channelId: string) {
          return yield* gather(channelId);
        }),
        whereIs,
        checkRooms,
        leftRoom: Effect.fn("Voice.leftRoom")(function* (channelId: string, at?: number) {
          const t = at ?? (yield* nowSec);
          yield* db.update(rooms).set({ last_seen: t }).where(and(eq(rooms.channel_id, channelId), isNull(rooms.archived_at)));
        }),
        maintainRooms,
        roomPicker,
      });
    }),
  );
}
