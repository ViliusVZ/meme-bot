#!/usr/bin/env bash
# Every live QA suite against the TEST bot, one after another (plan 05, verification.md §2c/§9),
# with each suite's output saved, then the numbers: each suite's result line, tap handling times
# from the bot's own "interaction <ms> ms" log lines during qa_all, and the container's memory.
#   bash scripts/qa_baseline.sh <out-dir>
# Never against production: the scripts default to the test bot and this refuses BOT=prod.
set -uo pipefail
cd "$(dirname "$0")/.."
[ "${BOT:-}" = "prod" ] && { echo "QA runs on the test bot only" >&2; exit 1; }
out=${1:?out dir}
mkdir -p "$out"
export PYTHONIOENCODING=utf-8
summary="$out/summary.txt"
: > "$summary"
note() { echo "$*" | tee -a "$summary"; }
run() { # name, command...
  local name=$1; shift
  local t0=$(date +%s)
  "$@" > "$out/$name.log" 2>&1
  local code=$?
  note "$name: exit $code, $(( $(date +%s) - t0 )) s, $(grep -E 'passed|failed' "$out/$name.log" | tail -1)"
}
note "test bot: $(curl -s https://srv2140520.hstgr.cloud/bot-dev/health)"

all_from=$(date -u +"%Y-%m-%d %H:%M:%S")
run qa_all python scripts/qa_all.py
all_to=$(date -u +"%Y-%m-%d %H:%M:%S")
run qa_timing python scripts/qa_timing.py
run qa_rooms python scripts/qa_rooms.py
run qa_stats python scripts/qa_stats.py
run qa_spontaneous python scripts/qa_spontaneous.py
run qa_slowpoke python scripts/qa_slowpoke.py

# the two helpers made for real clicks: a fixed sequence, its output kept for comparison
{
  python scripts/qa_late_ui.py setup && python scripts/qa_late_ui.py tick && python scripts/qa_late_ui.py state && python scripts/qa_late_ui.py offcard
} > "$out/qa_late_ui.log" 2>&1
note "qa_late_ui: exit $?, $(grep -c '' "$out/qa_late_ui.log") lines"
{
  python scripts/qa_leaveby.py setup && python scripts/qa_leaveby.py vote V time 19:00 && python scripts/qa_leaveby.py vote K time 19:30 &&
    python scripts/qa_leaveby.py vote L until 20:00 && python scripts/qa_leaveby.py vote L time 19:00 && python scripts/qa_leaveby.py vote L until "" &&
    python scripts/qa_leaveby.py state
} > "$out/qa_leaveby.log" 2>&1
note "qa_leaveby: exit $?, $(grep -c '' "$out/qa_leaveby.log") lines"
days=$(python -c "import sys; sys.path.insert(0,'scripts'); from qa_guard import TEST_DAYS as d; print(d[2], d[3], d[7])")
python scripts/reset_gamenight.py $days > "$out/reset.log" 2>&1
note "reset of the helpers' days ($days): exit $?"

run qa_maybe_matrix python scripts/qa_maybe_matrix.py

# tap handling during qa_all, from the bot's own log lines ("interaction 412 ms …")
ssh vps "journalctl CONTAINER_TAG=meme-bot-dev -q --since '$all_from UTC' --until '$all_to UTC' -o cat 2>/dev/null || true" > "$out/qa_all.botlog" 2>/dev/null
if [ ! -s "$out/qa_all.botlog" ]; then ssh vps "app-logs meme-bot-dev 3h" > "$out/qa_all.botlog" 2>&1; fi
python - "$out/qa_all.botlog" <<'PY' | tee -a "$summary"
import re, statistics, sys
ms = [int(m.group(1)) for l in open(sys.argv[1], encoding="utf-8", errors="replace") if (m := re.search(r"\binteraction (\d+) ms", l))]
if ms:
    ms.sort()
    p95 = ms[min(len(ms) - 1, int(round(0.95 * (len(ms) - 1))))]
    print(f"taps: {len(ms)}, median {statistics.median(ms):.0f} ms, p95 {p95} ms, max {ms[-1]} ms, over 1500 ms: {sum(1 for x in ms if x > 1500)}")
else:
    print("taps: no interaction lines found")
PY
note "memory: $(ssh vps "docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep '^meme-bot-dev-'") at uptime $(curl -s https://srv2140520.hstgr.cloud/bot-dev/health | python -c 'import json,sys; print(json.load(sys.stdin).get("uptime"))') s"
note "done"
