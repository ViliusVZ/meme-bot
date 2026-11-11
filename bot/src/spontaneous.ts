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
import type { Env } from "./env.js";
import { activityGuesses, fleeting, gameAliases, gameNights, games as gameTable, lobbyPrompts, readyRooms, rooms, sessions, voiceSegments } from "./db/index.js";
import { api, IS_COMPONENTS_V2, isNotFound } from "./discord.js";
import { players } from "./env.js";
import { local } from "./localtime.js";
import { emojiFor, games } from "./games.js";
import * as voice from "./voice.js";
import * as presence from "./presence.js";
import * as gemini from "./gemini.js";
import * as alerts from "./alerts.js";

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
const nowSec = () => Math.floor(Date.now() / 1000);
const mention = (u: string) => `<@${u}>`;
const real = not(like(rooms.channel_id, "pending:%"));

type Where = Map<string, string | null>;
export type Change = { user: string; from: string | null; to: string | null };
type Room = typeof rooms.$inferSelect;
type Session = typeof sessions.$inferSelect;

/** "A", "A and B", "A, B and C". */
export function names(users: string[]) {
  const m = users.map(mention);
  return m.length <= 1 ? (m[0] ?? "") : `${m.slice(0, -1).join(", ")} and ${m[m.length - 1]}`;
}

