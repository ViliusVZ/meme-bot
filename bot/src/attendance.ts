// Who is coming to a started night, and when: the attendance rows, ETAs said ahead, and the late
// slip that shows them. Split out of late.ts so game night can record attendance without importing
// late.ts, which calls back into game night (plan 05 removes that import cycle).
import { and, eq, isNull, like, not, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { gameNights, nightAttendance, rooms } from "./db/index.js";
import { api, IS_COMPONENTS_V2 } from "./discord.js";
import * as voice from "./voice.js";

export type Attendance = typeof nightAttendance.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);
const mention = (id: string) => `<@${id}>`;

export const get = async (env: Env, day: string, user: string): Promise<Attendance | null> =>
  (await env.db.select().from(nightAttendance).where(and(eq(nightAttendance.day, day), eq(nightAttendance.user_id, user))))[0] ?? null;

export const real = not(like(rooms.channel_id, "pending:%"));

export async function put(env: Env, day: string, user: string, set: Partial<Omit<Attendance, "day" | "user_id">>) {
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

/** Renders a late slip in its current state. */
export async function render(env: Env, day: string, user: string) {
  const row = (await get(env, day, user))!;
  const [n] = await env.db.select({ game: gameNights.game, start_at: gameNights.start_at }).from(gameNights).where(eq(gameNights.day, day));
  const [room] = await env.db.select({ channel_id: rooms.channel_id }).from(rooms).where(and(eq(rooms.day, day), real));
  return slip(env, day, user, row, n.game!, n.start_at ?? undefined, room?.channel_id);
}

export function slip(env: Env, day: string, user: string, row: Attendance, game: string, startAt?: number, roomId?: string) {
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
