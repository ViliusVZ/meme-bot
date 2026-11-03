"""End-to-end QA against the live bot, through the quiet admin routes (nobody gets pinged).

Uses throwaway future days so today's real poll is untouched, and cleans up after itself.
    python scripts/qa_all.py
"""
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from dc import admin, call

sys.stdout.reconfigure(encoding="utf-8")
V, K, L = "306836805825593344", "212567787896307713", "747902984003780651"
CH = "1567132345213911240"
WINTER = timezone(timedelta(hours=2))  # November in Vilnius; Windows Python has no tz database
results = {"pass": 0, "fail": 0}


def ok(cond, msg):
    results["pass" if cond else "fail"] += 1
    print(("  ✅ " if cond else "  ❌ ") + msg)


def section(title):
    print(f"\n▶ {title}")


def sql(q):
    out = subprocess.run(["python", "scripts/sql.py", q], capture_output=True, text=True, encoding="utf-8").stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def channels():
    for attempt in range(5):
        r = call("GET", "/guilds/{guild}/channels")
        if isinstance(r, list):
            return r
        print("    (channel list retry:", str(r)[:120], ")")
        time.sleep(3 * (attempt + 1))
    raise RuntimeError("channel list unavailable")


def night(day):
    rows = sql(f"SELECT * FROM game_nights WHERE day = '{day}'")
    return rows[0] if rows else None


def gn(day, user, choice, value=None):
    return admin("/admin/gamenight", {"action": "vote", "day": day, "user": user, "choice": choice, "value": value})


def at(day, hhmm):
    y, m, d = map(int, day.split("-"))
    h, mi = map(int, hhmm.split(":"))
    return str(int(datetime(y, m, d, h, mi, tzinfo=WINTER).timestamp()))


def card_text(day):
    n = night(day)
    if not n or not n["message_id"]:
        return ""
    m = call("GET", f"/channels/{CH}/messages/{n['message_id']}")
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


def reset(*days):
    for d in days:
        admin("/admin/gamenight", {"action": "reset", "day": d})


def to_time_stage(day, game="Palworld"):
    admin("/admin/gamenight", {"action": "plan", "user": V, "day": day})
    gn(day, V, "yes")
    gn(day, K, "yes")
    gn(day, L, "yes")
    gn(day, V, "game", game)
    gn(day, K, "game", game)


D1, D2, D3, D4 = "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"
# start clean, even after an aborted run
reset(D1, D2, D3, D4)
for rm in sql("SELECT channel_id FROM rooms"):
    call("DELETE", f"/channels/{rm['channel_id']}")
sql("DELETE FROM rooms; DELETE FROM tiebreaks; DELETE FROM night_attendance")

# ------------------------------------------------------------------ dedupe + planning
section("one poll per day")
r1 = admin("/admin/gamenight", {"action": "plan", "user": V, "day": D1})
r2 = admin("/admin/gamenight", {"action": "plan", "user": K, "day": D1})
ok(r1["started"] and not r2["started"] and r1["message_id"] == r2["message_id"], "planning a day twice gives one card")
votes = {v["user_id"]: v["choice"] for v in sql(f"SELECT user_id, choice FROM game_night_votes WHERE day='{D1}' AND stage='ask'")}
ok(votes.get(V) == "yes" and K not in votes, "the planner's yes counts; the second planner's click doesn't vote for them")
with ThreadPoolExecutor(3) as ex:
    rs = list(ex.map(lambda u: admin("/admin/gamenight", {"action": "plan", "user": u, "day": D2}), (V, K, L)))
ok(sum(1 for r in rs if r.get("started")) == 1 and len({r["message_id"] for r in rs}) == 1, "three simultaneous plans → exactly one card")
card_id = rs[0]["message_id"]
day_cards = [m for m in call("GET", f"/channels/{CH}/messages?limit=30") if f"gn:{D2}:" in json.dumps(m)]
ok([m["id"] for m in day_cards] == [card_id], f"and exactly one {D2} card message in the channel ({len(day_cards)})")

section("a claimed day whose post failed gets retried")
sql(f"INSERT INTO game_nights (day, stage, reminded, started_by, stage_at) VALUES ('{D3}', 'ask', 0, '{V}', {int(time.time())})")
admin("/admin/gamenight", {"action": "tick"})
ok(bool(night(D3)["message_id"]), "tick posts the unposted planned day")

# ------------------------------------------------------------------ ask stage
section("are we playing?")
ok("trio" in (gn(D1, "123", "yes")["notice"] or ""), "outsiders are refused")
gn(D1, K, "no")
ok(night(D1)["stage"] == "ask", "a no keeps it in ask")
gn(D1, K, "yes")
gn(D1, L, "yes")
ok(night(D1)["stage"] == "game", "everyone yes → game picking")
ok(bool(night(D1)["nudge_id"]), "a nudge went out for the next stage")