/** Minutes, said plainly: "46 min", "1 h 20 min". */
export function minutes(sec: number) {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

// ---------------------------------------------------------------- what's planned

/**
 * The planned night that owns voice right now: `rooms` are open rooms of nights that started (for
 * NIGHT_LIVE), `on` means one started lately (even if its room didn't open), `soon` that one is
 * about to start (or is due and hasn't yet).
 */
export async function planned(env: Env, t = nowSec()) {
  const nights = await env.db
    .select({ day: gameNights.day, start_at: gameNights.start_at, reminded: gameNights.reminded })
    .from(gameNights)
    .where(and(eq(gameNights.stage, "set"), gt(gameNights.start_at, t - NIGHT_LIVE), lte(gameNights.start_at, t + PLANNED_SOON)));
  const soon = nights.some((n) => !n.reminded);
  const started = nights.filter((n) => n.reminded && n.start_at! <= t).map((n) => n.day);
  const open = started.length
    ? await env.db
        .select({ channel_id: rooms.channel_id })
        .from(rooms)
        .where(and(inArray(rooms.day, started), isNull(rooms.archived_at), real))
    : [];
  const on = nights.some((n) => n.reminded && n.start_at! <= t && n.start_at! > t - NIGHT_ON);
  return { soon, on, rooms: new Set(open.map((r) => r.channel_id)) };
}
type Planned = Awaited<ReturnType<typeof planned>>;

// ---------------------------------------------------------------- the reaction to voice

/**
 * React to where everyone is (live.ts calls this, one at a time, after every voice change, on the
 * heartbeat and on reconnect). `change` is the move that triggered it, if any. Returns when to look
 * again (unix seconds) for something that's due with nothing else to trigger it, or null.
 */
export async function react(env: Env, where: Where, t = nowSec(), change?: Change) {
  const plan = await planned(env, t);
  const open = await voice.openRooms(env);
  const inRoom = (r: Room) => players(env).filter((p) => where.get(p) === r.channel_id);
  await trackSessions(env, open, inRoom, plan, t);
  if (change?.to === env.LOBBY_CHANNEL_ID && players(env).includes(change.user)) await pullIn(env, change, open, inRoom, plan, t);
  await readyRoom(env, where, open, plan, t);
  return gathering(env, where, open, inRoom, plan, t);
}

// ---------------------------------------------------------------- 🎮 what we're playing (game detection)

/**
 * What each of `users` is playing, as our games: Discord's name matched to a game (case aside) or
 * to a name we learned. `unknown` is a name two or more of them share that matches nothing.
 */
export async function playingGames(env: Env, users: string[]) {
  const seen = new Map(users.map((u) => [u, presence.playing(u)]));
  const all = [...new Set([...seen.values()].flat())];
  const game = new Map<string, string>(); // lower-case activity name → game
  if (all.length) {
    for (const g of await env.db.select({ name: gameTable.name }).from(gameTable).where(inArray(gameTable.name, all))) game.set(g.name.toLowerCase(), g.name);
    for (const a of await env.db.select().from(gameAliases).where(inArray(gameAliases.activity, all))) game.set(a.activity.toLowerCase(), a.game);
  }
  const of = new Map<string, string>();
  for (const [u, names] of seen) {
    const g = names.map((n) => game.get(n.toLowerCase())).find(Boolean);
    if (g) of.set(u, g);
  }
  // a name two of them share that we can't place (and Gemini didn't already rule out): worth a tap
  const notOurs = all.length
    ? new Set(
        (await env.db.select({ a: activityGuesses.activity }).from(activityGuesses).where(and(inArray(activityGuesses.activity, all), eq(activityGuesses.answered, true))))
          .map((r) => r.a.toLowerCase()),
      )
    : new Set<string>();
  const shared = all.filter((n) => !game.has(n.toLowerCase()) && !notOurs.has(n.toLowerCase()) && users.filter((u) => seen.get(u)!.includes(n)).length >= 2);
  return { of, unknown: shared[0] ?? null };
}

const RETRY_GUESS = 86400; // Gemini couldn't answer: ask about that name again a day later

/**
 * Someone's playing something new to us: ask Gemini (once per name, in the background) whether
 * it's one of our games under another name. A yes becomes an alias, so the next time two of us
 * are in it, it just works. Returns what was learned, for logs and tests.
 */
export async function learn(env: Env, names: string[], t = nowSec()) {
  if (!env.GEMINI_API_KEY || !names.length) return [];
  const list = (await games(env, 200)).map((g) => g.name);
  const known = new Set(list.map((g) => g.toLowerCase()));
  for (const a of await env.db.select().from(gameAliases).where(inArray(gameAliases.activity, names))) known.add(a.activity.toLowerCase());
  const learned: { activity: string; game: string | null }[] = [];
  for (const name of names.filter((n) => !known.has(n.toLowerCase()))) {
    // claim the name, so a second presence update doesn't ask twice; a failed ask may retry tomorrow
    const [claim] = await env.db
      .insert(activityGuesses)
      .values({ activity: name, at: t })
      .onConflictDoUpdate({ target: activityGuesses.activity, set: { at: t }, setWhere: and(eq(activityGuesses.answered, false), lte(activityGuesses.at, t - RETRY_GUESS)) })
      .returning({ a: activityGuesses.activity });
    if (!claim) continue;
    const r = await gemini.ask<{ game: string | null }>(
      env,
      `Discord shows a friend "Playing ${JSON.stringify(name)}". Our friend group's game list: ${JSON.stringify(list)}.
Is it one of the games on the list? Answer that game's name exactly as written in the list only if it
is clearly the same game (an edition, expansion, client, launcher or longer name of it, like "World of
Warcraft Classic" for "World of Warcraft"). If it's anything else (another game, an app like an editor
or a browser, or you aren't sure), answer null.`,
      { type: "OBJECT", properties: { game: { type: "STRING", nullable: true } }, required: ["game"] },
    );
    if (!r) continue; // no answer to be had today: claimed, so tomorrow it's tried again
    const game = list.find((g) => g.toLowerCase() === r.game?.toLowerCase()) ?? null;
    await env.db.update(activityGuesses).set({ game, answered: true }).where(eq(activityGuesses.activity, name));
    if (game) await env.db.insert(gameAliases).values({ activity: name, game, added_by: "gemini" }).onConflictDoNothing();
    learned.push({ activity: name, game });
  }
  return learned;
}

/** The one game everyone who's playing something we know is playing (null: none, or a mix). */
function oneGame(of: Map<string, string>) {
  const gs = [...new Set([...of.values()].map((g) => g.toLowerCase()))];
  if (gs.length !== 1) return null;
  const g = [...of.values()][0];
  return { game: g, by: [...of].filter(([, x]) => x.toLowerCase() === gs[0]).map(([u]) => u) };
}

/**
 * Two of us playing the same game and nobody in voice yet: have its room waiting under the Lobby.
 * Once per game per day, silently; the room archives itself after an hour if nobody comes.
 */
async function readyRoom(env: Env, where: Where, open: Room[], plan: Planned, t: number) {
  if (!env.PRESENCES || plan.soon || plan.on || plan.rooms.size) return;
  // only those not in voice yet (in voice, the Lobby flow has them)
  const away = players(env).filter((p) => !where.get(p));
  if (away.length < 2) return;
  const { of } = await playingGames(env, away);
  const counts = new Map<string, string[]>();
  for (const [u, g] of of) counts.set(g.toLowerCase(), [...(counts.get(g.toLowerCase()) ?? []), u]);
  const hit = [...counts.values()].find((us) => us.length >= 2);
  if (!hit) return;
  const game = of.get(hit[0])!;
  if (open.some((r) => r.game.toLowerCase() === game.toLowerCase())) return;
  const day = local(env, new Date(t * 1000)).day;
  const [claim] = await env.db.insert(readyRooms).values({ day, game, at: t }).onConflictDoNothing().returning({ day: readyRooms.day });
  if (!claim) return;
  try {
    const r = await voice.openRoom(env, game, await emojiFor(env, game), { move: false });
    console.log("room ready ahead", game, r.channelId);
  } catch (e) {
    await env.db.delete(readyRooms).where(and(eq(readyRooms.day, day), eq(readyRooms.game, game)));
    alerts.failed("getting a game room ready", e, game);
  }
}

/** Two of us in the Lobby playing the same game: straight to its room, with ↩ in case we're wrong. */
async function autoMove(env: Env, game: string, by: string[], t: number) {
  const [claim] = await env.db.insert(lobbyPrompts).values({ created_at: t, state: "moved", game }).onConflictDoNothing().returning({ id: lobbyPrompts.id });
  if (!claim) return;
  try {
    const r = await voice.openRoom(env, game, await emojiFor(env, game), { move: true });
    if (r.moved.length) await note(env, r.channelId, `🎮 Saw ${names(by)} in **${game}**, so I brought you over.`, r.moved, t);
  } catch (e) {
    await env.db.update(lobbyPrompts).set({ state: "failed" }).where(eq(lobbyPrompts.id, claim.id));
    alerts.failed("moving the Lobby into the game we're playing", e, game);
  }
}

// ---------------------------------------------------------------- the Lobby question

async function gathering(env: Env, where: Where, open: Room[], inRoom: (r: Room) => string[], plan: Planned, t: number) {
  const lobby = players(env).filter((p) => where.get(p) === env.LOBBY_CHANNEL_ID);
  const [cur] = await env.db.select().from(lobbyPrompts).where(eq(lobbyPrompts.current, true));

  if (lobby.length < 2) {
    // the gathering broke up (an undo stays in force while people trickle back)
    if (cur && !(cur.state === "undone" && t - cur.created_at < UNDO_QUIET)) await endGathering(env, cur, t);
    return null;
  }
  if (cur) {
    if (cur.state !== "open" || !cur.posted_at) return null;
    if (t - cur.posted_at < PROMPT_TTL) return cur.posted_at + PROMPT_TTL;
    await closePrompt(env, cur, "expired");
    return null;
  }
  // a planned night owns the Lobby; and with someone already in a game room, joiners get pulled there
  if (plan.soon || plan.on || plan.rooms.size || open.some((r) => inRoom(r).length)) return null;

  // the gathering started when the second of us got here (their Lobby stretch, as tracked for stats)
  const segs = await env.db
    .select({ started_at: voiceSegments.started_at })
    .from(voiceSegments)
    .where(and(eq(voiceSegments.open, true), eq(voiceSegments.channel_id, env.LOBBY_CHANNEL_ID), inArray(voiceSegments.user_id, lobby)));
  const starts = segs.map((s) => s.started_at).sort((a, b) => a - b);
  const since = starts.length >= 2 ? starts[1] : t;
  if (t < since + GATHER_AFTER) return since + GATHER_AFTER;
  // game detection: two playing the same game and nobody playing another → no need to ask
  const seen = env.PRESENCES ? await playingGames(env, lobby) : { of: new Map<string, string>(), unknown: null };
  const one = oneGame(seen.of);
  if (one && one.by.length >= 2) {
    await autoMove(env, one.game, one.by, t);
    return null;
  }
  await ask(env, t, one?.game ?? null, seen.unknown);
  return t + PROMPT_TTL;
}

/** Up to three games, the ones we played most recently first, then the most played. */
export async function recentGames(env: Env, n = 3) {
  const { rows } = await env.db.execute<{ game: string }>(sql`
    SELECT game FROM (
      SELECT game, created_at AS t FROM ${rooms} WHERE channel_id NOT LIKE 'pending:%'
      UNION ALL SELECT game, started_at FROM ${sessions}
      UNION ALL SELECT game, start_at FROM ${gameNights} WHERE stage = 'set' AND reminded AND game IS NOT NULL
    ) x GROUP BY game ORDER BY max(t) DESC LIMIT ${n}`);
  const out = rows.map((r) => r.game);
  for (const g of await games(env, n + out.length)) {
    if (out.length >= n) break;
    if (!out.some((x) => x.toLowerCase() === g.name.toLowerCase())) out.push(g.name);
  }
  return out;
}

export async function questionMessage(env: Env, id: number, first: string | null = null) {
  const recent = await recentGames(env);
  // someone's playing it: that game first
  const list = first ? [first, ...recent.filter((g) => g.toLowerCase() !== first.toLowerCase())].slice(0, 3) : recent;
  const emoji = new Map((await games(env, 100)).map((g) => [g.name.toLowerCase(), g.emoji ?? "🎮"]));
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
}

/** Claim this gathering's question, then post it; a failed post leaves the gathering quiet. */
async function ask(env: Env, t: number, first: string | null = null, activity: string | null = null) {
  const [claim] = await env.db
    .insert(lobbyPrompts)
    .values({ created_at: t, state: "open", activity })
    .onConflictDoNothing()
    .returning({ id: lobbyPrompts.id });
  if (!claim) return;
  try {
    const msg = await api(env, "POST", `/channels/${env.LOBBY_CHANNEL_ID}/messages`, await questionMessage(env, claim.id, first));
    await env.db.update(lobbyPrompts).set({ message_id: msg.id, posted_at: t }).where(eq(lobbyPrompts.id, claim.id));
  } catch (e) {
    await env.db.update(lobbyPrompts).set({ state: "failed" }).where(eq(lobbyPrompts.id, claim.id));
    alerts.failed("asking the Lobby what we're playing", e);
  }
}

const deleteMessage = (env: Env, channel: string, id: string) =>
  api(env, "DELETE", `/channels/${channel}/messages/${id}`).catch((e) => {
    if (!isNotFound(e)) console.log("couldn't delete", channel, id, e);
  });

async function closePrompt(env: Env, p: typeof lobbyPrompts.$inferSelect, state: "expired" | "dismissed") {
  const done = await env.db
    .update(lobbyPrompts)
    .set({ state })
    .where(and(eq(lobbyPrompts.id, p.id), eq(lobbyPrompts.state, "open")))
    .returning({ id: lobbyPrompts.id });
  if (done.length && p.message_id) await deleteMessage(env, env.LOBBY_CHANNEL_ID, p.message_id);
}

async function endGathering(env: Env, p: typeof lobbyPrompts.$inferSelect, t: number) {
  if (p.state === "open") await closePrompt(env, p, "expired");
  await env.db.update(lobbyPrompts).set({ current: false, ended_at: t }).where(eq(lobbyPrompts.id, p.id));
}

/** What to tell the tapper privately: a line, or a whole message (with buttons). */
export type Notice = string | { content: string; components: unknown[] } | null;

/**
 * A tap on the question: `lob:<id>:g:<game>` | `lob:<id>:other` | `lob:<id>:chill`, or the
 * follow-up offer `lob:<id>:alias`. Returns what to tell the tapper privately, if anything.
 */
export async function answer(env: Env, id: number, user: string, what: string, game?: string): Promise<Notice> {
  const [p] = await env.db.select().from(lobbyPrompts).where(eq(lobbyPrompts.id, id));
  if (!p) return "That question's gone 🫥";
  if (what === "alias") {
    if (!p.activity || !p.game) return "🤷";
    await env.db
      .insert(gameAliases)
      .values({ activity: p.activity, game: p.game, added_by: user })
      .onConflictDoUpdate({ target: gameAliases.activity, set: { game: p.game, added_by: user } });
    return `👍 From now on, two of you in *${p.activity}* go straight to **${p.game}**.`;
  }
  if (what === "chill") {
    if (p.state !== "open") return null;
    await env.db.update(lobbyPrompts).set({ by: user }).where(eq(lobbyPrompts.id, id));
    await closePrompt(env, p, "dismissed");
    return null;
  }
  // first tap wins
  const [won] = await env.db
    .update(lobbyPrompts)
    .set({ state: "picked", by: user, game: game! })
    .where(and(eq(lobbyPrompts.id, id), eq(lobbyPrompts.state, "open")))
    .returning({ id: lobbyPrompts.id });
  if (!won) {
    const [now] = await env.db.select().from(lobbyPrompts).where(eq(lobbyPrompts.id, id));
    return now?.state === "picked" && now.game ? `${mention(now.by!)} already picked **${now.game}** 🙂` : "That question's closed.";
  }
  try {
    const r = await voice.openRoom(env, game!, await emojiFor(env, game!), { by: user, move: true });
    if (p.message_id) await deleteMessage(env, env.LOBBY_CHANNEL_ID, p.message_id);
    if (p.activity) {
      // they were all in a game Discord calls something we don't know: offer to remember it (never silently)
      return {
        content: `Discord says you were playing *${p.activity}*. Is that **${game}**?`,
        components: [{ type: 1, components: [{ type: 2, style: 1, label: `Yes, always open ${game}`.slice(0, 80), custom_id: `lob:${id}:alias`, emoji: { name: "🧠" } }] }],
      };
    }
    return r.moved.length ? null : `🔊 Room's up: <#${r.channelId}>. Nobody was left in the Lobby to bring along.`;
  } catch (e) {
    // give the question back, so someone can try again
    await env.db.update(lobbyPrompts).set({ state: "open", by: null, game: null }).where(eq(lobbyPrompts.id, id));
    alerts.failed("opening a room from the Lobby question", e);
    return "😵 Couldn't open the room just now. Try again in a moment.";
  }
}

// ---------------------------------------------------------------- pulling latecomers in

/** Someone joined the Lobby: with exactly one game room in use (not a planned night's), bring them in, once. */
async function pullIn(env: Env, { user, from }: Change, open: Room[], inRoom: (r: Room) => string[], plan: Planned, t: number) {
  if (plan.on || plan.rooms.size) return; // a planned night's latecomers are late.ts's
  const busy = open.filter((r) => inRoom(r).length);
  if (busy.length !== 1) return;
  const r = busy[0];
  // came out of that very room (to chat in the Lobby, say): that's on purpose
  if (r.pulled.includes(user) || from === r.channel_id) return;
  // claim first, so a quick out-and-back can't pull twice
  const claimed = await env.db
    .update(rooms)
    .set({ pulled: sql`${rooms.pulled} || ${JSON.stringify([user])}::jsonb` })
    .where(and(eq(rooms.channel_id, r.channel_id), not(sql`${rooms.pulled} ? ${user}`)))
    .returning({ id: rooms.channel_id });
  if (!claimed.length) return;
  await api(env, "PATCH", `/guilds/${env.GUILD_ID}/members/${user}`, { channel_id: r.channel_id });
  await note(env, r.channel_id, `👋 Pulled ${mention(user)} in from the Lobby: ${names(inRoom(r))} ${inRoom(r).length === 1 ? "is" : "are"} here.`, [user], t);
}

/** A self-removing note in a room's chat, with the way back to the Lobby for `moved`. */
export async function note(env: Env, channel: string, content: string, moved: string[], t = nowSec()) {
  try {
    const msg = await api(env, "POST", `/channels/${channel}/messages`, {
      content,
      flags: SILENT,
      allowed_mentions: { parse: [] },
      components: [{ type: 1, components: [{ type: 2, style: 2, label: "Back to the Lobby", emoji: { name: "↩️" }, custom_id: `lob:back:${moved.join(",")}`.slice(0, 100) }] }],
    });
    await env.db.insert(fleeting).values({ message_id: msg.id, channel_id: channel, delete_at: t + NOTE_TTL }).onConflictDoNothing();
  } catch (e) {
    console.log("room note failed", channel, e); // the move itself happened; the note is a nicety
  }
}

/**
 * ↩ Back to the Lobby (from a note): whoever was moved goes back if they're still in that room, and
 * the Lobby stays quiet for this gathering. Returns what to tell the tapper.
 */
export async function goBack(env: Env, channel: string, users: string[], messageId: string | undefined, t = nowSec()) {
  const back: string[] = [];
  for (const u of users) {
    if ((await voice.voiceChannel(env, u).catch(() => null)) !== channel) continue;
    await api(env, "PATCH", `/guilds/${env.GUILD_ID}/members/${u}`, { channel_id: env.LOBBY_CHANNEL_ID })
      .then(() => back.push(u))
      .catch((e) => console.log("move back failed", u, e));
  }
  // quiet for this gathering: a current row that isn't asking
  const [cur] = await env.db.select().from(lobbyPrompts).where(eq(lobbyPrompts.current, true));
  if (cur?.state === "open") await closePrompt(env, cur, "dismissed");
  if (cur) await env.db.update(lobbyPrompts).set({ state: "undone", created_at: t }).where(eq(lobbyPrompts.id, cur.id));
  else await env.db.insert(lobbyPrompts).values({ created_at: t, state: "undone" }).onConflictDoNothing();
  if (messageId) {
    await deleteMessage(env, channel, messageId);
    await env.db.delete(fleeting).where(eq(fleeting.message_id, messageId));
  }
  return back.length ? null : "Nobody to move back: they've already left that room.";
}

// ---------------------------------------------------------------- sessions

async function trackSessions(env: Env, open: Room[], inRoom: (r: Room) => string[], plan: Planned, t: number) {
  const live = await env.db.select().from(sessions).where(eq(sessions.finished, false));
  for (const r of open) {
    if (plan.rooms.has(r.channel_id)) continue; // a planned night: late.ts and the night's own count have it
    const here = inRoom(r);
    let s = live.find((x) => x.channel_id === r.channel_id) ?? null;
    if (!s && here.length < 2) continue;
    try {
      if (!s) s = await startSession(env, r, t);
      await stepSession(env, s, here, t);
    } catch (e) {
      alerts.failed("keeping track of an unplanned session", e, r.game);
    }
  }
  await finishDue(env, open, t);
}

/** Sessions whose room went (archived, deleted) or that sat below two for END_GRACE wrap up. */
async function finishDue(env: Env, open: Room[], t: number) {
  const done: string[] = [];
  for (const s of await env.db.select().from(sessions).where(eq(sessions.finished, false))) {
    const roomOpen = open.some((r) => r.channel_id === s.channel_id);
    if (roomOpen && !(s.idle_since && t - s.idle_since >= END_GRACE)) continue;
    await finishSession(env, s, t)
      .then(() => done.push(s.game))
      .catch((e) => alerts.failed("wrapping up an unplanned session", e, s.game));
  }
  return done;
}

/** A session for this room's game today, new or resumed (same game, same day = same session). */
async function startSession(env: Env, r: Room, t: number) {
  const day = local(env, new Date(t * 1000)).day;
  const [s] = await env.db
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
  return (await env.db.select().from(sessions).where(and(eq(sessions.day, day), eq(sessions.game, r.game))))[0];
}

const together = (s: Session, t: number) => s.together_secs + (s.active_since ? t - s.active_since : 0);

async function stepSession(env: Env, s: Session, here: string[], t: number) {
  if (s.absorbed) return;
  const set: Partial<Session> = {};
  const who = [...new Set([...s.who, ...here])];
  if (who.length !== s.who.length) set.who = who;
  if (here.length >= 2 && !s.active_since) Object.assign(set, { active_since: t, idle_since: null });
  if (here.length < 2 && s.active_since) Object.assign(set, { active_since: null, idle_since: t, together_secs: s.together_secs + (t - s.active_since) });
  if (Object.keys(set).length) await env.db.update(sessions).set(set).where(and(eq(sessions.day, s.day), eq(sessions.game, s.game)));
  const cur: Session = { ...s, ...set };

  if (!cur.counted && together(cur, t) >= COUNT_AFTER) await count(env, cur);
  // the quiet line: two minutes in, only if one of us isn't there
  const missing = players(env).some((p) => !here.includes(p));
  if (!cur.message_id && here.length >= 2 && missing && t - cur.started_at >= LINE_AFTER) await postLine(env, cur, here);
  else if (cur.message_id && cur.message_id !== "posting" && here.length >= 2) await editLine(env, cur, liveLine(cur, here));
}

/** It counts as a game night, unless the day's planned night was this same game (then it's that one). */
async function count(env: Env, s: Session) {
  const [night] = await env.db
    .select({ day: gameNights.day })
    .from(gameNights)
    .where(and(eq(gameNights.day, s.day), eq(gameNights.stage, "set"), eq(gameNights.reminded, true), eq(gameNights.game, s.game)));
  if (night) return;
  const claimed = await env.db
    .update(sessions)
    .set({ counted: true })
    .where(and(eq(sessions.day, s.day), eq(sessions.game, s.game), eq(sessions.counted, false)))
    .returning({ day: sessions.day });
  if (claimed.length) await env.db.update(gameTable).set({ plays: sql`${gameTable.plays} + 1` }).where(eq(gameTable.name, s.game));
  s.counted = true;
}

const liveLine = (s: Session, here: string[]) => `🎮 ${names(here)} ${here.length === 1 ? "is" : "are"} in **${s.game}** → <#${s.channel_id}>`;
const doneLine = (s: Session, t: number) => `🎮 ${names(s.who)} played **${s.game}** for ${minutes(together(s, t))}`;

async function postLine(env: Env, s: Session, here: string[]) {
  const claimed = await env.db
    .update(sessions)
    .set({ message_id: "posting" })
    .where(and(eq(sessions.day, s.day), eq(sessions.game, s.game), isNull(sessions.message_id)))
    .returning({ day: sessions.day });
  if (!claimed.length) return;
  const line = liveLine(s, here);
  try {
    const msg = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, { content: line, flags: SILENT, allowed_mentions: { parse: [] } });
    await env.db.update(sessions).set({ message_id: msg.id, line }).where(and(eq(sessions.day, s.day), eq(sessions.game, s.game)));
  } catch (e) {
    await env.db.update(sessions).set({ message_id: null }).where(and(eq(sessions.day, s.day), eq(sessions.game, s.game)));
    console.log("session line failed", s.game, e); // tried again next time
  }
}

