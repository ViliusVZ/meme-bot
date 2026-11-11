"""Watch the TEST bot during a soak (plan 05, verification.md §10): every 30 s read /bot-dev/health, the
container's memory and its fresh log lines, and log anything off. One line per sample to stdout and
to the log file; problems are marked "OFF".

    python scripts/soak_watch.py [--minutes N] [--every S] [--log soak.log] [--url URL]

Off means: /health not ok or unreachable, not the leader, the clock (seconds since the last minute)
over 90, the gateway down, the version changed (a deploy), uptime going backwards (a restart), or a
log line saying "failed". The summary at the end gives memory at the start, after an hour and at
the end, and the count of each kind of problem.
"""
import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument("--minutes", type=float, default=48 * 60)
p.add_argument("--every", type=float, default=30)
p.add_argument("--log", default="soak.log")
p.add_argument("--url", default="https://srv2140520.hstgr.cloud/bot-dev/health")
p.add_argument("--app", default="meme-bot-dev")
p.add_argument("--no-ssh", action="store_true", help="health only (no memory or logs)")
a = p.parse_args()
assert "/bot/" not in a.url and not a.url.endswith("/bot/health"), "the soak watches the test bot only"

out = open(a.log, "a", encoding="utf-8")
counts: dict[str, int] = {}
mem: list[tuple[float, float]] = []
last: dict = {}
seen: set[str] = set()
started = time.time()


def say(line):
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"{stamp} {line}", flush=True)
    out.write(f"{stamp} {line}\n")
    out.flush()


def off(kind, detail):
    counts[kind] = counts.get(kind, 0) + 1
    say(f"OFF {kind}: {detail}")


def health():
    try:
        with urllib.request.urlopen(urllib.request.Request(a.url, headers={"User-Agent": "soak_watch"}), timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def ssh(cmd):
    try:
        return subprocess.run(["ssh", "vps", cmd], capture_output=True, text=True, timeout=30).stdout
    except Exception as e:
        return f"ssh failed: {e}"


def memory_mb():
    s = ssh(f"docker stats --no-stream --format '{{{{.Name}}}} {{{{.MemUsage}}}}' | grep '^{a.app}-'")
    m = re.search(r"([\d.]+)(MiB|GiB)", s)
    if not m:
        return None
    return float(m.group(1)) * (1024 if m.group(2) == "GiB" else 1)


say(f"soak_watch: {a.url} every {a.every:.0f} s for {a.minutes:.0f} min")
while time.time() - started < a.minutes * 60:
    t0 = time.time()
    status, h = health()
    if status != 200 or not h.get("ok"):
        off("health", f"{status} {json.dumps(h)[:200]}")
    else:
        if not h.get("leader"):
            off("leader", "this copy isn't leading")
        if (h.get("clock") or 0) > 90:
            off("clock", f"{h.get('clock')} s since the last minute")
        if not h.get("gateway"):
            off("gateway", "down")
        if last.get("version") and h.get("version") != last["version"]:
            off("version", f"{last['version'][:7]} → {str(h.get('version'))[:7]}")
        if last.get("uptime") is not None and (h.get("uptime") or 0) < last["uptime"]:
            off("restart", f"uptime {last['uptime']} → {h.get('uptime')}")
        last = h
    line = f"health {status} clock={h.get('clock')} leader={h.get('leader')} gateway={h.get('gateway')} background={h.get('background')} uptime={h.get('uptime')}"
    if not a.no_ssh:
        mb = memory_mb()
        if mb is not None:
            mem.append((time.time() - started, mb))
            line += f" mem={mb:.1f}MB"
        logs = ssh(f"app-logs {a.app} {max(1, int(a.every // 60) + 1)}m")
        for l in logs.splitlines():
            if re.search(r"failed", l, re.I) and l not in seen:
                seen.add(l)
                off("log", l.strip()[:300])
    say(line)
    time.sleep(max(0, a.every - (time.time() - t0)))

hour = next((m for s, m in mem if s >= 3600), None)
say("summary: " + json.dumps({"problems": counts, "mem_start": mem[0][1] if mem else None, "mem_1h": hour, "mem_end": mem[-1][1] if mem else None}))
sys.exit(1 if counts else 0)