# ------------------------------------------------------------------ game stage + tiebreak
section("game picking")
gn(D1, V, "game", "Phasmophobia")
gn(D1, K, "game", "Palworld")
gn(D1, L, "game", "R.E.P.O.")
tb = sql(f"SELECT * FROM tiebreaks WHERE kind='night' AND ref='{D1}'")
ok(len(tb) == 1 and night(D1)["stage"] == "game", "three-way split opens one tiebreak and waits")
ok("tiebreaker" in (gn(D1, V, "game", "Palworld")["notice"] or "").lower(), "changing a game vote during a tiebreak is refused")
ok("tiebreaker" in (gn(D1, V, "suggest", "Lethal Company")["notice"] or "").lower(), "suggesting during a tiebreak is refused")
t = admin("/admin/gamenight", {"action": "tb", "id": tb[0]["id"], "user": V, "choice": "wheel"})["tiebreak"]
n1 = night(D1)
ok(t["result"] in ("Phasmophobia", "Palworld", "R.E.P.O.") and n1["stage"] == "time" and n1["game"] == t["result"], f"wheel picks {t['result']} → time stage")
ok("spun the wheel" in (n1["note"] or ""), "the card keeps the tiebreak story")

section("majority wins straight away")
admin("/admin/gamenight", {"action": "plan", "user": V, "day": D4})
gn(D4, K, "yes")
gn(D4, L, "yes")
gn(D4, V, "game", "Enshrouded")
gn(D4, K, "game", "Enshrouded")
ok(night(D4)["stage"] == "time" and night(D4)["game"] == "Enshrouded" and not sql(f"SELECT 1 FROM tiebreaks WHERE ref='{D4}'"), "2 of 3 → time stage, no tiebreak")

# ------------------------------------------------------------------ time stage
section("time picking")
ok("passed" in (gn(D4, V, "time", str(int(time.time()) - 600))["notice"] or "") or "isn't on" in (gn(D4, V, "time", str(int(time.time()) - 600))["notice"] or ""), "a past time is refused")
ok("isn't on" in (gn(D4, V, "time", at("2026-11-20", "20:00"))["notice"] or ""), "a time on another day is refused")
ok("Couldn't read" in (gn(D4, V, "custom", "25:99")["notice"] or ""), "nonsense custom time is refused")
gn(D4, V, "custom", "19.15")
ok(sql(f"SELECT choice FROM game_night_votes WHERE day='{D4}' AND stage='time' AND user_id='{V}'")[0]["choice"] == at(D4, "19:15"), "custom 19.15 is stored as 19:15 that day")
gn(D4, V, "time", at(D4, "19:15"))
ok(not sql(f"SELECT 1 FROM game_night_votes WHERE day='{D4}' AND stage='time' AND user_id='{V}'"), "tapping your pick again takes it back")
gn(D4, V, "custom", "01:30")
ok(sql(f"SELECT choice FROM game_night_votes WHERE day='{D4}' AND stage='time' AND user_id='{V}'")[0]["choice"] == at("2026-11-14", "01:30"), "01:30 means after midnight")
ok("🌙 01:30" in card_text(D4), "after-midnight time shows with a 🌙")
gn(D4, V, "time", at(D4, "18:00"))

section("leave-by")
gn(D4, K, "until", "19:00")
gn(D4, K, "time", at(D4, "17:00"))
gn(D4, L, "time", at(D4, "19:00"))
n4 = night(D4)
ok(n4["stage"] == "time" and n4["conflict"], "K leaves 19:00 but L starts 19:00 → clash, not locked")
ok("Doesn't fit yet" in card_text(D4), "the card explains the clash")
gn(D4, K, "until", "")
n4 = night(D4)
ok(n4["stage"] == "set" and n4["start_at"] == int(at(D4, "19:00")), "clearing the leave-by locks it at 19:00")
ok(bool(n4["event_id"]), "a Discord event was created")
ok("Slowpoke" in card_text(D4), "the slowpoke gets credit")

# ------------------------------------------------------------------ cancel + reopen
section("cancel before the start, then reopen")
gn(D4, L, "out")
time.sleep(3)
n4 = night(D4)
ok(n4["stage"] == "off", "out before the start cancels the night")
evs = [e["id"] for e in call("GET", "/guilds/{guild}/scheduled-events")]
ok(n4["event_id"] not in evs, "and deletes the Discord event")
ok("Reopen" in card_text(D4), "the cancelled card offers 🔄 Reopen")
gn(D4, K, "reopen")
n4 = night(D4)
v4 = sql(f"SELECT stage, user_id, choice FROM game_night_votes WHERE day='{D4}'")
ok(n4["stage"] == "ask" and n4["started_by"] == K and n4["game"] is None, "reopen restarts the day's poll")
ok(v4 == [{"stage": "ask", "user_id": K, "choice": "yes"}], "with only the reopener's yes")
with ThreadPoolExecutor(2) as ex:
    list(ex.map(lambda u: gn(D4, u, "reopen"), (V, L)))
ok(night(D4)["stage"] == "ask", "reopen clicks on a live card do nothing")

# ------------------------------------------------------------------ the start: room, event, late handling
section("start time: room, event live, latecomers")
to_time_stage(D3, "Demonologist")
for u, hh in ((V, "17:00"), (K, "17:00"), (L, "17:00")):
    gn(D3, u, "time", at(D3, hh))
