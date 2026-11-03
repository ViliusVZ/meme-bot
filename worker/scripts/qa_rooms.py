"""QA: game-room lifecycle with nobody in voice (archive → delete, never-joined, deleted by hand)."""
import json
import subprocess
import sys
import time

from dc import admin, call

sys.stdout.reconfigure(encoding="utf-8")
ok = lambda cond, msg: print(("✅ " if cond else "❌ ") + msg)


def sql(q):
    out = subprocess.run(["python", "scripts/sql.py", q], capture_output=True, text=True, encoding="utf-8").stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def channels():
    return call("GET", "/guilds/{guild}/channels")


tick = lambda: admin("/admin/gamenight", {"action": "rooms"})
now = int(time.time())

# start clean: drop leftovers from earlier runs
for r in sql("SELECT channel_id FROM rooms"):
    call("DELETE", f"/channels/{r['channel_id']}")
sql("DELETE FROM rooms")
tick()

# 1) a room people played in and left 25 min ago: archive, then delete after 3 days
first = admin("/admin/gamenight", {"action": "room", "game": "Phasmophobia", "emoji": "👻"})
sql(f"UPDATE rooms SET last_seen = {now - 1500} WHERE channel_id = '{first['channelId']}'")
ok(tick().get("archived") == ["Phasmophobia"], "empty 25 min → archived")
sql(f"UPDATE rooms SET archived_at = {now - 4 * 86400}")
r = tick()
ok(r.get("deleted") == ["Phasmophobia"], f"archived 4 days → deleted ({r})")
names = [c["name"] for c in channels()]
ok("👻 Phasmophobia" not in names and "🗄️ Recent games" not in names, "room and empty archive category are gone")

# 2) opened but nobody comes: kept for an hour, then archived
room = admin("/admin/gamenight", {"action": "room", "game": "R.E.P.O.", "emoji": "📦"})
ok(room["moved"] == [] and not room["reused"], "room opens even with an empty Lobby (nobody to move)")
ok(not tick(), "fresh empty room is left alone")
sql(f"UPDATE rooms SET created_at = {now - 3700} WHERE channel_id = '{room['channelId']}'")
ok(tick().get("archived") == ["R.E.P.O."], "never joined for an hour → archived")

# 3) someone deletes a room by hand: forgotten without errors, archive tidied
call("DELETE", f"/channels/{room['channelId']}")
r = tick()
ok(r.get("forgotten") == ["R.E.P.O."], f"hand-deleted room is forgotten ({r})")
ok(not sql("SELECT * FROM rooms"), "rooms table is empty")
ok("🗄️ Recent games" not in [c["name"] for c in channels()], "archive category removed when empty")

# 4) reopening after a hand-deletion makes a fresh room
r2 = admin("/admin/gamenight", {"action": "room", "game": "Palworld", "emoji": "🐑"})
call("DELETE", f"/channels/{r2['channelId']}")
r3 = admin("/admin/gamenight", {"action": "room", "game": "Palworld", "emoji": "🐑"})
ok(r3["channelId"] != r2["channelId"] and not r3["reused"], "a hand-deleted room is recreated, not 'reused'")
call("DELETE", f"/channels/{r3['channelId']}")
sql("DELETE FROM rooms")
