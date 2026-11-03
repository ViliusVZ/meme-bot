"""QA: 📊 voice tracking and the stats panel on the live bot, with stand-in players.

Stand-in user ids (qa-1, qa-2, qa-3) and a stand-in room keep real voice time untouched.
    python scripts/qa_stats.py
"""
import json
import subprocess
import sys
import time

from dc import admin

sys.stdout.reconfigure(encoding="utf-8")
QA = ["qa-1", "qa-2", "qa-3"]
PLAYERS = ",".join(QA)
LOBBY, ROOM = "qa-lobby", "qa-room"
results = {"pass": 0, "fail": 0}


def ok(cond, msg):
    results["pass" if cond else "fail"] += 1
    print(("  ✅ " if cond else "  ❌ ") + msg)


def sql(q):
    out = subprocess.run(["python", "scripts/sql.py", q], capture_output=True, text=True, encoding="utf-8").stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def track(t, **where):
    admin("/admin/gamenight", {"action": "stats", "players": PLAYERS, "track": {u: where.get(u.replace("-", "")) for u in QA}, "t": t})


def segs():
    return sql(f"SELECT user_id, channel_id, game, started_at, last_seen, open FROM voice_segments WHERE user_id IN ({', '.join(repr(u) for u in QA)}) ORDER BY id")


def flatten(m):
    out = []

    def walk(cs):
        for c in cs:
            if c.get("content"):
                out.append(c["content"])
            if c.get("type") == 2:
                out.append(f"[{c.get('label')}]")
            walk(c.get("components", []))

    walk(m.get("components", []))
    return "\n".join(out)


def clean():
    sql(f"DELETE FROM voice_segments WHERE user_id IN ({', '.join(repr(u) for u in QA)}); DELETE FROM rooms WHERE channel_id = '{ROOM}'")


clean()
sql(f"INSERT INTO rooms (channel_id, game, day, created_by, created_at) VALUES ('{ROOM}', 'R.E.P.O.', NULL, NULL, {int(time.time())})")
# a little evening, a minute per check, starting 2 h 10 min ago (this week, unless that was Sunday
# and it's now early Monday: then ask the panel for last week)
t0 = int(time.time()) - 130 * 60
offset = -1 if time.localtime().tm_wday == 0 and time.localtime(t0).tm_wday == 6 else 0

print("\n▶ tracking")
track(t0, qa1=LOBBY)
ok(len(segs()) == 1 and segs()[0]["open"] == 1, "joining voice opens a segment")
track(t0 + 60, qa1=LOBBY, qa2=LOBBY)
track(t0 + 60, qa1=LOBBY, qa2=LOBBY)  # a second check racing at the same moment
ok(len(segs()) == 2, "a racing duplicate check doesn't open a second segment")
for k in range(2, 31):
    track(t0 + 60 * k, qa1=LOBBY, qa2=LOBBY)
s = segs()
ok(s[0]["last_seen"] == t0 + 1800 and s[0]["open"] == 1, "staying put extends the segment")
for k in range(31, 121):  # everyone hops into the game room; qa-3 joins later
    track(t0 + 60 * k, qa1=ROOM, qa2=ROOM, qa3=ROOM if k >= 60 else None)
s = segs()
lobby = [x for x in s if x["channel_id"] == LOBBY]
room = [x for x in s if x["channel_id"] == ROOM]
ok(all(x["open"] == 0 for x in lobby) and len(room) == 3, "moving channels closes the old segment and opens a new one")
ok(all(x["game"] == "R.E.P.O." for x in room), "game-room segments carry the room's game")
track(t0 + 60 * 121)  # everyone leaves
ok(all(x["open"] == 0 for x in segs()), "leaving voice closes every segment")
track(t0 + 60 * 122, qa1=LOBBY)
track(t0 + 60 * 126, qa1=LOBBY)  # a 4-minute hole in the checks
ok(len([x for x in segs() if x["user_id"] == "qa-1" and x["started_at"] >= t0 + 60 * 122]) == 2, "a long gap in the checks splits a segment")
track(t0 + 60 * 127)

print("\n▶ stats panel")
m = admin("/admin/gamenight", {"action": "stats", "players": PLAYERS, "kind": "week", "offset": offset})
txt = flatten(m)
print("    " + txt.replace("\n", "\n    "))
ok("Together · **2h 00m**" in txt, "2 hours together (30 min Lobby + 90 min R.E.P.O.)")
ok("1 call ·" in txt, "it's one call, Lobby → room included")
ok("R.E.P.O. **1h 30m**" in txt and "Hanging out **30m**" in txt, "game time and hangout time")
ok("🥇 <@qa-1> **2h 0" in txt and "<@qa-3> **1h 01m**" in txt, "voice time per person")
ok("[Week]" in txt and "[Share in chat]" in txt and m["flags"] & 64, "private, with period buttons and share")
for kind in ("month", "year", "all"):
    t = flatten(admin("/admin/gamenight", {"action": "stats", "players": PLAYERS, "kind": kind, "offset": 0}))
    ok("Together" in t or "Nothing yet" in t, f"{kind} view renders")
t = flatten(admin("/admin/gamenight", {"action": "stats", "players": PLAYERS, "kind": "week", "offset": offset - 50}))
ok("Nothing yet" in t, "a week a year ago is empty and says so")

print("\n▶ cleanup")
clean()
ok(not segs(), "stand-in data gone")
print(f"\n{results['pass']} passed, {results['fail']} failed")
sys.exit(1 if results["fail"] else 0)
