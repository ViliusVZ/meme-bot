// Dynamic game rooms. Hang out in the 🛋️ Lobby; when a game starts (a locked-in game night, or
// 🔊 Game room on the panel) the bot opens a voice room for that game and moves everyone in the
// Lobby into it. Once a room has sat empty for a while it moves to 🗄️ Recent games, and after a
// few days it's deleted. Someone rejoining an archived room brings it back.
//
// The bot has no gateway connection, so occupancy is checked over REST, per player: once a minute
// while anyone is in voice (watchVoice, inside the 5-minute tick), so a room and its night's event
// wrap up 15 minutes after the last person leaves. Rooms are only for the trio, which keeps that
// to three calls per check.
import type { Env } from "./index";
import { api, EPHEMERAL, IS_COMPONENTS_V2, isNotFound } from "./discord";
import { games, players } from "./gamenight";
import * as activity from "./activity";

export interface Room {
  channel_id: string;
  game: string;
  day: string | null; // the game night that opened it, if any
  created_by: string | null;
  created_at: number;
  last_seen: number | null; // last tick someone was in it
  archived_at: number | null;
}

const EMPTY_GRACE = 15 * 60; // empty this long after the last person leaves → archive + end the event
const EVENT_MARGIN = 10 * 60; // still playing this close to the event's end → push the end back
const EVENT_EXTEND = 30 * 60;
const NEVER_JOINED_GRACE = 60 * 60; // opened but nobody came → archive after this
const ARCHIVE_TTL = 3 * 86400; // archived rooms are deleted after this
const ARCHIVE_NAME = "🗄️ Recent games";
const nowSec = () => Math.floor(Date.now() / 1000);

/** The voice channel a user is in, or null. 404 "Unknown Voice State" means not in voice. */
export async function voiceChannel(env: Env, user: string): Promise<string | null> {
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

/** The game's most recent room, open or archived (an archived one gets brought back). */
const latestRoom = (env: Env, game: string) =>
  env.DB.prepare(
    `SELECT * FROM rooms WHERE game = ? COLLATE NOCASE AND channel_id NOT LIKE '${PENDING}%'
     ORDER BY archived_at IS NOT NULL, created_at DESC LIMIT 1`,
  )
    .bind(game)
    .first<Room>();

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
      await env.DB.prepare("DELETE FROM rooms WHERE channel_id = ?").bind(room.channel_id).run();
      room = null;
      reused = false;
    } else if (room.archived_at) {
      // played this recently: bring the archived room back instead of making a twin
      await api(env, "PATCH", `/channels/${room.channel_id}`, { parent_id: env.VOICE_CATEGORY_ID });
      await placeAfterLobby(env, room.channel_id);
      await env.DB.prepare("UPDATE rooms SET archived_at = NULL, last_seen = NULL, created_at = ?, day = COALESCE(?, day) WHERE channel_id = ?")
        .bind(nowSec(), opts.day ?? null, room.channel_id)
        .run();
      room = { ...room, archived_at: null };
    }
  }
  if (!room) {
    const placeholder = `${PENDING}${game.toLowerCase()}`;
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO rooms (channel_id, game, day, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(placeholder, game, opts.day ?? null, opts.by ?? null, nowSec())
      .run();
    if (!claim.meta.changes) {
      // someone else is creating this game's room right now: use theirs
      for (let i = 0; i < 6 && !room; i++) {
        await sleep(700);
        room = await latestRoom(env, game);
      }
      if (!room) throw new Error(`room for ${game} is still being created`);
      reused = true;
    } else {
      try {
        const ch = await api(env, "POST", `/guilds/${env.GUILD_ID}/channels`, {
          name: `${emoji ?? "🎮"} ${game}`.slice(0, 100),
          type: 2,
          parent_id: env.VOICE_CATEGORY_ID,
          bitrate: 96000,
        });
        await env.DB.prepare("UPDATE rooms SET channel_id = ? WHERE channel_id = ?").bind(ch.id, placeholder).run();
        await placeAfterLobby(env, ch.id);
        room = (await env.DB.prepare("SELECT * FROM rooms WHERE channel_id = ?").bind(ch.id).first<Room>())!;
      } catch (e) {
        await env.DB.prepare("DELETE FROM rooms WHERE channel_id = ?").bind(placeholder).run();
        throw e;
      }
    }
  }
  // a room reused for a game night belongs to that night now (late handling looks it up by day),
  // and its idle clock restarts so it isn't archived out from under the night
  if (reused && opts.day) {
    await env.DB.prepare("UPDATE rooms SET day = ?, last_seen = ? WHERE channel_id = ?").bind(opts.day, nowSec(), room.channel_id).run();
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
        .catch((e) => console.log("move failed", p, e));
    }),
  );
  if (moved.length) await env.DB.prepare("UPDATE rooms SET last_seen = ? WHERE channel_id = ?").bind(nowSec(), channelId).run();
  return players(env).filter((p) => moved.includes(p)); // stable order for the ping
}

