"""🤔 The Maybe matrix, live on the test bot: every answer combination in every round of "are we
playing?", every change of mind during each hold, and each kind of deadline, checked against a
model of the rules. Cards and pings are read back from Discord.

    python scripts/qa_maybe_matrix.py

Answers go through the quiet admin routes (nobody is pinged). Cases run one at a time: they all
share one Discord channel, and running them in parallel only measures Discord's rate limits (the
bot gives up and the admin route answers 500). Holds are ended by moving `paused_until` back
inside a quiet window, then one quiet tick, three test days at a time so the tick is done well
before the bot's own minute job.
Deadlines need today's date (planned days get until noon on the day), so those run on today, one
at a time. Cleans up every day it used.
"""
import json
import sys
import time
from itertools import product

from target import GAME_CHANNEL
from dc import admin, call
from qa_guard import TEST_DAYS, quiet_window, require_idle, sql

sys.stdout.reconfigure(encoding="utf-8")
V, K, L = "306836805825593344", "212567787896307713", "747902984003780651"
P = [V, K, L]
NAME = {V: "V", K: "K", L: "L"}
HOLD = {1: 2 * 3600, 2: 3600}
LABEL = {"yes": "I'm in", "maybe": "Maybe", "no": "Can't"}  # far-future days say "Can't", today "Not today"
results = {"pass": 0, "fail": 0}
failures = []


def ok(cond, msg):
    results["pass" if cond else "fail"] += 1
    if not cond:
        failures.append(msg)
        print("  ❌ " + msg, flush=True)


def section(title):
    print(f"\n▶ {title}", flush=True)


# ------------------------------------------------------------------ the rules, as a model

def decide(v, rnd):
    if all(v.get(p) == "yes" for p in P):
        return ("game",)
    full = all(v.get(p) for p in P)
    if full and any(v.get(p) == "no" for p in P):
        return ("off", {p: "no" for p in P if v[p] == "no"})
    if full and rnd < 3:
        return ("hold", [p for p in P if v[p] == "maybe"])
    return ("waiting",)


def at_deadline(v):
    return {p: ("ghost" if not v.get(p) else "no") for p in P if not v.get(p) or v[p] == "no"}


def panel(mine, final, label):
    opts = [o for o in ("yes", "maybe", "no") if not (final and o == "maybe")]
    return [f"Change to {label[o]}" for o in opts if o != mine] if mine else [label[o] for o in opts]


def show(v):
    return " ".join(f"{NAME[p]}:{v.get(p) or '—'}" for p in P)


def mentions(ps, sep=" "):
    return sep.join(f"<@{p}>" for p in ps)


# ------------------------------------------------------------------ live helpers

def vote(day, user, choice):
    return admin("/admin/gamenight", {"action": "vote", "day": day, "user": user, "choice": choice})


def night(day):
    rows = sql(f"SELECT * FROM game_nights WHERE day = '{day}'")
    return rows[0] if rows else None


def ask_votes(day):
    return {r["user_id"]: r["choice"] for r in sql(f"SELECT user_id, choice FROM game_night_votes WHERE day = '{day}' AND stage = 'ask'")}


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


def message(mid):
    for attempt in range(4):
        m = call("GET", f"/channels/{GAME_CHANNEL}/messages/{mid}")
        if isinstance(m, dict) and "id" in m:
            return m
        time.sleep(1 + attempt)
    return {}


def buttons(m):
    return [c.get("label") for row in m["components"][0]["components"] if row.get("type") == 1 for c in row["components"] if c.get("type") == 2]


def start(day, v1):
    """A fresh card for `day` that nobody has answered yet (like the 17:00 one), then the round-1 answers."""
    admin("/admin/gamenight", {"action": "reset", "day": day})
    admin("/admin/gamenight", {"action": "plan", "day": day})
    for p in P:
        if v1.get(p):
            vote(day, p, v1[p])


