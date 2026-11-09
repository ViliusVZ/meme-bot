// Running late. Once a locked-in night has started (its room is open), every minute, and the moment
// anyone joins the Lobby (live.ts), we check where each player is:
//   in the room      → they're here (a late slip, if any, becomes "✅ made it, 12 min late 🐢")
//   in the Lobby     → pulled into the room, once (if they wander back to the Lobby later, we leave
//                       them be)
//   anywhere else    → 10 min after start they get one late slip: "Running late?" with 🏃 ETA
//                       buttons and 😴 can't make it
// "Can't make it" (😴 on the slip, or on the card) calls the whole night off: we play all together
// or not at all (gamenight.ts posts the roast). Everyone's slips then say so.
// Saying it ahead (⏰ on the locked-in card): before the start, gamenight.ts moves the start to the
// latest ETA (we wait for everyone); after it, it's an ETA on your slip. Someone who said they'd be
// late and still isn't here 10 min after their ETA gets a slip like everyone else.
import { and, eq, gt, isNull, like, lte, not, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { gameNights, nightAttendance, rooms } from "./db/index.js";
import { api, IS_COMPONENTS_V2 } from "./discord.js";
import { bailFromSlip, players } from "./gamenight.js";
import * as voice from "./voice.js";
import * as alerts from "./alerts.js";

export type Attendance = typeof nightAttendance.$inferSelect;

const LATE_AFTER = 10 * 60; // grace before a late slip
const WATCH_FOR = 3 * 3600; // stop watching this long after the start
const nowSec = () => Math.floor(Date.now() / 1000);
const mention = (id: string) => `<@${id}>`;
const pings = (env: Env, users: string[]) => (env.QUIET ? { parse: [] } : { users });

export const get = async (env: Env, day: string, user: string): Promise<Attendance | null> =>
  (await env.db.select().from(nightAttendance).where(and(eq(nightAttendance.day, day), eq(nightAttendance.user_id, user))))[0] ?? null;

const real = not(like(rooms.channel_id, "pending:%"));

async function put(env: Env, day: string, user: string, set: Partial<Omit<Attendance, "day" | "user_id">>) {
  const cur = await get(env, day, user);
  const row = { day, user_id: user, state: "arrived", eta: null, message_id: null, arrived_at: null, roast: null, ...cur, ...set } as Attendance;
  const values = { state: row.state, eta: row.eta, message_id: row.message_id, arrived_at: row.arrived_at, roast: row.roast };
  await env.db
    .insert(nightAttendance)
    .values({ day, user_id: user, ...values })
    .onConflictDoUpdate({ target: [nightAttendance.day, nightAttendance.user_id], set: values });
  return row;
}

/** ⏰ said ahead of the start: they'll be here at `eta` (null takes it back). */
export async function expect(env: Env, day: string, user: string, eta: number | null) {
  if (eta === null) {
    await env.db.delete(nightAttendance).where(and(eq(nightAttendance.day, day), eq(nightAttendance.user_id, user), eq(nightAttendance.state, "eta")));
    return;
  }
  await put(env, day, user, { state: "eta", eta });
}

/** Who said they'd be late, and when they'll be here: { user: eta }. */
export async function etas(env: Env, day: string) {
  const rows = await env.db
    .select({ user: nightAttendance.user_id, eta: nightAttendance.eta })
    .from(nightAttendance)
    .where(and(eq(nightAttendance.day, day), eq(nightAttendance.state, "eta")));
  return Object.fromEntries(rows.map((r) => [r.user, r.eta!])) as Record<string, number>;
}

/** ⏰ on the card after the start: an ETA from now, on their slip (posted now if they had none). */
export async function declare(env: Env, day: string, user: string, mins: number) {
  const row = await get(env, day, user);
  const [room] = await env.db.select({ channel_id: rooms.channel_id }).from(rooms).where(and(eq(rooms.day, day), isNull(rooms.archived_at), real));
  const inRoom = room && (await voice.voiceChannel(env, user).catch(() => null)) === room.channel_id;
  if (row?.state === "arrived" || inRoom) return "You're already here 👋";
  const r = await put(env, day, user, { state: "eta", eta: nowSec() + mins * 60 });
  const body = await render(env, day, user);
  if (r.message_id) {
    await api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${r.message_id}`, body).catch(() => {});
  } else {
    const [n] = await env.db.select({ message_id: gameNights.message_id }).from(gameNights).where(eq(gameNights.day, day));
    const msg = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
      ...body,
      allowed_mentions: { parse: [] },
      message_reference: n?.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
    });
    await env.db.update(nightAttendance).set({ message_id: msg.id }).where(and(eq(nightAttendance.day, day), eq(nightAttendance.user_id, user)));
  }
  return `Got it 🏃 ETA <t:${r.eta}:t>. Everyone can see it on your slip.`;
}

/** People the start-time reminder already moved count as here (and won't be moved again). */
export async function markArrived(env: Env, day: string, users: string[]) {
  for (const u of users) await put(env, day, u, { state: "arrived", arrived_at: nowSec() });
}

/** Card "Can't make it" after the start: mark absent (and update their slip if they had one). */
/** The night was called off: every slip still asking "running late?" says so instead. */
export async function retireSlips(env: Env, day: string) {
  const rows = await env.db.select().from(nightAttendance).where(and(eq(nightAttendance.day, day), sql`${nightAttendance.message_id} IS NOT NULL`));
  for (const r of rows) {
    if (r.state === "arrived") continue;
    const content = r.state === "absent" ? `🚪 ${mention(r.user_id)} bailed, so game night's off. Roast below 🔥` : `~~⏰ Running late?~~ Never mind ${mention(r.user_id)}, game night's off 🫡`;
    await api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${r.message_id}`, {
      flags: IS_COMPONENTS_V2,
      allowed_mentions: { parse: [] },
      components: [{ type: 10, content }],
    }).catch(() => {});
  }
}

