// The real migrator (db/db.ts runMigrations: Drizzle 1.0, Effect) on a throwaway schema: blue and green
// starting together migrate once, a restart applies nothing, and a migrations table written by the
// old migrator (Drizzle 0.45: id, hash, created_at in ms) is upgraded in place without re-running
// anything, so production's existing database carries over.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterAll, expect, it } from "@effect/vitest";
import pg from "pg";
import { Effect } from "effect";
import { DbOptions, runMigrations } from "../src/db/db.js";
import { harness } from "./fx.js";
import { url } from "./pg.js";

const h = harness({ db: false });
/** The app's migrator, pointed at a throwaway schema (as main.ts runs it at startup). */
const migrateWith = (schema: string, dir: string) =>
  runMigrations(dir, `${schema}_drizzle`).pipe(Effect.provideService(DbOptions, { startupOptions: `-c search_path=${schema},public` }));
/** Promise code (node-postgres on the throwaway schema), as a step of the test. */
const p = <A>(f: () => Promise<A>) => Effect.promise(f);

const source = fileURLToPath(new URL("../drizzle", import.meta.url));
const made: { pool: pg.Pool; schema: string; dir: string }[] = [];

/** A fresh schema, and a copy of the migrations pointed at it (they name "public" explicitly). */
async function fresh() {
  const schema = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: url() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  cpSync(source, dir, { recursive: true });
  for (const m of readdirSync(dir)) {
    const f = join(dir, m, "migration.sql");
    writeFileSync(f, readFileSync(f, "utf8").replaceAll('"public".', `"${schema}".`));
  }
  const pool = new pg.Pool({ connectionString: url(), max: 4, options: `-c search_path=${schema},public` });
  made.push({ pool, schema, dir });
  return { pool, schema, dir, table: `"${schema}_drizzle"."__drizzle_migrations"` };
}
const tables = async (pool: pg.Pool, schema: string) =>
  Number((await pool.query("SELECT count(*) FROM information_schema.tables WHERE table_schema = $1", [schema])).rows[0].count);
const migrationCount = readdirSync(source).length;

afterAll(async () => {
  for (const m of made) {
    await m.pool.query(`DROP SCHEMA IF EXISTS ${m.schema} CASCADE; DROP SCHEMA IF EXISTS ${m.schema}_drizzle CASCADE`);
    await m.pool.end();
    rmSync(m.dir, { recursive: true, force: true });
  }
});

it.effect("two copies starting at once migrate once; a restart applies nothing", () =>
  Effect.gen(function* () {
    const { pool, schema, dir, table } = yield* p(fresh);
    yield* Effect.all([migrateWith(schema, dir), migrateWith(schema, dir)], { concurrency: "unbounded" });
    const rows = (yield* p(() => pool.query(`SELECT name FROM ${table} ORDER BY id`))).rows.map((r) => r.name);
    expect(rows).toEqual(readdirSync(source).sort());
    const before = yield* p(() => tables(pool, schema));
    expect(before).toBeGreaterThan(15);
    yield* migrateWith(schema, dir);
    expect((yield* p(() => pool.query(`SELECT count(*) FROM ${table}`))).rows[0].count).toBe(migrationCount);
    expect(yield* p(() => tables(pool, schema))).toBe(before);
  }).pipe(h.provide),
);

it.effect("an old-style migrations table (Drizzle 0.45) is upgraded in place, nothing re-run", () =>
  Effect.gen(function* () {
    const { pool, schema, dir, table } = yield* p(fresh);
    // what the old migrator left behind: every migration applied, rows of (hash, created_at in ms)
    const when: Record<string, number> = {
      init: 1793794234852, seed_games: 1793795898445, roasts: 1793803964311, bail_roasts: 1793805039163,
      retire_tiebreaks: 1793807405421, shared_roast_bags: 1793812533780, planned_start: 1793886876408,
      settings: 1793887692644, maybe_pause: 1794046586391, live_panels: 1794241536477,
      spontaneous: 1794386631426, lobby_activity: 1794387985356, activity_guesses: 1794398083351,
      news: 1794480064000, // (added after the 1.0 conversion: its folder's time)
    };
    yield* p(() => pool.query(`CREATE SCHEMA ${schema}_drizzle; CREATE TABLE ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`));
    for (const m of readdirSync(dir).sort()) {
      const sqlText = readFileSync(join(dir, m, "migration.sql"), "utf8");
      for (const stmt of sqlText.split("--> statement-breakpoint")) if (stmt.trim()) yield* p(() => pool.query(stmt));
      const hash = createHash("sha256").update(readFileSync(join(source, m, "migration.sql"), "utf8")).digest("hex");
      yield* p(() => pool.query(`INSERT INTO ${table} (hash, created_at) VALUES ($1, $2)`, [hash, when[m.replace(/^\d+_/, "")]]));
    }
    const before = yield* p(() => tables(pool, schema));
    yield* migrateWith(schema, dir); // would fail ("already exists") if it re-ran one
    const rows = (yield* p(() => pool.query(`SELECT id, name, created_at FROM ${table} ORDER BY id`))).rows;
    expect(rows.map((r) => r.name)).toEqual(readdirSync(source).sort());
    expect(rows.map((r) => Number(r.created_at))).toEqual(Object.values(when)); // the old timestamps stay, so the old code still sees them all
    expect(yield* p(() => tables(pool, schema))).toBe(before);
  }).pipe(h.provide),
);
