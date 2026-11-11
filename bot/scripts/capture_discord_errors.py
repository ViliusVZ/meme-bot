"""Capture Discord's real error answers from the TEST bot into test/fixtures/discord-errors/ (plan 05,
verification.md §2d). The typed error model is built from these, not from memory of Discord's docs.

    python scripts/capture_discord_errors.py

Goes through the test bot's /admin/discord passthrough, whose errors carry Discord's status and body
("GET /x -> 404 {...}"). The interaction-token and rate-limit cases need no bot token, so they go to
Discord directly. Only touches the test server: one scheduled event, created and ended here.
"""
import datetime
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import qa_guard  # noqa: E402
from dc import call  # noqa: E402
from target import BOT_ID, GAME_CHANNEL, LOBBY, PROD  # noqa: E402

assert not PROD, "captures run against the test bot only"
OUT = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures" / "discord-errors"
OUT.mkdir(parents=True, exist_ok=True)
API = "https://discord.com/api/v10"
UA = "DiscordBot (https://github.com/ViliusVZ/meme-bot, 3.0)"


def save(name, method, path, status, body, note):
    (OUT / f"{name}.json").write_text(json.dumps({"note": note, "request": {"method": method, "path": path}, "status": status, "body": body}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{name}: {status} {json.dumps(body)[:120]}")


def via_bot(name, method, path, body=None, note=""):
    r = call(method, path, body)
    err = r.get("error") if isinstance(r, dict) else None
    m = re.match(r"^(?:Error: )?\w+ (\S+) -> (\d+) (.*)$", err or "", re.S)
    if not m:
        raise SystemExit(f"{name}: expected an error, got {json.dumps(r)[:200]}")
    save(name, method, m.group(1), int(m.group(2)), json.loads(m.group(3)), note)
    return r


def direct(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null"), dict(e.headers)


qa_guard.require_idle()
guild_path = "/guilds/{guild}"

via_bot("unknown-voice-state", "GET", f"{guild_path}/voice-states/1", note="voice.ts voiceChannel: a user who isn't in voice")
via_bot("unknown-channel", "GET", "/channels/1", note="a channel that is gone (deleted by hand, or swept)")
via_bot("unknown-message", "GET", f"/channels/{GAME_CHANNEL}/messages/1", note="a message that is gone (deleted by hand, or swept)")
via_bot("unknown-message-patch", "PATCH", f"/channels/{GAME_CHANNEL}/messages/1", {"content": "x"}, note="editing a message that is gone")
via_bot("unknown-guild", "GET", "/guilds/968922621662076988/voice-states/10065", note="a guild the test bot isn't in (the trio's server; a read-only GET)")
via_bot("missing-access", "GET", "/channels/1567132345213911240/messages/10065", note="a 403 whose path contains 10065: must not read as 'not in voice' (a channel on the trio's server, which the test bot can't see; a read-only GET)")

# an event that was ended: what Discord says when we try to end it again, or push its end back
start = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)).isoformat()
end = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=65)).isoformat()
ev = call("POST", f"{guild_path}/scheduled-events", {"name": "plan 05 error capture", "privacy_level": 2, "scheduled_start_time": start, "scheduled_end_time": end, "entity_type": 2, "channel_id": LOBBY})
assert "id" in ev, ev
try:
    call("PATCH", f"{guild_path}/scheduled-events/{ev['id']}", {"status": 2})
    call("PATCH", f"{guild_path}/scheduled-events/{ev['id']}", {"status": 3})
    later = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=95)).isoformat()
    via_bot("ended-event-extend", "PATCH", f"{guild_path}/scheduled-events/{ev['id']}", {"scheduled_end_time": later}, note="voice.ts keepEventAlive: pushing back the end of an event that was ended")
    via_bot("ended-event-end", "PATCH", f"{guild_path}/scheduled-events/{ev['id']}", {"status": 3}, note="voice.ts archiveIfIdle: ending an event that was already ended")
finally:
    r = call("DELETE", f"{guild_path}/scheduled-events/{ev['id']}")
    print("event cleanup:", r)
via_bot("deleted-event-extend", "PATCH", f"{guild_path}/scheduled-events/{ev['id']}", {"scheduled_end_time": end}, note="pushing back the end of an event that was deleted")

# interaction webhooks: an expired (here: made-up) token
s, b, _ = direct("PATCH", f"/webhooks/{BOT_ID}/aW50ZXJhY3Rpb24-expired-token/messages/@original", {"content": "x"})
save("expired-interaction-token", "PATCH", f"/webhooks/{BOT_ID}/<token>/messages/@original", s, b, "discord.ts editOriginal on a token past its 15 minutes")

# a rate limit: unauthenticated webhook lookups have a small per-route bucket
for i in range(60):
    s, b, h = direct("GET", f"/webhooks/{BOT_ID}/aW50ZXJhY3Rpb24-expired-token/messages/@original")
    if s == 429:
        save("rate-limited", "GET", f"/webhooks/{BOT_ID}/<token>/messages/@original", s, b, f"after {i + 1} quick requests; headers: retry-after={h.get('Retry-After') or h.get('retry-after')}, scope={h.get('X-RateLimit-Scope') or h.get('x-ratelimit-scope')}")
        break
    time.sleep(0.05)
else:
    print("rate-limited: no 429 in 60 requests")
