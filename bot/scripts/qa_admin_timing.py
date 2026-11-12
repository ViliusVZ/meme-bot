"""Round-trip times of the admin routes that run the tap code, on the TEST bot (plan 05: tap timings
without the browser, old code vs new). The same fixed sequence every time: a quiet card on a QA day,
then rounds of a private copy's render and quiet votes that change it, then the card removed.

    python scripts/qa_admin_timing.py [--rounds 20] [--label new]

Prints each call's milliseconds and the median and 95th percentile per kind. Run it on the new code,
then (in the rollback rehearsal) on the old code, and compare.
"""
import argparse
import statistics
import sys
import time

from dc import admin
from qa_guard import TEST_DAYS, require_idle
from target import PROD

sys.stdout.reconfigure(encoding="utf-8")
assert not PROD, "test bot only"
p = argparse.ArgumentParser()
p.add_argument("--rounds", type=int, default=20)
p.add_argument("--label", default="")
a = p.parse_args()

V, K = "306836805825593344", "212567787896307713"
day = TEST_DAYS[4]
times: dict[str, list[float]] = {}


def timed(kind, payload):
    t0 = time.perf_counter()
    r = admin("/admin/gamenight", payload)
    times.setdefault(kind, []).append((time.perf_counter() - t0) * 1000)
    return r


require_idle()
admin("/admin/gamenight", {"action": "reset", "day": day})
admin("/admin/gamenight", {"action": "plan", "user": K, "day": day})
for i in range(a.rounds):
    timed("copy", {"action": "copy", "day": day, "user": V})
    timed("vote", {"action": "vote", "day": day, "user": V, "choice": "maybe" if i % 2 == 0 else "yes"})
admin("/admin/gamenight", {"action": "reset", "day": day})


def p95(xs):
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]


print(f"admin route timings {a.label} ({a.rounds} rounds)")
for kind, xs in times.items():
    print(f"  {kind}: median {statistics.median(xs):.0f} ms, p95 {p95(xs):.0f} ms, max {max(xs):.0f} ms ({', '.join(f'{x:.0f}' for x in xs)})")
