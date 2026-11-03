"""One-off: replace ad-hoc roles with a single admin role shared by the trio."""
import sys

from dc import call

sys.stdout.reconfigure(encoding="utf-8")
PLAYERS = ["306836805825593344", "212567787896307713", "747902984003780651"]

roles = {r["name"]: r for r in call("GET", "/guilds/{guild}/roles")}
trio = roles.get("😈 Trio") or call(
    "POST", "/guilds/{guild}/roles", {"name": "😈 Trio", "permissions": "8", "color": 0x8E44AD, "hoist": False, "mentionable": True}
)
print("role", trio.get("id"), trio.get("name"), trio.get("error", ""))
for uid in PLAYERS:
    print("assign", uid, call("PUT", f"/guilds/{{guild}}/members/{uid}/roles/{trio['id']}"))