def check(day, v, rnd, tag, held=None, label=LABEL):
    """Everything visible after answers `v` in round `rnd`: the stored night, the card on Discord, every private panel, the ping."""
    n = night(day)
    out = decide(v, rnd)
    card = flatten(message(n["message_id"])) if n and n["message_id"] else ""
    if out[0] == "game":
        ok(n["stage"] == "game" and "What are we playing" in card, f"{tag}: everyone's in → game picking")
        nudge = message(n["nudge_id"]) if n["nudge_id"] else {}
        ok("Everyone's in!" in nudge.get("content", ""), f"{tag}: 'everyone's in' ping")
        return n
    if out[0] == "off":
        ok(n["stage"] == "off" and n["roast"] and n["roast"]["who"] == out[1] and n["roasted_at"], f"{tag}: a no wins → off, roasted {sorted(NAME[p] for p in out[1])} (got {n['stage']}, {n['roast']})")
        ok("Reopen" in card and "How everyone voted" in card, f"{tag}: the closed card reveals the votes and offers reopen")
        return n
    if out[0] == "hold":
        unsure = out[1]
        sure = [p for p in P if p not in unsure]
        until_ok = abs((n["paused_until"] or 0) - (held or time.time() + HOLD[rnd])) <= (2 if held else 120)
        ok(n["stage"] == "ask" and n["maybes"] == rnd and until_ok, f"{tag}: on hold {HOLD[rnd] // 3600} h (got {n['stage']} maybes={n['maybes']})")
        marks = all(f"{'✅' if v[p] == 'yes' else '🤔'} <@{p}>" in card for p in P)
        ok(marks and "On hold" in card and "Vote by" not in card and "[Maybe]" in card, f"{tag}: the card shows who's unsure, the hold and no deadline")
        if not held:
            nudge = message(n["nudge_id"]).get("content", "") if n["nudge_id"] else ""
            want = f"🤔 {mentions(unsure, ' & ')} {'aren' if len(unsure) > 1 else 'isn'}'t sure yet" if sure else ""
            ok((nudge.startswith(mentions(sure)) and want in nudge) if sure else not nudge, f"{tag}: the sure ones are told why they wait ({nudge[:70]!r})")
    if out[0] == "waiting":
        final = rnd == 3
        # round 1 is secret until everyone's answered; after a hold the answers are out
        marks = all(f"{'⏳' if not v.get(p) else '🗳️' if rnd == 1 else {'yes': '✅', 'maybe': '🤔', 'no': '❌'}[v[p]]} <@{p}>" in card for p in P)
        ok(n["stage"] == "ask" and n["maybes"] == rnd - 1 and n["paused_until"] is None, f"{tag}: still asking (round {rnd})")
        ok(marks and "Vote by" in card and ("[Maybe]" in card) != final and (("Final call!" in card) == final), f"{tag}: the card shows answers, the deadline{' and no Maybe' if final else ''}")
    for p in P:
        copy = admin("/admin/gamenight", {"action": "copy", "day": day, "user": p})
        got = [b for b in buttons(copy)]
        ok(got == panel(v.get(p), rnd == 3 and out[0] == "waiting", label), f"{tag}: {NAME[p]}'s private panel {got}")
    return n


def end_holds(days):
    """Move every running hold on `days` to just now and run one quiet tick, inside a quiet window."""
    quiet_window()
    sql(f"UPDATE game_nights SET paused_until = {int(time.time()) - 5} WHERE day IN ({', '.join(repr(d) for d in days)}) AND paused_until IS NOT NULL")
    admin("/admin/gamenight", {"action": "tick"})


def check_resume(day, carried, unsure, rnd, tag):
    n = night(day)
    v = ask_votes(day)
    ok(n["paused_until"] is None and n["maybes"] == rnd - 1 and all(p not in v for p in unsure) and all(v.get(p) == carried[p] for p in P if p not in unsure),
       f"{tag}: hold over → the maybes are cleared, the rest stay")
    nudge = message(n["nudge_id"]).get("content", "") if n["nudge_id"] else ""
    word = "Final call" if rnd == 3 else "Decision time"
    ok(nudge.startswith(f"{mentions(unsure)} ⏰ {word}"), f"{tag}: the unsure (only) are asked again: {nudge[:60]!r}")


def guarded(fn, d, c):
    try:
        fn(d, c)
    except Exception as e:  # a crash is a failure, not the end of the run
        ok(False, f"{c}: crashed {e!r}")


def pool(cases, run):
    """Run cases one after another on the first test day."""
    for c in cases:
        guarded(run, TEST_DAYS[0], c)


def batches(cases, size=3):
    return [cases[i:i + size] for i in range(0, len(cases), size)]


def each(pairs, fn):
    """Each (day, case) in turn."""
    for d, c in pairs:
        guarded(fn, d, c)


# ------------------------------------------------------------------ run

