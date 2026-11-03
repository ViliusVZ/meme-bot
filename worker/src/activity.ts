// 📊 Voice time and game stats: calls, hours together, games played, when we play.
//
// Tracking: the bot has no gateway, so once a minute (voice.watchVoice, inside the lingering tick)
// it looks up which voice channel each player is in. Each player's stretch in one channel is a
// segment (first seen → last seen), so everything is accurate to about a minute. A segment in a
// game room carries that room's game; the Lobby and other channels count as hanging out.
//
// Stats: a call is a stretch where at least two of us are in the same channel (hopping from the
// Lobby into a game room together doesn't end it). Game time is time together in that game's room.
// Periods are local (Europe/Vilnius) weeks (Mon–Sun), months and years. 📊 Stats on the panel or
// /gamestats shows any period; a recap is posted in #game-night after each week, month and year.
import type { Env } from "./index";
import { api, EPHEMERAL, IS_COMPONENTS_V2 } from "./discord";
import { claimRecap, unclaimRecap } from "./db";
import { local, players, wallToUnix, gameLabel } from "./gamenight";

export interface Segment {
  id: number;
  user_id: string;
  channel_id: string;
  game: string | null;
  started_at: number;
  last_seen: number;
  open: number;
}
export type Kind = "week" | "month" | "year" | "all";

const POLL = 60; // seconds between voice checks; each segment is credited one poll past its last sighting
const GAP = 150; // a missed check or two doesn't split a segment
const CALL_GAP = 180; // together again within this, in any channel → still the same call
const nowSec = () => Math.floor(Date.now() / 1000);
const mention = (u: string) => `<@${u}>`;

// ---------------------------------------------------------------- tracking

