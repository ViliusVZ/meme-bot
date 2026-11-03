// Daily game-night planner: one card per day that walks through three stages.
//   ask  → "Are we playing today?" (needs every player to say yes)
//   game → pick a game (first to a majority wins; an all-different split is settled by dice)
//   time → everyone picks the earliest time they can start; we start at the latest of those
//   set  → locked in: Discord event + one ping now and one at start time
//   off  → someone bailed, or the day ended before we agreed
import type { Env } from "./index";
import { api, IS_COMPONENTS_V2 } from "./discord";
import { now } from "./db";

type Stage = "ask" | "game" | "time" | "set" | "off";
export interface Night {
  day: string;
  stage: Stage;
  message_id: string | null;
  game: string | null;
  start_at: number | null;
  event_id: string | null;
  reminded: number;
  note: string | null;
  nudge_id: string | null;
}
interface Game {
  name: string;
  emoji: string | null;
  plays: number;
}
type Votes = Record<string, string>; // user id → choice

const OPEN: Stage[] = ["ask", "game", "time"];
const COLORS: Record<Stage, number> = { ask: 0x5865f2, game: 0x57f287, time: 0xfee75c, set: 0xeb459e, off: 0x4f545c };
const SLOT_MS = 30 * 60e3;

export const players = (env: Env) => env.PLAYERS.split(",").map((s) => s.trim()).filter(Boolean);
const majority = (env: Env) => Math.floor(players(env).length / 2) + 1;
const mention = (id: string) => `<@${id}>`;
/** QUIET is set by the admin test route so simulated runs don't notify anyone. */
const pings = (env: Env, users: string[]) => (env.QUIET ? { parse: [] } : { users });
const ts = (sec: number, style: string) => `<t:${sec}:${style}>`;

// ---------------------------------------------------------------- time

/** Wall-clock parts in the server's timezone (Lithuania, so DST is handled for us). */
export function local(env: Env, d = new Date()) {
  const p: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), hm: `${p.hour}:${p.minute}` };
}

/** Half-hour start options, beginning at least 10 minutes from now. */
function slots(env: Env) {
  const today = local(env).day;
  let t = Math.ceil((Date.now() + 10 * 60e3) / SLOT_MS) * SLOT_MS;
  return Array.from({ length: 16 }, () => {
    const l = local(env, new Date(t));
    const slot = { value: String(t / 1000), label: l.day === today ? l.hm : `${l.hm} (after midnight)` };
    t += SLOT_MS;
    return slot;
  });
}

const clock = (env: Env, sec: number) => local(env, new Date(sec * 1000)).hm;

// ---------------------------------------------------------------- storage

const getNight = (env: Env, day: string) => env.DB.prepare("SELECT * FROM game_nights WHERE day = ?").bind(day).first<Night>();

async function votes(env: Env, day: string, stage: Stage): Promise<Votes> {
  const r = await env.DB.prepare("SELECT user_id, choice FROM game_night_votes WHERE day = ? AND stage = ?")
    .bind(day, stage)
    .all<{ user_id: string; choice: string }>();
  return Object.fromEntries(r.results.map((v) => [v.user_id, v.choice]));
}

const vote = (env: Env, day: string, stage: Stage, user: string, choice: string) =>
  env.DB.prepare(
    `INSERT INTO game_night_votes (day, stage, user_id, choice, voted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, stage, user_id) DO UPDATE SET choice = excluded.choice, voted_at = excluded.voted_at`,
  )
    .bind(day, stage, user, choice, now())
    .run();

export async function games(env: Env): Promise<Game[]> {
  const r = await env.DB.prepare("SELECT name, emoji, plays FROM games ORDER BY plays DESC, rowid LIMIT 25").all<Game>();
  return r.results;
}

/** Adds a game if it's new; returns its stored name (names are case-insensitive). */
export async function addGame(env: Env, raw: string, user: string) {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return null;
  await env.DB.prepare("INSERT OR IGNORE INTO games (name, emoji, added_by, added_at) VALUES (?, NULL, ?, ?)")
    .bind(name, user, now())
    .run();
  return (await env.DB.prepare("SELECT name FROM games WHERE name = ?").bind(name).first<{ name: string }>())!.name;
}

