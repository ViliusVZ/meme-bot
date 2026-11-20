// 📊 Voice time and game stats: calls, hours together, games played, when we play.
//
// Tracking: the gateway reports every join, leave and move the moment it happens (live.ts calls
// track() then), plus a heartbeat every minute while anyone is in voice. Each player's stretch in
// one channel is a segment: started_at → ended_at, to the second. A segment in a game room carries
// that room's game; the Lobby and other channels count as hanging out. If the bot was away
// (a restart), a segment that ended unseen counts until a minute past its last sighting.
//
// Stats: a call is a stretch where at least two of us are in the same channel (hopping from the
// Lobby into a game room together doesn't end it). Game time is time together in that game's room.
// Periods are local (Europe/Vilnius) weeks (Mon–Sun), months and years. 📊 Stats on the panel or
// /gamestats shows any period; a recap is posted in #game-night after each week, month and year.
import { and, eq, gte, lte, lt, min, sql } from "drizzle-orm";
import { Context, Effect, Layer, Match } from "effect";
import { gameNights, rooms, voiceSegments } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig, players } from "./config.js";
import { Discord, type DiscordError, EPHEMERAL, IS_COMPONENTS_V2 } from "./discord.js";
import { calendar, localAt, wallToUnixIn } from "./localtime.js";
import { Memes } from "./memes.js";
import { Games } from "./games.js";
import { Spontaneous } from "./spontaneous.js";
import { nowSec } from "./clock.js";

export type Segment = typeof voiceSegments.$inferSelect;
export type Kind = "week" | "month" | "year" | "all";

const POLL = 60; // heartbeat while anyone's in voice; a segment that ended unseen counts this long past its last sighting
const GAP = 150; // longer than this since the last sighting and we can't vouch for the time in between
const CALL_GAP = 180; // together again within this, in any channel → still the same call
const mention = (u: string) => `<@${u}>`;

/** The bot's time zone and the current unix second (the pure helpers take it). */
export type When = { readonly zone: string; readonly now: number };
const localOf = (w: When, sec = w.now) => localAt(w.zone, sec * 1000);

// ---------------------------------------------------------------- periods

/** Local period bounds (unix seconds); `offset` -1 is the one before the current one. */
export function periodAt(w: When, kind: Kind, offset = 0) {
  const l = localOf(w);
  return Match.value(kind).pipe(
    Match.when("week", () => {
      const dow = calendar(l.y, l.m, l.d).mondayFirst; // Monday = 0
      const monday = l.d - dow + 7 * offset;
      return { from: wallToUnixIn(w.zone, l.y, l.m, monday, 0, 0), to: wallToUnixIn(w.zone, l.y, l.m, monday + 7, 0, 0) };
    }),
    Match.when("month", () => ({ from: wallToUnixIn(w.zone, l.y, l.m + offset, 1, 0, 0), to: wallToUnixIn(w.zone, l.y, l.m + offset + 1, 1, 0, 0) })),
    Match.when("year", () => ({ from: wallToUnixIn(w.zone, l.y + offset, 1, 1, 0, 0), to: wallToUnixIn(w.zone, l.y + offset + 1, 1, 1, 0, 0) })),
    // all time (and a kind we don't know: the admin route passes it unchecked, as before)
    Match.orElse(() => ({ from: 0, to: w.now + 1 })),
  );
}

function periodLabel(zone: string, kind: Kind, offset: number, from: number, to: number, plain = false) {
  if (plain) offset = -99; // no "This week ·" prefix
  const fmt = (sec: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...o }).format(sec * 1000);
  return Match.value(kind).pipe(
    Match.when("all", () => "All time"),
    Match.when("year", () => (offset === 0 ? `This year · ${fmt(from, { year: "numeric" })}` : fmt(from, { year: "numeric" }))),
    Match.when("month", () => `${offset === 0 ? "This month · " : offset === -1 ? "Last month · " : ""}${fmt(from, { month: "long", year: "numeric" })}`),
    // a week (and a kind we don't know, as before)
    Match.orElse(() => {
      const range = `${fmt(from, { day: "numeric", month: "short" })} – ${fmt(to - 1, { day: "numeric", month: "short" })}`;
      return `${offset === 0 ? "This week · " : offset === -1 ? "Last week · " : ""}${range}`;
    }),
  );
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