require_idle()
t0 = time.time()
TODAY = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 2 * 3600))  # Vilnius (EET in winter)
TODAY_LABEL = {**LABEL, "no": "Not today"}
SUBSETS = [[p for i, p in enumerate(P) if m & (1 << i)] for m in range(1, 8)]
ALL3 = ("yes", "maybe", "no")
existing = night(TODAY)
if existing:
    print(f"🛑 today ({TODAY}) already has a night on the test bot ({existing['stage']}); not touching it")
    sys.exit(2)
for d in TEST_DAYS:
    admin("/admin/gamenight", {"action": "reset", "day": d})

# --- deadlines (today only: one at a time) ---------------------------------------------------
section(f"⏳ deadlines, on today ({TODAY})")


def shift_open(back):
    """Pretend the current round opened `back` seconds ago, then one quiet tick (inside a quiet window)."""
    quiet_window()
    sql(f"UPDATE game_nights SET stage_at = {int(time.time()) - back} WHERE day = '{TODAY}'")
    admin("/admin/gamenight", {"action": "tick"})


def deadline_case(tag, v1, rounds, window):
    """`rounds`: answers to give after each hold (round 2, round 3); the last round is left to run out."""
    start(TODAY, v1)
    v = dict(v1)
    rnd = 1
    for later in rounds:
        unsure = [p for p in P if v.get(p) == "maybe"]
        end_holds([TODAY])
        rnd += 1
        v = {p: (None if p in unsure else v.get(p)) for p in P}
        check_resume(TODAY, v, unsure, rnd, f"{tag} r{rnd}")
        for p, a in later.items():
            r = vote(TODAY, p, a)
            if rnd == 3 and a == "maybe":
                ok("No more maybes" in (r.get("notice") or ""), f"{tag}: a maybe on the final call is refused")
            else:
                v[p] = a
    missing = [p for p in P if not v.get(p)]
    check(TODAY, v, rnd, f"{tag} r{rnd}", label=TODAY_LABEL)
    shift_open(window - 29 * 60)  # 29 min left
    n = night(TODAY)
    nudge = message(n["nudge_id"]).get("content", "") if n["nudge_id"] else ""
    ok(n["warned"] == "ask" and nudge.startswith(f"{mentions(missing)} ⏳ Last call"), f"{tag}: last call to {[NAME[p] for p in missing]} only: {nudge[:50]!r}")
    shift_open(window + 5)
    n = night(TODAY)
    want = at_deadline(v)
    ok(n["stage"] == "off" and n["roast"] and n["roast"]["who"] == want, f"{tag}: deadline → off, roasted {sorted(NAME[p] + ':' + r for p, r in want.items())} (got {n['roast']})")
    admin("/admin/gamenight", {"action": "reset", "day": TODAY})


deadline_case("round 1: V maybe, K no, L silent", {V: "maybe", K: "no"}, [], 3 * 3600)
deadline_case("round 1: nobody answers", {}, [], 3 * 3600)
deadline_case("round 2: L stays silent", {V: "yes", K: "yes", L: "maybe"}, [{}], 3600)
deadline_case("round 2: K maybe again, L silent", {V: "yes", K: "maybe", L: "maybe"}, [{K: "maybe"}], 3600)
deadline_case("round 3: final call, L silent after a refused maybe", {V: "yes", K: "yes", L: "maybe"}, [{L: "maybe"}, {L: "maybe"}], 3600)

section("🌙 midnight during a hold closes quietly")
PAST = "2026-01-01"  # before the bot existed: never a real night
sql(f"DELETE FROM game_night_votes WHERE day = '{PAST}'; DELETE FROM game_nights WHERE day = '{PAST}'")
sql(f"INSERT INTO game_nights (day, stage, reminded, stage_at, maybes, paused_until) VALUES ('{PAST}', 'ask', false, {int(time.time()) - 3600}, 1, {int(time.time()) + 3600})")
sql(f"INSERT INTO game_night_votes (day, stage, user_id, choice, voted_at) VALUES ('{PAST}', 'ask', '{V}', 'yes', 'x'), ('{PAST}', 'ask', '{K}', 'yes', 'x'), ('{PAST}', 'ask', '{L}', 'maybe', 'x')")
admin("/admin/gamenight", {"action": "tick"})
n = night(PAST)
ok(n["stage"] == "off" and n["roast"] is None and n["paused_until"] is None, f"the day ended on hold → closed, nobody roasted (got {n['stage']}, {n['roast']})")
sql(f"DELETE FROM game_night_votes WHERE day = '{PAST}'; DELETE FROM game_nights WHERE day = '{PAST}'")

