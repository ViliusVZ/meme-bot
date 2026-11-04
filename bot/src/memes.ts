// Daily memes: the pool, posting claims, votes, streaks, leaderboards.
import { and, count, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { memes, recaps, users, votes } from "./db/index.js";

export const VOTES = [
  { key: "fire", emoji: "🔥", weight: 3, persona: "🔥 Hype Machine" },
  { key: "lol", emoji: "😂", weight: 2, persona: "😂 Easy Laugh" },
  { key: "dead", emoji: "💀", weight: 2, persona: "💀 Professionally Deceased" },
  { key: "mid", emoji: "🗑️", weight: -1, persona: "🗑️ Certified Hater" },
] as const;
export type VoteKind = (typeof VOTES)[number]["key"];
export type Tally = Partial<Record<VoteKind, number>>;

export type Meme = typeof memes.$inferSelect;
export interface Ranked extends Meme {
  score: number;
  votes: number;
}

const SCORE = sql<number>`COALESCE(SUM(CASE ${votes.kind} ${sql.raw(VOTES.map((v) => `WHEN '${v.key}' THEN ${v.weight}`).join(" "))} END), 0)::int`;

export const now = () => new Date().toISOString();
export const utcDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);

export function score(t: Tally) {
  return VOTES.reduce((s, v) => s + (t[v.key] ?? 0) * v.weight, 0);
}

export type Incoming = Pick<Meme, "id" | "title" | "image" | "link" | "author" | "published" | "rank">;

export async function ingest(env: Env, list: Incoming[]) {
  if (!list.length) return 0;
  const at = now();
  await env.db
    .insert(memes)
    .values(list.map((m) => ({ id: m.id, title: m.title, image: m.image, link: m.link, author: m.author, published: m.published, rank: m.rank, ingested_at: at })))
    .onConflictDoUpdate({ target: memes.id, set: { rank: sql`excluded.rank`, title: sql`excluded.title` } });
  return list.length;
}

export const getMeme = async (env: Env, id: string) => (await env.db.select().from(memes).where(eq(memes.id, id)))[0] ?? null;

