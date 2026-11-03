// Running late. Once a locked-in night has started (its room is open), every tick checks where
// each player is:
//   in the room      → they're here (a late slip, if any, becomes "✅ made it, 12 min late 🐢")
//   in the Lobby     → pulled into the room, once (if they wander back to the Lobby later, we leave
//                       them be)
//   anywhere else    → 10 min after start they get one late slip: "Running late?" with 🏃 ETA
//                       buttons and 😴 can't make it
// "Can't make it" after the start only marks that person absent; the others are already playing.
import type { Env } from "./index";
import { api, IS_COMPONENTS_V2 } from "./discord";
import { players } from "./gamenight";
import * as voice from "./voice";

export interface Attendance {
  day: string;
  user_id: string;
  state: "arrived" | "late" | "eta" | "absent";
  eta: number | null;
  message_id: string | null; // their late slip, if one was posted
  arrived_at: number | null;
}

const LATE_AFTER = 10 * 60; // grace before a late slip
const WATCH_FOR = 3 * 3600; // stop watching this long after the start
const nowSec = () => Math.floor(Date.now() / 1000);
const mention = (id: string) => `<@${id}>`;
const pings = (env: Env, users: string[]) => (env.QUIET ? { parse: [] } : { users });

export const get = (env: Env, day: string, user: string) =>
  env.DB.prepare("SELECT * FROM night_attendance WHERE day = ? AND user_id = ?").bind(day, user).first<Attendance>();

async function put(env: Env, day: string, user: string, set: Partial<Omit<Attendance, "day" | "user_id">>) {
  const cur = await get(env, day, user);
  const row = { state: "arrived", eta: null, message_id: null, arrived_at: null, ...cur, ...set } as Attendance;
  await env.DB.prepare(
    `INSERT INTO night_attendance (day, user_id, state, eta, message_id, arrived_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, user_id) DO UPDATE SET state = excluded.state, eta = excluded.eta, message_id = excluded.message_id, arrived_at = excluded.arrived_at`,
  )
    .bind(day, user, row.state, row.eta, row.message_id, row.arrived_at)
    .run();
  return row;
}

/** People the start-time reminder already moved count as here (and won't be moved again). */
export async function markArrived(env: Env, day: string, users: string[]) {
  for (const u of users) await put(env, day, u, { state: "arrived", arrived_at: nowSec() });
}

/** Card "Can't make it" after the start: mark absent (and update their slip if they had one). */
export async function markAbsent(env: Env, day: string, user: string) {
  const row = await put(env, day, user, { state: "absent" });
  if (row.message_id) {
    await api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${row.message_id}`, await render(env, day, user)).catch(() => {});
  }
}

type Night = { day: string; game: string | null; start_at: number | null; message_id: string | null };

/** Tick: handle everyone for every night that's under way. */
export async function watch(env: Env) {
  const t = nowSec();
  const nights = (
    await env.DB.prepare("SELECT day, game, start_at, message_id FROM game_nights WHERE stage = 'set' AND reminded = 1 AND start_at <= ? AND start_at > ?")
      .bind(t, t - WATCH_FOR)
      .all<Night>()
  ).results;
  const done: Record<string, string[]> = {};
  const note = (k: string, v: string) => (done[k] ??= []).push(v);

  for (const n of nights) {
    const room = await env.DB.prepare("SELECT channel_id FROM rooms WHERE day = ? AND archived_at IS NULL AND channel_id NOT LIKE 'pending:%'").bind(n.day).first<{ channel_id: string }>();
    if (!room) continue;
    for (const p of players(env)) {
      // one player's trouble (a failed move or post) must not hold up the others
      try {
        await watchPlayer(env, n, room.channel_id, p, t, note);
      } catch (e) {
        console.log("late: player failed", n.day, p, e);
      }
    }
  }
  return done;
}

async function watchPlayer(env: Env, n: Night, roomId: string, p: string, t: number, note: (k: string, v: string) => void) {
  let at: string | null;
  try {
    at = await voice.voiceChannel(env, p);
  } catch (e) {
    console.log("late: voice lookup failed", p, e);
    return; // never act on a guess
  }
  const row = await get(env, n.day, p);
  const updateSlip = async (r: Attendance) => {
    if (!r.message_id) return;
    await api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${r.message_id}`, slip(env, n.day, p, r, n.game!, n.start_at!)).catch(() => {});
  };

  if (at === roomId) {
    // here (even if they'd said they couldn't make it: plans change, nice surprise)
    if (row?.state === "arrived") return;
    await updateSlip(await put(env, n.day, p, { state: "arrived", arrived_at: t }));
    note("arrived", p);
    return;
  }
  if (row?.state === "absent") return;

  if (at === env.LOBBY_CHANNEL_ID && row?.state !== "arrived") {
    // late arrival waiting in the Lobby: bring them in (once; arrived means we never move again)
    await api(env, "PATCH", `/guilds/${env.GUILD_ID}/members/${p}`, { channel_id: roomId });
    await updateSlip(await put(env, n.day, p, { state: "arrived", arrived_at: t }));
    note("moved", p);
    return;
  }

  if (!row && t - n.start_at! >= LATE_AFTER) {
    // not here, not in the Lobby, no word from them: one late slip. Claim the row first so two
    // overlapping ticks can't both post one.
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO night_attendance (day, user_id, state) VALUES (?, ?, 'late')").bind(n.day, p).run();
    if (!claim.meta.changes) return;
    const fresh: Attendance = { day: n.day, user_id: p, state: "late", eta: null, message_id: null, arrived_at: null };
    try {
      const msg = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
        ...slip(env, n.day, p, fresh, n.game!, n.start_at!, roomId),
        allowed_mentions: pings(env, [p]),
        message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
      });
      await env.DB.prepare("UPDATE night_attendance SET message_id = ? WHERE day = ? AND user_id = ?").bind(msg.id, n.day, p).run();
      note("slipped", p);
    } catch (e) {
      // release the claim so the next tick can try again
      await env.DB.prepare("DELETE FROM night_attendance WHERE day = ? AND user_id = ? AND message_id IS NULL AND state = 'late'").bind(n.day, p).run();
      throw e;
    }
  }
}

