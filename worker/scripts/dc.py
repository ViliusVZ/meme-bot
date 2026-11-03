"""Call the Discord API as the bot, via the Worker's /admin/discord passthrough.

    python scripts/dc.py GET /guilds/{guild}/channels
    python scripts/dc.py PATCH /channels/123 '{"name": "x"}'

Reads INGEST_SECRET from worker/.dev.vars. {guild} expands to the Terrible Trio guild id.
"""
import json
import pathlib
import sys
import urllib.request

WORKER = "https://meme-bot.meme-bot-worker.workers.dev"
GUILD = "968922621662076988"
SECRET = dict(
    line.split("=", 1) for line in (pathlib.Path(__file__).parent.parent / ".dev.vars").read_text().split()
)["INGEST_SECRET"]


def call(method, path, body=None):
    return admin("/admin/discord", {"method": method, "path": path.replace("{guild}", GUILD), "body": body})


def admin(route, payload=None):
    req = urllib.request.Request(
        WORKER + route,
        method="POST",
        data=json.dumps(payload or {}).encode(),
        headers={"Authorization": f"Bearer {SECRET}", "Content-Type": "application/json", "User-Agent": "dc.py"},
    )
    with urllib.request.urlopen(req, timeout=150) as r:
        return json.loads(r.read())


if __name__ == "__main__":
    method, path, *rest = sys.argv[1:]
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(call(method, path, json.loads(rest[0]) if rest else None), indent=1, ensure_ascii=False))