export const removeGame = (env: Env, name: string) => env.DB.prepare("DELETE FROM games WHERE name = ?").bind(name).run();

/** Compare-and-set on the stage, so concurrent clicks can only advance a night once. */
async function advance(env: Env, day: string, from: Stage, to: Stage, set: { game?: string; start_at?: number; note?: string | null } = {}) {
  const r = await env.DB.prepare(
    `UPDATE game_nights SET stage = ?, game = COALESCE(?, game), start_at = COALESCE(?, start_at), note = COALESCE(?, note)
     WHERE day = ? AND stage = ?`,
  )
    .bind(to, set.game ?? null, set.start_at ?? null, set.note ?? null, day, from)
    .run();
  return r.meta.changes > 0;
}

function tally(env: Env, v: Votes) {
  const counts = new Map<string, number>();
  for (const p of players(env)) if (v[p]) counts.set(v[p], (counts.get(v[p]) ?? 0) + 1);
  return counts;
}

// ---------------------------------------------------------------- flow

/** Posts today's "are we playing?" card. Cron calls this every 15 min; only the poll hour (or force) posts, once per day. */
export async function startNight(env: Env, force = false) {
  const { day, hour } = local(env);
  await closeStale(env, day);
  if (!force && hour !== Number(env.GAME_POLL_HOUR)) return { skipped: "not poll hour" };
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO game_nights (day, stage, reminded) VALUES (?, 'ask', 0)").bind(day).run();
  if (!ins.meta.changes) return { skipped: "already started", day, night: await getNight(env, day) };
  try {
    const msg = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, await render(env, day));
    await env.DB.prepare("UPDATE game_nights SET message_id = ? WHERE day = ?").bind(msg.id, day).run();
    return { started: day, message_id: msg.id as string };
  } catch (e) {
    await env.DB.prepare("DELETE FROM game_nights WHERE day = ?").bind(day).run();
    throw e;
  }
}

/** Yesterday's unfinished polls get closed so their buttons stop working. */
async function closeStale(env: Env, today: string) {
  const stale = await env.DB.prepare(`SELECT day FROM game_nights WHERE day < ? AND stage IN ('ask', 'game', 'time')`).bind(today).all<{ day: string }>();
  for (const { day } of stale.results) await close(env, day);
}

async function close(env: Env, day: string) {
  const n = await getNight(env, day);
  if (!n || !OPEN.includes(n.stage)) return;
  const note = n.stage === "ask" ? "Not everyone was in. Maybe tomorrow 🫡" : "The day ended before we agreed. Maybe tomorrow 🫡";
  if (await advance(env, day, n.stage, "off", { note })) {
    await clearNudge(env, n);
    await refresh(env, day);
  }
}

/**
 * Stage changes only edit the card, which doesn't notify anyone. When the next stage needs
 * the others' input, ping them once; the previous nudge is deleted so the channel stays tidy.
 */
async function nudge(env: Env, day: string, actor: string, content: string) {
  const n = (await getNight(env, day))!;
  const others = players(env).filter((p) => p !== actor);
  await clearNudge(env, n);
  const m = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
    content: `${others.map(mention).join(" ")} ${content}`,
    allowed_mentions: pings(env, others),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
  await env.DB.prepare("UPDATE game_nights SET nudge_id = ? WHERE day = ?").bind(m.id, day).run();
}

async function clearNudge(env: Env, n: Night) {
  if (!n.nudge_id) return;
  await api(env, "DELETE", `/channels/${env.GAME_CHANNEL_ID}/messages/${n.nudge_id}`).catch(() => {});
  await env.DB.prepare("UPDATE game_nights SET nudge_id = NULL WHERE day = ?").bind(n.day).run();
}

