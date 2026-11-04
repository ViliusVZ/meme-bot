// 🧹 Every night at 03:00 (Vilnius) #game-night is swept: the bot's messages from before then go
// (yesterday's cards, nudges, pings, late slips, roasts), so the channel only ever shows what's
// current. Kept: pinned messages (the HQ panel), stats recaps, and anything belonging to a night
// that's still going (a card still taking votes, a planned day ahead, a night that started in the
// last 6 hours). People's own messages are never touched.
//
// "Only you can see this" messages aren't in the channel at all: Discord keeps them on your
// device, and they disappear when Discord reloads.
import { and, gte, inArray, or, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { gameNights, nightAttendance } from "./db/index.js";
import { api } from "./discord.js";
import { claimRecap, unclaimRecap } from "./memes.js";
import { isOver, local, wallToUnix } from "./gamenight.js";

const HOUR = 3; // local
const KEEP_AFTER_START = 6 * 3600;
const DISCORD_EPOCH = 1420070400000n;

type Message = { id: string; author: { id: string }; pinned?: boolean; content?: string; components?: unknown[] };

const createdMs = (id: string) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

/** Message ids still in use: cards, nudges and late slips of nights that aren't over. */
async function keepers(env: Env) {
  const t = Math.floor(Date.now() / 1000);
  const today = local(env).day;
  const nights = await env.db.select().from(gameNights).where(or(gte(gameNights.day, today), inArray(gameNights.stage, ["ask", "game", "time", "set"])));
  const live = nights.filter((n) =>
    n.day >= today ||
    (["ask", "game", "time"].includes(n.stage) && !isOver(env, n)) ||
    (n.stage === "set" && (n.start_at ?? 0) > t - KEEP_AFTER_START),
  );
  const ids = new Set<string>();
  for (const n of live) for (const id of [n.message_id, n.nudge_id]) if (id) ids.add(id);
  if (live.length) {
    const slips = await env.db
      .select({ id: nightAttendance.message_id })
      .from(nightAttendance)
      .where(and(inArray(nightAttendance.day, live.map((n) => n.day)), sql`${nightAttendance.message_id} IS NOT NULL`));
    for (const s of slips) ids.add(s.id!);
  }
  return ids;
}

/** Sweep #game-night: the bot's messages from before `cutoffMs`, except the keepers. */
export async function sweep(env: Env, cutoffMs: number) {
  const me = (await api(env, "GET", "/users/@me")).id as string;
  const keep = await keepers(env);
  const doomed: string[] = [];
  let before: string | undefined;
  // newest first, 100 at a time, back to the start of the channel
  for (;;) {
    const page = (await api(env, "GET", `/channels/${env.GAME_CHANNEL_ID}/messages?limit=100${before ? `&before=${before}` : ""}`)) as Message[];
    if (!page.length) break;
    for (const m of page) {
      if (m.author.id !== me || m.pinned || keep.has(m.id) || createdMs(m.id) >= cutoffMs) continue;
      if (JSON.stringify(m.components ?? []).includes("recap ·")) continue; // 📊 weekly/monthly/yearly recaps stay
      doomed.push(m.id);
    }
    before = page[page.length - 1].id;
    if (page.length < 100) break;
  }
  // bulk delete takes 2–100 messages younger than 14 days; anything else goes one by one
  const young = doomed.filter((id) => Date.now() - createdMs(id) < 13.5 * 86400_000);
  const old = doomed.filter((id) => !young.includes(id));
  for (let i = 0; i < young.length; i += 100) {
    const batch = young.slice(i, i + 100);
    if (batch.length === 1) old.push(batch[0]);
    else await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages/bulk-delete`, { messages: batch });
  }
  for (const id of old) await api(env, "DELETE", `/channels/${env.GAME_CHANNEL_ID}/messages/${id}`).catch(() => {});
  // whatever we deleted is no longer a card or a nudge
  if (doomed.length) {
    await env.db.update(gameNights).set({ message_id: null }).where(inArray(gameNights.message_id, doomed));
    await env.db.update(gameNights).set({ nudge_id: null }).where(inArray(gameNights.nudge_id, doomed));
  }
  return { deleted: doomed.length, kept: keep.size };
}

/** Minute job: the 03:00 sweep, once a day (claimed in the database, so it can't run twice). */
export async function nightly(env: Env) {
  const l = local(env);
  if (l.hour < HOUR) return {};
  const key = `cleanup:${l.day}`;
  if (!(await claimRecap(env, key))) return {};
  try {
    return await sweep(env, wallToUnix(env, l.y, l.m, l.d, HOUR, 0) * 1000);
  } catch (e) {
    await unclaimRecap(env, key); // the next minute tries again
    throw e;
  }
}

/** A snowflake for a given time (tests). */
export const snowflakeAt = (ms: number, n = 0) => String(((BigInt(ms) - DISCORD_EPOCH) << 22n) + BigInt(n));
