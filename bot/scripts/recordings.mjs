// G4 against the baseline (plan 05, verification.md §2a): every recording the baseline has must
// still be produced, unchanged, by the same test. New tests and new test files may add recordings.
// The only exceptions are listed in test/recordings.allowed.json, each with its reason (and in
// STATUS.md under "Declared exceptions").
//   node scripts/recordings.mjs [--base <git ref>]     (default: the tag `baseline`)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = `${root}test/__recordings__/`;
const base = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "baseline";
const allowedFile = `${root}test/recordings.allowed.json`;
const allowed = existsSync(allowedFile) ? JSON.parse(readFileSync(allowedFile, "utf8")) : {};

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
const baseFiles = git("ls-tree", "--name-only", `${base}:bot/test/__recordings__`).split("\n").filter((f) => f.endsWith(".json"));
const problems = [];
let checked = 0;
for (const f of baseFiles) {
  const before = JSON.parse(git("show", `${base}:bot/test/__recordings__/${f}`));
  if (!existsSync(dir + f)) {
    problems.push(`${f}: no longer written`);
    continue;
  }
  const now = JSON.parse(readFileSync(dir + f, "utf8"));
  for (const [k, rec] of Object.entries(before)) {
    checked++;
    if (allowed[f]?.[k]) continue;
    if (!(k in now)) problems.push(`${f} › ${k}: no longer recorded`);
    else if (JSON.stringify(now[k]) !== JSON.stringify(rec)) problems.push(`${f} › ${k}: differs from ${base}`);
  }
}
const extra = readdirSync(dir).filter((f) => f.endsWith(".json") && !baseFiles.includes(f));
if (problems.length) {
  console.error(`recordings: ${problems.length} differ from ${base}\n` + problems.map((p) => `  ${p}`).join("\n"));
  process.exit(1);
}
console.log(`recordings: ${checked} identical to ${base}${extra.length ? `; new files: ${extra.join(", ")}` : ""}`);
