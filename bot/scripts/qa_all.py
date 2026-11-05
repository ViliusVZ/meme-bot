"""End-to-end QA against the live bot, through the quiet admin routes (nobody gets pinged).

Only runs while the bot is idle (qa_guard.require_idle), uses far-future test days, and cleans up
only what it created.
    python scripts/qa_all.py
"""
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from target import BOT_ID, GAME_CHANNEL
from dc import admin, call
from qa_guard import TEST_DAYS, Snapshot, quiet_window, require_idle, vilnius

sys.stdout.reconfigure(encoding="utf-8")
V, K, L = "306836805825593344", "212567787896307713", "747902984003780651"
CH = GAME_CHANNEL
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


at = vilnius


def card_text(day):
    n = night(day)
    if not n or not n["message_id"]:
        return ""
    return flatten(call("GET", f"/channels/{CH}/messages/{n['message_id']}"))


def flatten(m):
    """A message's text and button labels (not dropdown options), one per line."""
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
    gn(day, L, "game", game)  # nothing's decided until everyone's voted


require_idle()
D1, D2, D3, D4, D5 = TEST_DAYS[:5]
DAYS = ", ".join(f"'{d}'" for d in (D1, D2, D3, D4))
QA_ROOM = "QA Test Room"
snap = Snapshot()
# start clean, even after an aborted run (test days and the QA room only)
reset(D1, D2, D3, D4)
for rm in sql(f"SELECT channel_id FROM rooms WHERE day IN ({DAYS}) OR game = '{QA_ROOM}'"):
    call("DELETE", f"/channels/{rm['channel_id']}")
sql(f"DELETE FROM rooms WHERE day IN ({DAYS}) OR game = '{QA_ROOM}'")

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
day_cards = [m for m in call("GET", f"/channels/{CH}/messages?limit=30") if f"gn:{D2}:" in json.dumps(m.get("components") or [])]
ok([m["id"] for m in day_cards] == [card_id], f"and exactly one {D2} card message in the channel ({len(day_cards)})")

section("🤫 answers are secret until everyone has answered")
sql(f"DELETE FROM game_night_votes WHERE day = '{D2}'")  # whoever won the race above said yes; start from known answers
gn(D2, V, "yes")
r = gn(D2, K, "no")
copy = admin("/admin/gamenight", {"action": "copy", "day": D2, "user": K})
copy_btns = [b for row in copy["components"][0]["components"] if row.get("type") == 1 for b in row["components"]]
ok(copy["flags"] & 64 and [b["label"] for b in copy_btns] == ["Change to I'm in"], "the voter's private panel says their answer and offers only the switch")
txt = card_text(D2)
ok("❌" not in txt and "✅ <@" not in txt and f"🗳️ <@{K}>" in txt and f"⏳ <@{L}>" in txt, "the card shows who answered, not what")
gn(D2, L, "yes")
txt = card_text(D2)
ok(f"❌ <@{K}>" in txt and f"✅ <@{V}>" in txt and f"✅ <@{L}>" in txt, "everyone answered → who said what is revealed")

section("a claimed day whose post failed gets retried")
sql(f"INSERT INTO game_nights (day, stage, reminded, started_by, stage_at) VALUES ('{D3}', 'ask', false, '{V}', {int(time.time())})")
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

# ------------------------------------------------------------------ game stage + split re-vote
section("game picking")
r = gn(D1, V, "game", "Phasmophobia")
ok(r.get("update") is True and not r.get("notice"), "your vote counts (your private copy shows it, not a receipt)")
gn(D1, K, "game", "Palworld")
txt = card_text(D1)
ok("Phasmophobia" not in txt and "Palworld" not in txt and f"🗳️ <@{K}>" in txt and f"⏳ <@{L}>" in txt, "game votes stay secret")
gn(D1, L, "game", "R.E.P.O.")
txt = card_text(D1)
ok(all(g in txt for g in ("Phasmophobia", "Palworld", "R.E.P.O.")) and all(f"<@{u}>" in txt for u in (V, K, L)), "a split reveals who picked what")
ok(night(D1)["stage"] == "game" and "Split vote" in txt, "and stays open for a re-vote")
gn(D1, L, "game", "Palworld")  # L comes round to K's pick
n1 = night(D1)
ok(n1["stage"] == "time" and n1["game"] == "Palworld", "two agreeing settles it → time stage")