export type Crunched = {
  total: number;
  calls: Call[];
  perUser: Map<string, number>;
  byGame: Map<string, number>;
  hangout: number;
  firstIn: Map<string, number>;
  nights: { played: number; unplanned: number; upcoming: number; cancelled: number; games: Map<string, number> };
};

/**
 * When a segment ends: when we saw them leave; for a live one (seen within GAP), now; otherwise
 * (ended unseen, or from the old minute-by-minute checks) a minute past the last sighting.
 */
export function segmentEnd(s: Pick<Segment, "ended_at" | "last_seen" | "open">, t: number) {
  if (s.ended_at != null) return s.ended_at;
  if (s.open && t - s.last_seen <= GAP) return t;
  return s.last_seen + POLL;
}

// ---------------------------------------------------------------- rendering

/** 3725 → "1h 02m", 300 → "5m". */
export function dur(sec: number) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "When we play": busiest weekday, usual start, latest finish (after-midnight counts as late). */
function whenWePlay(zone: string, cs: Call[]) {
  if (!cs.length) return null;
  const dayOf = (sec: number) => {
    const l = localAt(zone, sec * 1000);
    return calendar(l.y, l.m, l.d).mondayFirst;
  };
  const perDay = new Array(7).fill(0);
  for (const c of cs) perDay[dayOf(c.start)] += c.end - c.start;
  const busiest = perDay.indexOf(Math.max(...perDay));
  // minutes since 06:00, so 01:00 sorts after 23:00
  const mins = (sec: number) => {
    const l = localAt(zone, sec * 1000);
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

const KINDS: [Kind, string][] = [
  ["week", "Week"],
  ["month", "Month"],
  ["year", "Year"],
  ["all", "All time"],
];

export class Activity extends Context.Service<
  Activity,
  {
    /**
     * Record where everyone is at `t`: extend the segments of people still where they were, close the
     * rest, open new ones. A segment closed within GAP of its last sighting ended at `t` (we saw them
     * go); one older than that ended unseen, somewhere after its last sighting.
     */
    track(where: ReadonlyMap<string, string | null>, t?: number): Effect.Effect<void, DbError>;
    crunch(from: number, to: number): Effect.Effect<Crunched, DbError>;
    /** The stats body for a period (shared by the 📊 panel and the posted recaps). */
    statsBody(title: string, s: Crunched, prev?: Crunched, prevName?: string): Effect.Effect<string[], DbError>;
    /** 📊 The interactive stats panel (private): pick week/month/year/all time, step back and forth, share. */
    statsPanel(kind?: Kind, offset?: number, sharedBy?: string): Effect.Effect<object, DbError>;
    /**
     * Every minute: after each week (Monday), month (the 1st) and year (1 January), from 10:00, post that
     * period's stats in #game-night once. Quiet periods (no calls, no nights) are skipped.
     */
    readonly recaps: Effect.Effect<Record<string, string>, DbError | DiscordError>;
  }
>()("meme-bot/activity") {
  static readonly layer = Layer.effect(
    Activity,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const memes = yield* Memes;
      const games = yield* Games;
      const spontaneous = yield* Spontaneous;
      const trio = Effect.provideService(players, AppConfig, config);
      const zone = config.timezone;
      const when = Effect.map(nowSec, (now): When => ({ zone, now }));

      const crunch = Effect.fn("Activity.crunch")(function* (from: number, to: number) {
        const t = yield* nowSec;
        const raw = yield* db
          .select()
          .from(voiceSegments)
          .where(and(sql`COALESCE(${voiceSegments.ended_at}, ${voiceSegments.last_seen} + ${POLL}) > ${from}`, lt(voiceSegments.started_at, to)));
        const ps = yield* trio;
        const segs = raw
          .filter((s) => ps.includes(s.user_id))
          .map((s) => ({ ...s, started_at: Math.max(s.started_at, from), end: Math.min(segmentEnd(s, t), to, t) }))
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
        const fromDay = localAt(zone, from * 1000).day;
        const toDay = localAt(zone, (to - 1) * 1000).day;
        const nights = yield* db
          .select({ day: gameNights.day, stage: gameNights.stage, game: gameNights.game, start_at: gameNights.start_at, reminded: gameNights.reminded })
          .from(gameNights)
          .where(and(gte(gameNights.day, fromDay), lte(gameNights.day, toDay)));
        const played = nights.filter((n) => n.stage === "set" && n.reminded);
        // 🎮 plus the ones nobody planned: we just ended up playing (spontaneous.ts)
        const unplanned = yield* spontaneous.counted(fromDay, toDay);
        const nightGames = new Map<string, number>();
        for (const g of [...played.map((n) => n.game!), ...unplanned.map((u) => u.game)]) nightGames.set(g, (nightGames.get(g) ?? 0) + 1);

        return {
          total: cs.reduce((s, c) => s + (c.end - c.start), 0),
          calls: cs,
          perUser,
          byGame,
          hangout,
          firstIn,
          nights: {
            played: played.length + unplanned.length,
            unplanned: unplanned.length,
            upcoming: nights.filter((n) => n.stage === "set" && !n.reminded).length,
            cancelled: nights.filter((n) => n.stage === "off").length,
            games: nightGames,
          },
        } satisfies Crunched;
      });

      const statsBody = Effect.fn("Activity.statsBody")(function* (title: string, s: Crunched, prev?: Crunched, prevName?: string) {
        const label = yield* games.label;
        const lines: string[] = [`## 📊 ${title}`];
        if (!s.total && !s.nights.played && !s.nights.cancelled && !s.nights.upcoming) {
          const [since] = yield* db.select({ t: min(voiceSegments.started_at) }).from(voiceSegments);
          lines.push("*Nothing yet: no calls or game nights in this period.*");
          if (since?.t) lines.push(`-# Voice time is tracked since <t:${since.t}:D>.`);
          return lines;
        }

        const longest = s.calls.reduce<Call | null>((a, c) => (!a || c.end - c.start > a.end - a.start ? c : a), null);
        const together = s.total ? [`### 📞 Together · **${dur(s.total)}**`] : ["### 📞 Together", "No calls with two or more of you yet."];
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

        const gameLines = sortDesc(s.byGame).map(([g, sec]) => {
          const n = s.nights.games.get(g) ?? 0;
          return `${label(g)} **${dur(sec)}**${n ? ` · ${n} game night${n === 1 ? "" : "s"}` : ""}`;
        });
        // game nights whose room time we didn't see (say, played in the Lobby)
        for (const [g, n] of sortDesc(s.nights.games)) if (!s.byGame.has(g)) gameLines.push(`${label(g)} · ${n} game night${n === 1 ? "" : "s"}`);
        if (s.hangout >= 60) gameLines.push(`🛋️ Hanging out **${dur(s.hangout)}**`);
        const nightLine = [
          s.nights.played && `🎉 ${s.nights.played} game night${s.nights.played === 1 ? "" : "s"} played${s.nights.unplanned ? ` (${s.nights.unplanned} unplanned)` : ""}`,
          s.nights.cancelled && `😴 ${s.nights.cancelled} called off`,
          s.nights.upcoming && `📅 ${s.nights.upcoming} coming up`,
        ].filter(Boolean);
        if (gameLines.length || nightLine.length) lines.push([`### 🎮 Games`, ...gameLines, ...(nightLine.length ? [`-# ${nightLine.join(" · ")}`] : [])].join("\n"));

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
        const w = whenWePlay(zone, s.calls);
        if (w) lines.push(`### 🕐 When\n${w}`);
        return lines;
      });

      return Activity.of({
        track: Effect.fn("Activity.track")(function* (where: ReadonlyMap<string, string | null>, at?: number) {
          const t = at ?? (yield* nowSec);
          const ps = yield* trio;
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const open = yield* tx.select().from(voiceSegments).where(eq(voiceSegments.open, true));
              const roomList = yield* tx.select({ channel_id: rooms.channel_id, game: rooms.game }).from(rooms);
              const gameOf = new Map(roomList.map((r) => [r.channel_id, r.game]));
              for (const p of ps) {
                const ch = where.get(p) ?? null;
                const seg = open.find((s) => s.user_id === p);
                if (seg && ch === seg.channel_id && t - seg.last_seen <= GAP) {
                  yield* tx.update(voiceSegments).set({ last_seen: Math.max(t, seg.last_seen) }).where(eq(voiceSegments.id, seg.id));
                  continue;
                }
                if (seg) {
                  const seen = t - seg.last_seen <= GAP;
                  yield* tx
                    .update(voiceSegments)
                    .set(seen ? { open: false, last_seen: t, ended_at: t } : { open: false })
                    .where(eq(voiceSegments.id, seg.id));
                }
                if (ch) {
                  // the unique open-segment index makes a racing second check a no-op
                  yield* tx
                    .insert(voiceSegments)
                    .values({ user_id: p, channel_id: ch, game: gameOf.get(ch) ?? null, started_at: t, last_seen: t, open: true })
                    .onConflictDoNothing();
                }
              }
            }),
          );
        }),
        crunch,
        statsBody,
        statsPanel: Effect.fn("Activity.statsPanel")(function* (kind: Kind = "week", offset = 0, sharedBy?: string) {
          const w = yield* when;
          const shared = !!sharedBy;
          const { from, to } = periodAt(w, kind, offset);
          const s = yield* crunch(from, to);
          const prevName = kind === "all" ? undefined : offset === 0 ? `last ${kind}` : `the ${kind} before`;
          const prev = kind === "all" ? undefined : yield* crunch(periodAt(w, kind, offset - 1).from, periodAt(w, kind, offset - 1).to);
          const body = (yield* statsBody(periodLabel(zone, kind, offset, from, to), s, prev, prevName)).map((content) => ({ type: 10, content }));
          const btn = (style: number, label: string, custom_id: string, disabled = false, emoji?: string) => ({
            type: 2,
            style,
            label,
            custom_id,
            disabled,
            ...(emoji ? { emoji: { name: emoji } } : {}),
          });
          const components: unknown[] = [...body];
          if (shared) components.push({ type: 10, content: `-# 📣 Shared by ${mention(sharedBy!)}` });
          else {
            components.push(
              { type: 1, components: KINDS.map(([k, name]) => btn(k === kind ? 1 : 2, name, `st:${k}:0`)) },
              {
                type: 1,
                components: [
                  btn(2, "Earlier", `st:${kind}:${offset - 1}`, kind === "all", "◀️"),
                  btn(2, "Later", `st:${kind}:${offset + 1}`, kind === "all" || offset >= 0, "▶️"),
                  // nothing to show off in an empty period
                  btn(3, "Share in chat", `st:${kind}:${offset}:share`, !s.total && !s.nights.played && !s.nights.cancelled && !s.nights.upcoming, "📣"),
                ],
              },
            );
          }
          return {
            flags: IS_COMPONENTS_V2 | (shared ? 0 : EPHEMERAL),
            allowed_mentions: { parse: [] },
            components: [{ type: 17, accent_color: 0x3498db, components }],
          };
        }),
        recaps: Effect.gen(function* () {
          const w = yield* when;
          const l = localOf(w);
          if (l.hour < 10) return {};
          const done: Record<string, string> = {};
          const due: [Kind, string][] = [];
          const dow = calendar(l.y, l.m, l.d).mondayFirst;
          if (dow === 0) due.push(["week", "Last week"]);
          if (l.d === 1) due.push(["month", "Last month"]);
          if (l.d === 1 && l.m === 1) due.push(["year", "Last year"]);
          for (const [kind] of due) {
            const { from, to } = periodAt(w, kind, -1);
            const key = `games-${kind}:${localOf(w, from).day}`;
            // claim → post is never cut short (architecture §15); a failed post gives the claim back
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                if (!(yield* memes.claimRecap(key))) return;
                yield* Effect.gen(function* () {
                  const s = yield* crunch(from, to);
                  if (!s.total && !s.nights.played) {
                    done[key] = "quiet, skipped";
                    return;
                  }
                  const prev = yield* crunch(periodAt(w, kind, -2).from, periodAt(w, kind, -2).to);
                  const title = `${{ week: "Weekly", month: "Monthly", year: "Yearly" }[kind as "week"]} recap · ${periodLabel(zone, kind, -1, from, to, true)}`;
                  const body = (yield* statsBody(title, s, prev, `the ${kind} before`)).map((content) => ({ type: 10, content }));
                  yield* discord.createMessage(config.gameChannelId, {
                    flags: IS_COMPONENTS_V2,
                    allowed_mentions: { parse: [] },
                    components: [{ type: 17, accent_color: 0x3498db, components: [...body, { type: 10, content: "-# 📊 More on the panel: **Stats**, or **/gamestats**" }] }],
                  });
                  done[key] = "posted";
                }).pipe(Effect.tapError(() => memes.unclaimRecap(key)));
              }),
            );
          }
          return done;
        }).pipe(Effect.withSpan("Activity.recaps")),
      });
    }),
  );
}