/** Each player's voice channel right now (null: couldn't tell, so don't act on it). */
async function whereIs(env: Env) {
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

/** Empty past its grace? Then move the room to 🗄️ Recent games and end its night's event. */
async function archiveIfIdle(env: Env, r: Room, t: number) {
  const idleSince = r.last_seen ?? r.created_at;
  const grace = r.last_seen ? EMPTY_GRACE : NEVER_JOINED_GRACE;
  if (t - idleSince < grace) return false;
  const cat = await archiveCategory(env, true);
  await api(env, "PATCH", `/channels/${r.channel_id}`, { parent_id: cat });
  await env.DB.prepare("UPDATE rooms SET archived_at = ? WHERE channel_id = ? AND archived_at IS NULL").bind(t, r.channel_id).run();
  // the session's over: end its Discord event if it went live
  if (r.day) {
    const n = await env.DB.prepare("SELECT event_id FROM game_nights WHERE day = ? AND stage = 'set'").bind(r.day).first<{ event_id: string | null }>();
    if (n?.event_id) await api(env, "PATCH", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`, { status: 3 }).catch(() => {});
  }
  return true;
}

/** Still playing near the event's planned end: push it back, so Discord doesn't end it under us. */
async function keepEventAlive(env: Env, r: Room, t: number) {
  if (!r.day) return;
  const n = await env.DB.prepare("SELECT event_id, event_end FROM game_nights WHERE day = ? AND stage = 'set' AND reminded = 1")
    .bind(r.day)
    .first<{ event_id: string | null; event_end: number | null }>();
  if (!n?.event_id || !n.event_end || n.event_end - t > EVENT_MARGIN) return;
  const end = t + EVENT_EXTEND;
  await api(env, "PATCH", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`, { scheduled_end_time: new Date(end * 1000).toISOString() })
    .then(() => env.DB.prepare("UPDATE game_nights SET event_end = ? WHERE day = ?").bind(end, r.day).run())
    .catch((e) => console.log("event extend failed", e));
}

/**
 * Inside a tick, until `until` (unix seconds): check voice now, then every minute while anyone is
 * in voice. Each check records voice time (activity.ts) and re-checks open rooms. With nobody in
 * voice there's nothing to measure: the next tick (≤ 5 min) spots the next join, and an empty
 * room is only looked at again when its 15 minutes are up. So call lengths and the wrap-up are
 * accurate to the minute, and quiet hours cost one check per tick.
 */
export async function watchVoice(env: Env, until: number) {
  const done: string[] = [];
  let next = nowSec();
  while (next <= until) {
    await sleep(Math.max(0, next * 1000 - Date.now()));
    const where = await whereIs(env);
    if (!where) {
      next = nowSec() + 60; // couldn't tell: try again in a minute
      continue;
    }
    const t = nowSec();
    await activity.track(env, where, t).catch((e) => console.log("voice tracking failed", e));
    const occupied = new Set([...where.values()].filter(Boolean) as string[]);
    const open = (await env.DB.prepare("SELECT * FROM rooms WHERE archived_at IS NULL AND channel_id NOT LIKE ?").bind(`${PENDING}%`).all<Room>()).results;
    for (const r of open) {
      try {
        if (occupied.has(r.channel_id)) {
          await env.DB.prepare("UPDATE rooms SET last_seen = ? WHERE channel_id = ?").bind(t, r.channel_id).run();
          await keepEventAlive(env, r, t);
        } else if (await archiveIfIdle(env, r, t)) {
          done.push(r.game);
        }
      } catch (e) {
        console.log("room watch failed", r.channel_id, e); // the next minute (or tick) tries again
      }
    }
    if (occupied.size) {
      next = t + 60;
      continue;
    }
    // nobody in voice: only an empty room's wrap-up is worth waiting for
    const still = (await env.DB.prepare("SELECT * FROM rooms WHERE archived_at IS NULL AND channel_id NOT LIKE ?").bind(`${PENDING}%`).all<Room>()).results;
    const due = still.map((r) => (r.last_seen ? r.last_seen + EMPTY_GRACE : r.created_at + NEVER_JOINED_GRACE));
    next = due.length ? Math.max(t + 1, Math.min(...due)) : Infinity;
  }
  return done;
}

/** New rooms go right under the Lobby, newest first. */
async function placeAfterLobby(env: Env, channelId: string) {
  const all = (await api(env, "GET", `/guilds/${env.GUILD_ID}/channels`)) as { id: string; parent_id?: string; position: number; type: number }[];
  const voice = all.filter((c) => c.parent_id === env.VOICE_CATEGORY_ID && c.type === 2).sort((a, b) => a.position - b.position);
  const rest = voice.filter((c) => c.id !== env.LOBBY_CHANNEL_ID && c.id !== channelId);
  const order = [env.LOBBY_CHANNEL_ID, channelId, ...rest.map((c) => c.id)];
  await api(env, "PATCH", `/guilds/${env.GUILD_ID}/channels`, order.map((id, position) => ({ id, position })));
}

async function archiveCategory(env: Env, create: boolean): Promise<string | null> {
  const all = (await api(env, "GET", `/guilds/${env.GUILD_ID}/channels`)) as { id: string; name: string; type: number; position: number }[];
  const found = all.find((c) => c.type === 4 && c.name === ARCHIVE_NAME);
  if (found || !create) return found?.id ?? null;
  const cat = await api(env, "POST", `/guilds/${env.GUILD_ID}/channels`, { name: ARCHIVE_NAME, type: 4, position: 99 });
  return cat.id;
}

/**
 * Tick: who's in which room? Busy rooms stay (or come back from the archive), rooms empty past
 * their grace move to 🗄️ Recent games, and archived rooms past their TTL are deleted. The
 * archive category disappears when it's empty.
 */
export async function maintainRooms(env: Env) {
  let rooms = (await env.DB.prepare("SELECT * FROM rooms").all<Room>()).results;
  const all = (await api(env, "GET", `/guilds/${env.GUILD_ID}/channels`)) as { id: string; name: string; type: number; parent_id?: string }[];
  const done: Record<string, string[]> = {};
  const note = (k: string, v: string) => (done[k] ??= []).push(v);

  // placeholders belong to a creation in progress; a stale one is a crashed creation
  const t0 = nowSec();
  for (const r of rooms.filter((r) => r.channel_id.startsWith(PENDING) && t0 - r.created_at > PENDING_TTL)) {
    await env.DB.prepare("DELETE FROM rooms WHERE channel_id = ?").bind(r.channel_id).run();
  }
  rooms = rooms.filter((r) => !r.channel_id.startsWith(PENDING));

  // rooms someone deleted by hand: forget them
  const live = new Set(all.map((c) => c.id));
  for (const r of rooms.filter((r) => !live.has(r.channel_id))) {
    await env.DB.prepare("DELETE FROM rooms WHERE channel_id = ?").bind(r.channel_id).run();
    note("forgotten", r.game);
  }
  rooms = rooms.filter((r) => live.has(r.channel_id));

  await tidyArchive(env, all);
  if (!rooms.length) return done;
  const t = nowSec();
  // never archive on a guess: if we can't see who's in voice, try again next tick
  const occupied = await occupancy(env);
  if (!occupied) return { ...done, skipped: ["voice lookup failed"] };

  for (const r of rooms) {
    const busy = occupied.has(r.channel_id);
    try {
      if (busy) {
        await env.DB.prepare("UPDATE rooms SET last_seen = ?, archived_at = NULL WHERE channel_id = ?").bind(t, r.channel_id).run();
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
        await env.DB.prepare("DELETE FROM rooms WHERE channel_id = ?").bind(r.channel_id).run();
        note("deleted", r.game);
      }
    } catch (e) {
      if (String(e).includes(" 404 ")) {
        // deleted by hand: forget it
        await env.DB.prepare("DELETE FROM rooms WHERE channel_id = ?").bind(r.channel_id).run();
        note("forgotten", r.game);
      } else {
        console.log("room maintenance failed", r.channel_id, e);
      }
    }
  }
  // rooms may have just been deleted: tidy against a fresh channel list (best effort)
  await api(env, "GET", `/guilds/${env.GUILD_ID}/channels`)
    .then((fresh) => tidyArchive(env, fresh))
    .catch((e) => console.log("archive tidy failed", e));
  return done;
}

/** Drop the 🗄️ Recent games category once nothing is left in it. */
async function tidyArchive(env: Env, all: { id: string; name: string; type: number; parent_id?: string }[]) {
  const cat = all.find((c) => c.type === 4 && c.name === ARCHIVE_NAME);
  if (cat && !all.some((c) => c.parent_id === cat.id)) await api(env, "DELETE", `/channels/${cat.id}`).catch(() => {});
}

// ---------------------------------------------------------------- UI

/** 🔊 Game room: pick a game, get a room, and everyone in the Lobby comes with you. */
export async function roomPicker(env: Env) {
  const list = await games(env);
  const active = (await env.DB.prepare("SELECT game, channel_id FROM rooms WHERE archived_at IS NULL AND channel_id NOT LIKE 'pending:%'").all<{ game: string; channel_id: string }>()).results;
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
