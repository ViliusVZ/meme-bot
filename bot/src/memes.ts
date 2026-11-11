// Daily memes: the pool, posting claims, votes, streaks, leaderboards.
import { and, count, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";
import type { Env } from "./env.js";
import { memes, recaps, users, votes } from "./db/index.js";
import { Db, type DbError } from "./db/db.js";
import { nowIso } from "./clock.js";
import { run, runSync } from "./legacy.js"; // LEGACY-BRIDGE

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

/** The UTC day `offsetDays` from `ms`: "2026-11-06". */
export const utcDayAt = (ms: number, offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms + offsetDays * 864e5);
/** The UTC day `offsetDays` from now. */
export const utcDayNow = (offsetDays = 0) => Effect.map(Clock.currentTimeMillis, (ms) => utcDayAt(ms, offsetDays));

export function score(t: Tally) {
  return VOTES.reduce((s, v) => s + (t[v.key] ?? 0) * v.weight, 0);
}

export type Incoming = Pick<Meme, "id" | "title" | "image" | "link" | "author" | "published" | "rank">;
type StreakRow = { streak: number; best_streak: number; last_vote_day: string | null };

export interface UserStats {
  kinds: Tally;
  agree: { total: number; agreed: number | null };
  user: StreakRow | null;
  summoned: number;
}

function getMemeColumns() {
  const { id, title, image, link, author, published, rank, ingested_at, post_kind, day, posted_at, requested_by, channel_id, message_id } = memes;
  return { id, title, image, link, author, published, rank, ingested_at, post_kind, day, posted_at, requested_by, channel_id, message_id };
}

export class Memes extends Context.Service<
  Memes,
  {
    ingest(incoming: ReadonlyArray<Incoming>): Effect.Effect<number, DbError>;
    get(id: string): Effect.Effect<Meme | null, DbError>;
    tally(memeId: string): Effect.Effect<Tally, DbError>;
    /** Who voted what on a meme, in voting order: { lol: ["id1", "id2"], … }. */
    voters(memeId: string): Effect.Effect<Partial<Record<VoteKind, string[]>>, DbError>;
    /**
     * Claim a pool meme for posting. The UPDATE only succeeds for an unclaimed meme, and the
     * one_daily_per_day index rejects a second daily for the same day, so two racing callers
     * can never both post. Gives false when it's taken (or the database refused).
     */
    claim(id: string, kind: "daily" | "request", extra: { day?: string; requestedBy?: string }): Effect.Effect<boolean>;
    unclaim(id: string): Effect.Effect<void, DbError>;
    setMessage(id: string, channelId: string | undefined, messageId: string): Effect.Effect<void, DbError>;
    /** Toggle semantics: same button again removes the vote, a different one switches it. */
    castVote(memeId: string, userId: string, kind: VoteKind): Effect.Effect<"removed" | "changed" | "new", DbError>;
    /** Bump the voting streak once per UTC day. Gives the new streak, or null if already counted today. */
    bumpStreak(userId: string, name: string): Effect.Effect<number | null, DbError>;
    /** A streak only counts if it's still alive (voted today or yesterday). */
    liveStreak(u: Pick<StreakRow, "streak" | "last_vote_day"> | null): Effect.Effect<number>;
    leaderboard(sinceIso: string | null, untilIso: string | null, limit: number): Effect.Effect<Ranked[], DbError>;
    topVoter(sinceIso: string, untilIso: string): Effect.Effect<{ user_id: string; n: number } | null, DbError>;
    readonly longestLiveStreak: Effect.Effect<{ user_id: string; streak: number } | null, DbError>;
    userStats(userId: string): Effect.Effect<UserStats, DbError>;
    /** Record a recap period; false if it was already posted. */
    claimRecap(period: string): Effect.Effect<boolean, DbError>;
    unclaimRecap(period: string): Effect.Effect<void, DbError>;
  }
>()("meme-bot/memes") {
  static readonly layer = Layer.effect(
    Memes,
    Effect.gen(function* () {
      const db = yield* Db;
      const liveStreak = Effect.fn("Memes.liveStreak")(function* (u: Pick<StreakRow, "streak" | "last_vote_day"> | null) {
        return u && (u.last_vote_day === (yield* utcDayNow()) || u.last_vote_day === (yield* utcDayNow(-1))) ? u.streak : 0;
      });
      return Memes.of({
        ingest: Effect.fn("Memes.ingest")(function* (incoming: ReadonlyArray<Incoming>) {
          // one row per id (Postgres won't upsert the same row twice in one statement)
          const list = [...new Map(incoming.map((m) => [m.id, m])).values()];
          if (!list.length) return 0;
          const at = yield* nowIso;
          yield* db
            .insert(memes)
            .values(list.map((m) => ({ id: m.id, title: m.title, image: m.image, link: m.link, author: m.author, published: m.published, rank: m.rank, ingested_at: at })))
            .onConflictDoUpdate({ target: memes.id, set: { rank: sql`excluded.rank`, title: sql`excluded.title` } });
          return list.length;
        }),
        get: Effect.fn("Memes.get")(function* (id: string) {
          return (yield* db.select().from(memes).where(eq(memes.id, id)))[0] ?? null;
        }),
        tally: Effect.fn("Memes.tally")(function* (memeId: string) {
          const rows = yield* db.select({ kind: votes.kind, n: count() }).from(votes).where(eq(votes.meme_id, memeId)).groupBy(votes.kind);
          return Object.fromEntries(rows.map((r) => [r.kind, r.n])) as Tally;
        }),
        voters: Effect.fn("Memes.voters")(function* (memeId: string) {
          const rows = yield* db.select({ kind: votes.kind, user: votes.user_id }).from(votes).where(eq(votes.meme_id, memeId)).orderBy(votes.voted_at);
          const out: Partial<Record<VoteKind, string[]>> = {};
          for (const r of rows) (out[r.kind] ??= []).push(r.user);
          return out;
        }),
        claim: Effect.fn("Memes.claim")(function* (id: string, kind: "daily" | "request", extra: { day?: string; requestedBy?: string }) {
          const at = yield* nowIso;
          const r = yield* db
            .update(memes)
            .set({ post_kind: kind, day: extra.day ?? null, requested_by: extra.requestedBy ?? null, posted_at: at })
            .where(and(eq(memes.id, id), isNull(memes.post_kind)))
            .returning({ id: memes.id })
            .pipe(
              // unique index violation: today's daily already claimed (any refusal counts as not claimed, as always)
              Effect.catchTag("EffectDrizzleQueryError", () => Effect.succeed([])),
            );
          return r.length === 1;
        }),
        unclaim: Effect.fn("Memes.unclaim")(function* (id: string) {
          yield* db.update(memes).set({ post_kind: null, day: null, requested_by: null, posted_at: null }).where(eq(memes.id, id));
        }),
        setMessage: Effect.fn("Memes.setMessage")(function* (id: string, channelId: string | undefined, messageId: string) {
          yield* db.update(memes).set({ channel_id: channelId, message_id: messageId }).where(eq(memes.id, id));
        }),
        castVote: Effect.fn("Memes.castVote")(function* (memeId: string, userId: string, kind: VoteKind) {
          const where = and(eq(votes.meme_id, memeId), eq(votes.user_id, userId));
          const [prev] = yield* db.select({ kind: votes.kind }).from(votes).where(where);
          if (prev?.kind === kind) {
            yield* db.delete(votes).where(where);
            return "removed" as const;
          }
          yield* db
            .insert(votes)
            .values({ meme_id: memeId, user_id: userId, kind, voted_at: yield* nowIso })
            .onConflictDoUpdate({ target: [votes.meme_id, votes.user_id], set: { kind: sql`excluded.kind`, voted_at: sql`excluded.voted_at` } });
          return prev ? ("changed" as const) : ("new" as const);
        }),
        bumpStreak: Effect.fn("Memes.bumpStreak")(function* (userId: string, name: string) {
          const today = yield* utcDayNow();
          const [u] = yield* db
            .select({ streak: users.streak, best_streak: users.best_streak, last_vote_day: users.last_vote_day })
            .from(users)
            .where(eq(users.user_id, userId));
          if (u?.last_vote_day === today) {
            yield* db.update(users).set({ name }).where(eq(users.user_id, userId));
            return null;
          }
          const streak = u?.last_vote_day === (yield* utcDayNow(-1)) ? u.streak + 1 : 1;
          const best = Math.max(u?.best_streak ?? 0, streak);
          yield* db
            .insert(users)
            .values({ user_id: userId, name, streak, best_streak: best, last_vote_day: today })
            .onConflictDoUpdate({ target: users.user_id, set: { name, streak, best_streak: best, last_vote_day: today } });
          return streak;
        }),
        liveStreak,
        leaderboard: Effect.fn("Memes.leaderboard")(function* (sinceIso: string | null, untilIso: string | null, limit: number) {
          return (yield* db
            .select({ ...getMemeColumns(), score: SCORE, votes: sql<number>`COUNT(${votes.user_id})::int` })
            .from(memes)
            .innerJoin(votes, eq(votes.meme_id, memes.id))
            .where(and(sql`${memes.post_kind} IS NOT NULL`, gte(memes.posted_at, sinceIso ?? "0000"), lt(memes.posted_at, untilIso ?? "9999")))
            .groupBy(memes.id)
            .orderBy(desc(SCORE), desc(sql`COUNT(${votes.user_id})`), memes.posted_at)
            .limit(limit)) as Ranked[];
        }),
        topVoter: Effect.fn("Memes.topVoter")(function* (sinceIso: string, untilIso: string) {
          const [r] = yield* db
            .select({ user_id: votes.user_id, n: count() })
            .from(votes)
            .where(and(gte(votes.voted_at, sinceIso), lt(votes.voted_at, untilIso)))
            .groupBy(votes.user_id)
            .orderBy(desc(count()))
            .limit(1);
          return r ?? null;
        }),
        longestLiveStreak: Effect.gen(function* () {
          const [r] = yield* db
            .select({ user_id: users.user_id, streak: users.streak })
            .from(users)
            .where(gte(users.last_vote_day, yield* utcDayNow(-1)))
            .orderBy(desc(users.streak))
            .limit(1);
          return r ?? null;
        }).pipe(Effect.withSpan("Memes.longestLiveStreak")),
        userStats: Effect.fn("Memes.userStats")(function* (userId: string) {
          const [kinds, agree, user, summoned] = yield* Effect.all(
            [
              db.select({ kind: votes.kind, n: count() }).from(votes).where(eq(votes.user_id, userId)).groupBy(votes.kind),
              // share of this user's votes that matched the meme's winning reaction (ties count)
              db.execute<{ total: number; agreed: number | null }>(sql`
      WITH t AS (SELECT meme_id, kind, COUNT(*) AS c FROM votes GROUP BY meme_id, kind),
           w AS (SELECT meme_id, kind FROM t WHERE c = (SELECT MAX(c) FROM t t2 WHERE t2.meme_id = t.meme_id))
      SELECT COUNT(*)::int AS total,
             SUM(CASE WHEN EXISTS (SELECT 1 FROM w WHERE w.meme_id = v.meme_id AND w.kind = v.kind) THEN 1 ELSE 0 END)::int AS agreed
      FROM votes v WHERE v.user_id = ${userId}`),
              db
                .select({ streak: users.streak, best_streak: users.best_streak, last_vote_day: users.last_vote_day })
                .from(users)
                .where(eq(users.user_id, userId)),
              db.select({ n: count() }).from(memes).where(eq(memes.requested_by, userId)),
            ] as const,
            { concurrency: 4 }, // the four reads at once, as before
          );
          return {
            kinds: Object.fromEntries(kinds.map((r) => [r.kind, r.n])) as Tally,
            agree: agree.rows[0] as { total: number; agreed: number | null },
            user: (user[0] ?? null) as StreakRow | null,
            summoned: summoned[0].n,
          };
        }),
        claimRecap: Effect.fn("Memes.claimRecap")(function* (period: string) {
          const r = yield* db.insert(recaps).values({ period, posted_at: yield* nowIso }).onConflictDoNothing().returning({ period: recaps.period });
          return r.length === 1;
        }),
        unclaimRecap: Effect.fn("Memes.unclaimRecap")(function* (period: string) {
          yield* db.delete(recaps).where(eq(recaps.period, period));
        }),
      });
    }),
  );
}

// the old functions, for the code that isn't on Effect yet
export const now = () => runSync(nowIso); // LEGACY-BRIDGE
export const utcDay = (offsetDays = 0) => runSync(utcDayNow(offsetDays)); // LEGACY-BRIDGE
export const ingest = (env: Env, incoming: Incoming[]) => run(env, Memes.use((m) => m.ingest(incoming))); // LEGACY-BRIDGE
export const getMeme = (env: Env, id: string) => run(env, Memes.use((m) => m.get(id))); // LEGACY-BRIDGE
export const tally = (env: Env, memeId: string) => run(env, Memes.use((m) => m.tally(memeId))); // LEGACY-BRIDGE
export const voters = (env: Env, memeId: string) => run(env, Memes.use((m) => m.voters(memeId))); // LEGACY-BRIDGE
export const claim = (env: Env, id: string, kind: "daily" | "request", extra: { day?: string; requestedBy?: string }) => run(env, Memes.use((m) => m.claim(id, kind, extra))); // LEGACY-BRIDGE
export const unclaim = (env: Env, id: string) => run(env, Memes.use((m) => m.unclaim(id))); // LEGACY-BRIDGE
export const setMessage = (env: Env, id: string, channelId: string, messageId: string) => run(env, Memes.use((m) => m.setMessage(id, channelId, messageId))); // LEGACY-BRIDGE
export const castVote = (env: Env, memeId: string, userId: string, kind: VoteKind) => run(env, Memes.use((m) => m.castVote(memeId, userId, kind))); // LEGACY-BRIDGE
export const bumpStreak = (env: Env, userId: string, name: string) => run(env, Memes.use((m) => m.bumpStreak(userId, name))); // LEGACY-BRIDGE
export const liveStreak = (u: Pick<StreakRow, "streak" | "last_vote_day"> | null) => runSync(Memes.use((m) => m.liveStreak(u))); // LEGACY-BRIDGE
export const leaderboard = (env: Env, sinceIso: string | null, untilIso: string | null, limit: number) => run(env, Memes.use((m) => m.leaderboard(sinceIso, untilIso, limit))); // LEGACY-BRIDGE
export const topVoter = (env: Env, sinceIso: string, untilIso: string) => run(env, Memes.use((m) => m.topVoter(sinceIso, untilIso))); // LEGACY-BRIDGE
export const longestLiveStreak = (env: Env) => run(env, Memes.use((m) => m.longestLiveStreak)); // LEGACY-BRIDGE
export const userStats = (env: Env, userId: string) => run(env, Memes.use((m) => m.userStats(userId))); // LEGACY-BRIDGE
export const claimRecap = (env: Env, period: string) => run(env, Memes.use((m) => m.claimRecap(period))); // LEGACY-BRIDGE
export const unclaimRecap = (env: Env, period: string) => run(env, Memes.use((m) => m.unclaimRecap(period))); // LEGACY-BRIDGE
