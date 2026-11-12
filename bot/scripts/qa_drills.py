"""The fault drills on the TEST bot (plan 05, verification.md §8). Each drill does something rough to
the running bot and checks what it should survive; the observed log lines and timings are printed
for STATUS.md.

    python scripts/qa_drills.py [drill ...]      # all of them, or e.g. lock-lost handover

Drills: lock-lost, all-connections, handover, stop-before-start, stop-after-start, hard-kill,
restart-loop. Test bot only; host-watch is paused around anything that stops a container by hand;
qa_guard.require_idle() holds before each drill.
"""
import json
import subprocess
import sys
import time
import urllib.request

from dc import admin
from qa_guard import TEST_DAYS, quiet_window, require_idle, sql
from target import DATABASE, PROD, URL

sys.stdout.reconfigure(encoding="utf-8")
assert not PROD, "drills run on the test bot only"
APP = "meme-bot-dev"
results = {"pass": 0, "fail": 0}


def ok(cond, msg):
    results["pass" if cond else "fail"] += 1
    print(("  ✅ " if cond else "  ❌ ") + msg, flush=True)


def ssh(cmd, check=True):
    return subprocess.run(["ssh", "vps", cmd], capture_output=True, text=True, check=check).stdout


def health():
    try:
        with urllib.request.urlopen(URL + "/health", timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def container():
    return ssh(f"docker ps --format '{{{{.Names}}}}' | grep '^{APP}-'").split()[0]


def logs(since):
    """The test bot's log lines since `since` (UTC, 'YYYY-MM-DD HH:MM:SS')."""
    return ssh(f"journalctl -q -o cat --since '{since} UTC' CONTAINER_TAG={APP} 2>/dev/null || true", check=False).splitlines()


def utc():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())


