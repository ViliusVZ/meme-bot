"""The forced soak on the TEST bot (plan 05, README "the owner's changes": the 48-hour soak in one
sitting). Each scheduled thing is made to happen through the admin routes, then checked: it happened
exactly once, forcing it again does nothing, and a restart of the container in between neither loses
nor repeats it. Then a few hundred minute ticks back to back. Run soak_watch.py alongside.

    python scripts/qa_soak_force.py [--ticks 300] [--no-restart]

Things the admin routes can't force without a test-only hook (the 03:00 sweep, the 19:00 meme-shame
call-out) are proven by TestClock tests instead (STATUS.md says which). Test bot only; quiet calls
(nobody is pinged); scoped to what it creates.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request

from dc import admin
from qa_guard import TEST_DAYS, require_idle, sql
from target import PROD, URL

sys.stdout.reconfigure(encoding="utf-8")
assert not PROD, "the forced soak runs on the test bot only"
p = argparse.ArgumentParser()
p.add_argument("--ticks", type=int, default=300)
p.add_argument("--no-restart", action="store_true")
a = p.parse_args()

results = {"pass": 0, "fail": 0}


def ok(cond, msg):
    results["pass" if cond else "fail"] += 1
    print(("  ✅ " if cond else "  ❌ ") + msg, flush=True)


def health():
    with urllib.request.urlopen(URL + "/health", timeout=10) as r:
        return json.loads(r.read())


def restart():
    """Restart the test bot's running container (as a crash or a host reboot would), and wait for it to lead again."""
    if a.no_restart:
        return
    name = subprocess.run(["ssh", "vps", "docker ps --format '{{.Names}}' | grep '^meme-bot-dev-'"], capture_output=True, text=True).stdout.split()[0]
    subprocess.run(["ssh", "vps", f"sudo host-watch pause 30m >/dev/null; docker restart {name} >/dev/null"], check=True)
    for _ in range(90):
        time.sleep(2)
        try:
            h = health()
            if h.get("ok") and h.get("leader"):
                print(f"  (restarted {name}; leading again, uptime {h.get('uptime')} s)", flush=True)
                return
        except Exception:
            pass
    raise SystemExit("the test bot didn't come back within 3 minutes")


def tick():
    return admin("/admin/gamenight", {"action": "tick"})


require_idle()
day = TEST_DAYS[6]

# ---------------------------------------------------------------- the daily poll card
print("▶ the poll card", flush=True)
admin("/admin/gamenight", {"action": "reset", "day": day})
first = admin("/admin/gamenight", {"action": "plan", "day": day})
ok(first.get("started") is True, f"a card is posted for {day}")
again = admin("/admin/gamenight", {"action": "plan", "day": day})
ok(again.get("started") is False, "forcing it again posts nothing")
restart()
after = admin("/admin/gamenight", {"action": "plan", "day": day})
ok(after.get("started") is False, "after a restart it isn't posted again")
rows = sql(f"SELECT count(*)::int AS n, max(message_id) AS m FROM game_nights WHERE day = '{day}'")
ok(rows[0]["n"] == 1 and rows[0]["m"] == first.get("message_id"), "one card row, the first card's message")
admin("/admin/gamenight", {"action": "reset", "day": day})

# ---------------------------------------------------------------- the daily meme
print("▶ the daily meme", flush=True)
today = time.strftime("%Y-%m-%d", time.gmtime())
# the meme job posts once a day at or after POST_HOUR_UTC: each forced minute runs it
dailies = f"SELECT count(*)::int AS n FROM memes WHERE post_kind = 'daily' AND posted_at LIKE '{today}%'"
before = sql(dailies)[0]["n"]
t1 = tick()
t2 = tick()
restart()
t3 = tick()
now_n = sql(dailies)[0]["n"]
ok(now_n == 1, f"today's daily meme exists exactly once (before: {before}, now: {now_n})")
ok(all("posted" not in (t.get("meme") or {}) or i == 0 for i, t in enumerate([t1, t2, t3])), "only the first forced minute could post it")

# ---------------------------------------------------------------- a Reddit refill
print("▶ a Reddit refill", flush=True)
sql("UPDATE settings SET value = jsonb_build_object('ok', 0, 'tried', 0) WHERE key = 'reddit_refill'")
r = tick()
ok((r.get("refill") or {}).get("refilling") is True, "a minute with the last refill long ago starts one")
time.sleep(20)
ok(not (tick().get("refill") or {}).get("refilling"), "the next minute doesn't start another")
restart()
ok(not (tick().get("refill") or {}).get("refilling"), "nor does a minute after a restart (the time is in the database)")

# ---------------------------------------------------------------- the weekly and monthly recaps
for period in ("week", "month"):
    print(f"▶ the {period}ly meme recap", flush=True)
    first = admin("/admin/recap", {"period": period})
    again = admin("/admin/recap", {"period": period})
    ok("posted" not in again, f"forcing the {period}ly recap again posts nothing ({json.dumps(first)[:80]} then {json.dumps(again)[:80]})")
    restart()
    after = admin("/admin/recap", {"period": period})
    ok("posted" not in after, f"nor after a restart")

# ---------------------------------------------------------------- minute ticks back to back
print(f"▶ {a.ticks} minute ticks back to back", flush=True)
errors = 0
t0 = time.time()
for i in range(a.ticks):
    out = tick()
    errors += sum(1 for v in out.values() if isinstance(v, dict) and "error" in v)
    if i % 50 == 49:
        h = health()
        print(f"  {i + 1} ticks, {time.time() - t0:.0f} s, health ok={h.get('ok')} leader={h.get('leader')} clock={h.get('clock')}", flush=True)
ok(errors == 0, f"no job failed in {a.ticks} ticks ({errors} errors)")

print(f"\n{results['pass']} passed, {results['fail']} failed", flush=True)
sys.exit(1 if results["fail"] else 0)
