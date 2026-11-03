// Dynamic game rooms. Hang out in the 🛋️ Lobby; when a game starts (a locked-in game night, or
// 🔊 Game room on the panel) the bot opens a voice room for that game and moves everyone in the
// Lobby into it. Once a room has sat empty for a while it moves to 🗄️ Recent games, and after a
// few days it's deleted. Someone rejoining an archived room brings it back.
//
// The bot has no gateway connection, so occupancy is checked over REST, per player, on the
// 15-minute tick. Rooms are only for the trio, which keeps that to three calls per room.
import type { Env } from "./index";
import { api, EPHEMERAL, IS_COMPONENTS_V2 } from "./discord";
import { games, players } from "./gamenight";

export interface Room {
  channel_id: string;
  game: string;
  day: string | null; // the game night that opened it, if any
  created_by: string | null;
  created_at: number;
  last_seen: number | null; // last tick someone was in it
  archived_at: number | null;
}

const EMPTY_GRACE = 20 * 60; // empty this long after people leave → archive
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

const activeRoom = (env: Env, game: string) =>
  env.DB.prepare("SELECT * FROM rooms WHERE game = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(game).first<Room>();

/**
 * Opens (or reuses) the room for a game and moves everyone sitting in the Lobby into it.
 * Reusing means two "start a room" clicks, or a game night plus a manual room, never make two
 * Phasmophobia rooms.
 */
export async function openRoom(env: Env, game: string, emoji: string | null, opts: { day?: string; by?: string } = {}) {
  let room = await activeRoom(env, game);
  let reused = !!room;
  if (room) {
    // make sure it still exists (someone may have deleted it by hand)
    const ch = await api(env, "GET", `/channels/${room.channel_id}`).catch(() => null);
    if (!ch) {
      await env.DB.prepare("DELETE FROM rooms WHERE channel_id = ?").bind(room.channel_id).run();
      room = null;
      reused = false;
    }
  }
  if (!room) {
    const ch = await api(env, "POST", `/guilds/${env.GUILD_ID}/channels`, {
      name: `${emoji ?? "🎮"} ${game}`.slice(0, 100),
      type: 2,
      parent_id: env.VOICE_CATEGORY_ID,
      bitrate: 96000,
    });
    await placeAfterLobby(env, ch.id);
    await env.DB.prepare("INSERT INTO rooms (channel_id, game, day, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(ch.id, game, opts.day ?? null, opts.by ?? null, nowSec())
      .run();
    room = (await env.DB.prepare("SELECT * FROM rooms WHERE channel_id = ?").bind(ch.id).first<Room>())!;
  }
  const moved = await moveFromLobby(env, room.channel_id);
  if (moved.length) await env.DB.prepare("UPDATE rooms SET last_seen = ? WHERE channel_id = ?").bind(nowSec(), room.channel_id).run();
  return { channelId: room.channel_id, moved, reused };
}

/** Moves every player currently in the Lobby into a room. Returns who was moved. */
async function moveFromLobby(env: Env, channelId: string) {
  const moved: string[] = [];
  for (const p of players(env)) {
    const at = await voiceChannel(env, p).catch((e) => (console.log("voice lookup failed", p, e), null));
    if (at !== env.LOBBY_CHANNEL_ID) continue;
    await api(env, "PATCH", `/guilds/${env.GUILD_ID}/members/${p}`, { channel_id: channelId })
      .then(() => moved.push(p))
      .catch((e) => console.log("move failed", p, e));
  }
  return moved;
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
  const where = new Map<string, string | null>();
  try {
    for (const p of players(env)) where.set(p, await voiceChannel(env, p));
  } catch (e) {
    // never archive on a guess: if we can't see who's in voice, try again next tick
    console.log("voice lookup failed, skipping room maintenance", e);
    return { ...done, skipped: ["voice lookup failed"] };
  }
  const occupied = new Set([...where.values()].filter(Boolean) as string[]);

  for (const r of rooms) {
    const busy = occupied.has(r.channel_id);
    try {
      if (busy) {
        await env.DB.prepare("UPDATE rooms SET last_seen = ?, archived_at = NULL WHERE channel_id = ?").bind(t, r.channel_id).run();
        if (r.archived_at) {
          await api(env, "PATCH", `/channels/${r.channel_id}`, { parent_id: env.VOICE_CATEGORY_ID });
          await placeAfterLobby(env, r.channel_id);
          note("revived", r.game);
        }
        continue;
      }
      if (!r.archived_at) {
        const idleSince = r.last_seen ?? r.created_at;
        const grace = r.last_seen ? EMPTY_GRACE : NEVER_JOINED_GRACE;
        if (t - idleSince < grace) continue;
        const cat = await archiveCategory(env, true);
        await api(env, "PATCH", `/channels/${r.channel_id}`, { parent_id: cat });
        await env.DB.prepare("UPDATE rooms SET archived_at = ? WHERE channel_id = ?").bind(t, r.channel_id).run();
        note("archived", r.game);
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
  const active = (await env.DB.prepare("SELECT game, channel_id FROM rooms WHERE archived_at IS NULL").all<{ game: string; channel_id: string }>()).results;
  return {
    flags: IS_COMPONENTS_V2 | EPHEMERAL,
    components: [
      {
        type: 17,
        accent_color: 0x5865f2,
        components: [
          { type: 10, content: `## 🔊 Open a game room\nPick the game. I'll open its voice room and move everyone in <#${env.LOBBY_CHANNEL_ID}> into it.` },
          ...(active.length ? [{ type: 10, content: `-# Open now: ${active.map((r) => `<#${r.channel_id}>`).join(" · ")}` }] : []),
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: "room:open",
                placeholder: "🎮 Which game?",
                options: list.slice(0, 24).map((g) => ({ label: g.name, value: g.name, emoji: { name: g.emoji ?? "🎮" } })),
              },
            ],
          },
          { type: 1, components: [{ type: 2, style: 2, emoji: { name: "✏️" }, label: "Something else", custom_id: "room:other" }] },
          { type: 10, content: "-# Rooms tidy themselves: empty for ~20 min → 🗄️ Recent games, deleted after 3 days." },
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
