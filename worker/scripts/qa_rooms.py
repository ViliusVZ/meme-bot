"""QA: game-room lifecycle with nobody in voice (archive → delete, never-joined, deleted by hand).

The live bot's own once-a-minute room sweep runs alongside and follows the same rules, so checks
look at the resulting state rather than at which sweep did the work.
"""
import json
import subprocess
import sys
import time

from dc import admin, call
from qa_guard import require_idle

sys.stdout.reconfigure(encoding="utf-8")
ok = lambda cond, msg: print(("✅ " if cond else "❌ ") + msg)


def sql(q):
    out = subprocess.run(["python", "scripts/sql.py", q], capture_output=True, text=True, encoding="utf-8").stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def channels():
    return call("GET", "/guilds/{guild}/channels")


require_idle()  # no real rooms exist past this point, so every room below is ours
def tick():
    time.sleep(2)  # back-to-back channel listings hit Discord's rate limit
    return admin("/admin/gamenight", {"action": "rooms"})


def row(channel_id):
    rows = sql(f"SELECT * FROM rooms WHERE channel_id = '{channel_id}'")
    return rows[0] if rows else None


now = int(time.time())

# start clean: drop leftovers from earlier runs
for r in sql("SELECT channel_id FROM rooms"):
    call("DELETE", f"/channels/{r['channel_id']}")
sql("DELETE FROM rooms")
tick()

# 1) a room people played in and left 25 min ago: archive, then delete after 3 days
first = admin("/admin/gamenight", {"action": "room", "game": "Phasmophobia", "emoji": "👻"})
sql(f"UPDATE rooms SET last_seen = {now - 1500} WHERE channel_id = '{first['channelId']}'")
tick()
ok(row(first["channelId"])["archived_at"] is not None, "empty 25 min → archived")
sql(f"UPDATE rooms SET archived_at = {now - 4 * 86400} WHERE channel_id = '{first['channelId']}'")
r = tick()
ok(row(first["channelId"]) is None, f"archived 4 days → deleted ({r})")
names = [c["name"] for c in channels()]
ok("👻 Phasmophobia" not in names and "🗄️ Recent games" not in names, "room and empty archive category are gone")

# 2) opened but nobody comes: kept for an hour, then archived
room = admin("/admin/gamenight", {"action": "room", "game": "R.E.P.O.", "emoji": "📦"})
ok(room["moved"] == [] and not room["reused"], "room opens even with an empty Lobby (nobody to move)")
tick()
ok(row(room["channelId"])["archived_at"] is None, "fresh empty room is left alone")
sql(f"UPDATE rooms SET created_at = {now - 3700} WHERE channel_id = '{room['channelId']}'")
tick()
ok(row(room["channelId"])["archived_at"] is not None, "never joined for an hour → archived")

# 3) someone deletes a room by hand: forgotten without errors, archive tidied
call("DELETE", f"/channels/{room['channelId']}")
r = tick()
ok(row(room["channelId"]) is None, f"hand-deleted room is forgotten ({r})")
ok(not sql("SELECT * FROM rooms"), "rooms table is empty")
ok("🗄️ Recent games" not in [c["name"] for c in channels()], "archive category removed when empty")

# 4) reopening after a hand-deletion makes a fresh room
r2 = admin("/admin/gamenight", {"action": "room", "game": "Palworld", "emoji": "🐑"})
call("DELETE", f"/channels/{r2['channelId']}")
r3 = admin("/admin/gamenight", {"action": "room", "game": "Palworld", "emoji": "🐑"})
ok(r3["channelId"] != r2["channelId"] and not r3["reused"], "a hand-deleted room is recreated, not 'reused'")
call("DELETE", f"/channels/{r3['channelId']}")
sql("DELETE FROM rooms")