/** A late slip button: late:<day>:<user>:<5|15|30|out>. Only the late person can answer it. */
export async function act(env: Env, day: string, owner: string, clicker: string, choice: string) {
  if (clicker !== owner) return { notice: "That's not your late slip 😄" };
  const row = await get(env, day, owner);
  if (!row) return { notice: "That slip has expired 🫥" };
  if (row.state === "arrived") return { notice: "You're already here 👋" };
  if (choice === "out") await put(env, day, owner, { state: "absent" });
  else {
    const mins = Number(choice);
    if (![5, 15, 30].includes(mins)) return { notice: "🤷" };
    await put(env, day, owner, { state: "eta", eta: nowSec() + mins * 60 });
  }
  return { notice: undefined };
}

/** Renders a late slip in its current state. */
export async function render(env: Env, day: string, user: string) {
  const row = (await get(env, day, user))!;
  const n = (await env.DB.prepare("SELECT game, start_at FROM game_nights WHERE day = ?").bind(day).first<{ game: string; start_at: number }>())!;
  const room = await env.DB.prepare("SELECT channel_id FROM rooms WHERE day = ? AND channel_id NOT LIKE 'pending:%'").bind(day).first<{ channel_id: string }>();
  return slip(env, day, user, row, n.game, n.start_at, room?.channel_id);
}

function slip(env: Env, day: string, user: string, row: Attendance, game: string, startAt?: number, roomId?: string) {
  const where = roomId ? ` in <#${roomId}>` : "";
  const buttons = [
    { type: 2, style: 1, emoji: { name: "🏃" }, label: "5 min", custom_id: `late:${day}:${user}:5` },
    { type: 2, style: 1, emoji: { name: "🏃" }, label: "15 min", custom_id: `late:${day}:${user}:15` },
    { type: 2, style: 1, emoji: { name: "🏃" }, label: "30 min", custom_id: `late:${day}:${user}:30` },
    { type: 2, style: 2, emoji: { name: "😴" }, label: "Can't make it", custom_id: `late:${day}:${user}:out` },
  ];
  let body: unknown[];
  let accent = 0xfee75c;
  if (row.state === "arrived") {
    const mins = startAt && row.arrived_at ? Math.max(0, Math.round((row.arrived_at - startAt) / 60)) : null;
    const onTime = row.eta && row.arrived_at && row.arrived_at <= row.eta + 120;
    accent = 0x57f287;
    body = [{ type: 10, content: `✅ ${mention(user)} made it${mins ? `, ${mins} min late` : ""}${onTime ? " (right on their ETA 👏)" : mins && mins >= 20 ? " 🐢" : ""}` }];
  } else if (row.state === "absent") {
    accent = 0x4f545c;
    body = [{ type: 10, content: `😴 ${mention(user)} can't make it tonight. Have fun without them!` }];
  } else if (row.state === "eta") {
    body = [
      { type: 10, content: `🏃 ${mention(user)} is on the way · ETA <t:${row.eta}:t> (<t:${row.eta}:R>)` },
      { type: 1, components: buttons.map((b) => ({ ...b, style: 2 })) }, // still changeable
    ];
  } else {
    body = [{ type: 10, content: `⏰ ${mention(user)} we've started ${game ? `**${game}**` : ""}${where}. Running late?` }, { type: 1, components: buttons }];
  }
  // edits never re-ping; the first post overrides this with a ping for the late person only
  return { flags: IS_COMPONENTS_V2, allowed_mentions: { parse: [] as string[] }, components: [{ type: 17, accent_color: accent, components: body }] };
}
