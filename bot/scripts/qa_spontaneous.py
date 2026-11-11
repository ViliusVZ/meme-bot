"""QA: 🎮 spontaneous play on the test bot, against the real Discord API, with stand-in players.

The Lobby question is posted and rendered by Discord, a tap opens a real room, an unplanned session
posts its quiet line in #game-night, counts at 10 minutes and says how long it went once it's over.
Time is simulated (the admin route takes `t`), so the run takes seconds. Stand-ins can't be moved
between voice channels (they aren't members), so pulling people in is covered by the unit tests.

    python scripts/qa_spontaneous.py
"""
import sys
import time

from dc import admin, call
from qa_guard import require_idle, sql

sys.stdout.reconfigure(encoding="utf-8")
failed = []


def ok(cond, msg):
    print(("✅ " if cond else "❌ ") + msg)
    if not cond:
        failed.append(msg)


PLAYERS = "qa_s1,qa_s2,qa_s3"
GAME = "QA Spontaneous"
lobby = lambda where, t, change=None: admin("/admin/gamenight", {"action": "lobby", "players": PLAYERS, "where": where, "t": t, "change": change})
require_idle()
chans = call("GET", "/guilds/{guild}/channels")
lobby_ch = next(c["id"] for c in chans if c["type"] == 2 and "Lobby" in c["name"])
gn_ch = next(c["id"] for c in chans if c["type"] == 0 and "game-night" in c["name"])

t0 = int(time.time())
made = {"room": None, "prompt": None, "line": None}
try:
    # 1. two in the Lobby: nothing at 29 s, the question at 30 s
    r = lobby({"qa_s1": "LOBBY", "qa_s2": "LOBBY"}, t0)
    ok(r.get("due") == t0 + 30, f"two in the Lobby: look again at +30 s (got {r})")
    r = lobby({"qa_s1": "LOBBY", "qa_s2": "LOBBY"}, t0 + 29)
    p = sql("SELECT * FROM lobby_prompts WHERE current")
    ok(not p, "nothing asked at 29 s")
    r = lobby({"qa_s1": "LOBBY", "qa_s2": "LOBBY"}, t0 + 30)
    p = sql("SELECT * FROM lobby_prompts WHERE current")
    ok(len(p) == 1 and p[0]["state"] == "open" and p[0]["message_id"], "the question is posted at 30 s")
    made["prompt"] = p[0]["id"] if p else None
    if p:
        msg = call("GET", f"/channels/{lobby_ch}/messages/{p[0]['message_id']}")
        text = str(msg)
        ok("Playing something?" in text and "Just hanging out" in text, "Discord shows it with its buttons")
        ok(msg.get("flags", 0) & (1 << 12), "it's silent (no notification)")
    lobby({"qa_s1": "LOBBY", "qa_s2": "LOBBY", "qa_s3": "LOBBY"}, t0 + 60)
    ok(len(sql(f"SELECT id FROM lobby_prompts WHERE id >= {made['prompt'] or 0}")) == 1, "a third joining doesn't ask again")

    # 2. a tap opens the game's room and takes the question away
    r = admin("/admin/gamenight", {"action": "lobby", "players": PLAYERS, "answer": {"id": made["prompt"], "user": "qa_s1", "what": "g", "game": GAME}})
    room = sql(f"SELECT * FROM rooms WHERE game = '{GAME}' AND archived_at IS NULL")
    ok(len(room) == 1, f"the tap opened the {GAME} room ({r.get('notice')})")
    made["room"] = room[0]["channel_id"] if room else None
    gone = call("GET", f"/channels/{lobby_ch}/messages/{p[0]['message_id']}") if p else {}
    ok("error" in gone and "404" in str(gone), "the question is gone from the Lobby")
    late = admin("/admin/gamenight", {"action": "lobby", "players": PLAYERS, "answer": {"id": made["prompt"], "user": "qa_s2", "what": "g", "game": "Other"}})
    ok("already picked" in str(late.get("notice")), f"a late tap hears who won ({late.get('notice')})")

    # 3. the session: line at 2 min (qa_s3 is missing), a night at 10, the line's final words when it's over
    R = made["room"]
    lobby({"qa_s1": R, "qa_s2": R, "qa_s3": None}, t0 + 70)
    lobby({"qa_s1": R, "qa_s2": R, "qa_s3": None}, t0 + 200)
    s = sql(f"SELECT * FROM sessions WHERE game = '{GAME}'")
    ok(s and s[0]["message_id"] and s[0]["message_id"] != "posting", "the quiet line is posted 2 minutes in")
    made["line"] = s[0]["message_id"] if s else None
    line = call("GET", f"/channels/{gn_ch}/messages/{made['line']}") if made["line"] else {}
    ok(GAME in str(line.get("content")) and line.get("flags", 0) & (1 << 12) and not line.get("mentions"), f"it's silent and pings nobody: {line.get('content')}")
    lobby({"qa_s1": R, "qa_s2": R, "qa_s3": None}, t0 + 70 + 600)
    ok(sql(f"SELECT counted FROM sessions WHERE game = '{GAME}'")[0]["counted"], "ten minutes together: it counts as a game night")
    lobby({"qa_s1": R, "qa_s2": None, "qa_s3": None}, t0 + 70 + 1500)
    m = admin("/admin/gamenight", {"action": "lobby", "players": PLAYERS, "minute": True, "t": t0 + 70 + 1500 + 900})
    ok(GAME in str(m.get("finished")), f"15 min below two: wrapped up ({m})")
    line = call("GET", f"/channels/{gn_ch}/messages/{made['line']}")
    ok("played" in str(line.get("content")) and "25 min" in str(line.get("content")), f"the line says how long: {line.get('content')}")
finally:
    # tidy: the line, the room, and every row this run made
    if made["line"] and made["line"] != "posting":
        call("DELETE", f"/channels/{gn_ch}/messages/{made['line']}")
    if made["room"]:
        call("DELETE", f"/channels/{made['room']}")
    sql(
        f"DELETE FROM sessions WHERE game = '{GAME}'; DELETE FROM rooms WHERE game = '{GAME}'; "
        f"DELETE FROM lobby_prompts WHERE id = {made['prompt'] or 0}; "
        f"DELETE FROM voice_segments WHERE user_id IN ('qa_s1', 'qa_s2', 'qa_s3')"
    )
    print("🧹 cleaned up")

print(f"\n{'all good' if not failed else f'{len(failed)} failed'}")
sys.exit(1 if failed else 0)
