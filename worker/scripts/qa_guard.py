"""Safety net for the QA scripts. They run against the live bot, so they must never touch real data.

`require_idle()` aborts unless the bot is idle: no real night voting or on, no real game room, nobody
in voice (QA rooms pull people out of the Lobby) and not around the 17:00 poll. QA nights live on
far-future TEST_DAYS, and cleanups only remove what a run created (see `Snapshot`). Never weaken
this: on 2026-11-03 an unguarded run wiped a real game night's card, room and event mid-session.
"""
import json
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone

from dc import call

PLAYERS = ("306836805825593344", "212567787896307713", "747902984003780651")
GAME_CHANNEL = "1567132345213911240"
BOT_ID = "968964425514102895"
# Planning only reaches a week out, so anything past two weeks is never a real night. QA uses the
# eight days from the first Monday at least 45 days ahead.
REAL_UNTIL = str(date.today() + timedelta(days=14))
_monday = date.today() + timedelta(days=45)
_monday += timedelta(days=-_monday.weekday() % 7)
TEST_DAYS = tuple(str(_monday + timedelta(days=i)) for i in range(8))


def _last_sunday(y, m):
    d = date(y, m, 31)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def vilnius(day, hhmm):
    """Unix seconds (as a string) for a Vilnius wall-clock time; Windows Python has no tz database."""
    y, m, d = map(int, day.split("-"))
    h, mi = map(int, hhmm.split(":"))
    wall = datetime(y, m, d, h, mi)
    summer = datetime.combine(_last_sunday(y, 3), datetime.min.time()) + timedelta(hours=3) <= wall < datetime.combine(_last_sunday(y, 10), datetime.min.time()) + timedelta(hours=4)
    return str(int((wall - timedelta(hours=3 if summer else 2)).replace(tzinfo=timezone.utc).timestamp()))


def sql(q):
    out = subprocess.run(["python", "scripts/sql.py", q], capture_output=True, text=True, encoding="utf-8").stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def in_list(values):
    return ", ".join(f"'{v}'" for v in values)


def wall(ts):
    """Vilnius "HH:MM" for unix seconds (the inverse of `vilnius`)."""
    for off in (2, 3):
        t = datetime.fromtimestamp(int(ts), timezone.utc) + timedelta(hours=off)
        if vilnius(t.strftime("%Y-%m-%d"), t.strftime("%H:%M")) == str(int(ts)):
            return t.strftime("%H:%M")
    return "??:??"


def require_idle():
    now = int(time.time())
    problems = []
    for n in sql(f"SELECT day, stage, start_at FROM game_nights WHERE day <= '{REAL_UNTIL}'"):
        if n["stage"] in ("ask", "game", "time"):
            problems.append(f"real night {n['day']} is still voting ({n['stage']})")
        elif n["stage"] == "set" and (n["start_at"] or 0) > now - 5 * 3600:
            problems.append(f"real night {n['day']} is on or coming up")
    for r in sql(f"SELECT game FROM rooms WHERE day IS NULL OR day <= '{REAL_UNTIL}'"):
        problems.append(f"a real game room is open ({r['game']})")
    utc = time.gmtime(now)
    minutes = utc.tm_hour * 60 + utc.tm_min
    if 13 * 60 + 50 <= minutes <= 15 * 60 + 10:  # 17:00 Vilnius is 14:00 or 15:00 UTC
        problems.append("it's around the 17:00 poll")
    for p in PLAYERS:
        if call("GET", f"/guilds/{{guild}}/voice-states/{p}").get("channel_id"):
            problems.append(f"<@{p}> is in voice")
    if problems:
        print("🛑 Not running QA, the bot isn't idle:\n  - " + "\n  - ".join(problems))
        sys.exit(2)


class Snapshot:
    """Remembers what existed before a run, so cleanup only removes what the run created."""

    def __init__(self):
        self.marker = str((int(time.time() * 1000) - 1420070400000) << 22)  # a snowflake for "now"
        self.events = {e["id"] for e in call("GET", "/guilds/{guild}/scheduled-events")}
        self.games = {g["name"]: g["plays"] for g in sql("SELECT name, plays FROM games")}

    def cleanup(self):
        # only the bot's own messages, and only ones posted during this run
        for m in call("GET", f"/channels/{GAME_CHANNEL}/messages?after={self.marker}&limit=100"):
            if m["author"]["id"] == BOT_ID and not m.get("pinned"):
                call("DELETE", f"/channels/{GAME_CHANNEL}/messages/{m['id']}")
        for e in call("GET", "/guilds/{guild}/scheduled-events"):
            if e["id"] not in self.events:
                call("DELETE", f"/guilds/{{guild}}/scheduled-events/{e['id']}")
        current = {g["name"] for g in sql("SELECT name FROM games")}
        added = current - set(self.games)
        stmts = [f"UPDATE games SET plays = {p} WHERE name = '{n.replace(chr(39), chr(39) * 2)}'" for n, p in self.games.items()]
        if added:
            stmts.append(f"DELETE FROM games WHERE name IN ({in_list(n.replace(chr(39), chr(39) * 2) for n in added)})")
        sql("; ".join(stmts))
