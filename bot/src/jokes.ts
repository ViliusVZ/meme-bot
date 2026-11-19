// 🌅 The morning joke: a small stock the outside writer keeps topped up (GET /jokes/stock, POST
// /jokes), one joke posted each morning (09:00 on weekdays, 10:30 at weekends, local time) with the
// meme vote buttons, so we learn what lands. The claim is the database's: one joke a day, ever.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Ref } from "effect";
import { jokes, jokeVotes } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig } from "./config.js";
import { Discord, type DiscordError } from "./discord.js";
import { localAt, wallToUnixIn } from "./localtime.js";
import { nowIso } from "./clock.js";
import { VOTES, type Tally, type VoteKind } from "./memes.js";
import { jokeMessage } from "./ui.js";

export type Joke = typeof jokes.$inferSelect;

/** The stock the writer tops up to. */
export const STOCK_TARGET = 6;
/** How many of the latest jokes the writer sees, so it doesn't repeat a joke or a theme. */
export const RECENT = 60;
/** The longest joke, in characters. */
export const MAX_TEXT = 600;
/** A morning whose joke is this late (a restart, an outage) goes without one. */
export const LATE_MS = 2 * 3600_000;
export const LANGS = ["en", "lt"] as const;

/** The local time of `day`'s joke: 09:00 Monday to Friday, 10:30 on Saturdays and Sundays. */
export function jokeTimeOf(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const dow = (Math.floor(Date.UTC(y, m - 1, d) / 86_400_000) + 4) % 7; // 1 Jan 1970 was a Thursday
  return dow === 0 || dow === 6 ? { hour: 10, minute: 30 } : { hour: 9, minute: 0 };
}

/** Today's joke in `timeZone` at `ms`: its local day and when it's due (epoch ms). */
export function jokeDue(timeZone: string, ms: number) {
  const l = localAt(timeZone, ms);
  const t = jokeTimeOf(l.day);
  return { day: l.day, at: wallToUnixIn(timeZone, l.y, l.m, l.d, t.hour, t.minute) * 1000 };
}

/** The text as the repeat check sees it: no case, accents, punctuation or extra spaces. */
export function normalized(text: string) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export type JokeInput = { readonly text: string; readonly lang: string; readonly theme: string; readonly form: string };
export type Stock = {
  in_stock: number;
  target: number;
  need: number;
  recent: { text: string; lang: string; theme: string; form: string }[];
};
export type Added = { ok: true; id: number } | { ok: false; status: 400 | 409; error: string };
export type Voters = Partial<Record<VoteKind, string[]>>;

export class Jokes extends Context.Service<
  Jokes,
  {
    /** What the writer needs: how many are in stock, the target, and the latest jokes (newest first). */
    readonly stock: Effect.Effect<Stock, DbError>;
    /** One joke for the stock: 400 for a bad shape or length, 409 for a repeat. */
    add(input: JokeInput): Effect.Effect<Added, DbError>;
    /**
     * Every minute: post this morning's joke once it's due, the oldest in stock first. More than
     * LATE_MS late, the morning goes without; an empty stock posts nothing and only logs it.
     */
    readonly postDue: Effect.Effect<{ posted?: number; skipped?: string; day?: string }, DbError | DiscordError>;
    get(id: number): Effect.Effect<Joke | null, DbError>;
    /** Who voted what on a joke, in voting order, and the counts. */
    votes(id: number): Effect.Effect<{ tally: Tally; by: Voters }, DbError>;
    /** Toggle semantics, as the memes': the same button again removes the vote, another switches it. */
    castVote(id: number, userId: string, kind: VoteKind): Effect.Effect<"removed" | "changed" | "new", DbError>;
  }
