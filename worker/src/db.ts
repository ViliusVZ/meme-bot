import type { Env } from "./index";

export const VOTES = [
  { key: "fire", emoji: "🔥", weight: 3, persona: "🔥 Hype Machine" },
  { key: "lol", emoji: "😂", weight: 2, persona: "😂 Easy Laugh" },
  { key: "dead", emoji: "💀", weight: 2, persona: "💀 Professionally Deceased" },
  { key: "mid", emoji: "🗑️", weight: -1, persona: "🗑️ Certified Hater" },
] as const;
export type VoteKind = (typeof VOTES)[number]["key"];
export type Tally = Partial<Record<VoteKind, number>>;

export interface Meme {
  id: string;
  title: string;
  image: string;
  link: string;
  author: string;
  published: string;
  rank: number | null;
  post_kind: "daily" | "request" | null;
  day: string | null;
  posted_at: string | null;
  requested_by: string | null;
  channel_id: string | null;
  message_id: string | null;
}
export interface Ranked extends Meme {
  score: number;
  votes: number;
}

const SCORE_SQL = `COALESCE(SUM(CASE v.kind ${VOTES.map((v) => `WHEN '${v.key}' THEN ${v.weight}`).join(" ")} END), 0)`;

export const now = () => new Date().toISOString();
export const utcDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);

export function score(t: Tally) {
  return VOTES.reduce((s, v) => s + (t[v.key] ?? 0) * v.weight, 0);
}

export async function ingest(env: Env, memes: Omit<Meme, "post_kind" | "day" | "posted_at" | "requested_by" | "channel_id" | "message_id">[]) {
  const at = now();
  const stmt = env.DB.prepare(
    `INSERT INTO memes (id, title, image, link, author, published, rank, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET rank = excluded.rank, title = excluded.title`,
  );
  if (memes.length)
    await env.DB.batch(memes.map((m) => stmt.bind(m.id, m.title, m.image, m.link, m.author, m.published, m.rank, at)));
  return memes.length;
}

export const getMeme = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM memes WHERE id = ?").bind(id).first<Meme>();

export async function tally(env: Env, memeId: string): Promise<Tally> {
  const { results } = await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM votes WHERE meme_id = ? GROUP BY kind")
    .bind(memeId)
    .all<{ kind: VoteKind; n: number }>();
  return Object.fromEntries(results.map((r) => [r.kind, r.n]));
}

/**
 * Claim a pool meme for posting. The UPDATE only succeeds for an unclaimed meme, and the
 * one_daily_per_day index rejects a second daily for the same day, so two racing callers
 * can never both post.
 */
export async function claim(env: Env, id: string, kind: "daily" | "request", extra: { day?: string; requestedBy?: string }) {
  try {
    const r = await env.DB.prepare(
      "UPDATE memes SET post_kind = ?, day = ?, requested_by = ?, posted_at = ? WHERE id = ? AND post_kind IS NULL",
    )
      .bind(kind, extra.day ?? null, extra.requestedBy ?? null, now(), id)
      .run();
    return r.meta.changes === 1;
  } catch {
    return false; // unique index violation: today's daily already claimed
  }
}

export const unclaim = (env: Env, id: string) =>
  env.DB.prepare("UPDATE memes SET post_kind = NULL, day = NULL, requested_by = NULL, posted_at = NULL WHERE id = ?")
    .bind(id)
    .run();

export const setMessage = (env: Env, id: string, channelId: string, messageId: string) =>
  env.DB.prepare("UPDATE memes SET channel_id = ?, message_id = ? WHERE id = ?").bind(channelId, messageId, id).run();

/** Toggle semantics: same button again removes the vote, a different one switches it. */
export async function castVote(env: Env, memeId: string, userId: string, kind: VoteKind) {
  const prev = await env.DB.prepare("SELECT kind FROM votes WHERE meme_id = ? AND user_id = ?")
    .bind(memeId, userId)
    .first<{ kind: VoteKind }>();
  if (prev?.kind === kind) {
    await env.DB.prepare("DELETE FROM votes WHERE meme_id = ? AND user_id = ?").bind(memeId, userId).run();
    return "removed" as const;
  }
  await env.DB.prepare(
    `INSERT INTO votes (meme_id, user_id, kind, voted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(meme_id, user_id) DO UPDATE SET kind = excluded.kind, voted_at = excluded.voted_at`,
  )
    .bind(memeId, userId, kind, now())
    .run();
  return prev ? ("changed" as const) : ("new" as const);
}

