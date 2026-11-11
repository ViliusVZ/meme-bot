#!/usr/bin/env bash
# Every gate of plan 05 (verification.md §3), in order; stops at the first red one.
#   bash scripts/gates.sh
# Runs against TEST_DATABASE_URL (a local Postgres is much faster than the tunnel; see STATUS.md).
# The floors (tests, query sites) live in scripts/gates.json: the test count only ever goes up.
set -euo pipefail
cd "$(dirname "$0")/.."
floors=scripts/gates.json
red() { echo "GATE RED: $*" >&2; exit 1; }

echo "== G1 types"
npm run -s check || red "G1 types"

echo "== G2 tests (+ G4 recordings)"
if grep -rnE "\b(test|it|describe)\.(only|skip|todo)\b|(^|[^.[:alnum:]_])(xit|xtest|fit)\(" test --include=*.ts; then red "G2: .only/.skip/.todo in the tests"; fi
rm -rf test/__recordings__/full
npx vitest run --coverage --coverage.reporter=json --reporter=default --reporter=json --outputFile.json=coverage/vitest.json || red "G2 tests"
node -e '
const r = require("./coverage/vitest.json"), f = require("./'$floors'");
if (r.numFailedTests || r.numPendingTests || r.numTodoTests) { console.error("failed/skipped/todo:", r.numFailedTests, r.numPendingTests, r.numTodoTests); process.exit(1); }
if (r.numPassedTests < f.tests) { console.error(`tests: ${r.numPassedTests} < floor ${f.tests}`); process.exit(1); }
if (r.numPassedTests > f.tests) { f.tests = r.numPassedTests; require("fs").writeFileSync("'$floors'", JSON.stringify(f, null, 1) + "\n"); }
console.log(`G2: ${r.numPassedTests} passed (floor ${f.tests})`);
' || red "G2 counts"
if [ -n "$(git status --porcelain -- test/__recordings__)" ]; then git status --short -- test/__recordings__; red "G4 recordings differ"; fi
echo "G4: recordings identical"

echo "== G3 queries"
python scripts/qcov.py --expect "$(node -p 'require("./'$floors'").querySites')" || red "G3 queries"

echo "== G5 assertions"
node scripts/assertions.mjs --check || red "G5 assertions"

echo "== G6 leftovers"
node scripts/leftovers.mjs ${LEFTOVERS_FLAGS:-} > coverage/leftovers.txt || { cat coverage/leftovers.txt; red "G6 leftovers"; }
tail -1 coverage/leftovers.txt

echo "== G7 build"
npm run -s build || red "G7 build"

echo "ALL GATES GREEN"
