// The Effect database (db/db.ts): today's pool settings, bigint as numbers, typed failures that
// roll a transaction back, and the same throwaway schema as the old pool during the transition.
import { expect, test } from "vitest";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { eq, sql } from "drizzle-orm";
import { gameNights, games } from "../src/db/schema.js";
import { Db } from "../src/db/db.js";
import { run } from "./old/legacy.js";
import { harness } from "./harness.js";

const h = harness({ tables: [gameNights, games] });
class Nope extends Schema.TaggedError<Nope>()("Nope", {}) {}

test("the pool has today's settings: statement timeout, idle-in-transaction timeout, application name", async () => {
  const [s] = await run(
    h.env,
    Effect.gen(function* () {
      const sqlc = yield* SqlClient.SqlClient;
      return yield* sqlc<{ st: string; idle: string; app: string }>`SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('application_name') AS app`;
    }),
  );
  expect(s).toEqual({ st: "30s", idle: "1min", app: "meme-bot" });
});

test("bigint columns and raw bigint aggregates are numbers, as with the old pool", async () => {
  const r = await run(
    h.env,
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.insert(gameNights).values({ day: "2026-11-06", stage: "ask", reminded: false, stage_at: 1793977200 });
      const [n] = yield* db.select().from(gameNights);
      const [m] = yield* db.select({ m: sql<number>`MAX(${gameNights.stage_at})`, g: sql<number>`GREATEST(MAX(${gameNights.stage_at})::bigint, ${2 ** 40}::bigint)` }).from(gameNights);
      return [n.stage_at, m.m, m.g];
    }),
  );
  expect(r).toEqual([1793977200, 1793977200, 2 ** 40]);
});

test("a typed failure rolls the transaction back and comes out typed; a failed query is typed", async () => {
  const out = await run(
    h.env,
    Effect.gen(function* () {
      const db = yield* Db;
      const e = yield* db.transaction((tx) => tx.insert(games).values({ name: "Rolled back", added_at: "x" }).pipe(Effect.andThen(new Nope()))).pipe(Effect.flip);
      const bad = yield* db.insert(gameNights).values({} as never).pipe(Effect.flip);
      const left = yield* db.select().from(games).where(eq(games.name, "Rolled back"));
      return [e._tag, bad._tag, left.length];
    }),
  );
  expect(out).toEqual(["Nope", "EffectDrizzleQueryError", 0]);
});

test("the old pool and the Effect one see the same schema", async () => {
  await h.t.db.insert(games).values({ name: "Written by the old pool", added_at: "x" });
  const seen = await run(
    h.env,
    Effect.gen(function* () {
      const db = yield* Db;
      return (yield* db.select({ name: games.name }).from(games)).map((g) => g.name);
    }),
  );
  expect(seen).toContain("Written by the old pool");
});