/** Bump the voting streak once per UTC day. Returns the new streak, or null if already counted today. */
export async function bumpStreak(env: Env, userId: string, name: string) {
  const today = utcDay();
  const u = await env.DB.prepare("SELECT streak, best_streak, last_vote_day FROM users WHERE user_id = ?")
    .bind(userId)
    .first<{ streak: number; best_streak: number; last_vote_day: string | null }>();
  if (u?.last_vote_day === today) {
    await env.DB.prepare("UPDATE users SET name = ? WHERE user_id = ?").bind(name, userId).run();
    return null;
  }
  const streak = u?.last_vote_day === utcDay(-1) ? u.streak + 1 : 1;
  const best = Math.max(u?.best_streak ?? 0, streak);
  await env.DB.prepare(
    `INSERT INTO users (user_id, name, streak, best_streak, last_vote_day) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, streak = excluded.streak,
       best_streak = excluded.best_streak, last_vote_day = excluded.last_vote_day`,
  )
    .bind(userId, name, streak, best, today)
    .run();
  return streak;
}

/** A streak only counts if it's still alive (voted today or yesterday). */
export const liveStreak = (u: { streak: number; last_vote_day: string | null } | null) =>
  u && (u.last_vote_day === utcDay() || u.last_vote_day === utcDay(-1)) ? u.streak : 0;

export async function leaderboard(env: Env, sinceIso: string | null, untilIso: string | null, limit: number) {
  const { results } = await env.DB.prepare(
    `SELECT m.*, ${SCORE_SQL} AS score, COUNT(v.user_id) AS votes
     FROM memes m JOIN votes v ON v.meme_id = m.id
     WHERE m.post_kind IS NOT NULL AND m.posted_at >= ? AND m.posted_at < ?
     GROUP BY m.id ORDER BY score DESC, votes DESC, m.posted_at ASC LIMIT ?`,
  )
    .bind(sinceIso ?? "0000", untilIso ?? "9999", limit)
    .all<Ranked>();
  return results;
}

export async function topVoter(env: Env, sinceIso: string, untilIso: string) {
  return env.DB.prepare(
    `SELECT user_id, COUNT(*) AS n FROM votes WHERE voted_at >= ? AND voted_at < ?
     GROUP BY user_id ORDER BY n DESC LIMIT 1`,
  )
    .bind(sinceIso, untilIso)
    .first<{ user_id: string; n: number }>();
}

export async function longestLiveStreak(env: Env) {
  return env.DB.prepare(
    "SELECT user_id, streak FROM users WHERE last_vote_day >= ? ORDER BY streak DESC LIMIT 1",
  )
    .bind(utcDay(-1))
    .first<{ user_id: string; streak: number }>();
}

export async function userStats(env: Env, userId: string) {
  const [kinds, agree, user, summoned] = await env.DB.batch([
    env.DB.prepare("SELECT kind, COUNT(*) AS n FROM votes WHERE user_id = ? GROUP BY kind").bind(userId),
    // share of this user's votes that matched the meme's winning reaction (ties count)
    env.DB.prepare(
      `WITH t AS (SELECT meme_id, kind, COUNT(*) AS c FROM votes GROUP BY meme_id, kind),
            w AS (SELECT meme_id, kind FROM t WHERE c = (SELECT MAX(c) FROM t t2 WHERE t2.meme_id = t.meme_id))
       SELECT COUNT(*) AS total,
              SUM(EXISTS (SELECT 1 FROM w WHERE w.meme_id = v.meme_id AND w.kind = v.kind)) AS agreed
       FROM votes v WHERE v.user_id = ?`,
    ).bind(userId),
    env.DB.prepare("SELECT streak, best_streak, last_vote_day FROM users WHERE user_id = ?").bind(userId),
    env.DB.prepare("SELECT COUNT(*) AS n FROM memes WHERE requested_by = ?").bind(userId),
  ]);
  return {
    kinds: Object.fromEntries((kinds.results as { kind: VoteKind; n: number }[]).map((r) => [r.kind, r.n])) as Tally,
    agree: agree.results[0] as { total: number; agreed: number | null },
    user: (user.results[0] ?? null) as { streak: number; best_streak: number; last_vote_day: string | null } | null,
    summoned: (summoned.results[0] as { n: number }).n,
  };
}

/** Record a recap period; false if it was already posted. */
export async function claimRecap(env: Env, period: string) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO recaps (period, posted_at) VALUES (?, ?)").bind(period, now()).run();
  return r.meta.changes === 1;
}
export const unclaimRecap = (env: Env, period: string) =>
  env.DB.prepare("DELETE FROM recaps WHERE period = ?").bind(period).run();
