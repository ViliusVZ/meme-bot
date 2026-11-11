// Postgres connection (node-postgres pool + Drizzle), migrations, and the leader lock.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export * from "./schema.js";
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

const MIGRATION_LOCK = 4_242_001;

/**
 * Apply pending migrations from drizzle/. Blue and green may start at the same moment, so the
 * migration runs under an advisory lock: the second one waits, then finds nothing to do.
 * (`migrationsSchema` is for tests, which migrate a throwaway schema.)
 */
export async function runMigrations(pool: pg.Pool, folder: string, migrationsSchema = "drizzle") {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await migrate(drizzle({ client }), { migrationsFolder: folder, migrationsSchema });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

const LEADER_LOCK = 4_242_002;

/**
 * Leadership: exactly one running copy owns the Discord gateway and the scheduler (blue and green
 * overlap for a few seconds during a deploy; both serve clicks, only the leader runs timers). The
 * lock is a session advisory lock on a dedicated connection, so it's released the moment that copy
 * stops or loses its connection. `onLost` fires if the connection dies while we lead.
 */
export async function acquireLeadership(pool: pg.Pool, onLost: () => void, signal: AbortSignal) {
  while (!signal.aborted) {
    let client: pg.PoolClient | null = null;
    try {
      client = await pool.connect();
      for (;;) {
        if (signal.aborted) throw new Error("aborted");
        const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LEADER_LOCK]);
        if (rows[0].ok) break;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      const held = client;
      let lost = false;
      const lose = () => {
        if (lost) return;
        lost = true;
        held.release(true);
        onLost();
      };
      held.on("error", lose);
      held.on("end", lose);
      // keep the connection busy-proof: a cheap ping every 15 s notices a dead socket quickly
      const ping = setInterval(() => held.query("SELECT 1").catch(lose), 15_000);
      return {
        release: async () => {
          clearInterval(ping);
          if (lost) return;
          lost = true;
          await held.query("SELECT pg_advisory_unlock($1)", [LEADER_LOCK]).catch(() => {});
          held.release();
        },
      };
    } catch (e) {
      client?.release(true);
      if (signal.aborted) break;
      console.log("leader lock: retrying", String(e));
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }
  return null;
}

/** A transaction handle (same query API as `db`). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
