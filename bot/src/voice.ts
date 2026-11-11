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
import type { Env } from "./env.js";
import { gameNights, rooms } from "./db/index.js";
import { api, EPHEMERAL, IS_COMPONENTS_V2, isNotFound } from "./discord.js";
import { games, players } from "./gamenight.js";
import * as presence from "./presence.js";
import * as channels from "./channels.js";
import * as alerts from "./alerts.js";

export type Room = typeof rooms.$inferSelect;

const EMPTY_GRACE = 15 * 60; // empty this long after the last person leaves → archive + end the event
const EVENT_MARGIN = 10 * 60; // still playing this close to the event's end → push the end back
const EVENT_EXTEND = 30 * 60;
const NEVER_JOINED_GRACE = 60 * 60; // opened but nobody came → archive after this
const ARCHIVE_TTL = 3 * 86400; // archived rooms are deleted after this
const ARCHIVE_NAME = "🗄️ Recent games";
const nowSec = () => Math.floor(Date.now() / 1000);

/** The voice channel a user is in, or null. 404 "Unknown Voice State" means not in voice. */
export async function voiceChannel(env: Env, user: string): Promise<string | null> {
  const live = presence.channelOf(user);
  if (live !== undefined) return live;
  try {
    const s = await api(env, "GET", `/guilds/${env.GUILD_ID}/voice-states/${user}`);
    return s?.channel_id ?? null;
  } catch (e) {
    if (String(e).includes("10065") || String(e).includes(" 404 ")) return null;
    throw e;
  }
}

/** While a room's channel is being created, its row holds a placeholder id ("pending:<game>"). */
const PENDING = "pending:";
const PENDING_TTL = 5 * 60; // a placeholder older than this is a crashed creation: drop it
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const real = not(like(rooms.channel_id, `${PENDING}%`));

/** The game's most recent room, open or archived (an archived one gets brought back). */
const latestRoom = async (env: Env, game: string): Promise<Room | null> =>
  (
    await env.db
      .select()
      .from(rooms)
      .where(and(eq(rooms.game, game), real))
      .orderBy(asc(sql`${rooms.archived_at} IS NOT NULL`), desc(rooms.created_at))
      .limit(1)
  )[0] ?? null;

/** Rooms that are open (not archived, not mid-creation). */
export const openRooms = (env: Env) => env.db.select().from(rooms).where(and(isNull(rooms.archived_at), real));

/**
 * Opens (or reuses) the room for a game and moves everyone sitting in the Lobby into it.
 * Reusing means two "start a room" clicks, or a game night plus a manual room, never make two
 * Phasmophobia rooms: creation is claimed with a placeholder row first, and whoever loses the
 * claim waits for the winner's room instead of making its own.
 */
export async function openRoom(env: Env, game: string, emoji: string | null, opts: { day?: string; by?: string; move?: boolean } = {}) {
  let room = await latestRoom(env, game);
  let reused = !!room;
  if (room) {
    // make sure it still exists (someone may have deleted it by hand); only a real 404 means gone
    const ch = await api(env, "GET", `/channels/${room.channel_id}`).catch((e) => {
      if (isNotFound(e)) return null;
      throw e;
    });
    if (!ch) {
      await env.db.delete(rooms).where(eq(rooms.channel_id, room.channel_id));
      room = null;
      reused = false;
    } else if (room.archived_at) {
      // played this recently: bring the archived room back instead of making a twin
      await api(env, "PATCH", `/channels/${room.channel_id}`, { parent_id: env.VOICE_CATEGORY_ID });
      await placeAfterLobby(env, room.channel_id);
      await env.db
        .update(rooms)
        .set({ archived_at: null, last_seen: null, created_at: nowSec(), pulled: [], ...(opts.day ? { day: opts.day } : {}) })
        .where(eq(rooms.channel_id, room.channel_id));
      room = { ...room, archived_at: null };
    }
  }
  if (!room) {
    const placeholder = `${PENDING}${game.toLowerCase()}`;
    const claim = await env.db
      .insert(rooms)
      .values({ channel_id: placeholder, game, day: opts.day ?? null, created_by: opts.by ?? null, created_at: nowSec() })
      .onConflictDoNothing()
      .returning({ id: rooms.channel_id });
    if (!claim.length) {
      // someone else is creating this game's room right now: use theirs
      // (creating a channel and slotting it under the Lobby can take a few seconds under rate limits)
      for (let i = 0; i < 20 && !room; i++) {
        await sleep(700);
        room = await latestRoom(env, game);
      }
      if (!room) throw new Error(`room for ${game} is still being created`);
      reused = true;
    } else if ((room = await latestRoom(env, game))) {
      // another click finished creating this game's room between our first look and our claim
      await env.db.delete(rooms).where(eq(rooms.channel_id, placeholder));
      reused = true;
    } else {
      try {
        const ch = await api(env, "POST", `/guilds/${env.GUILD_ID}/channels`, {
          name: `${emoji ?? "🎮"} ${game}`.slice(0, 100),
          type: 2,
          parent_id: env.VOICE_CATEGORY_ID,
          bitrate: 96000,
        });
        await env.db.update(rooms).set({ channel_id: ch.id }).where(eq(rooms.channel_id, placeholder));
        await placeAfterLobby(env, ch.id);
        room = (await env.db.select().from(rooms).where(eq(rooms.channel_id, ch.id)))[0];
      } catch (e) {
        await env.db.delete(rooms).where(eq(rooms.channel_id, placeholder));
        throw e;
      }
    }
  }
  // a room reused for a game night belongs to that night now (late handling looks it up by day),
  // and its idle clock restarts so it isn't archived out from under the night
  if (reused && opts.day) {
    await env.db.update(rooms).set({ day: opts.day, last_seen: nowSec() }).where(eq(rooms.channel_id, room.channel_id));
  }
  // a game night opens its room a few seconds early and moves people on the dot itself
  const moved = opts.move === false ? [] : await moveFromLobby(env, room.channel_id);
  return { channelId: room.channel_id, moved, reused };
}

