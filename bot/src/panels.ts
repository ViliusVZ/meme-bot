// 🔒 Private copies of a card: the "only you can see this" reply a tap on a game-night card or a poll
// gets. Discord lets us edit one for 15 minutes after the tap that made or last updated it, so every
// copy follows its card for that long instead of staying on whatever it showed when you tapped (the
// game picker after the game's decided, say, so you pick again).
import { and, eq, lt } from "drizzle-orm";
import { Context, Effect, Layer, Result, Schema, Semaphore } from "effect";
import { panels } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { Discord, EPHEMERAL } from "./discord.js";
import { nowSec } from "./clock.js";

/** Discord takes edits to a tap's reply for 15 minutes; stop a little before that. */
const LIFE = 14 * 60;

/** The copy a tap just answered: the sync keeps its notice ("already picked…") instead of wiping it. */
export type Mine = { message_id: string; notice?: string };

/** Someone's private copy of the card, as of now. */
export type Render<E = never> = (user: string, notice?: string) => Effect.Effect<{ flags: number }, E>;

/** Discord wouldn't show us the copy a tap made (not posted yet after the retries, or gone). */
export class CopyNotFound extends Schema.TaggedError<CopyNotFound>()("CopyNotFound", { status: Schema.optional(Schema.Number) }) {
  override get message() {
    return `@original -> ${this.status}`;
  }
}

export class Panels extends Context.Service<
  Panels,
  {
    /**
     * Remember a private copy someone got or tapped. A tap on the copy names it; a fresh one from the
     * card is looked up once Discord has posted it. Each tap renews the 15 minutes.
     * `card` is what it's a copy of: `gn:<day>` or `poll:<id>`.
     */
    track(card: string, user: string, token: string, messageId?: string): Effect.Effect<void, DbError | CopyNotFound>;
    /**
     * Bring every live private copy of a card up to date. Syncs for one card run one after another, so
     * an older state never lands on top of a newer one; syncs of different cards run side by side.
     */
    sync<E>(card: string, render: Render<E>, mine?: Mine): Effect.Effect<void, DbError | E>;
  }
>()("meme-bot/panels") {
  static readonly layer = Layer.effect(
    Panels,
    Effect.gen(function* () {
      const db = yield* Db;
      const discord = yield* Discord;
      // one permit per card: a sync waits for the one before it (waiters are served in order); a
      // card's entry goes once nobody is syncing or waiting on it
      const locks = new Map<string, { lock: Semaphore.Semaphore; users: number }>();
      const withCardLock = <A, E, R>(card: string, effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            let entry = locks.get(card);
            if (!entry) locks.set(card, (entry = { lock: Semaphore.makeUnsafe(1), users: 0 }));
            entry.users++;
            return entry;
          }),
          (entry) => entry.lock.withPermit(effect),
          (entry) =>
            Effect.sync(() => {
              if (--entry.users === 0) locks.delete(card);
            }),
        );

      const push = <E>(card: string, render: Render<E>, mine?: Mine) =>
        Effect.gen(function* () {
          yield* db.delete(panels).where(lt(panels.tapped_at, (yield* nowSec) - LIFE));
          const live = yield* db.select().from(panels).where(eq(panels.card, card));
          // every copy at once; one copy's failure doesn't stop the others' edits
          const results = yield* Effect.all(
            live.map((p) =>
              Effect.gen(function* () {
                const { flags, ...copy } = yield* render(p.user_id, p.message_id === mine?.message_id ? mine.notice : undefined);
                // an edit can't set "ephemeral" again (and needn't: it stays only theirs)
                const r = yield* discord.editOriginal(p.token, { ...copy, flags: flags & ~EPHEMERAL });
                // dismissed, or the token ran out: let it go (unless a newer tap renewed it meanwhile)
                if (!r?.ok) yield* db.delete(panels).where(and(eq(panels.message_id, p.message_id), eq(panels.token, p.token)));
              }),
            ),
            { concurrency: "unbounded", mode: "result" },
          );
          const failed = results.find(Result.isFailure);
          if (failed) return yield* Effect.fail(failed.failure);
        });

      return Panels.of({
        track: Effect.fn("Panels.track")(function* (card: string, user: string, token: string, messageId?: string) {
          let id = messageId;
          if (id === undefined) {
            const r = yield* discord.originalMessage(token);
            if (!r?.ok) return yield* new CopyNotFound({ status: r?.status });
            // the copy's message: its id (a body that isn't one can't be tracked either)
            id = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ id: Schema.String })))(r.text).pipe(Effect.mapError(() => new CopyNotFound({ status: r.status })))).id;
          }
          const t = yield* nowSec;
          yield* db
            .insert(panels)
            .values({ message_id: id, card, user_id: user, token, tapped_at: t })
            .onConflictDoUpdate({ target: panels.message_id, set: { token, tapped_at: t } });
        }),
        sync: (card, render, mine) => withCardLock(card, push(card, render, mine)).pipe(Effect.withSpan("Panels.sync", { attributes: { card } })),
      });
    }),
  );
}