/** Re-render a card in place (used outside interactions, where we can't reply with an update). */
export async function refresh(env: Env, day: string) {
  const n = await getNight(env, day);
  if (n?.message_id) await api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${n.message_id}`, await render(env, day));
}

/**
 * A player clicked something. Returns an error to show privately, or null when the card
 * should simply be re-rendered. Slow side effects (events, pings) go through `defer`.
 */
export async function act(
  env: Env,
  day: string,
  user: string,
  action: string,
  value: string | undefined,
  defer: (p: Promise<unknown>) => void,
): Promise<string | null> {
  const n = await getNight(env, day);
  if (!n) return "This poll has vanished 🫥";
  if (!players(env).includes(user)) return "This one's for the trio 😅";
  if (OPEN.includes(n.stage) && day !== local(env).day) {
    await close(env, day);
    return null;
  }

  switch (action) {
    case "yes":
    case "no":
      if (n.stage !== "ask") return null;
      await vote(env, day, "ask", user, action);
      break;
    case "game":
      if (n.stage !== "game" || !value) return null;
      await vote(env, day, "game", user, value);
      break;
    case "suggest": {
      if (n.stage !== "game") return "Game picking is already over for today.";
      const name = await addGame(env, value ?? "", user);
      if (!name) return "Give the game a name 🙃";
      await vote(env, day, "game", user, name);
      break;
    }
    case "time":
      if (n.stage !== "time" || !value) return null;
      await vote(env, day, "time", user, value);
      break;
    case "out":
      if (n.stage === "set" && (n.start_at ?? 0) < Date.now() / 1000 - 4 * 3600) return "That game night is already history 🕰️";
      if (n.stage === "off" || n.stage === "ask") return null;
      if (await advance(env, day, n.stage, "off", { note: `${mention(user)} can't make it. Maybe tomorrow 🫡` })) {
        defer(n.stage === "set" ? cancelLocked(env, n, user) : clearNudge(env, n));
      }
      return null;
    default:
      return "🤷";
  }
  await settle(env, day, user, defer);
  return null;
}

/** Moves the night forward if the votes allow it. */
async function settle(env: Env, day: string, actor: string, defer: (p: Promise<unknown>) => void) {
  const n = (await getNight(env, day))!;
  const ps = players(env);

  if (n.stage === "ask") {
    const v = await votes(env, day, "ask");
    if (ps.every((p) => v[p] === "yes") && (await advance(env, day, "ask", "game"))) {
      defer(nudge(env, day, actor, "✅ Everyone's in! Pick a game ⬆️"));
    }
    return;
  }

  if (n.stage === "game") {
    const v = await votes(env, day, "game");
    const counts = tally(env, v);
    let winner = [...counts].find(([, c]) => c >= majority(env))?.[0];
    let note: string | null = null;
    if (!winner && ps.every((p) => v[p])) {
      const options = [...counts.keys()];
      winner = options[Math.floor(Math.random() * options.length)];
      note = "🎲 Everyone picked something different, so the dice chose";
    }
    if (winner && (await advance(env, day, "game", "time", { game: winner, note }))) {
      defer(nudge(env, day, actor, `${await emojiFor(env, winner)} **${winner}** it is! When can you start? ⬆️`));
    }
    return;
  }

  if (n.stage === "time") {
    const v = await votes(env, day, "time");
    if (!ps.every((p) => v[p])) return;
    const soonest = Math.ceil((Date.now() / 1000 + 120) / 300) * 300; // if everyone's picks are already past
    const start = Math.max(soonest, ...ps.map((p) => Number(v[p])));
    if (await advance(env, day, "time", "set", { start_at: start })) defer(lockIn(env, day));
  }
}

