"""Testing helper: wipe today's game night and every message in #game-night (no pings involved)."""
import sys

from dc import admin, call

CHANNEL = "1567132345213911240"
sys.stdout.reconfigure(encoding="utf-8")
print(admin("/admin/gamenight", {"action": "reset"}))
for m in call("GET", f"/channels/{CHANNEL}/messages?limit=50"):
    call("DELETE", f"/channels/{CHANNEL}/messages/{m['id']}")
print("messages left:", len(call("GET", f"/channels/{CHANNEL}/messages?limit=50")))
print("events left:", len(call("GET", "/guilds/{guild}/scheduled-events")))