/** Moves every player currently in the Lobby into a room, all at once. Returns who was moved. */
export async function moveFromLobby(env: Env, channelId: string) {
  const moved: string[] = [];
  await Promise.all(
    players(env).map(async (p) => {
      const at = await voiceChannel(env, p).catch((e) => (console.log("voice lookup failed", p, e), null));
      if (at !== env.LOBBY_CHANNEL_ID) return;
      await api(env, "PATCH", `/guilds/${env.GUILD_ID}/members/${p}`, { channel_id: channelId })
        .then(() => moved.push(p))
        .catch((e) => alerts.failed("moving someone into the game room", e, p));
    }),
  );
  if (moved.length) await env.db.update(rooms).set({ last_seen: nowSec() }).where(eq(rooms.channel_id, channelId));
  return players(env).filter((p) => moved.includes(p)); // stable order for the ping
}

/** Each player's voice channel right now (null: couldn't tell, so don't act on it). */
export async function whereIs(env: Env) {
  try {
    const ps = players(env);
    const at = await Promise.all(ps.map((p) => voiceChannel(env, p)));
    return new Map(ps.map((p, i) => [p, at[i]]));
  } catch (e) {
    console.log("voice lookup failed", e);
    return null;
  }
}

/** The voice channels with a player in them right now (null: couldn't tell). */
async function occupancy(env: Env) {
  const where = await whereIs(env);
  return where && new Set([...where.values()].filter(Boolean) as string[]);
}

/** When an open room's wrap-up is due if it stays empty (unix seconds). */
export const wrapUpAt = (r: Room) => (r.last_seen ? r.last_seen + EMPTY_GRACE : r.created_at + NEVER_JOINED_GRACE);