/** The night is set: create a Discord event and ping everyone once. */
async function lockIn(env: Env, day: string) {
  const n = (await getNight(env, day))!;
  const ps = players(env);
  await clearNudge(env, n);
  await env.DB.prepare("UPDATE games SET plays = plays + 1 WHERE name = ?").bind(n.game).run();
  try {
    const start = n.start_at! * 1000;
    const ev = await api(env, "POST", `/guilds/${env.GUILD_ID}/scheduled-events`, {
      name: `🎮 ${n.game}`,
      description: `Terrible Trio game night: ${n.game}. Planned by Meme Bot 3000.`,
      privacy_level: 2,
      entity_type: 3,
      entity_metadata: { location: "Terrible Trio 🔊" },
      scheduled_start_time: new Date(start).toISOString(),
      scheduled_end_time: new Date(start + 3 * 3600e3).toISOString(),
    });
    await env.DB.prepare("UPDATE game_nights SET event_id = ? WHERE day = ?").bind(ev.id, day).run();
    await refresh(env, day);
  } catch (e) {
    console.log("event failed", e);
  }
  await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
    content: `🎉 ${ps.map(mention).join(" ")} it's on! ${await emojiFor(env, n.game!)} **${n.game}** at ${ts(n.start_at!, "t")} (${ts(n.start_at!, "R")})`,
    allowed_mentions: pings(env, ps),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
}

