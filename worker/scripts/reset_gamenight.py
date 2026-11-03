"""Testing helper: wipe test game nights and polls, and every #game-night message except the pinned panel.

    python scripts/reset_gamenight.py [day ...]     (default: today)
"""
import sys

from dc import admin, call

CHANNEL = "1567132345213911240"
sys.stdout.reconfigure(encoding="utf-8")
for day in sys.argv[1:] or [None]:
    print(day or "today", admin("/admin/gamenight", {"action": "reset", **({"day": day} if day else {})}))
pinned = {p.get("message", p).get("id") for p in call("GET", f"/channels/{CHANNEL}/pins")}
for m in call("GET", f"/channels/{CHANNEL}/messages?limit=50"):
    if m["id"] not in pinned:
        call("DELETE", f"/channels/{CHANNEL}/messages/{m['id']}")
print("messages left:", len(call("GET", f"/channels/{CHANNEL}/messages?limit=50")), "(pinned:", len(pinned), ")")
print("events left:", len(call("GET", "/guilds/{guild}/scheduled-events")))
