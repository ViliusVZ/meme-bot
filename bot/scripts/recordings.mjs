// G4 (plan 05, verification.md §2a): every recording that exists at the reference commits must
// still be produced, unchanged, by the same test: at the tag `baseline` (the phase 0 recordings,
// taken from the old code) and at HEAD (so a recording added later is held too, from the commit
// that added it). New test files and new tests may add recordings; nothing else may change. The
// only exceptions are listed in test/recordings.allowed.json, each with its reason (and in
// STATUS.md under "Declared exceptions").
//   node scripts/recordings.mjs [--base <git ref>]...     (default: baseline and HEAD)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = `${root}test/__recordings__/`;
const args = process.argv.slice(2);
const bases = args.flatMap((a, i) => (args[i - 1] === "--base" ? [a] : []));
if (!bases.length) bases.push("baseline", "HEAD");
const allowedFile = `${root}test/recordings.allowed.json`;
const allowed = existsSync(allowedFile) ? JSON.parse(readFileSync(allowedFile, "utf8")) : {};
// every exception names its reason; they are printed with each run, so none goes unseen
for (const [f, keys] of Object.entries(allowed))
  for (const [k, reason] of Object.entries(keys)) {
    if (typeof reason !== "string" || reason.trim().length < 10) {
      console.error(`recordings.allowed.json: ${f} › ${k} needs its reason`);
      process.exit(1);
    }
    console.log(`allowed to differ: ${f} › ${k}: ${reason}`);
  }
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });

const problems = [];
const summary = [];
for (const base of bases) {
  const baseFiles = git("ls-tree", "--full-tree", "--name-only", `${base}:bot/test/__recordings__`)
    .split("\n")
    .filter((f) => f.endsWith(".json"));
  // a reference with nothing in it would make this gate pass without checking anything
  if (!baseFiles.length) {
    console.error(`recordings: ${base} has no recordings (wrong ref?)`);
    process.exit(1);
  }
  let checked = 0;
  for (const f of baseFiles) {
    const before = JSON.parse(git("show", `${base}:bot/test/__recordings__/${f}`));
    if (!existsSync(dir + f)) {
      problems.push(`${f}: no longer written (vs ${base})`);
      continue;
    }
    const now = JSON.parse(readFileSync(dir + f, "utf8"));
    for (const [k, rec] of Object.entries(before)) {
      checked++;
      if (allowed[f]?.[k]) continue;
      if (!(k in now)) problems.push(`${f} › ${k}: no longer recorded (vs ${base})`);
      else if (JSON.stringify(now[k]) !== JSON.stringify(rec)) problems.push(`${f} › ${k}: differs from ${base}`);
    }
  }
  const extra = readdirSync(dir).filter((f) => f.endsWith(".json") && !baseFiles.includes(f));
  summary.push(`${checked} identical to ${base}${extra.length ? ` (new files: ${extra.join(", ")})` : ""}`);
}
if (problems.length) {
  console.error(`recordings: ${problems.length} problem(s)\n` + [...new Set(problems)].map((p) => `  ${p}`).join("\n"));
  process.exit(1);
}
console.log(`recordings: ${summary.join("; ")}`);
