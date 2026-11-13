"""QA: 🎮 spontaneous play on the test bot, against the real Discord API, with stand-in players.

The Lobby question is posted and rendered by Discord, a tap opens a real room, an unplanned session
posts its quiet line in #game-night, counts at 10 minutes and says how long it went once it's over.
Time is simulated (the admin route takes `t`), so the run takes seconds. Stand-ins can't be moved
between voice channels (they aren't members), so pulling people in is covered by the unit tests.

⚔️ Early birds (plan 07), on a far-future QA day with a night locked in for 19:00: two stand-ins in the
Lobby get the night's card (never the question), "Just hanging out" takes it away and counts as an
answer, "Open the room" opens the night's room, and all three here for 30 s start the night early with
one silent line; 19:00 then brings nothing. The start's partial ping (rule 3) needs real people in a
real room (the start reads Discord's own voice states), so only the unit tests cover it
(early.test.ts, tests 3 and 4).

    python scripts/qa_spontaneous.py
"""
import sys
import time

from dc import admin, call
from qa_guard import TEST_DAYS, Snapshot, require_idle, sql, vilnius

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

# ---------------------------------------------------------------- ⚔️ early birds (plan 07)
EPLAYERS = "qa_e1,qa_e2,qa_e3"
EGAME = "QA Early Birds"
DAY = TEST_DAYS[6]
START = int(vilnius(DAY, "19:00"))
early = lambda where, t, change=None: admin("/admin/gamenight", {"action": "lobby", "players": EPLAYERS, "where": where, "t": t, "change": change})
answer = lambda pid, what, game=None: admin("/admin/gamenight", {"action": "lobby", "players": EPLAYERS, "answer": {"id": pid, "user": "qa_e1", "what": what, **({"game": game} if game else {})}})
current = lambda: sql("SELECT p.*, c.day AS night, c.start_at AS shows FROM lobby_prompts p LEFT JOIN night_cards c ON c.prompt_id = p.id WHERE p.current")
on_air = lambda: sql(f"SELECT reminded, start_at FROM game_nights WHERE day = '{DAY}'")[0]
snap = Snapshot()
made = {"prompts": [], "room": None}
admin("/admin/gamenight", {"action": "reset", "day": DAY})
sql(f"INSERT INTO games (name, emoji, added_at) VALUES ('{EGAME}', '⚔️', '{DAY}') ON CONFLICT DO NOTHING")
sql(f"INSERT INTO game_nights (day, stage, game, start_at, stage_at) VALUES ('{DAY}', 'set', '{EGAME}', {START}, {START - 3 * 3600})")
try:
    # 2. two of us early: the night's card, never "Playing something?"
    t1 = START - 40 * 60  # 18:20
    early({"qa_e1": "LOBBY", "qa_e2": "LOBBY"}, t1)
    r = early({"qa_e1": "LOBBY", "qa_e2": "LOBBY"}, t1 + 30)
    p = current()
    ok(len(p) == 1 and p[0]["night"] == DAY and p[0]["state"] == "open" and p[0]["message_id"], f"two early: the night's card, not the question ({r})")
    made["prompts"] += [x["id"] for x in p]
    if p:
        msg = call("GET", f"/channels/{lobby_ch}/messages/{p[0]['message_id']}")
        text = str(msg)
        ok("Playing something?" not in text and "you're early" in text and f"<t:{START}:t>" in text, "Discord shows the night's card with its start")
        ok("Still waiting on <@qa_e3>" in text and "Open the room" in text and "Just hanging out" in text, "it says who's missing, with both buttons")
        ok(msg.get("flags", 0) & (1 << 12) and msg.get("flags", 0) & (1 << 15) and not msg.get("mentions"), "it's silent, components v2, and pings nobody")
        answer(p[0]["id"], "chill")
        gone = call("GET", f"/channels/{lobby_ch}/messages/{p[0]['message_id']}")
        ok("404" in str(gone), "🛋️ Just hanging out takes the card away")
        early({"qa_e1": "LOBBY", "qa_e2": "LOBBY", "qa_e3": "LOBBY"}, t1 + 90)
        r = early({"qa_e1": "LOBBY", "qa_e2": "LOBBY", "qa_e3": "LOBBY"}, t1 + 130)
        ok(not on_air()["reminded"] and r["early"]["started"] is None, f"…and it's an answer: all three here, still no early start ({r['early']})")
    # the gathering breaks up; two come back: a new card, and this time ⚔️ Open the room
    early({"qa_e1": None, "qa_e2": None, "qa_e3": None}, t1 + 140)
    t2 = t1 + 200
    early({"qa_e1": "LOBBY", "qa_e2": "LOBBY"}, t2)
    early({"qa_e1": "LOBBY", "qa_e2": "LOBBY"}, t2 + 30)
    p = current()
    made["prompts"] += [x["id"] for x in p]
    ok(len(p) == 1 and p[0]["night"] == DAY, "back together: a new card")
    if p:
        a = answer(p[0]["id"], "g", EGAME)
        room = sql(f"SELECT * FROM rooms WHERE game = '{EGAME}' AND archived_at IS NULL")
        ok(len(room) == 1, f"⚔️ Open the room opens the night's room ({a.get('notice')})")
        made["room"] = room[0]["channel_id"] if room else None
        gone = call("GET", f"/channels/{lobby_ch}/messages/{p[0]['message_id']}")
        ok("404" in str(gone), "and the card goes")
        ok(not on_air()["reminded"], "the night itself hasn't started")
    R = made["room"]
    if R:
        # 1. the two in the room, then the third: 30 s later the night starts, early and quietly
        early({"qa_e1": R, "qa_e2": R, "qa_e3": None}, t2 + 60)
        r = early({"qa_e1": R, "qa_e2": R, "qa_e3": R}, t2 + 120)
        ok(r["early"] == {"started": None, "due": t2 + 150}, f"all three here: it starts 30 s later ({r['early']})")
        r = early({"qa_e1": R, "qa_e2": R, "qa_e3": R}, t2 + 150)
        ok(r["early"]["started"] == DAY, f"…and it does ({r['early']})")
        night = on_air()
        ok(night["reminded"] and night["start_at"] == t2 + 150, f"the start moved to then and is claimed ({night})")
        lines = [m for m in call("GET", f"/channels/{gn_ch}/messages?after={snap.marker}&limit=20") if "Everyone's here early" in str(m.get("content"))]
        ok(len(lines) == 1, f"one line in #game-night: {lines[0]['content'] if lines else None}")
        if lines:
            ln = lines[0]
            ok("(was 19:00)" in ln["content"] and f"<#{R}>" in ln["content"] and EGAME in ln["content"], "it says what's on, when it was planned, and where")
            ok(ln.get("flags", 0) & (1 << 12) and not ln.get("mentions"), "silent, pinging nobody (they're all there)")
        s = sql(f"SELECT absorbed FROM sessions WHERE game = '{EGAME}'")
        ok(s and s[0]["absorbed"], "the warm-up session is the night now (counted once)")
        # 19:00 comes (as the bot sees it): nothing more
        early({"qa_e1": R, "qa_e2": R, "qa_e3": R}, START)
        later = [m for m in call("GET", f"/channels/{gn_ch}/messages?after={snap.marker}&limit=20") if "starts now" in str(m.get("content"))]
        ok(not later and on_air()["start_at"] == t2 + 150, "19:00 comes: no second start, no ping")
finally:
    if made["room"]:
        call("DELETE", f"/channels/{made['room']}")
    for pid in made["prompts"]:
        for x in sql(f"SELECT message_id FROM lobby_prompts WHERE id = {pid} AND message_id IS NOT NULL"):
            call("DELETE", f"/channels/{lobby_ch}/messages/{x['message_id']}")
    admin("/admin/gamenight", {"action": "reset", "day": DAY})
    ids = ", ".join(str(i) for i in made["prompts"]) or "0"
    sql(
        f"DELETE FROM sessions WHERE game = '{EGAME}'; DELETE FROM rooms WHERE game = '{EGAME}'; "
        f"DELETE FROM night_cards WHERE prompt_id IN ({ids}); DELETE FROM lobby_prompts WHERE id IN ({ids}); "
        f"DELETE FROM voice_segments WHERE user_id IN ('qa_e1', 'qa_e2', 'qa_e3')"
    )
    snap.cleanup()
    print("🧹 cleaned up (early birds)")

print(f"\n{'all good' if not failed else f'{len(failed)} failed'}")
sys.exit(1 if failed else 0)