type Night = { day: string; game: string | null; start_at: number | null; message_id: string | null };

/** Every minute (and on Lobby joins): handle everyone for every night that's under way. */
export async function watch(env: Env) {
  const t = nowSec();
  const nights: Night[] = await env.db
    .select({ day: gameNights.day, game: gameNights.game, start_at: gameNights.start_at, message_id: gameNights.message_id })
    .from(gameNights)
    .where(and(eq(gameNights.stage, "set"), eq(gameNights.reminded, true), lte(gameNights.start_at, t), gt(gameNights.start_at, t - WATCH_FOR)));
  const done: Record<string, string[]> = {};
  const note = (k: string, v: string) => (done[k] ??= []).push(v);

  for (const n of nights) {
    const [room] = await env.db
      .select({ channel_id: rooms.channel_id })
      .from(rooms)
      .where(and(eq(rooms.day, n.day), isNull(rooms.archived_at), real));
    if (!room) continue;
    for (const p of players(env)) {
      // one player's trouble (a failed move or post) must not hold up the others
      try {
        await watchPlayer(env, n, room.channel_id, p, t, note);
      } catch (e) {
        alerts.failed("latecomer upkeep", e, n.day, p);
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

  // said ahead they'd be late, and 10 min past that ETA they're still not here
  const overdue = row?.state === "eta" && !row.message_id && t - Math.max(row.eta!, n.start_at!) >= LATE_AFTER;
  if ((!row && t - n.start_at! >= LATE_AFTER) || overdue) {
    // not here, not in the Lobby, no word from them: one late slip. Claim the row first so two
    // overlapping runs can't both post one.
    const claim = row
      ? await env.db
          .update(nightAttendance)
          .set({ state: "late", eta: null })
          .where(and(eq(nightAttendance.day, n.day), eq(nightAttendance.user_id, p), eq(nightAttendance.state, "eta"), isNull(nightAttendance.message_id)))
          .returning({ day: nightAttendance.day })
      : await env.db
          .insert(nightAttendance)
          .values({ day: n.day, user_id: p, state: "late" })
          .onConflictDoNothing()
          .returning({ day: nightAttendance.day });
    if (!claim.length) return;
    const fresh: Attendance = { day: n.day, user_id: p, state: "late", eta: null, message_id: null, arrived_at: null, roast: null };
    try {
      const msg = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
        ...slip(env, n.day, p, fresh, n.game!, n.start_at!, roomId),
        allowed_mentions: pings(env, [p]),
        message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
      });
      await env.db.update(nightAttendance).set({ message_id: msg.id }).where(and(eq(nightAttendance.day, n.day), eq(nightAttendance.user_id, p)));
      note("slipped", p);
    } catch (e) {
      // release the claim so the next minute can try again
      if (row) await put(env, n.day, p, { state: "eta", eta: row.eta });
      else
        await env.db
          .delete(nightAttendance)
          .where(and(eq(nightAttendance.day, n.day), eq(nightAttendance.user_id, p), isNull(nightAttendance.message_id), eq(nightAttendance.state, "late")));
      throw e;
    }
  }
}

/** A late slip button: late:<day>:<user>:<5|15|30|out>. Only the late person can answer it. */
export async function act(env: Env, day: string, owner: string, clicker: string, choice: string) {
  if (clicker !== owner) return { notice: "That's not your late slip 😄" };
  const row = await get(env, day, owner);
  if (!row) return { notice: "That slip has expired 🫥" };
  const [night] = await env.db.select({ stage: gameNights.stage }).from(gameNights).where(eq(gameNights.day, day));
  if (night?.stage !== "set") return { notice: "Game night's off, no need to hurry 🫡" };
  if (row.state === "arrived") return { notice: "You're already here 👋" };
  if (choice === "out") {
    // all of us or none of us: the night's off (this also retires every slip, this one included)
    await put(env, day, owner, { state: "absent" });
    await bailFromSlip(env, day, owner);
  } else {
    const mins = Number(choice);
    if (![5, 15, 30].includes(mins)) return { notice: "🤷" };
    await put(env, day, owner, { state: "eta", eta: nowSec() + mins * 60 });
  }
  return { notice: undefined };
}

/** Renders a late slip in its current state. */
export async function render(env: Env, day: string, user: string) {
  const row = (await get(env, day, user))!;
  const [n] = await env.db.select({ game: gameNights.game, start_at: gameNights.start_at }).from(gameNights).where(eq(gameNights.day, day));
  const [room] = await env.db.select({ channel_id: rooms.channel_id }).from(rooms).where(and(eq(rooms.day, day), real));
  return slip(env, day, user, row, n.game!, n.start_at ?? undefined, room?.channel_id);
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
    return { flags: IS_COMPONENTS_V2, allowed_mentions: { parse: [] as string[] }, components: [{ type: 10, content: `🚪 ${mention(user)} bailed, so game night's off. Roast below 🔥` }] };
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
