// A real Postgres for tests: each test file gets its own throwaway schema with the migrations
// applied, so files can run in parallel and nothing leaks between runs.
//   TEST_DATABASE_URL=postgres://… (CI: a service container; locally: .env.test via an SSH tunnel)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Env } from "../src/env.js";

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function url() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const file = fileURLToPath(new URL("../.env.test", import.meta.url));
  if (existsSync(file)) {
    const m = readFileSync(file, "utf8").match(/^TEST_DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  }
  throw new Error("set TEST_DATABASE_URL (or create bot/.env.test)");
}

export async function testDb() {
  const name = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: url() });
  await admin.connect();
  await admin.query("CREATE EXTENSION IF NOT EXISTS citext SCHEMA public").catch(() => {}); // shared by every schema
  await admin.query(`CREATE SCHEMA ${name}`);
  await admin.end();
  // the schema first, public second (where the citext extension lives)
  const pool = new pg.Pool({ connectionString: url(), max: 4, options: `-c search_path=${name},public` });
  const db = drizzle({ client: pool });
  // the same SQL the bot runs on startup, pointed at this schema (drizzle qualifies references with "public")
  const dir = fileURLToPath(new URL("../drizzle", import.meta.url));
  // drizzle 1.0 layout: one folder per migration (<timestamp>_<name>/migration.sql), in name order
  for (const f of readdirSync(dir).filter((f) => existsSync(`${dir}/${f}/migration.sql`)).sort()) {
    const sqlText = readFileSync(`${dir}/${f}/migration.sql`, "utf8").replaceAll('"public".', `"${name}".`);
    for (const stmt of sqlText.split("--> statement-breakpoint")) if (stmt.trim()) await pool.query(stmt);
  }
  return {
    db,
    pool,
    close: async () => {
      await pool.query(`DROP SCHEMA ${name} CASCADE`);
      await pool.end();
    },
  };
}

/** An env for module code under test (no Discord token: calls to Discord are stubbed by the test). */
export function testEnv(db: Env["db"], over: Partial<Env> = {}): Env {
  return {
    db,
    DISCORD_TOKEN: "x",
    DISCORD_PUBLIC_KEY: "00",
    DISCORD_APP_ID: "app",
    INGEST_SECRET: "i",
    ADMIN_SECRET: "a",
    GUILD_ID: "guild",
    CHANNEL_ID: "memes",
    SUBREDDIT: "ProgrammerHumor",
    POST_HOUR_UTC: "10",
    GAME_CHANNEL_ID: "gn",
    PLAYERS: "a,b,c",
    TIMEZONE: "Europe/Vilnius",
    GAME_POLL_HOUR: "17",
    GAME_POLL_HOUR_WEEKEND: "14",
    LOBBY_CHANNEL_ID: "lobby",
    VOICE_CATEGORY_ID: "voice",
    ...over,
  };
}