def until(cond, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(1)
    return False


def leading():
    h = health()
    return h.get("ok") and h.get("leader")


def show(lines, pattern=("leader:", "gateway:", "SIGTERM", "shutting", "started on time", "failed", "refill")):
    for l in lines:
        if any(p in l for p in pattern):
            print("     " + l[-200:], flush=True)


def psql(q):
    """SQL as the database's superuser (to terminate the bot's backends), inside the postgres container as sql.py does."""
    return subprocess.run(["ssh", "vps", f"docker exec -i postgres psql -U postgres -d {DATABASE} -At"], input=q, capture_output=True, text=True).stdout


# ---------------------------------------------------------------- the drills

def lock_lost():
    print("▶ the leader loses its database connection", flush=True)
    since = utc()
    killed = psql("SELECT pg_terminate_backend(l.pid) FROM pg_locks l WHERE l.locktype = 'advisory' AND l.objid = 4242002 AND l.granted")
    ok("t" in killed, "the lock's backend was terminated")
    t0 = time.time()
    ok(until(lambda: any("stepped down" in l for l in logs(since)), 30), "leader: stepped down")
    ok(until(lambda: any("took over" in l for l in logs(since)), 30), f"leader: took over ({time.time() - t0:.0f} s)")
    ok(until(leading, 30), "/health says leader again")
    show(logs(since))


def all_connections():
    print("▶ every database connection drops", flush=True)
    since = utc()
    before = health().get("uptime", 0)
    psql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE '{APP}%' OR application_name LIKE 'meme-bot%' AND datname = '{DATABASE}'")
    ok(until(lambda: health().get("ok"), 30), "/health is ok again within seconds")
    ok(health().get("uptime", 0) >= before, "no process restart")
    t = admin("/admin/gamenight", {"action": "tick"})
    ok(not any(isinstance(v, dict) and "error" in v for v in t.values()), "the next minute's jobs run")
    show(logs(since))


def handover():
    print("▶ handover: the same image deployed twice in a row", flush=True)
    since = utc()
    image = ssh(f"docker inspect --format '{{{{.Config.Image}}}}' {container()}").strip()
    for _ in range(2):
        ssh(f"sudo host-watch pause 30m >/dev/null; deploy-app {APP} {image} >/dev/null 2>&1", check=False)
        ok(until(leading, 120), "leading again after the deploy")
    lines = logs(since)
    took, stepped = [l for l in lines if "took over" in l], [l for l in lines if "stepped down" in l]
    ok(len(took) >= 2 and len(stepped) >= 2, f"two handovers ({len(took)} took over, {len(stepped)} stepped down)")
    ok((health().get("clock") or 0) < 120, f"/health.clock under 120 ({health().get('clock')})")
    show(lines)


def stop_during_start(offset):
    label = "5 s before" if offset < 0 else "half a second after"
    print(f"▶ the leader stopped {label} a start", flush=True)
    require_idle()
    day = TEST_DAYS[5]
    admin("/admin/gamenight", {"action": "reset", "day": day})
    admin("/admin/gamenight", {"action": "plan", "day": day})
    start = int(time.time()) + 60
    quiet_window()
    sql(f"UPDATE game_nights SET stage = 'set', game = 'QA Test Room', start_at = {start}, reminded = false WHERE day = '{day}'")
    since = utc()
    # (the leader's own clock arms a start timer for any night starting within two minutes)
    time.sleep(max(0, start - time.time() + offset))
    ssh(f"sudo host-watch pause 30m >/dev/null; docker stop -t 40 {container()} >/dev/null; docker start {container()} >/dev/null", check=False)
    ok(until(leading, 120), "leading again")
    time.sleep(70)  # the next minute's maintain catches a start the timer missed
    n = sql(f"SELECT reminded FROM game_nights WHERE day = '{day}'")
    ok(n and n[0]["reminded"] is True, "the night started")
    pings = [l for l in logs(since) if "started on time" in l]
    ok(len(pings) <= 1, f"one start, not two ({len(pings)} 'started on time')")
    show(logs(since))
    admin("/admin/gamenight", {"action": "reset", "day": day})


def hard_kill():
    print("▶ a hard kill mid-minute", flush=True)
    since = utc()
    refills = sql("SELECT value FROM settings WHERE key = 'reddit_refill'")
    ssh(f"sudo host-watch pause 30m >/dev/null; docker kill {container()} >/dev/null; docker start {container()} >/dev/null", check=False)
    ok(until(leading, 120), "it restarts and leads again")
    time.sleep(70)
    lines = logs(since)
    ok(not any("memes refilled" in l or "refill" in l and "started" in l for l in lines), "Reddit isn't refetched")
    ok(sql("SELECT value FROM settings WHERE key = 'reddit_refill'") == refills, "the refill time is unchanged")
    show(lines)


def restart_loop():
    print("▶ five restarts in two minutes", flush=True)
    since = utc()
    for _ in range(5):
        ssh(f"sudo host-watch pause 30m >/dev/null; docker restart {container()} >/dev/null", check=False)
        time.sleep(20)
    ok(until(leading, 120), "leading at the end")
    lines = logs(since)
    ok(not any("memes refilled" in l for l in lines), "no Reddit fetch")
    alerts = [l for l in lines if "level=WARN" in l and "failed" in l]
    ok(len(alerts) == 0, f"no alert storm ({len(alerts)} failure lines)")
    show(lines)


DRILLS = {
    "lock-lost": lock_lost,
    "all-connections": all_connections,
    "handover": handover,
    "stop-before-start": lambda: stop_during_start(-5),
    "stop-after-start": lambda: stop_during_start(0.5),
    "hard-kill": hard_kill,
    "restart-loop": restart_loop,
}

try:
    for name in sys.argv[1:] or list(DRILLS):
        require_idle()
        DRILLS[name]()
finally:
    ssh("sudo host-watch resume >/dev/null", check=False)
print(f"\n{results['pass']} passed, {results['fail']} failed", flush=True)
sys.exit(1 if results["fail"] else 0)
