// The assertion ledger (plan 05, verification.md §2b): for every test, the ordered list of what it
// asserts. The migration rewrites how tests call the code, never what they assert, and this is
// the proof.
//   node scripts/assertions.mjs          write test/assertions.ledger.json
//   node scripts/assertions.mjs --check  fail if an existing test's assertions changed, shrank,
//                                        were reordered or disappeared (new tests are fine)
// What is recorded per assertion: the matcher chain after `expect(…)` with its arguments
// (`.not.toBe(401)`), or for `assert.*` the method and every argument after the actual value.
// The value under test is left out on purpose: that is the call expression, which may change.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const testDir = `${root}test`;
const ledgerFile = `${testDir}/assertions.ledger.json`;
const squash = (s) => s.replace(/\s+/g, " ").trim();

const TEST_FNS = new Set(["test", "it", "vt"]);
const calleeName = (call) => {
  let e = call.expression;
  while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) e = e.expression; // test.each(…)(…), it.effect
  return ts.isIdentifier(e) ? e.text : undefined;
};

function scan(file) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const text = (n) => squash(n.getText(src));
  const entries = new Map(); // key → assertions, in source order
  const add = (key, a) => {
    if (!entries.has(key)) entries.set(key, []);
    entries.get(key).push(a);
  };
  // the test (with its describe path) or helper function a node sits in
  const owner = (node) => {
    const path = [];
    let fn;
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && p.arguments.length) {
        const name = calleeName(p);
        if (name === "describe" || TEST_FNS.has(name)) path.unshift(`${name === "describe" ? "describe" : "test"} ${text(p.arguments[0])}`);
      }
      if (!fn && !path.length) {
        if (ts.isFunctionDeclaration(p) && p.name) fn = `fn ${p.name.text}`;
        else if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) fn = `fn ${p.parent.name.getText(src)}`;
      }
    }
    if (path.length) return path.join(" > ");
    return fn ?? "top level";
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "expect") {
      // climb the chain: expect(x).not.toBe(1), expect(p).rejects.toThrow("…")
      let chain = "";
      let cur = node;
      for (;;) {
        const p = cur.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
          chain += `.${p.name.text}`;
          cur = p;
        } else if (ts.isCallExpression(p) && p.expression === cur && cur !== node) {
          chain += `(${p.arguments.map(text).join(", ")})`;
          cur = p;
        } else break;
      }
      const msg = node.arguments[1] ? ` [${text(node.arguments[1])}]` : "";
      add(owner(node), `expect${msg}${chain}`);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "assert"
    ) {
      add(owner(node), `assert.${node.expression.name.text}(_${node.arguments.slice(1).map((a) => `, ${text(a)}`).join("")})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return Object.fromEntries(entries);
}

const files = readdirSync(testDir).filter((f) => f.endsWith(".ts")).sort();
const ledger = Object.fromEntries(files.map((f) => [f, scan(`${testDir}/${f}`)]).filter(([, e]) => Object.keys(e).length));

if (!process.argv.includes("--check")) {
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1) + "\n");
  const n = Object.values(ledger).flatMap((e) => Object.values(e)).reduce((s, a) => s + a.length, 0);
  console.log(`ledger written: ${Object.keys(ledger).length} files, ${n} assertions`);
  process.exit(0);
}

if (!existsSync(ledgerFile)) {
  console.error("no ledger: run without --check first");
  process.exit(1);
}
const before = JSON.parse(readFileSync(ledgerFile, "utf8"));
const problems = [];
let checked = 0;
// a test may move to another file (the harness consolidation), so look it up by key everywhere
const now = new Map();
for (const [f, e] of Object.entries(ledger)) for (const [k, a] of Object.entries(e)) now.set(k, [...(now.get(k) ?? []), { f, a }]);
for (const [f, e] of Object.entries(before)) {
  for (const [k, a] of Object.entries(e)) {
    checked += a.length;
    const cands = now.get(k) ?? [];
    const same = cands.find((c) => c.f === f) ?? (cands.length === 1 ? cands[0] : undefined);
    if (!same) problems.push(`${f} › ${k}: gone`);
    else if (JSON.stringify(same.a) !== JSON.stringify(a)) {
      const i = a.findIndex((x, j) => x !== same.a[j]);
      problems.push(`${f} › ${k}: assertion ${i + 1} was\n    ${a[i]}\n  now\n    ${same.a[i] ?? "(missing)"}`);
    }
  }
}
if (problems.length) {
  console.error(`assertion ledger: ${problems.length} test(s) changed\n` + problems.map((p) => `  ${p}`).join("\n"));
  process.exit(1);
}
console.log(`assertion ledger: identical (${checked} assertions checked)`);
