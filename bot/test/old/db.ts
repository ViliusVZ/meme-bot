// The old node-postgres pool, for the tests until phase 6 (plan 05: it left src in phase 5, step 8; the
// app runs on @effect/sql-pg, src/db/db.ts).
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

export * from "../../src/db/schema.js";
export type Db = NodePgDatabase;

// bigint (int8) columns hold unix seconds and counts: small enough for a JS number
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function connect(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // nothing here takes more than a second: a query stuck on a lock fails instead of hanging its job
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
    application_name: process.env.APP_NAME ?? "meme-bot",
  });
  // a dropped connection must never crash the process: idle ones are handled by the pool, and every
  // client gets its own listener for the times it's checked out (transactions, the leader lock)
  pool.on("error", (e) => console.log("pg pool error", e.message));
  pool.on("connect", (client) => client.on("error", (e) => console.log("pg client error", e.message)));
  const db = drizzle({ client: pool });
  return { pool, db };
}

/** A transaction handle (same query API as `db`). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