section("most votes wins, once everyone's voted")
admin("/admin/gamenight", {"action": "plan", "user": V, "day": D4})
gn(D4, K, "yes")
gn(D4, L, "yes")
gn(D4, V, "game", "Enshrouded")
gn(D4, K, "game", "Enshrouded")
ok(night(D4)["stage"] == "game", "two votes for the same game still wait for the third")
gn(D4, L, "game", "Palworld")
ok(night(D4)["stage"] == "time" and night(D4)["game"] == "Enshrouded", "2–1 → time stage")
ok(f"Enshrouded** ← <@{V}> <@{K}>" in card_text(D4), "the decided game vote is revealed")

# ------------------------------------------------------------------ time stage
section("time picking")
ok("passed" in (gn(D4, V, "time", str(int(time.time()) - 600))["notice"] or "") or "isn't on" in (gn(D4, V, "time", str(int(time.time()) - 600))["notice"] or ""), "a past time is refused")
ok("isn't on" in (gn(D4, V, "time", at(TEST_DAYS[7], "20:00"))["notice"] or ""), "a time on another day is refused")
ok("Couldn't read" in (gn(D4, V, "custom", "25:99")["notice"] or ""), "nonsense custom time is refused")
gn(D4, V, "custom", "19.15")
ok(sql(f"SELECT choice FROM game_night_votes WHERE day='{D4}' AND stage='time' AND user_id='{V}'")[0]["choice"] == at(D4, "19:15"), "custom 19.15 is stored as 19:15 that day")
gn(D4, V, "time", at(D4, "19:15"))
ok(not sql(f"SELECT 1 FROM game_night_votes WHERE day='{D4}' AND stage='time' AND user_id='{V}'"), "tapping your pick again takes it back")
r = gn(D4, V, "custom", "01:30")
ok(sql(f"SELECT choice FROM game_night_votes WHERE day='{D4}' AND stage='time' AND user_id='{V}'")[0]["choice"] == at(D5, "01:30"), "01:30 means after midnight")
btns = lambda d, u: [b for row in admin("/admin/gamenight", {"action": "copy", "day": d, "user": u})["components"][0]["components"] if row.get("type") == 1 for b in row["components"]]
ok([b["label"] for b in btns(D4, V) if b.get("style") == 3] == ["🌙 01:30"], "the private copy highlights your pick, with a 🌙 for after midnight (even a custom one)")
txt = card_text(D4)
ok("01:30" not in txt and f"🗳️ <@{V}>" in txt, "the card doesn't: no button for a secret custom time")
gn(D4, V, "time", at(D4, "18:00"))

section("leave-by")
gn(D4, K, "until", "19:00")
r = gn(D4, K, "time", at(D4, "17:00"))
mine = btns(D4, K)
ok([b["label"] for b in mine if b.get("style") == 3] == ["17:00"] and any(b["label"] == "Leave by 19:00" for b in mine), "the private copy shows your start and your leave-by")
txt = card_text(D4)
ok("Someone has to leave by **19:00**" in txt and f"<@{K}> from" not in txt and "· 1" not in txt, "a leave-by shows without its owner, no counts")
gn(D4, L, "time", at(D4, "19:00"))
n4 = night(D4)
ok(n4["stage"] == "time" and n4["conflict"], "K leaves 19:00 but L starts 19:00 → clash, not locked")
txt = card_text(D4)
ok("Doesn't fit yet" in txt and f"<@{K}> has to leave" in txt and f"🕐 <@{L}> from" in txt, "everyone picked → revealed, and the card explains the clash")
gn(D4, K, "until", "")
n4 = night(D4)
ok(n4["stage"] == "set" and n4["start_at"] == int(at(D4, "19:00")), "clearing the leave-by locks it at 19:00")
ok(bool(n4["event_id"]), "a Discord event was created")
txt = card_text(D4)
ok("Slowpoke" in txt, "the slowpoke gets credit")
ok(f"<@{L}> **19:00**" in txt and f"<@{K}> **17:00**" in txt and "Enshrouded** ← " in txt, "the locked card reveals everyone's picks")

# ------------------------------------------------------------------ polls
section("🤫 secret polls")
pid = sql(f"INSERT INTO polls (question, options, created_by, created_at) VALUES ('qa secret', '[\"Pizza\", \"Kebab\"]', '{K}', 'qa') RETURNING id")[0]["id"]
pv = lambda u, c: admin("/admin/gamenight", {"action": "poll-vote", "poll": pid, "user": u, "choice": c})
render = lambda: flatten(admin("/admin/gamenight", {"action": "poll-render", "poll": pid}))
ok(pv(V, 0).get("update") is True, "the vote counts")
txt = render()
ok("█" not in txt and "· 1" not in txt and f"🗳️ <@{V}>" in txt and f"⏳ <@{L}>" in txt, "the poll shows who voted, not what or how many")
ok("Took your vote back" in (pv(V, 0).get("notice") or "") and f"⏳ <@{V}>" in render(), "tapping again takes it back")
pv(V, 0)
pv(L, 0)
ok("Decided" not in render(), "2 of 3 isn't the end: everyone gets a say")
pv(K, 1)
txt = render()
ok("Decided: Pizza" in txt and "█" in txt and f"<@{V}> <@{L}>" in txt, "everyone's in → most votes wins, bars and voters revealed")
sql(f"DELETE FROM poll_votes WHERE poll_id = {pid}; DELETE FROM polls WHERE id = {pid}")

