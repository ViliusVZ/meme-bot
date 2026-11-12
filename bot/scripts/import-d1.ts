// Import a D1 export (scripts/export_d1.py) into an empty Postgres database, in one transaction.
//   DATABASE_URL=postgres://… npx tsx scripts/import-d1.ts d1-export.json [--replace | --merge]
// --replace empties the tables first (for re-running a rehearsal). --merge is for right after the
// switchover: a second export picks up clicks that reached the old bot between the first export
// and the switch; rows the new bot already has win (insert-if-missing, nothing is overwritten).
// Converts SQLite's 0/1 flags to booleans and JSON-in-text to jsonb, keeps ids, and moves the
// identity sequences past them.
// The database must be migrated first (start the bot against it once, or `npx drizzle-kit
// migrate`): the old migrator this called went with plan 05.
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as s from "../src/db/schema.js";

const [file, flag] = process.argv.slice(2);
if (!file || !process.env.DATABASE_URL) throw new Error("usage: DATABASE_URL=… tsx scripts/import-d1.ts export.json [--replace]");
const d1 = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, any>[]>;
// its own pool (the app runs on @effect/sql-pg; this one-off script keeps node-postgres)
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });
const migrated = await pool.query(`SELECT to_regclass('memes') IS NOT NULL AS ok`);
if (!migrated.rows[0].ok) throw new Error("the database isn't migrated yet: start the bot against it once (or npx drizzle-kit migrate), then import");

const bool = (v: unknown) => v === 1 || v === true || v === "1";
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
const rows = (t: string) => d1[t] ?? [];
const order = [
  s.votes, s.pollVotes, s.memes, s.users, s.recaps, s.gameNightVotes, s.gameNights, s.games,
  s.tiebreaks, s.polls, s.rooms, s.nightAttendance, s.voiceSegments,
];

await db.transaction(async (tx) => {
  // (games doesn't count: a fresh database already has the starter list from migration 0001)
  const counts = await tx.execute<{ n: number }>(sql`SELECT (SELECT COUNT(*) FROM memes) + (SELECT COUNT(*) FROM game_nights) + (SELECT COUNT(*) FROM votes) AS n`);
  const merge = flag === "--merge";
  if (Number(counts.rows[0].n) > 0 && !merge) {
    if (flag !== "--replace") throw new Error("target isn't empty (use --replace to wipe it, or --merge to add what's missing)");
    for (const t of order) await tx.delete(t);
  }
  const insert = async (table: any, list: any[]) => {
    for (let i = 0; i < list.length; i += 500) {
      const q = tx.insert(table).values(list.slice(i, i + 500));
      await (merge ? q.onConflictDoNothing() : q);
    }
  };
  await insert(s.memes, rows("memes"));
  await insert(s.votes, rows("votes"));
  await insert(s.users, rows("users"));
  await insert(s.recaps, rows("recaps"));
  await insert(s.gameNights, rows("game_nights").map((r) => ({ ...r, reminded: bool(r.reminded) })));
  await insert(s.gameNightVotes, rows("game_night_votes"));
  // games.seq is "generated always": insert in rowid order and let it number them. The starter games
  // already exist (migration 0001, same order), so those take the imported plays and details.
  for (const g of rows("games").sort((a, b) => a.seq - b.seq)) {
    const { seq: _, ...rest } = g;
    const q = tx.insert(s.games).values(rest as typeof s.games.$inferInsert);
    await (merge ? q.onConflictDoNothing() : q.onConflictDoUpdate({ target: s.games.name, set: { emoji: rest.emoji, added_by: rest.added_by, added_at: rest.added_at, plays: rest.plays } }));
  }
  await insert(s.polls, rows("polls").map((r) => ({ ...r, options: json(r.options) })));
  await insert(s.pollVotes, rows("poll_votes"));
  await insert(
    s.tiebreaks,
    rows("tiebreaks").map((r) => ({ ...r, options: json(r.options), contenders: json(r.contenders), alive: json(r.alive), hands: json(r.hands), history: json(r.history) })),
  );
  await insert(s.rooms, rows("rooms"));
  await insert(s.nightAttendance, rows("night_attendance"));
  await insert(s.voiceSegments, rows("voice_segments").map((r) => ({ ...r, open: bool(r.open), ended_at: null })));
  // identity columns: continue after the imported ids
  for (const t of ["polls", "tiebreaks", "voice_segments"])
    await tx.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT MAX(id) FROM ${t}), 0) + 1, false)`));
});

const check = await db.execute<{ t: string; n: number }>(sql`
  SELECT 'memes' t, COUNT(*)::int n FROM memes UNION ALL SELECT 'votes', COUNT(*)::int FROM votes
  UNION ALL SELECT 'users', COUNT(*)::int FROM users UNION ALL SELECT 'recaps', COUNT(*)::int FROM recaps
  UNION ALL SELECT 'game_nights', COUNT(*)::int FROM game_nights UNION ALL SELECT 'game_night_votes', COUNT(*)::int FROM game_night_votes
  UNION ALL SELECT 'games', COUNT(*)::int FROM games UNION ALL SELECT 'polls', COUNT(*)::int FROM polls
  UNION ALL SELECT 'poll_votes', COUNT(*)::int FROM poll_votes UNION ALL SELECT 'tiebreaks', COUNT(*)::int FROM tiebreaks
  UNION ALL SELECT 'rooms', COUNT(*)::int FROM rooms UNION ALL SELECT 'night_attendance', COUNT(*)::int FROM night_attendance
  UNION ALL SELECT 'voice_segments', COUNT(*)::int FROM voice_segments`);
let ok = true;
for (const r of check.rows) {
  const want = rows(r.t).length;
  const fine = process.argv.includes("--merge") ? r.n >= want : want === r.n; // merging: the new bot may have more
  if (!fine) ok = false;
  console.log(`${fine ? "✓" : "✗"} ${r.t}: ${r.n}/${want}`);
}
await pool.end();
if (!ok) process.exit(1);