async function cancelLocked(env: Env, n: Night, user: string) {
  await clearNudge(env, n);
  if (n.event_id) await api(env, "DELETE", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`).catch(() => {});
  const others = players(env).filter((p) => p !== user);
  await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
    content: `😢 ${others.map(mention).join(" ")} ${mention(user)} can't make it, so tonight's **${n.game}** is off.`,
    allowed_mentions: pings(env, others),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
}

/** Cron: ping the squad when a locked-in game night starts. */
export async function remind(env: Env) {
  const nowSec = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare("SELECT * FROM game_nights WHERE stage = 'set' AND reminded = 0 AND start_at <= ?")
    .bind(nowSec + 120)
    .all<Night>();
  const sent: string[] = [];
  for (const n of due.results) {
    const claimed = await env.DB.prepare("UPDATE game_nights SET reminded = 1 WHERE day = ? AND reminded = 0").bind(n.day).run();
    if (!claimed.meta.changes || n.start_at! < nowSec - 1800) continue;
    const ps = players(env);
    await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
      content: `⏰ ${ps.map(mention).join(" ")} ${await emojiFor(env, n.game!)} **${n.game}** starts now! Hop in 🔊`,
      allowed_mentions: pings(env, ps),
      message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
    });
    sent.push(n.day);
  }
  return { reminded: sent };
}

// ---------------------------------------------------------------- rendering

async function emojiFor(env: Env, game: string) {
  const g = await env.DB.prepare("SELECT emoji FROM games WHERE name = ?").bind(game).first<{ emoji: string | null }>();
  return g?.emoji ?? "🎮";
}

const text = (content: string) => ({ type: 10, content });
const row = (...components: unknown[]) => ({ type: 1, components });
const button = (style: number, emoji: string, label: string, custom_id: string) => ({ type: 2, style, emoji: { name: emoji }, label, custom_id });

export async function render(env: Env, day: string) {
  const n = (await getNight(env, day))!;
  const ps = players(env);
  const date = ts(Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000), "D");
  const id = (action: string) => `gn:${day}:${action}`;
  const out = button(2, "🚪", "I'm out", id("out"));
  let body: unknown[];

  switch (n.stage) {
    case "ask": {
      const v = await votes(env, day, "ask");
      const yes = ps.filter((p) => v[p] === "yes").length;
      const no = ps.filter((p) => v[p] === "no").length;
      const status = no
        ? ps.every((p) => v[p])
          ? "😴 Not tonight… unless someone changes their mind before midnight."
          : "Someone's out for now. Votes can change until midnight."
        : `Waiting on ${ps.length - yes} more. It's on when all ${ps.length} say yes.`;
      body = [
        text(`## 🎮 Game night? · ${date}\n### Are we playing today?`),
        text(ps.map((p) => `${v[p] === "yes" ? "✅" : v[p] === "no" ? "❌" : "⏳"} ${mention(p)}`).join("　")),
        text(`-# ${status}`),
        row(button(3, "✅", `I'm in · ${yes}`, id("yes")), button(4, "✖️", `Not today · ${no}`, id("no"))),
      ];
      break;
    }
    case "game": {
      const v = await votes(env, day, "game");
      const list = await games(env);
      const emoji = new Map(list.map((g) => [g.name, g.emoji ?? "🎮"]));
      const picks = [...tally(env, v)]
        .sort((a, b) => b[1] - a[1])
        .map(([g, c]) => `${emoji.get(g) ?? "🎮"} **${g}** · ${c} · ${ps.filter((p) => v[p] === g).map(mention).join(" ")}`);
      const waiting = ps.filter((p) => !v[p]);
      body = [
        text(`## 🕹️ What are we playing? · ${date}\n✅ All ${ps.length} are in!`),
        text(picks.length ? picks.join("\n") : "*No picks yet…*"),
        text(
          `-# First game to ${majority(env)} votes wins · all different → 🎲 dice decide${waiting.length ? ` · waiting on ${waiting.map(mention).join(" ")}` : ""}`,
        ),
        row({
          type: 3,
          custom_id: id("game"),
          placeholder: "🎯 Pick a game…",
          options: list.map((g) => ({
            label: g.name,
            value: g.name,
            emoji: { name: g.emoji ?? "🎮" },
            description: g.plays ? `Played ${g.plays}×` : undefined,
          })),
        }),
        row(button(1, "➕", "Suggest a game", id("suggest")), out),
      ];
      break;
    }
    case "time": {
      const v = await votes(env, day, "time");
      const lines = ps.map((p) => (v[p] ? `🕐 ${mention(p)} from **${clock(env, Number(v[p]))}**` : `⏳ ${mention(p)}`));
      body = [
        text(`## ⏰ What time? · ${date}\n${n.note ? `-# ${n.note}\n` : ""}### ${await emojiFor(env, n.game!)} ${n.game} it is!`),
        text(`Pick the **earliest** time you can start. We kick off when everyone's ready.\n${lines.join("\n")}`),
        row({
          type: 3,
          custom_id: id("time"),
          placeholder: "🕐 I can start from…",
          options: slots(env).map((s) => ({ ...s, emoji: { name: "🕐" } })),
        }),
        row(out),
      ];
      break;
    }
    case "set":
      body = [
        text(`## 🎉 Game night is ON · ${date}`),
        text(
          `### ${await emojiFor(env, n.game!)} ${n.game}\n🕐 **${clock(env, n.start_at!)}** · ${ts(n.start_at!, "R")}\n👥 ${ps.map(mention).join(" ")}`,
        ),
        row(
          ...(n.event_id
            ? [{ type: 2, style: 5, emoji: { name: "📅" }, label: "Event", url: `https://discord.com/events/${env.GUILD_ID}/${n.event_id}` }]
            : []),
          button(2, "🚪", "Can't make it", id("out")),
        ),
      ];
      break;
    case "off":
      body = [text(`## 😴 No game night · ${date}`), text(n.note ?? "Maybe tomorrow 🫡")];
      break;
  }
  return {
    flags: IS_COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [{ type: 17, accent_color: COLORS[n.stage], components: body }],
  };
}

export function suggestModal(day: string) {
  return {
    custom_id: `gn:${day}:suggest`,
    title: "Suggest a game",
    components: [
      {
        type: 1,
        components: [{ type: 4, custom_id: "name", style: 1, label: "Game name", placeholder: "Lethal Company", max_length: 60, required: true }],
      },
    ],
  };
}

/** Testing/maintenance: wipe a day's night (card, votes, event). */
export async function resetNight(env: Env, day: string) {
  const n = await getNight(env, day);
  if (!n) return { reset: false };
  if (n.message_id) await api(env, "DELETE", `/channels/${env.GAME_CHANNEL_ID}/messages/${n.message_id}`).catch(() => {});
  await clearNudge(env, n);
  if (n.event_id) await api(env, "DELETE", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`).catch(() => {});
  await env.DB.batch([
    env.DB.prepare("DELETE FROM game_night_votes WHERE day = ?").bind(day),
    env.DB.prepare("DELETE FROM game_nights WHERE day = ?").bind(day),
  ]);
  return { reset: true };
}