# ------------------------------------------------------------------ cancel + reopen
section("cancel before the start, then reopen")
gn(D4, L, "out")
time.sleep(3)
n4 = night(D4)
ok(n4["stage"] == "off", "out before the start cancels the night")
evs = [e["id"] for e in call("GET", "/guilds/{guild}/scheduled-events")]
ok(n4["event_id"] not in evs, "and deletes the Discord event")
txt = card_text(D4)
ok("Reopen" in txt, "the cancelled card offers 🔄 Reopen")
ok("How everyone voted" in txt and f"<@{V}> **18:00**" in txt, "and reveals how everyone voted")
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
quiet_window()
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
quiet_window()
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
n3 = night(D3)
ok(r["row"]["state"] == "absent" and n3["stage"] == "off", "😴 after the start calls the night off for everyone (all or none)")
ok((n3["roast"] or {}).get("who") == {K: "out"}, "and the bailer is the one roasted")
roasts = [m for m in call("GET", f"/channels/{CH}/messages?limit=20") if (m.get("content") or "").startswith("🔥") and f"<@{K}> 🚪 bailed" in m["content"]]
ok(len(roasts) == 1, "one roast in the channel")
ok("off" in (admin("/admin/gamenight", {"action": "late", "day": D3, "user": V, "choice": "5"}).get("notice") or ""), "other slips just say the night's off")
ok(gn(D3, L, "out").get("update") is True and night(D3)["roast"]["who"] == {K: "out"}, "a second bail changes nothing")

section("rooms: concurrent opens make one room")
with ThreadPoolExecutor(3) as ex:
    rr = list(ex.map(lambda _: admin("/admin/gamenight", {"action": "room", "game": QA_ROOM, "emoji": "🧪"}), range(3)))
ids = {r.get("channelId") for r in rr}
ok(len(ids) == 1 and None not in ids, f"three simultaneous opens → one room ({len(ids)})")
cs = [c for c in channels() if c["name"] == f"🧪 {QA_ROOM}"]
ok(len(cs) == 1, f"exactly one channel exists ({len(cs)})")

section("session over: room archived, event ended")
quiet_window()
for rm in sql(f"SELECT channel_id FROM rooms WHERE day IN ({DAYS}) OR game = '{QA_ROOM}'"):
    sql(f"UPDATE rooms SET last_seen = {now - 1500}, created_at = {now - 4000} WHERE channel_id = '{rm['channel_id']}'")
tk = admin("/admin/gamenight", {"action": "rooms"})
ok(len(tk.get("archived", [])) == 2, f"both empty rooms archived ({tk})")
ev = call("GET", f"/guilds/{{guild}}/scheduled-events/{n3['event_id']}")
ok(ev.get("status") == 3 or "error" in ev, f"the night's event ended (status {ev.get('status', 'gone')})")

# ------------------------------------------------------------------ cleanup
section("cleanup")
for rm in sql("SELECT channel_id FROM rooms"):
    call("DELETE", f"/channels/{rm['channel_id']}")
sql(f"DELETE FROM rooms WHERE day IN ({DAYS}) OR game = '{QA_ROOM}'")
reset(D1, D2, D3, D4)
admin("/admin/gamenight", {"action": "rooms"})
snap.cleanup()
left = sql(
    f"SELECT (SELECT count(*) FROM game_nights WHERE day IN ({DAYS})) n, (SELECT count(*) FROM rooms WHERE day IN ({DAYS}) OR game = '{QA_ROOM}') r,"
    f" (SELECT count(*) FROM night_attendance WHERE day IN ({DAYS})) a"
)[0]
ok(left == {"n": 0, "r": 0, "a": 0}, f"test data gone {left}")
ok(not [m for m in call("GET", f"/channels/{CH}/messages?after={snap.marker}&limit=100") if m["author"]["id"] == BOT_ID], "no QA messages left in #game-night")
ok("🗄️ Recent games" not in [c["name"] for c in channels()], "no leftover archive category")

print(f"\n{results['pass']} passed, {results['fail']} failed")
sys.exit(1 if results["fail"] else 0)