>()("meme-bot/jokes") {
  static readonly layer = Layer.effect(
    Jokes,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const emptyLogged = yield* Ref.make<string | null>(null); // the day an empty stock was last logged

      /** Take the oldest joke in stock for `day`; null when there's none (or another copy took the day). */
      const claim = Effect.fn("Jokes.claim")(function* (day: string) {
        const at = yield* nowIso;
        const r = yield* db
          .update(jokes)
          .set({ day, posted_at: at })
          .where(and(isNull(jokes.day), sql`${jokes.id} = (SELECT id FROM jokes WHERE day IS NULL ORDER BY added_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`))
          .returning()
          .pipe(
            // unique index violation: the day's joke is already claimed
            Effect.catchTag("EffectDrizzleQueryError", () => Effect.succeed([])),
          );
        return r[0] ?? null;
      });

      /** The joke posted for `day`, if there is one. */
      const postedOn = Effect.fn("Jokes.postedOn")(function* (day: string) {
        return (yield* db.select({ id: jokes.id }).from(jokes).where(eq(jokes.day, day)))[0] ?? null;
      });

      const votes = Effect.fn("Jokes.votes")(function* (id: number) {
        const rows = yield* db.select({ kind: jokeVotes.kind, user: jokeVotes.user_id }).from(jokeVotes).where(eq(jokeVotes.joke_id, id)).orderBy(jokeVotes.voted_at);
        const by: Voters = {};
        for (const r of rows) (by[r.kind] ??= []).push(r.user);
        const tally: Tally = Object.fromEntries(VOTES.filter((v) => by[v.key]).map((v) => [v.key, by[v.key]!.length]));
        return { tally, by };
      });

      const postDue = Effect.gen(function* () {
        const channel = config.jokeChannelId;
        if (channel === undefined) return { skipped: "off" };
        const now = yield* Clock.currentTimeMillis;
        const { day, at } = jokeDue(config.timezone, now);
        if (now < at) return { skipped: "too early" };
        if (yield* postedOn(day)) return { skipped: "already posted", day };
        if (now >= at + LATE_MS) return { skipped: "too late", day };
        // claim → post → its id is never cut short (architecture §15); a failed post gives the joke back
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const joke = yield* claim(day);
            if (!joke) {
              if (yield* postedOn(day)) return { skipped: "already posted", day }; // another copy took the day just now
              if ((yield* Ref.getAndSet(emptyLogged, day)) !== day) yield* Effect.logInfo(`morning joke: none in stock, nothing posted on ${day}`);
              return { skipped: "no joke in stock", day };
            }
            const posted = yield* discord.createMessage(channel, jokeMessage(joke, {})).pipe(
              Effect.tapError(() => db.update(jokes).set({ day: null, posted_at: null }).where(eq(jokes.id, joke.id))),
            );
            yield* db.update(jokes).set({ channel_id: channel, message_id: posted.id }).where(eq(jokes.id, joke.id));
            return { posted: joke.id, day };
          }),
        );
      }).pipe(Effect.withSpan("Jokes.postDue"));

      return Jokes.of({
        stock: Effect.gen(function* () {
          const [{ n }] = yield* db.select({ n: sql<number>`count(*)::int` }).from(jokes).where(isNull(jokes.day));
          const recent = yield* db.select({ text: jokes.text, lang: jokes.lang, theme: jokes.theme, form: jokes.form }).from(jokes).orderBy(desc(jokes.id)).limit(RECENT);
          return { in_stock: n, target: STOCK_TARGET, need: Math.max(0, STOCK_TARGET - n), recent };
        }).pipe(Effect.withSpan("Jokes.stock")),
        add: Effect.fn("Jokes.add")(function* (input: JokeInput) {
          const text = input.text.trim();
          const theme = input.theme.trim();
          const form = input.form.trim();
          const bad = (error: string): Added => ({ ok: false, status: 400, error });
          if (!text) return bad("text: empty");
          if (text.length > MAX_TEXT) return bad(`text: ${text.length} characters, at most ${MAX_TEXT}`);
          if (!(LANGS as readonly string[]).includes(input.lang)) return bad(`lang: "en" or "lt"`);
          if (!theme || theme.length > 40) return bad("theme: 1 to 40 characters");
          if (!form || form.length > 40) return bad("form: 1 to 40 characters");
          const norm = normalized(text);
          if (!norm) return bad("text: no words in it");
          const r = yield* db
            .insert(jokes)
            .values({ text, norm, lang: input.lang as Joke["lang"], theme, form, added_at: yield* nowIso })
            .onConflictDoNothing({ target: jokes.norm })
            .returning({ id: jokes.id });
          if (!r[0]) return { ok: false, status: 409, error: "that joke is already in the stock or was posted" } as Added;
          yield* Effect.logInfo(`joke added #${r[0].id} ${input.lang} ${theme} / ${form}`);
          return { ok: true, id: r[0].id } as Added;
        }),
        postDue,
        get: Effect.fn("Jokes.get")(function* (id: number) {
          return (yield* db.select().from(jokes).where(eq(jokes.id, id)))[0] ?? null;
        }),
        votes,
        castVote: Effect.fn("Jokes.castVote")(function* (id: number, userId: string, kind: VoteKind) {
          const where = and(eq(jokeVotes.joke_id, id), eq(jokeVotes.user_id, userId));
          const [prev] = yield* db.select({ kind: jokeVotes.kind }).from(jokeVotes).where(where);
          if (prev?.kind === kind) {
            yield* db.delete(jokeVotes).where(where);
            return "removed" as const;
          }
          yield* db
            .insert(jokeVotes)
            .values({ joke_id: id, user_id: userId, kind, voted_at: yield* nowIso })
            .onConflictDoUpdate({ target: [jokeVotes.joke_id, jokeVotes.user_id], set: { kind: sql`excluded.kind`, voted_at: sql`excluded.voted_at` } });
          return prev ? ("changed" as const) : ("new" as const);
        }),
      });
    }),
  );
}