/** One voice check: extend the segments of people still where they were, close the rest, open new ones. */
export async function track(env: Env, where: Map<string, string | null>, t = nowSec()) {
  const open = (await env.DB.prepare("SELECT * FROM voice_segments WHERE open = 1").all<Segment>()).results;
  const rooms = (await env.DB.prepare("SELECT channel_id, game FROM rooms").all<{ channel_id: string; game: string }>()).results;
  const gameOf = new Map(rooms.map((r) => [r.channel_id, r.game]));
  const stmts: D1PreparedStatement[] = [];
  for (const p of players(env)) {
    const ch = where.get(p) ?? null;
    const seg = open.find((s) => s.user_id === p);
    if (seg && ch === seg.channel_id && t - seg.last_seen <= GAP) {
      stmts.push(env.DB.prepare("UPDATE voice_segments SET last_seen = ? WHERE id = ?").bind(t, seg.id));
      continue;
    }
    if (seg) stmts.push(env.DB.prepare("UPDATE voice_segments SET open = 0 WHERE id = ?").bind(seg.id));
    if (ch) {
      // the unique open-segment index makes a racing second check a no-op
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO voice_segments (user_id, channel_id, game, started_at, last_seen, open) VALUES (?, ?, ?, ?, ?, 1)").bind(
          p,
          ch,
          gameOf.get(ch) ?? null,
          t,
          t,
        ),
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// ---------------------------------------------------------------- periods

/** Local period bounds (unix seconds); `offset` -1 is the one before the current one. */
export function period(env: Env, kind: Kind, offset = 0) {
  const l = local(env);
  if (kind === "week") {
    const dow = (new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay() + 6) % 7; // Monday = 0
    const monday = l.d - dow + 7 * offset;
    return { from: wallToUnix(env, l.y, l.m, monday, 0, 0), to: wallToUnix(env, l.y, l.m, monday + 7, 0, 0) };
  }
  if (kind === "month") return { from: wallToUnix(env, l.y, l.m + offset, 1, 0, 0), to: wallToUnix(env, l.y, l.m + offset + 1, 1, 0, 0) };
  if (kind === "year") return { from: wallToUnix(env, l.y + offset, 1, 1, 0, 0), to: wallToUnix(env, l.y + offset + 1, 1, 1, 0, 0) };
  return { from: 0, to: nowSec() + 1 };
}

function periodLabel(env: Env, kind: Kind, offset: number, from: number, to: number, plain = false) {
  if (plain) offset = -99; // no "This week ·" prefix
  const fmt = (sec: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: env.TIMEZONE, ...o }).format(new Date(sec * 1000));
  if (kind === "all") return "All time";
  if (kind === "year") return offset === 0 ? `This year · ${fmt(from, { year: "numeric" })}` : fmt(from, { year: "numeric" });
  if (kind === "month") return `${offset === 0 ? "This month · " : offset === -1 ? "Last month · " : ""}${fmt(from, { month: "long", year: "numeric" })}`;
  const range = `${fmt(from, { day: "numeric", month: "short" })} – ${fmt(to - 1, { day: "numeric", month: "short" })}`;
  return `${offset === 0 ? "This week · " : offset === -1 ? "Last week · " : ""}${range}`;
}

// ---------------------------------------------------------------- crunching

type Interval = { start: number; end: number; who: Set<string>; channel: string; game: string | null };
export type Call = { start: number; end: number; who: Set<string>; firstIn: string; games: Map<string, number> };

/** Stretches with two or more of us in the same channel. */
function togetherIntervals(segs: (Segment & { end: number })[]) {
  const out: Interval[] = [];
  const byChannel = new Map<string, (Segment & { end: number })[]>();
  for (const s of segs) byChannel.set(s.channel_id, [...(byChannel.get(s.channel_id) ?? []), s]);
  for (const [channel, list] of byChannel) {
    const cuts = [...new Set(list.flatMap((s) => [s.started_at, s.end]))].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      const here = list.filter((s) => s.started_at <= a && s.end >= b);
      if (new Set(here.map((s) => s.user_id)).size < 2) continue;
      const game = here.find((s) => s.game)?.game ?? null;
      const prev = out[out.length - 1];
      if (prev && prev.channel === channel && prev.end === a && prev.game === game) {
        prev.end = b;
        for (const s of here) prev.who.add(s.user_id);
      } else out.push({ start: a, end: b, who: new Set(here.map((s) => s.user_id)), channel, game });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Together-stretches merged into calls (short gaps and channel hops don't end a call). */
function calls(intervals: Interval[], segs: (Segment & { end: number })[]): Call[] {
  const out: Call[] = [];
  for (const iv of intervals) {
    const last = out[out.length - 1];
    const call = last && iv.start - last.end <= CALL_GAP ? last : null;
    const target = call ?? { start: iv.start, end: iv.end, who: new Set<string>(), firstIn: "", games: new Map<string, number>() };
    target.end = Math.max(target.end, iv.end);
    for (const u of iv.who) target.who.add(u);
    if (iv.game) target.games.set(iv.game, (target.games.get(iv.game) ?? 0) + (iv.end - iv.start));
    if (!call) out.push(target);
  }
  // who was in voice first, in the run-up to each call
  for (const c of out) {
    const before = segs.filter((s) => c.who.has(s.user_id) && s.started_at <= c.start && s.end >= c.start - CALL_GAP);
    c.firstIn = before.sort((a, b) => a.started_at - b.started_at)[0]?.user_id ?? [...c.who][0];
  }
  return out;
}

export async function crunch(env: Env, from: number, to: number) {
  const t = nowSec();
  const raw = (await env.DB.prepare("SELECT * FROM voice_segments WHERE last_seen + ? > ? AND started_at < ?").bind(POLL, from, to).all<Segment>()).results;
  const ps = players(env);
  const segs = raw
    .filter((s) => ps.includes(s.user_id))
    .map((s) => ({ ...s, started_at: Math.max(s.started_at, from), end: Math.min(s.last_seen + POLL, to, t) }))
    .filter((s) => s.end > s.started_at);
  const together = togetherIntervals(segs);
  const cs = calls(together, segs);

  const perUser = new Map(ps.map((p) => [p, 0]));
  for (const s of segs) perUser.set(s.user_id, perUser.get(s.user_id)! + (s.end - s.started_at));
  const byGame = new Map<string, number>();
  let hangout = 0;
  for (const iv of together) {
    if (iv.game) byGame.set(iv.game, (byGame.get(iv.game) ?? 0) + (iv.end - iv.start));
    else hangout += iv.end - iv.start;
  }
  const firstIn = new Map<string, number>();
  for (const c of cs) firstIn.set(c.firstIn, (firstIn.get(c.firstIn) ?? 0) + 1);

  // game nights in the period (by start time, or by day for nights that never got a time)
  const fromDay = local(env, new Date(from * 1000)).day;
  const toDay = local(env, new Date((to - 1) * 1000)).day;
  const nights = (
    await env.DB.prepare("SELECT day, stage, game, start_at, reminded FROM game_nights WHERE day >= ? AND day <= ?").bind(fromDay, toDay).all<{
      day: string;
      stage: string;
      game: string | null;
      start_at: number | null;
      reminded: number;
    }>()
  ).results;
  const played = nights.filter((n) => n.stage === "set" && n.reminded);
  const nightGames = new Map<string, number>();
  for (const n of played) nightGames.set(n.game!, (nightGames.get(n.game!) ?? 0) + 1);

  return {
    total: cs.reduce((s, c) => s + (c.end - c.start), 0),
    calls: cs,
    perUser,
    byGame,
    hangout,
    firstIn,
    nights: {
      played: played.length,
      upcoming: nights.filter((n) => n.stage === "set" && !n.reminded).length,
      cancelled: nights.filter((n) => n.stage === "off").length,
      games: nightGames,
    },
  };
}
export type Crunched = Awaited<ReturnType<typeof crunch>>;

// ---------------------------------------------------------------- rendering

/** 3725 → "1h 02m", 300 → "5m". */
export function dur(sec: number) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "When we play": busiest weekday, usual start, latest finish (after-midnight counts as late). */
function when(env: Env, cs: Call[]) {
  if (!cs.length) return null;
  const dayOf = (sec: number) => {
    const l = local(env, new Date(sec * 1000));
    return (new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay() + 6) % 7;
  };
  const perDay = new Array(7).fill(0);
  for (const c of cs) perDay[dayOf(c.start)] += c.end - c.start;
  const busiest = perDay.indexOf(Math.max(...perDay));
  // minutes since 06:00, so 01:00 sorts after 23:00
  const mins = (sec: number) => {
    const l = local(env, new Date(sec * 1000));
    return (l.hour * 60 + l.minute - 360 + 1440) % 1440;
  };
  const hm = (m: number) => {
    const x = (m + 360) % 1440;
    return `${x < 360 ? "🌙 " : ""}${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
  };
  const starts = cs.map((c) => mins(c.start)).sort((a, b) => a - b);
  const latest = cs.reduce((a, c) => (mins(c.end) > mins(a.end) ? c : a));
  const parts = [`busiest day **${WEEKDAYS[busiest]}**`, `usually starting around **${hm(starts[Math.floor(starts.length / 2)])}**`];
  if (cs.length > 1 || mins(latest.end) > 18 * 60) parts.push(`latest finish **${hm(mins(latest.end))}** (${WEEKDAYS[dayOf(latest.start)].slice(0, 3)})`);
  return parts.join(" · ");
}

function sortDesc(m: Map<string, number>) {
  return [...m].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}

/** The stats body for a period (shared by the 📊 panel and the posted recaps). */
export async function statsBody(env: Env, title: string, s: Crunched, prev?: Crunched, prevName?: string) {
  const label = await gameLabel(env);
  const lines: string[] = [`## 📊 ${title}`];
  if (!s.total && !s.nights.played && !s.nights.cancelled && !s.nights.upcoming) {
    const since = await env.DB.prepare("SELECT MIN(started_at) t FROM voice_segments").first<{ t: number | null }>();
    lines.push("*Nothing yet: no calls or game nights in this period.*");
    if (since?.t) lines.push(`-# Voice time is tracked since <t:${since.t}:D>.`);
    return lines;
  }

  const longest = s.calls.reduce<Call | null>((a, c) => (!a || c.end - c.start > a.end - a.start ? c : a), null);
  const together = [`### 📞 Together · **${dur(s.total)}**`];
  if (s.calls.length) {
    together.push(
      `${s.calls.length} call${s.calls.length === 1 ? "" : "s"} · longest **${dur(longest!.end - longest!.start)}** (<t:${longest!.start}:f>)${s.calls.length > 1 ? ` · average ${dur(s.total / s.calls.length)}` : ""}`,
    );
  }
  if (prev && prevName) {
    const d = s.total - prev.total;
    if (prev.total || s.total) together.push(`-# ${d > 0 ? `⬆️ ${dur(d)} more` : d < 0 ? `⬇️ ${dur(-d)} less` : "Same"} than ${prevName}`);
  }
  lines.push(together.join("\n"));

  const games = sortDesc(s.byGame).map(([g, sec]) => {
    const n = s.nights.games.get(g) ?? 0;
    return `${label(g)} **${dur(sec)}**${n ? ` · ${n} game night${n === 1 ? "" : "s"}` : ""}`;
  });
  // game nights whose room time we didn't see (say, played in the Lobby)
  for (const [g, n] of sortDesc(s.nights.games)) if (!s.byGame.has(g)) games.push(`${label(g)} · ${n} game night${n === 1 ? "" : "s"}`);
  if (s.hangout >= 60) games.push(`🛋️ Hanging out **${dur(s.hangout)}**`);
  const nightLine = [
    s.nights.played && `🎉 ${s.nights.played} game night${s.nights.played === 1 ? "" : "s"} played`,
    s.nights.cancelled && `😴 ${s.nights.cancelled} called off`,
    s.nights.upcoming && `📅 ${s.nights.upcoming} coming up`,
  ].filter(Boolean);
  if (games.length || nightLine.length) lines.push([`### 🎮 Games`, ...games, ...(nightLine.length ? [`-# ${nightLine.join(" · ")}`] : [])].join("\n"));

  const people = sortDesc(s.perUser);
  if (people.length) {
    const first = sortDesc(s.firstIn)[0];
    lines.push(
      [
        "### 👥 Voice time",
        people.map(([u, sec], i) => `${["🥇", "🥈", "🥉"][i] ?? "•"} ${mention(u)} **${dur(sec)}**`).join("\n"),
        ...(first && s.calls.length > 1 ? [`-# 🚪 First one in: ${mention(first[0])} (${first[1]}×)`] : []),
      ].join("\n"),
    );
  }
  const w = when(env, s.calls);
  if (w) lines.push(`### 🕐 When\n${w}`);
  return lines;
}

const KINDS: [Kind, string][] = [
  ["week", "Week"],
  ["month", "Month"],
  ["year", "Year"],
  ["all", "All time"],
];

/** 📊 The interactive stats panel (private): pick week/month/year/all time, step back and forth, share. */
export async function statsPanel(env: Env, kind: Kind = "week", offset = 0, shared = false) {
  const { from, to } = period(env, kind, offset);
  const s = await crunch(env, from, to);
  const prevName = kind === "all" ? undefined : offset === 0 ? `last ${kind}` : `the ${kind} before`;
  const prev = kind === "all" ? undefined : await crunch(env, period(env, kind, offset - 1).from, period(env, kind, offset - 1).to);
  const body = (await statsBody(env, periodLabel(env, kind, offset, from, to), s, prev, prevName)).map((content) => ({ type: 10, content }));
  const btn = (style: number, label: string, custom_id: string, disabled = false, emoji?: string) => ({
    type: 2,
    style,
    label,
    custom_id,
    disabled,
    ...(emoji ? { emoji: { name: emoji } } : {}),
  });
  const components: unknown[] = [...body];
  if (!shared) {
    components.push(
      { type: 1, components: KINDS.map(([k, name]) => btn(k === kind ? 1 : 2, name, `st:${k}:0`)) },
      {
        type: 1,
        components: [
          btn(2, "Earlier", `st:${kind}:${offset - 1}`, kind === "all", "◀️"),
          btn(2, "Later", `st:${kind}:${offset + 1}`, kind === "all" || offset >= 0, "▶️"),
          btn(3, "Share in chat", `st:${kind}:${offset}:share`, false, "📣"),
        ],
      },
    );
  }
  return {
    flags: IS_COMPONENTS_V2 | (shared ? 0 : EPHEMERAL),
    allowed_mentions: { parse: [] },
    components: [{ type: 17, accent_color: 0x3498db, components }],
  };
}

// ---------------------------------------------------------------- recaps

/**
 * Tick: after each week (Monday), month (the 1st) and year (1 January), from 10:00, post that
 * period's stats in #game-night once. Quiet periods (no calls, no nights) are skipped.
 */
export async function recaps(env: Env) {
  const l = local(env);
  if (l.hour < 10) return {};
  const done: Record<string, string> = {};
  const due: [Kind, string][] = [];
  const dow = (new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay() + 6) % 7;
  if (dow === 0) due.push(["week", "Last week"]);
  if (l.d === 1) due.push(["month", "Last month"]);
  if (l.d === 1 && l.m === 1) due.push(["year", "Last year"]);
  for (const [kind] of due) {
    const { from, to } = period(env, kind, -1);
    const key = `games-${kind}:${local(env, new Date(from * 1000)).day}`;
    if (!(await claimRecap(env, key))) continue;
    try {
      const s = await crunch(env, from, to);
      if (!s.total && !s.nights.played) {
        done[key] = "quiet, skipped";
        continue;
      }
      const prev = await crunch(env, period(env, kind, -2).from, period(env, kind, -2).to);
      const title = `${{ week: "Weekly", month: "Monthly", year: "Yearly" }[kind as "week"]} recap · ${periodLabel(env, kind, -1, from, to, true)}`;
      const body = (await statsBody(env, title, s, prev, `the ${kind} before`)).map((content) => ({ type: 10, content }));
      await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
        flags: IS_COMPONENTS_V2,
        allowed_mentions: { parse: [] },
        components: [{ type: 17, accent_color: 0x3498db, components: [...body, { type: 10, content: "-# 📊 More on the panel: **Stats**, or **/gamestats**" }] }],
      });
      done[key] = "posted";
    } catch (e) {
      await unclaimRecap(env, key);
      throw e;
    }
  }
  return done;
}