export async function tally(env: Env, memeId: string): Promise<Tally> {
  const rows = await env.db.select({ kind: votes.kind, n: count() }).from(votes).where(eq(votes.meme_id, memeId)).groupBy(votes.kind);
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

/**
 * Claim a pool meme for posting. The UPDATE only succeeds for an unclaimed meme, and the
 * one_daily_per_day index rejects a second daily for the same day, so two racing callers
 * can never both post.
 */
export async function claim(env: Env, id: string, kind: "daily" | "request", extra: { day?: string; requestedBy?: string }) {
  try {
    const r = await env.db
      .update(memes)
      .set({ post_kind: kind, day: extra.day ?? null, requested_by: extra.requestedBy ?? null, posted_at: now() })
      .where(and(eq(memes.id, id), isNull(memes.post_kind)))
      .returning({ id: memes.id });
    return r.length === 1;
  } catch {
    return false; // unique index violation: today's daily already claimed
  }
}

export const unclaim = (env: Env, id: string) =>
  env.db.update(memes).set({ post_kind: null, day: null, requested_by: null, posted_at: null }).where(eq(memes.id, id));

export const setMessage = (env: Env, id: string, channelId: string, messageId: string) =>
  env.db.update(memes).set({ channel_id: channelId, message_id: messageId }).where(eq(memes.id, id));

/** Toggle semantics: same button again removes the vote, a different one switches it. */
export async function castVote(env: Env, memeId: string, userId: string, kind: VoteKind) {
  const where = and(eq(votes.meme_id, memeId), eq(votes.user_id, userId));
  const [prev] = await env.db.select({ kind: votes.kind }).from(votes).where(where);
  if (prev?.kind === kind) {
    await env.db.delete(votes).where(where);
    return "removed" as const;
  }
  await env.db
    .insert(votes)
    .values({ meme_id: memeId, user_id: userId, kind, voted_at: now() })
    .onConflictDoUpdate({ target: [votes.meme_id, votes.user_id], set: { kind: sql`excluded.kind`, voted_at: sql`excluded.voted_at` } });
  return prev ? ("changed" as const) : ("new" as const);
}

type StreakRow = { streak: number; best_streak: number; last_vote_day: string | null };

/** Bump the voting streak once per UTC day. Returns the new streak, or null if already counted today. */
export async function bumpStreak(env: Env, userId: string, name: string) {
  const today = utcDay();
  const [u] = await env.db
    .select({ streak: users.streak, best_streak: users.best_streak, last_vote_day: users.last_vote_day })
    .from(users)
    .where(eq(users.user_id, userId));
  if (u?.last_vote_day === today) {
    await env.db.update(users).set({ name }).where(eq(users.user_id, userId));
    return null;
  }
  const streak = u?.last_vote_day === utcDay(-1) ? u.streak + 1 : 1;
  const best = Math.max(u?.best_streak ?? 0, streak);
  await env.db
    .insert(users)
    .values({ user_id: userId, name, streak, best_streak: best, last_vote_day: today })
    .onConflictDoUpdate({ target: users.user_id, set: { name, streak, best_streak: best, last_vote_day: today } });
  return streak;
}

/** A streak only counts if it's still alive (voted today or yesterday). */
export const liveStreak = (u: Pick<StreakRow, "streak" | "last_vote_day"> | null) =>
  u && (u.last_vote_day === utcDay() || u.last_vote_day === utcDay(-1)) ? u.streak : 0;

export async function leaderboard(env: Env, sinceIso: string | null, untilIso: string | null, limit: number): Promise<Ranked[]> {
  return env.db
    .select({ ...getMemeColumns(), score: SCORE, votes: sql<number>`COUNT(${votes.user_id})::int` })
    .from(memes)
    .innerJoin(votes, eq(votes.meme_id, memes.id))
    .where(and(sql`${memes.post_kind} IS NOT NULL`, gte(memes.posted_at, sinceIso ?? "0000"), lt(memes.posted_at, untilIso ?? "9999")))
    .groupBy(memes.id)
    .orderBy(desc(SCORE), desc(sql`COUNT(${votes.user_id})`), memes.posted_at)
    .limit(limit);
}

function getMemeColumns() {
  const { id, title, image, link, author, published, rank, ingested_at, post_kind, day, posted_at, requested_by, channel_id, message_id } = memes;
  return { id, title, image, link, author, published, rank, ingested_at, post_kind, day, posted_at, requested_by, channel_id, message_id };
}

export async function topVoter(env: Env, sinceIso: string, untilIso: string) {
  const [r] = await env.db
    .select({ user_id: votes.user_id, n: count() })
    .from(votes)
    .where(and(gte(votes.voted_at, sinceIso), lt(votes.voted_at, untilIso)))
    .groupBy(votes.user_id)
    .orderBy(desc(count()))
    .limit(1);
  return r ?? null;
}

export async function longestLiveStreak(env: Env) {
  const [r] = await env.db
    .select({ user_id: users.user_id, streak: users.streak })
    .from(users)
    .where(gte(users.last_vote_day, utcDay(-1)))
    .orderBy(desc(users.streak))
    .limit(1);
  return r ?? null;
}

export async function userStats(env: Env, userId: string) {
  const [kinds, agree, user, summoned] = await Promise.all([
    env.db.select({ kind: votes.kind, n: count() }).from(votes).where(eq(votes.user_id, userId)).groupBy(votes.kind),
    // share of this user's votes that matched the meme's winning reaction (ties count)
    env.db.execute<{ total: number; agreed: number | null }>(sql`
      WITH t AS (SELECT meme_id, kind, COUNT(*) AS c FROM votes GROUP BY meme_id, kind),
           w AS (SELECT meme_id, kind FROM t WHERE c = (SELECT MAX(c) FROM t t2 WHERE t2.meme_id = t.meme_id))
      SELECT COUNT(*)::int AS total,
             SUM(CASE WHEN EXISTS (SELECT 1 FROM w WHERE w.meme_id = v.meme_id AND w.kind = v.kind) THEN 1 ELSE 0 END)::int AS agreed
      FROM votes v WHERE v.user_id = ${userId}`),
    env.db
      .select({ streak: users.streak, best_streak: users.best_streak, last_vote_day: users.last_vote_day })
      .from(users)
      .where(eq(users.user_id, userId)),
    env.db.select({ n: count() }).from(memes).where(eq(memes.requested_by, userId)),
  ]);
  return {
    kinds: Object.fromEntries(kinds.map((r) => [r.kind, r.n])) as Tally,
    agree: agree.rows[0],
    user: (user[0] ?? null) as StreakRow | null,
    summoned: summoned[0].n,
  };
}

/** Record a recap period; false if it was already posted. */
export async function claimRecap(env: Env, period: string) {
  const r = await env.db.insert(recaps).values({ period, posted_at: now() }).onConflictDoNothing().returning({ period: recaps.period });
  return r.length === 1;
}
export const unclaimRecap = (env: Env, period: string) => env.db.delete(recaps).where(eq(recaps.period, period));
