// The database, as Effect services: one pool (PgClient, @effect/sql-pg) with the same settings the
// node-postgres pool has, Drizzle's Effect database on it (Db), and the migrations. Queries keep
// Drizzle's shape: `yield* db.select()…`; a failed one is a typed DbError, never a defect, so the
// "claim, post, release the claim if the post failed" patterns release on database errors too.
import { PgClient, PgTypes } from "@effect/sql-pg";
import { Context, Effect, Layer, Result } from "effect";
import type { SqlError } from "effect/sql";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { AppConfig } from "../config.js";

/** How a query or a transaction can fail. */
export type DbError = EffectDrizzleQueryError | SqlError.SqlError;

/**
 * bigint (int8) columns hold unix seconds and counts: small enough for a JS number. Drizzle's own
 * codec covers bigint({ mode: "number" }) columns, but raw sql aggregates over them (MAX, GREATEST)
 * would arrive as BigInt, so the client's registry decodes int8 to a number (spike S1).
 */
export function int8AsNumber(): PgTypes.Registry {
  const registry = PgTypes.makeRegistry();
  const unsafe = (n: bigint) => n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER);
  registry.register<number | bigint>(
    PgTypes.OID.int8,
    {
      decode: (bytes) => {
        if (bytes.byteLength !== 8) return Result.fail(new PgTypes.CodecError({ message: `int8: ${bytes.byteLength} bytes` }));
        const n = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0);
        return unsafe(n) ? Result.fail(new PgTypes.CodecError({ message: `int8 ${n} is not a safe number` })) : Result.succeed(Number(n));
      },
      encode: (value) => {
        if (typeof value === "number" && !Number.isSafeInteger(value)) return Result.fail(new PgTypes.CodecError({ message: `int8: ${value} is not an integer` }));
        const out = new Uint8Array(8);
        new DataView(out.buffer).setBigInt64(0, BigInt(value));
        return Result.succeed(out);
      },
    },
    { arrayOid: PgTypes.OID.int8Array },
  );
  return registry;
}

/** Where the pool points, beyond the URL (tests: their throwaway schema). */
export const DbOptions = Context.Reference<{ readonly startupOptions?: string }>("meme-bot/db/db/DbOptions", { defaultValue: () => ({}) });

/** The pool: today's settings (db/index.ts connect) on the Effect client. */
export const PgLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const options = yield* DbOptions;
    return PgClient.layer({
      url: config.databaseUrl,
      maxConnections: 10,
      idleTimeout: "30 seconds",
      acquireTimeout: "5 seconds",
      applicationName: config.appName,
      startupOptions: options.startupOptions,
      // nothing here takes more than a second: a query stuck on a lock fails instead of hanging its job
      startupParameters: { statement_timeout: "30s", idle_in_transaction_session_timeout: "60s" },
      types: int8AsNumber(),
    });
  }),
);

type Database = Effect.Success<ReturnType<typeof PgDrizzle.makeWithDefaults>>;

/** Drizzle's Effect database on the pool. */
export class Db extends Context.Service<Db, Database>()("meme-bot/db/db") {
  static readonly layer = Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(Layer.provideMerge(PgLive));
}

/** A transaction handle (the same query API as Db). */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const MIGRATION_LOCK = 4_242_001;

/**
 * Apply pending migrations from drizzle/. Blue and green may start at the same moment, so the
 * migration runs under an advisory lock, on a connection of its own: the second one waits, then
 * finds nothing to do. Closing the connection at the end releases the lock (spike S3).
 * (`migrationsSchema` is for tests, which migrate a throwaway schema.)
 */
export const runMigrations = Effect.fn("Db.runMigrations")(function* (folder: string, migrationsSchema = "drizzle") {
  const config = yield* AppConfig;
  const options = yield* DbOptions;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* PgClient.makeClient({
        url: config.databaseUrl,
        applicationName: config.appName,
        startupOptions: options.startupOptions,
        // the pool's limits here too: waiting on the lock, or a migration stuck behind a lock, fails
        // after 30 s (startup fails, and Docker tries again) instead of stalling the copy still serving
        startupParameters: { statement_timeout: "30s", idle_in_transaction_session_timeout: "60s" },
        types: int8AsNumber(),
      });
      yield* client`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
      const db = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideService(PgClient.PgClient, client));
      yield* migrate(db, { migrationsFolder: folder, migrationsSchema });
    }),
  );
});

