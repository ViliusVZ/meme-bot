"""Call the Discord API as the bot, via its /admin/discord passthrough (test bot unless BOT=prod).

    python scripts/dc.py GET /guilds/{guild}/channels
    python scripts/dc.py PATCH /channels/123 '{"name": "x"}'

{guild} expands to the target's server id. The admin secret comes from bot/.env.qa.
"""
import json
import sys
import urllib.request

from target import ADMIN_SECRET, GUILD, URL


def call(method, path, body=None):
    return admin("/admin/discord", {"method": method, "path": path.replace("{guild}", GUILD), "body": body})


def admin(route, payload=None):
    req = urllib.request.Request(
        URL + route,
        method="POST",
        data=json.dumps(payload or {}).encode(),
        headers={"Authorization": f"Bearer {ADMIN_SECRET}", "Content-Type": "application/json", "User-Agent": "dc.py"},
    )
    with urllib.request.urlopen(req, timeout=150) as r:
        return json.loads(r.read())


if __name__ == "__main__":
    method, path, *rest = sys.argv[1:]
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(call(method, path, json.loads(rest[0]) if rest else None), indent=1, ensure_ascii=False))
