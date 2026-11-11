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
import { players } from "./env.js";
import { bailFromSlip } from "./gamenight.js";
import { get, put, real, slip, type Attendance } from "./attendance.js";
import * as voice from "./voice.js";
import * as alerts from "./alerts.js";

const LATE_AFTER = 10 * 60; // grace before a late slip
const WATCH_FOR = 3 * 3600; // stop watching this long after the start
const nowSec = () => Math.floor(Date.now() / 1000);
const pings = (env: Env, users: string[]) => (env.QUIET ? { parse: [] } : { users });

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

// the data half moved to attendance.ts; still offered from here to existing callers
export { declare, etas, expect, get, markArrived, render, retireSlips, type Attendance } from "./attendance.js";

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