async function editLine(env: Env, s: Session, line: string) {
  if (s.line === line || !s.message_id || s.message_id === "posting") return;
  await api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${s.message_id}`, { content: line, allowed_mentions: { parse: [] } }).catch((e) => {
    if (!isNotFound(e)) throw e; // swept away at 03:00, or deleted by hand: fine
  });
  await env.db.update(sessions).set({ line }).where(and(eq(sessions.day, s.day), eq(sessions.game, s.game)));
}

/** Over: the line says how long it went (or goes, if it never counted). */
async function finishSession(env: Env, s: Session, t: number) {
  const end = s.active_since ? t : (s.idle_since ?? t);
  const final: Session = { ...s, together_secs: s.together_secs + (s.active_since ? t - s.active_since : 0), active_since: null };
  const done = await env.db
    .update(sessions)
    .set({ finished: true, active_since: null, idle_since: s.idle_since ?? end, together_secs: final.together_secs })
    .where(and(eq(sessions.day, s.day), eq(sessions.game, s.game), eq(sessions.finished, false)))
    .returning({ day: sessions.day });
  if (!done.length) return;
  if (!final.counted && final.together_secs >= COUNT_AFTER) await count(env, final);
  if (!s.message_id || s.message_id === "posting") return;
  if (final.counted) await editLine(env, final, doneLine(final, t));
  else {
    await deleteMessage(env, env.GAME_CHANNEL_ID, s.message_id);
    await env.db.update(sessions).set({ message_id: null, line: null }).where(and(eq(sessions.day, s.day), eq(sessions.game, s.game)));
  }
}

/**
 * The day's planned night just started with this game: a session of the same game that day is the
 * night now. It stops counting on its own (the night counts), and its line goes.
 */
export async function absorb(env: Env, day: string, game: string) {
  const [s] = await env.db
    .update(sessions)
    .set({ absorbed: true, finished: true, active_since: null })
    .where(and(eq(sessions.day, day), eq(sessions.game, game), eq(sessions.absorbed, false)))
    .returning();
  if (!s) return;
  if (s.counted) {
    await env.db.update(sessions).set({ counted: false }).where(and(eq(sessions.day, day), eq(sessions.game, game)));
    await env.db.update(gameTable).set({ plays: sql`GREATEST(${gameTable.plays} - 1, 0)` }).where(eq(gameTable.name, game));
  }
  if (s.message_id && s.message_id !== "posting") await deleteMessage(env, env.GAME_CHANNEL_ID, s.message_id);
}

// ---------------------------------------------------------------- the minute job

/**
 * Every minute (the leader's clock): what needs doing even when nobody's in voice to trigger it.
 * Notes past their time go, questions past theirs go, sessions that have sat below two long enough
 * (or whose room went) wrap up.
 */
export async function minute(env: Env, t = nowSec()) {
  const out: Record<string, unknown> = {};
  const due = await env.db.select().from(fleeting).where(lte(fleeting.delete_at, t));
  for (const n of due) {
    await deleteMessage(env, n.channel_id, n.message_id);
    await env.db.delete(fleeting).where(eq(fleeting.message_id, n.message_id));
  }
  if (due.length) out.notes = due.length;

  const [cur] = await env.db.select().from(lobbyPrompts).where(and(eq(lobbyPrompts.current, true), eq(lobbyPrompts.state, "open")));
  if (cur?.posted_at && t - cur.posted_at >= PROMPT_TTL) {
    await closePrompt(env, cur, "expired");
    out.expired = cur.id;
  }

  const finished = await finishDue(env, await voice.openRooms(env), t);
  if (finished.length) out.finished = finished;
  return out;
}

/** Unplanned nights that counted, by day (stats): [{ day, game }]. */
export async function counted(env: Env, fromDay: string, toDay: string) {
  return env.db
    .select({ day: sessions.day, game: sessions.game })
    .from(sessions)
    .where(and(eq(sessions.counted, true), sql`${sessions.day} BETWEEN ${fromDay} AND ${toDay}`))
    .orderBy(desc(sessions.day));
}

