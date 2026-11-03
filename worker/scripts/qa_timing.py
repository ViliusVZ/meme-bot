"""QA: starts land on the dot, and rooms wrap up 15 minutes after the last person leaves.

    python scripts/qa_timing.py
"""
import json
import subprocess
import sys
import time

from dc import admin, call
from qa_guard import GAME_CHANNEL, TEST_DAYS, Snapshot, quiet_window, require_idle, vilnius

sys.stdout.reconfigure(encoding="utf-8")
V, K, L = "306836805825593344", "212567787896307713", "747902984003780651"
DAY = TEST_DAYS[5]
QA_ROOM = "QA Test Room"
results = {"pass": 0, "fail": 0}


def ok(cond, msg):
    results["pass" if cond else "fail"] += 1
    print(("  ✅ " if cond else "  ❌ ") + msg)


def sql(q):
    out = subprocess.run(["python", "scripts/sql.py", q], capture_output=True, text=True, encoding="utf-8").stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def gn(user, choice, value=None):
    return admin("/admin/gamenight", {"action": "vote", "day": DAY, "user": user, "choice": choice, "value": value})


def snowflake_ms(sid):
    return (int(sid) >> 22) + 1420070400000


require_idle()
snap = Snapshot()
admin("/admin/gamenight", {"action": "reset", "day": DAY})
admin("/admin/gamenight", {"action": "plan", "user": V, "day": DAY})
for u in (K, L):
    gn(u, "yes")
gn(V, "game", "Phasmophobia")
gn(K, "game", "Phasmophobia")
for u in (V, K, L):
    gn(u, "time", vilnius(DAY, "18:00"))
n = sql(f"SELECT stage, event_id, event_end FROM game_nights WHERE day = '{DAY}'")[0]
print("\n▶ lock-in")
ok(n["stage"] == "set" and n["event_id"] and n["event_end"] == int(vilnius(DAY, "21:00")), f"locked with an event ending 21:00 (event_end stored: {n['event_end']})")

print("\n▶ a start on the dot")
quiet_window()
start = int(time.time()) + 25
sql(f"UPDATE game_nights SET start_at = {start}, reminded = 0 WHERE day = '{DAY}'")
r = admin("/admin/gamenight", {"action": "precise", "within": 40})
done = time.time()
ok(r == [DAY], f"the waiting start fired ({r})")
room = sql(f"SELECT channel_id, created_at FROM rooms WHERE day = '{DAY}'")
ok(len(room) == 1, "a room was opened")
room_ms = snowflake_ms(room[0]["channel_id"])
ok(start * 1000 - 15000 <= room_ms < start * 1000, f"the room opened {start - room_ms / 1000:.1f}s before the start")
pings = [m for m in call("GET", f"/channels/{GAME_CHANNEL}/messages?after={snap.marker}&limit=50") if "starts now" in (m.get("content") or "")]
ok(len(pings) == 1, "one start ping")
lag = snowflake_ms(pings[0]["id"]) / 1000 - start if pings else 99
ok(0 <= lag < 2, f"the ping went out {lag:.2f}s after the start time (moves happen just before it)")
ev = call("GET", f"/guilds/{{guild}}/scheduled-events/{n['event_id']}")
ok(ev.get("status") == 2, "the event went live")
r = admin("/admin/gamenight", {"action": "precise", "within": 5})
ok(r == [], "nothing fires twice")
ok(sql(f"SELECT reminded FROM game_nights WHERE day = '{DAY}'")[0]["reminded"] == 1, "the start is claimed once")

print("\n▶ wrap-up 15 minutes after the last person leaves")
now = int(time.time())
other = admin("/admin/gamenight", {"action": "room", "game": QA_ROOM, "emoji": "🧪"})
sql(f"UPDATE rooms SET last_seen = {now - 14 * 60 - 20} WHERE day = '{DAY}'")  # left 14m20s ago
sql(f"UPDATE rooms SET last_seen = {now - 13 * 60} WHERE channel_id = '{other['channelId']}'")  # left 13 min ago
before = time.time()
r = admin("/admin/gamenight", {"action": "watch", "within": 70})
# (the real tick's own minute sweep may get there first; either way it's the same 15-minute rule)
archived = sql(f"SELECT archived_at FROM rooms WHERE day = '{DAY}'")[0]["archived_at"]
ok(archived is not None and "QA Test Room" not in r, f"right at the 15-minute mark the empty room is archived ({r}, {time.time() - before:.0f}s)")
ev = call("GET", f"/guilds/{{guild}}/scheduled-events/{n['event_id']}")
ok(ev.get("status") == 3, f"and the night's event ended (status {ev.get('status')})")
ok(sql(f"SELECT archived_at FROM rooms WHERE channel_id = '{other['channelId']}'")[0]["archived_at"] is None, "the other room is still open")

print("\n▶ cleanup")
for rm in sql(f"SELECT channel_id FROM rooms WHERE day = '{DAY}' OR game = '{QA_ROOM}'"):
    call("DELETE", f"/channels/{rm['channel_id']}")
sql(f"DELETE FROM rooms WHERE day = '{DAY}' OR game = '{QA_ROOM}'")
admin("/admin/gamenight", {"action": "reset", "day": DAY})
admin("/admin/gamenight", {"action": "rooms"})
snap.cleanup()
ok(not sql(f"SELECT 1 FROM game_nights WHERE day = '{DAY}'"), "test night gone")
ok("🗄️ Recent games" not in [c["name"] for c in call("GET", "/guilds/{guild}/channels")], "no leftover archive category")
print(f"\n{results['pass']} passed, {results['fail']} failed")
sys.exit(1 if results["fail"] else 0)
