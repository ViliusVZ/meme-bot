// 😴 Snoozing game-night planning: no automatic daily card (17:00, 14:00 on weekends) until the
// snooze runs out. Anyone in the trio can snooze it for 3 days, a week or a month, or wake it back
// up early. Only the automatic card sleeps: 🎮 Play today and 📅 Plan a day still work.
import { eq } from "drizzle-orm";
import type { Env } from "./env.js";
import { settings } from "./db/index.js";
import { api, EPHEMERAL, IS_COMPONENTS_V2 } from "./discord.js";
import { getNight, local, players, pollHour, wallToUnix } from "./gamenight.js";

const KEY = "snooze";
/** `until` is the first local day the daily card is back. */
type Snooze = { until: string; by: string; span?: Span };
export type Span = "3d" | "week" | "month";
const SPANS: Record<Span, string> = { "3d": "3 days", week: "a week", month: "a month" };

const mention = (id: string) => `<@${id}>`;
const pings = (env: Env, users: string[]) => (env.QUIET ? { parse: [] } : { users });

/** A local day shifted by days (and months), as YYYY-MM-DD. */
export function shift(day: string, days: number, months = 0) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d + days)).toISOString().slice(0, 10);
}

/** The snooze in force, if any (one that has run out doesn't count). */
export async function current(env: Env): Promise<Snooze | null> {
  const [row] = await env.db.select().from(settings).where(eq(settings.key, KEY));
  const s = row?.value as Snooze | undefined;
  return s && s.until > local(env).day ? s : null;
}

/** Is the automatic card for `day` snoozed? */
export async function isSnoozed(env: Env, day: string) {
  const s = await current(env);
  return !!s && day < s.until;
}

/** The first day whose automatic card is still to come: today until its poll hour is over (and no card yet), else tomorrow. */
async function nextCardDay(env: Env) {
  const l = local(env);
  return l.hour <= pollHour(env, l.day) && !(await getNight(env, l.day)) ? l.day : shift(l.day, 1);
}

/** When the next automatic card goes out (unix seconds), snooze included. */
export async function nextCard(env: Env) {
  const s = await current(env);
  const first = await nextCardDay(env);
  const day = s && s.until > first ? s.until : first;
  const [y, m, d] = day.split("-").map(Number);
  // in the middle of the poll hour, it's "within a minute"
  return Math.max(wallToUnix(env, y, m, d, pollHour(env, day), 0), Math.floor(Date.now() / 1000) + 60);
}

/** 😴 Snooze the daily card for 3 days, a week or a month, counted from the next one due. */
export async function snooze(env: Env, user: string, span: Span) {
  const from = await nextCardDay(env);
  const until = span === "month" ? shift(from, 0, 1) : shift(from, span === "3d" ? 3 : 7);
  const value: Snooze = { until, by: user, span };
  await env.db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updated_at: new Date() } });
  const next = await nextCard(env);
  await announce(
    env,
    user,
    `😴 ${mention(user)} snoozed game night planning for ${SPANS[span]}: no daily poll until <t:${next}:f> (<t:${next}:R>). 🎮 Play today and 📅 Plan a day still work.`,
  );
  return `✅ Snoozed for ${SPANS[span]}.`;
}

/** ⏰ Wake planning back up. */
export async function wake(env: Env, user: string) {
  if (!(await current(env))) return "Planning isn't snoozed 🙂";
  await env.db.delete(settings).where(eq(settings.key, KEY));
  const next = await nextCard(env);
  await announce(env, user, `⏰ ${mention(user)} woke game night planning back up: the next daily poll is <t:${next}:f> (<t:${next}:R>).`);
  return "✅ Back on.";
}

async function announce(env: Env, user: string, content: string) {
  await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
    content,
    allowed_mentions: pings(
      env,
      players(env).filter((p) => p !== user),
    ),
  }).catch((e) => console.log("snooze announce failed", e));
}

/** The private 😴 panel: what's on, and the snooze buttons. */
export async function panel(env: Env, notice?: string) {
  const s = await current(env);
  const next = await nextCard(env);
  const button = (style: number, emoji: string, label: string, custom_id: string) => ({ type: 2, style, emoji: { name: emoji }, label, custom_id });
  const status = s
    ? `😴 **Planning is snoozed** (by ${mention(s.by)}). The next daily poll is <t:${next}:f> (<t:${next}:R>).`
    : `🎮 **Planning is on.** The next daily poll is <t:${next}:f> (<t:${next}:R>). Need a break? Snooze it:`;
  return {
    flags: IS_COMPONENTS_V2 | EPHEMERAL,
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 17,
        accent_color: s ? 0x4f545c : 0x5865f2,
        components: [
          { type: 10, content: `## 😴 Snooze game night planning${notice ? `\n${notice}` : ""}` },
          { type: 10, content: status },
          {
            type: 1,
            components: [
              button(s?.span === "3d" ? 1 : 2, "😴", "3 days", "snz:3d"),
              button(s?.span === "week" ? 1 : 2, "😴", "1 week", "snz:week"),
              button(s?.span === "month" ? 1 : 2, "😴", "1 month", "snz:month"),
              ...(s ? [button(3, "⏰", "Wake it up", "snz:wake")] : []),
            ],
          },
          { type: 10, content: "-# Only the automatic daily poll sleeps (17:00, 14:00 on weekends). 🎮 Play today and 📅 Plan a day still work. Snoozing again replaces the old snooze." },
        ],
      },
    ],
  };
}
