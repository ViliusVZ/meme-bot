// G6 (plan 05, verification.md §3): what is left of the promise-style code in src/, and the
// import cycles.
//   node scripts/leftovers.mjs           print the table, write it into STATUS.md, and fail if a
//                                        count went up since scripts/leftovers.json or src/ has an
//                                        import cycle
//   node scripts/leftovers.mjs --update  also save the current counts (refused if any went up)
//   node scripts/leftovers.mjs --final   phase 5 onwards: every count must be zero outside the
//                                        boundary files (architecture.md §16)
// Comments are stripped before counting, so a comment that says "await" doesn't count.
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(root, "src");
const savedFile = join(root, "scripts", "leftovers.json");
const statusFile = join(root, "..", "docs", "plans", "05-effect-migration", "STATUS.md");

const PATTERNS = {
  async: /\basync\b/g,
  await: /\bawait\b/g,
  ".then(": /\.then\(/g,
  ".catch(": /\.catch\(/g,
  "try {": /\btry\s*\{/g,
  "new Promise": /\bnew Promise\b/g,
  "setTimeout/Interval": /\bset(Timeout|Interval)\(/g,
  AbortController: /\bAbortController\b/g,
  AbortSignal: /\bAbortSignal\b/g,
  "fetch(": /(?<![.\w])fetch\(/g,
  "console.": /\bconsole\./g,
  "Date.now/new Date": /\bDate\.now\(|\bnew Date\b/g,
  "Math.random": /\bMath\.random\b/g,
  "process.env": /\bprocess\.env\b/g,
  ": any": /:\s*any\b/g,
  "as any": /\bas any\b/g,
  _reset: /\b_reset\b/g,
  "LEGACY-BRIDGE": /LEGACY-BRIDGE/g,
  "Effect.promise": /\bEffect\.promise\b/g,
  "Effect.tryPromise": /\bEffect\.tryPromise\b/g,
  runPromise: /\brunPromise\b/g,
  runFork: /\brunFork\b/g,
  "Effect.orDie": /\bEffect\.orDie\b/g,
  "@effect-diagnostics": /@effect-diagnostics/g,
  "@ts-": /@ts-/g,
};
// The transition's own marker: it goes up in phase 3 by design and must be zero after phase 5.
const MAY_GROW = new Set(["LEGACY-BRIDGE"]);
// architecture.md §16: the files where some promise-style code is allowed, each with a comment.
const BOUNDARY = new Set(["main.ts", "gateway.ts", "verify.ts", "db/migrate.ts"]);

const files = (function walk(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
})(srcDir).sort();

const printer = ts.createPrinter({ removeComments: true });
const counts = {}; // file → pattern → n
const imports = new Map(); // file → files it imports at runtime
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // transition code (phases 3-5) is counted under its own marker, which must reach zero after
  // phase 5; its lines don't also count as old-style code
  const unmarked = text
    .split("\n")
    .filter((l) => !l.includes("LEGACY-BRIDGE"))
    .join("\n");
  const code = printer.printFile(ts.createSourceFile(f, unmarked, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  const rel = relative(srcDir, f).replaceAll("\\", "/");
  counts[rel] = {};
  for (const [name, re] of Object.entries(PATTERNS)) {
    // markers live in comments, so count them in the raw text
    const n = (name === "LEGACY-BRIDGE" || name === "@effect-diagnostics" || name === "@ts-" ? text : code).match(re)?.length ?? 0;
    if (n) counts[rel][name] = n;
  }
  const deps = new Set();
  const add = (spec) => {
    if (!spec.startsWith(".")) return;
    const target = resolve(dirname(f), spec.replace(/\.js$/, ".ts"));
    if (existsSync(target)) deps.add(relative(srcDir, target).replaceAll("\\", "/"));
  };
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier)) {
      const named = n.importClause?.namedBindings;
      const allTypes = named && ts.isNamedImports(named) && !n.importClause.name && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
      if (!allTypes) add(n.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) add(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  imports.set(rel, deps);
}

// import cycles: strongly connected components (Tarjan)
const cycles = [];
{
  let i = 0;
  const idx = new Map(), low = new Map(), stack = [], on = new Set();
  const strong = (v) => {
    idx.set(v, i), low.set(v, i), i++, stack.push(v), on.add(v);
    for (const w of imports.get(v) ?? []) {
      if (!idx.has(w)) strong(w), low.set(v, Math.min(low.get(v), low.get(w)));
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = [];
      let w;
      do (w = stack.pop()), on.delete(w), c.push(w);
      while (w !== v);
      if (c.length > 1 || imports.get(v)?.has(v)) cycles.push(c.sort());
    }
  };
  for (const v of imports.keys()) if (!idx.has(v)) strong(v);
}

const total = (inBoundary) => {
  const t = {};
  for (const [f, c] of Object.entries(counts)) if (BOUNDARY.has(f) === inBoundary) for (const [k, n] of Object.entries(c)) t[k] = (t[k] ?? 0) + n;
  return t;
};
const outside = total(false), inside = total(true);
const sum = (t) => Object.values(t).reduce((a, b) => a + b, 0);

// the table, for the terminal and for STATUS.md
const names = Object.keys(PATTERNS);
const rows = [
  "| Pattern | Outside boundary files | In boundary files |",
  "|---|---|---|",
  ...names.map((k) => `| \`${k}\` | ${outside[k] ?? 0} | ${inside[k] ?? 0} |`),
  `| **total** | **${sum(outside)}** | **${sum(inside)}** |`,
];
const perFile = Object.entries(counts)
  .map(([f, c]) => [f, Object.values(c).reduce((a, b) => a + b, 0)])
  .filter(([, n]) => n)
  .sort((a, b) => b[1] - a[1])
  .map(([f, n]) => `${f} ${n}`)
  .join(", ");
const table = `${rows.join("\n")}\n\nImport cycles: ${cycles.length ? cycles.map((c) => c.join(" ↔ ")).join("; ") : "none"}.\nPer file: ${perFile || "nothing left"}.`;
console.log(table);

if (existsSync(statusFile)) {
  const s = readFileSync(statusFile, "utf8");
  const block = `<!-- leftovers -->\n${table}\n<!-- /leftovers -->`;
  const next = /<!-- leftovers -->[\s\S]*?<!-- \/leftovers -->/.test(s) ? s.replace(/<!-- leftovers -->[\s\S]*?<!-- \/leftovers -->/, block) : s;
  if (next !== s) writeFileSync(statusFile, next);
}

const problems = [];
if (cycles.length) problems.push(`import cycles: ${cycles.map((c) => c.join(" ↔ ")).join("; ")}`);
const saved = existsSync(savedFile) ? JSON.parse(readFileSync(savedFile, "utf8")) : null;
const now = { outside, inside };
if (saved) {
  for (const side of ["outside", "inside"])
    for (const k of names) {
      if (MAY_GROW.has(k)) continue;
      const before = saved[side][k] ?? 0, after = now[side][k] ?? 0;
      if (after > before) problems.push(`${k} (${side} boundary files) went up: ${before} → ${after}`);
    }
}
if (process.argv.includes("--final")) {
  if (sum(outside)) problems.push(`--final: ${sum(outside)} left outside the boundary files`);
}
if (problems.length) {
  console.error(`\nG6 red:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
if (process.argv.includes("--update") || !saved) {
  writeFileSync(savedFile, JSON.stringify(now, null, 1) + "\n");
  console.log("\nsaved to scripts/leftovers.json");
}
console.log(`\nG6 green: ${sum(outside)} left outside the boundary files`);