# --- round 1: every complete answer --------------------------------------------------------------
section("round 1: all 27 complete answer combinations")


def r1(day, combo):
    v = dict(zip(P, combo))
    start(day, v)
    check(day, v, 1, f"r1 {show(v)}")


pool(list(product(ALL3, repeat=3)), r1)

# --- hold 1: every change of mind --------------------------------------------------------------
section("hold 1: every change of mind (42)")


def held(unsure):
    return {p: ("maybe" if p in unsure else "yes") for p in P}


def hold1_change(day, c):
    unsure, p, a = c
    v = held(unsure)
    start(day, v)
    until = night(day)["paused_until"]
    vote(day, p, a)
    check(day, {**v, p: a}, 1, f"hold1 unsure={''.join(NAME[u] for u in unsure)} {NAME[p]}→{a}", held=until)


pool([(s, p, a) for s in SUBSETS for p in P for a in ALL3 if a != held(s)[p]], hold1_change)

# --- round 2: every way the unsure answer again --------------------------------------------------
section("round 2: hold over, then every complete answer from the unsure (63)")
r2_cases = [(s, combo) for s in SUBSETS for combo in product(ALL3, repeat=len(s))]
for batch in batches(r2_cases):
    pairs = list(zip(TEST_DAYS, batch))
    each(pairs, lambda d, c: start(d, held(c[0])))
    end_holds([d for d, _ in pairs])

    def r2(d, c):
        unsure, combo = c
        tag = f"r2 unsure={''.join(NAME[u] for u in unsure)} → {'/'.join(combo)}"
        carried = {p: (None if p in unsure else "yes") for p in P}
        check_resume(d, carried, unsure, 2, tag)
        v = {**carried, **dict(zip(unsure, combo))}
        for p, a in zip(unsure, combo):
            vote(d, p, a)
        check(d, v, 2, tag)

    each(pairs, r2)

# --- hold 2 + round 3: the final call -------------------------------------------------------------
section("hold 2 changes (42) and the final call: every yes/no answer, maybes refused (26 + 7)")
for batch in batches([("change", s, p, a) for s in SUBSETS for p in P for a in ALL3 if a != held(s)[p]] + [("final", s, combo) for s in SUBSETS for combo in product(("yes", "no", "maybe"), repeat=len(s)) if "maybe" not in combo or set(combo) == {"maybe"}]):
    pairs = list(zip(TEST_DAYS, batch))
    each(pairs, lambda d, c: start(d, held(P)))  # everyone unsure in round 1
    end_holds([d for d, _ in pairs])
    each(pairs, lambda d, c: [vote(d, p, a) for p, a in held(c[1]).items()])  # round 2: c[1] unsure again
    pre = {d: night(d)["paused_until"] for d, _ in pairs}

    def hold2(d, c):
        _, unsure, p, a = c
        vote(d, p, a)
        check(d, {**held(unsure), p: a}, 2, f"hold2 unsure={''.join(NAME[u] for u in unsure)} {NAME[p]}→{a}", held=pre[d])

    each([(d, c) for d, c in pairs if c[0] == "change"], hold2)
    finals = [(d, c) for d, c in pairs if c[0] == "final"]
    if finals:
        end_holds([d for d, _ in finals])

        def final(d, c):
            _, unsure, combo = c
            tag = f"r3 unsure={''.join(NAME[u] for u in unsure)} → {'/'.join(combo)}"
            carried = {p: (None if p in unsure else "yes") for p in P}
            check_resume(d, carried, unsure, 3, tag)
            v = dict(carried)
            for p, a in zip(unsure, combo):
                r = vote(d, p, a)
                if a == "maybe":
                    ok("No more maybes" in (r.get("notice") or ""), f"{tag}: {NAME[p]}'s maybe is refused")
                else:
                    v[p] = a
            check(d, v, 3, tag)

        each(finals, final)

# ------------------------------------------------------------------ cleanup
section("cleanup")
for d in (*TEST_DAYS, TODAY):
    admin("/admin/gamenight", {"action": "reset", "day": d})
left = sql(f"SELECT count(*) AS n FROM game_nights WHERE day IN ({', '.join(repr(d) for d in (*TEST_DAYS, TODAY, PAST))})")[0]["n"]
ok(left == 0, f"every day used is gone ({left} left)")
print(f"\n{results['pass']} passed, {results['fail']} failed in {round((time.time() - t0) / 60, 1)} min")
for f in failures:
    print("  ❌", f)