/** Empty past its grace? Then move the room to 🗄️ Recent games and end its night's event. */
async function archiveIfIdle(env: Env, r: Room, t: number) {
  const idleSince = r.last_seen ?? r.created_at;
  const grace = r.last_seen ? EMPTY_GRACE : NEVER_JOINED_GRACE;
  if (t - idleSince < grace) return false;
  const cat = await archiveCategory(env, true);
  await api(env, "PATCH", `/channels/${r.channel_id}`, { parent_id: cat });
  await env.db.update(rooms).set({ archived_at: t }).where(and(eq(rooms.channel_id, r.channel_id), isNull(rooms.archived_at)));
  // the session's over: end its Discord event if it went live
  if (r.day) {
    const [n] = await env.db
      .select({ event_id: gameNights.event_id, event_end: gameNights.event_end })
      .from(gameNights)
      .where(and(eq(gameNights.day, r.day), eq(gameNights.stage, "set")));
    if (n?.event_id && n.event_end) {
      await api(env, "PATCH", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`, { status: 3 }).catch(() => {});
      await eventOver(env, r.day);
    }
  }
  return true;
}

/** Discord's answer when an event was ended (by us, by hand, or by Discord) or deleted. */
const isFinished = (e: unknown) => isNotFound(e) || String(e).includes("INVALID_END_BY_STATUS");

/** An ended event can't come back: forget its end, so a revived room doesn't try to push it back. */
const eventOver = (env: Env, day: string) => env.db.update(gameNights).set({ event_end: null }).where(eq(gameNights.day, day));

/** Still playing near the event's planned end: push it back, so Discord doesn't end it under us. */
async function keepEventAlive(env: Env, r: Room, t: number) {
  if (!r.day) return;
  const [n] = await env.db
    .select({ event_id: gameNights.event_id, event_end: gameNights.event_end })
    .from(gameNights)
    .where(and(eq(gameNights.day, r.day), eq(gameNights.stage, "set"), eq(gameNights.reminded, true)));
  if (!n?.event_id || !n.event_end || n.event_end - t > EVENT_MARGIN) return;
  const end = t + EVENT_EXTEND;
  await api(env, "PATCH", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`, { scheduled_end_time: new Date(end * 1000).toISOString() })
    .then(() => env.db.update(gameNights).set({ event_end: end }).where(eq(gameNights.day, r.day!)))
    .catch(async (e) => {
      if (isFinished(e)) await eventOver(env, r.day!);
      else alerts.failed("extending the Discord event", e);
    });
}

/**
 * Re-check open rooms against who's where: busy rooms are marked seen (and their event kept
 * alive), empty ones past their grace are wrapped up. Returns what was archived and when the next
 * empty room falls due (unix seconds, or null), so the caller can wake up right then.
 */
export async function checkRooms(env: Env, occupied: Set<string>, t = nowSec()) {
  const archived: string[] = [];
  for (const r of await openRooms(env)) {
    try {
      if (occupied.has(r.channel_id)) {
        await env.db.update(rooms).set({ last_seen: t }).where(eq(rooms.channel_id, r.channel_id));
        await keepEventAlive(env, r, t);
      } else if (await archiveIfIdle(env, r, t)) {
        archived.push(r.game);
      }
    } catch (e) {
      console.log("room check failed", r.channel_id, e); // the next check tries again
    }
  }
  const still = (await openRooms(env)).filter((r) => !occupied.has(r.channel_id));
  const due = still.map(wrapUpAt);
  return { archived, nextDue: due.length ? Math.min(...due) : null };
}

/** Someone just left a room: its idle clock starts now, not at the last check. */
export async function leftRoom(env: Env, channelId: string, t = nowSec()) {
  await env.db.update(rooms).set({ last_seen: t }).where(and(eq(rooms.channel_id, channelId), isNull(rooms.archived_at)));
}

/** New rooms go right under the Lobby, newest first. */
async function placeAfterLobby(env: Env, channelId: string) {
  const all = await channels.list(env);
  const voice = all.filter((c) => c.parent_id === env.VOICE_CATEGORY_ID && c.type === 2).sort((a, b) => a.position - b.position);
  const rest = voice.filter((c) => c.id !== env.LOBBY_CHANNEL_ID && c.id !== channelId);
  const order = [env.LOBBY_CHANNEL_ID, channelId, ...rest.map((c) => c.id)];
  await api(env, "PATCH", `/guilds/${env.GUILD_ID}/channels`, order.map((id, position) => ({ id, position })));
}

async function archiveCategory(env: Env, create: boolean): Promise<string | null> {
  const all = await channels.list(env);
  const found = all.find((c) => c.type === 4 && c.name === ARCHIVE_NAME);
  if (found || !create) return found?.id ?? null;
  const cat = await api(env, "POST", `/guilds/${env.GUILD_ID}/channels`, { name: ARCHIVE_NAME, type: 4, position: 99 });
  return cat.id;
}

/**
 * Every minute: who's in which room? Busy rooms stay (or come back from the archive), rooms empty past
 * their grace move to 🗄️ Recent games, and archived rooms past their TTL are deleted. The
 * archive category disappears when it's empty.
 */
export async function maintainRooms(env: Env) {
  let known = await env.db.select().from(rooms);
  const all = await channels.list(env);
  const done: Record<string, string[]> = {};
  const note = (k: string, v: string) => (done[k] ??= []).push(v);

  // placeholders belong to a creation in progress; a stale one is a crashed creation
  const t0 = nowSec();
  for (const r of known.filter((r) => r.channel_id.startsWith(PENDING) && t0 - r.created_at > PENDING_TTL)) {
    await env.db.delete(rooms).where(eq(rooms.channel_id, r.channel_id));
  }
  known = known.filter((r) => !r.channel_id.startsWith(PENDING));

  // rooms someone deleted by hand: forget them
  const live = new Set(all.map((c) => c.id));
  for (const r of known.filter((r) => !live.has(r.channel_id))) {
    await env.db.delete(rooms).where(eq(rooms.channel_id, r.channel_id));
    note("forgotten", r.game);
  }
  known = known.filter((r) => live.has(r.channel_id));

  await tidyArchive(env, all);
  if (!known.length) return done;
  const t = nowSec();
  // never archive on a guess: if we can't see who's in voice, try again next minute
  const occupied = await occupancy(env);
  if (!occupied) return { ...done, skipped: ["voice lookup failed"] };

  for (const r of known) {
    const busy = occupied.has(r.channel_id);
    try {
      if (busy) {
        await env.db
          .update(rooms)
          .set({ last_seen: t, archived_at: null, ...(r.archived_at ? { pulled: [] } : {}) })
          .where(eq(rooms.channel_id, r.channel_id));
        if (r.archived_at) {
          await api(env, "PATCH", `/channels/${r.channel_id}`, { parent_id: env.VOICE_CATEGORY_ID });
          await placeAfterLobby(env, r.channel_id);
          note("revived", r.game);
        } else {
          await keepEventAlive(env, r, t);
        }
        continue;
      }
      if (!r.archived_at) {
        if (await archiveIfIdle(env, r, t)) note("archived", r.game);
      } else if (t - r.archived_at >= ARCHIVE_TTL) {
        await api(env, "DELETE", `/channels/${r.channel_id}`).catch((e) => {
          if (!String(e).includes(" 404 ")) throw e; // already gone is fine
        });
        await env.db.delete(rooms).where(eq(rooms.channel_id, r.channel_id));
        note("deleted", r.game);
      }
    } catch (e) {
      if (String(e).includes(" 404 ")) {
        // deleted by hand: forget it
        await env.db.delete(rooms).where(eq(rooms.channel_id, r.channel_id));
        note("forgotten", r.game);
      } else {
        alerts.failed("game room upkeep", e, r.channel_id);
      }
    }
  }
  // rooms may have just been deleted: tidy against a fresh channel list (best effort)
  await channels
    .list(env)
    .then((fresh) => tidyArchive(env, fresh))
    .catch((e) => alerts.failed("tidying 🗄️ Recent games", e));
  return done;
}

/** Drop the 🗄️ Recent games category once nothing is left in it. */
async function tidyArchive(env: Env, all: channels.Channel[]) {
  const cat = all.find((c) => c.type === 4 && c.name === ARCHIVE_NAME);
  if (cat && !all.some((c) => c.parent_id === cat.id)) await api(env, "DELETE", `/channels/${cat.id}`).catch(() => {});
}

// ---------------------------------------------------------------- UI

/** 🔊 Game room: pick a game, get a room, and everyone in the Lobby comes with you. */
export async function roomPicker(env: Env) {
  const list = await games(env);
  const active = await openRooms(env);
  return {
    flags: IS_COMPONENTS_V2 | EPHEMERAL,
    components: [
      {
        type: 17,
        accent_color: 0x5865f2,
        components: [
          { type: 10, content: `## 🔊 Open a game room\nPick the game. I'll open its voice room and move everyone in <#${env.LOBBY_CHANNEL_ID}> into it.` },
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
}

export const otherRoomModal = () => ({
  custom_id: "room:other",
  title: "Open a game room",
  components: [{ type: 1, components: [{ type: 4, custom_id: "value", style: 1, label: "Game or room name", placeholder: "Lethal Company", max_length: 60, required: true }] }],
});

/** The result line after opening a room. */
export function roomResult(env: Env, r: { channelId: string; moved: string[]; reused: boolean }) {
  const moved = r.moved.length ? ` Moved ${r.moved.map((u) => `<@${u}>`).join(" ")} from the Lobby.` : ` Nobody was in <#${env.LOBBY_CHANNEL_ID}> to move; hop in yourself.`;
  return `${r.reused ? "🔊 That room is already open:" : "🔊 Room's up:"} <#${r.channelId}>.${moved}`;
}