n3 = night(D3)
ok(n3["stage"] == "set", "D3 locked in")
now = int(time.time())
sql(f"UPDATE game_nights SET start_at = {now} WHERE day = '{D3}'")
tk = admin("/admin/gamenight", {"action": "tick"})
ok(tk["maintain"].get("reminded") == D3, "the start reminder fired")
room = sql(f"SELECT * FROM rooms WHERE day = '{D3}'")
ok(len(room) == 1, "a game room was opened for the night")
ev = call("GET", f"/guilds/{{guild}}/scheduled-events/{n3['event_id']}")
ok(ev.get("status") == 2, f"the event went live (status {ev.get('status')})")
tk = admin("/admin/gamenight", {"action": "tick"})
ok("reminded" not in tk["maintain"], "the reminder doesn't fire twice")
ok(not tk["late"], "no late slips before the 10-minute grace")
sql(f"UPDATE game_nights SET start_at = {now - 660} WHERE day = '{D3}'")
tk = admin("/admin/gamenight", {"action": "tick"})
slipped = (tk["late"] or {}).get("slipped", [])
ok(sorted(slipped) == sorted([V, K, L]), f"after 10 min, everyone not in voice gets one late slip ({len(slipped)})")
tk = admin("/admin/gamenight", {"action": "tick"})
ok(not (tk["late"] or {}).get("slipped"), "and only one each")
r = admin("/admin/gamenight", {"action": "late", "day": D3, "user": V, "clicker": K, "choice": "5"})
ok("not your late slip" in (r.get("notice") or ""), "you can't answer someone else's slip")
r = admin("/admin/gamenight", {"action": "late", "day": D3, "user": V, "choice": "15"})
ok(r["row"]["state"] == "eta" and abs(r["row"]["eta"] - (int(time.time()) + 900)) < 30, "🏃 15 min sets an ETA")
r = admin("/admin/gamenight", {"action": "late", "day": D3, "user": K, "choice": "out"})
ok(r["row"]["state"] == "absent", "😴 marks absent")
ok(night(D3)["stage"] == "set", "and the night carries on for the others")
r = gn(D3, L, "out")
ok("carry on" in (r.get("notice") or "") and night(D3)["stage"] == "set", "card 'Can't make it' after the start only marks absent")
ok(sql(f"SELECT state FROM night_attendance WHERE day='{D3}' AND user_id='{L}'")[0]["state"] == "absent", "L is absent")

section("rooms: concurrent opens make one room")
with ThreadPoolExecutor(3) as ex:
    rr = list(ex.map(lambda _: admin("/admin/gamenight", {"action": "room", "game": "Counter-Strike 2", "emoji": "🔫"}), range(3)))
ids = {r.get("channelId") for r in rr}
ok(len(ids) == 1 and None not in ids, f"three simultaneous opens → one room ({len(ids)})")
cs = [c for c in channels() if c["name"] == "🔫 Counter-Strike 2"]
ok(len(cs) == 1, f"exactly one channel exists ({len(cs)})")

section("session over: room archived, event ended")
for rm in sql("SELECT channel_id FROM rooms"):
    sql(f"UPDATE rooms SET last_seen = {now - 1500}, created_at = {now - 4000} WHERE channel_id = '{rm['channel_id']}'")
tk = admin("/admin/gamenight", {"action": "rooms"})
ok(len(tk.get("archived", [])) == 2, f"both empty rooms archived ({tk})")
ev = call("GET", f"/guilds/{{guild}}/scheduled-events/{n3['event_id']}")
ok(ev.get("status") == 3 or "error" in ev, f"the night's event ended (status {ev.get('status', 'gone')})")

# ------------------------------------------------------------------ cleanup
section("cleanup")
for rm in sql("SELECT channel_id FROM rooms"):
    call("DELETE", f"/channels/{rm['channel_id']}")
sql("DELETE FROM rooms")
reset(D1, D2, D3, D4)
admin("/admin/gamenight", {"action": "rooms"})
for m in call("GET", f"/channels/{CH}/messages?limit=50"):
    if not m.get("pinned"):
        call("DELETE", f"/channels/{CH}/messages/{m['id']}")
for e in call("GET", "/guilds/{guild}/scheduled-events"):
    call("DELETE", f"/guilds/{{guild}}/scheduled-events/{e['id']}")
sql("DELETE FROM tiebreaks; DELETE FROM night_attendance; DELETE FROM games WHERE name = 'Lethal Company'; UPDATE games SET plays = 0")
left = sql("SELECT (SELECT count(*) FROM game_nights) n, (SELECT count(*) FROM rooms) r, (SELECT count(*) FROM night_attendance) a")[0]
ok(left == {"n": 0, "r": 0, "a": 0}, f"database clean {left}")
ok(len(call("GET", f"/channels/{CH}/messages?limit=10")) == 1, "only the pinned panel left in #game-night")
ok("🗄️ Recent games" not in [c["name"] for c in channels()], "no leftover archive category")

print(f"\n{results['pass']} passed, {results['fail']} failed")
sys.exit(1 if results["fail"] else 0)
