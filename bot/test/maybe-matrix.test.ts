// 🤔 The whole "are we playing?" matrix: every combination of answers in every round, plus every
// change of mind during each hold, checked against a model of the rules (not the code):
//   round 1: 3 h to answer · everyone answered, nobody said no, someone said maybe → on hold 2 h
//   round 2: the maybes are cleared and get 1 h · another maybe → on hold 1 h more
//   round 3: final call, ✅ or ✖️ only, 1 h · a no always wins · no answer by a deadline = ghost
// Real Postgres, Discord stubbed, the clock moved by hand. Friday 2026-11-06, 17:00 Vilnius.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { GameNight, type Deferred, type NightGone } from "../src/gamenight.js";
import type { DiscordError } from "../src/discord.js";
import { Nights } from "../src/nights.js";
import { Interactions } from "../src/interactions.js";
import { Db, type DbError } from "../src/db/db.js";
import { gameNights, gameNightVotes, nightAttendance, roastBags, settings } from "../src/db/schema.js";
import { harness } from "./fx.js";

type Answer = "yes" | "maybe" | "no" | null;
type Votes = Record<string, Answer>;
const P = ["a", "b", "c"];
const DAY = "2026-11-06";
const T = (hm: string) => Date.parse(`${DAY}T${hm}:00+02:00`) / 1000; // Vilnius wall clock (EET)
const OPENS = [0, T("17:00"), T("19:00"), T("20:00")]; // when each round opens on the paths below
const WINDOW = [0, 3 * 3600, 3600, 3600];
const HOLD = [0, 2 * 3600, 3600];
const LABEL = { yes: "I'm in", maybe: "Maybe", no: "Not today" } as const;

const h = harness({
  tables: [gameNightVotes, nightAttendance, gameNights, roastBags, settings],
  discord: { firstId: 1000 },
  clock: T("17:00") * 1000,
});
const calls = h.calls;

// ---------------------------------------------------------------- harness

const setNow = (sec: number) => h.setTime(sec * 1000);
// a tap's slow work starts at once, as it did; `flush` waits for what's been started
type Later = DbError | DiscordError | NightGone;
const pending: Fiber.Fiber<unknown, Later>[] = [];
const started = (x: Effect.Effect<unknown, Later>) => Effect.forkDetach(x, { startImmediately: true });
const track: Deferred = (x) => Effect.map(started(x), (f) => void pending.push(f));
const flush = Effect.gen(function* () {
  while (pending.length) yield* Effect.forEach(pending.splice(0), Fiber.join, { concurrency: "unbounded", discard: true });
});
const act = (p: string, a: string, later: Deferred = track) => GameNight.use((g) => g.act(DAY, p, a, undefined, later));
const answer = (p: string, a: string) =>
  Effect.gen(function* () {
    const r = yield* act(p, a);
    yield* flush;
    return r;
  });
const night = () => Effect.map(Nights.use((n) => n.get(DAY)), (n) => n!);
const render = (viewer?: string) => GameNight.use((g) => g.render(DAY, viewer));
const maintain = GameNight.use((g) => g.maintain);
const startNight = (by?: string, anyHour = false) => GameNight.use((g) => g.startNight(by, anyHour));
const posts = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).map((c) => c.body);
const text = (m: unknown) => JSON.stringify(m);
const labels = (m: any): string[] =>
  m.components[0].components.filter((c: any) => c.type === 1).flatMap((r: any) => r.components.filter((b: any) => b.type === 2).map((b: any) => b.label));
const mention = (ps: string[]) => ps.map((p) => `<@${p}>`).join(" ");
const subsets = [1, 2, 3, 4, 5, 6, 7].map((m) => P.filter((_, i) => m & (1 << i))); // every non-empty group of players
const combos = (n: number, opts: Answer[]): Answer[][] => (n === 0 ? [[]] : combos(n - 1, opts).flatMap((c) => opts.map((o) => [...c, o])));
const show = (v: Votes) => P.map((p) => `${p}:${v[p] ?? "—"}`).join(" ");

// ---------------------------------------------------------------- the rules, as a model

type Outcome = { kind: "game" } | { kind: "off"; who: Record<string, string> } | { kind: "hold"; unsure: string[] } | { kind: "waiting" };

function decide(v: Votes, round: number): Outcome {
  const all = P.every((p) => v[p]);
  if (P.every((p) => v[p] === "yes")) return { kind: "game" };
  if (all && P.some((p) => v[p] === "no")) return { kind: "off", who: Object.fromEntries(P.filter((p) => v[p] === "no").map((p) => [p, "no"])) };
  if (all && round < 3) return { kind: "hold", unsure: P.filter((p) => v[p] === "maybe") };
  return { kind: "waiting" };
}

/** At a deadline: no answer = ghost, a no gets roasted too, a maybe doesn't. */
const atDeadline = (v: Votes) => Object.fromEntries(P.flatMap((p) => (!v[p] ? [[p, "ghost"]] : v[p] === "no" ? [[p, "no"]] : [])));

function panel(mine: Answer, final: boolean) {
  const opts = (["yes", "maybe", "no"] as const).filter((o) => !(final && o === "maybe"));
  return mine ? opts.filter((o) => o !== mine).map((o) => `Change to ${LABEL[o]}`) : opts.map((o) => LABEL[o]);
}

// ---------------------------------------------------------------- checks

/** Everything visible after the answers `v` are in, in `round`, which opened at `opened`; `held` = a hold already running. */
function check(v: Votes, round: number, opened: number, before: number, held?: number) {
  return Effect.gen(function* () {
    const n = yield* night();
    const out = decide(v, round);
    const fresh = posts().slice(before);
    const roasts = fresh.filter((m) => m.content?.startsWith("🔥"));
    switch (out.kind) {
      case "game":
        expect(n.stage).toBe("game");
        expect(fresh.filter((m) => m.content?.includes("Everyone's in!")).map((m) => m.allowed_mentions.users)).toEqual([P]);
        expect(roasts).toEqual([]);
        return;
      case "off":
        expect([n.stage, n.roast?.who]).toEqual(["off", out.who]);
        expect(roasts.length).toBe(1);
        expect(text(yield* render())).toContain("Reopen");
        return;
      case "hold": {
        const until = held ?? opened + HOLD[round];
        expect([n.stage, n.maybes, n.paused_until]).toEqual(["ask", round, until]);
        const card = yield* render();
        for (const p of P) expect(text(card)).toContain(`${v[p] === "yes" ? "✅" : "🤔"} <@${p}>`);
        expect(text(card)).toContain("**On hold**");
        expect(text(card)).not.toContain("Vote by");
        expect(labels(card)).toEqual(["I'm in", "Maybe", "Not today"]);
        const told = fresh.filter((m) => m.content?.includes("sure yet"));
        const sure = P.filter((p) => !out.unsure.includes(p));
        if (held) expect(told).toEqual([]); // still the same hold: nobody's pinged again
        else if (!sure.length) expect(told).toEqual([]); // nobody's waiting on anyone
        else {
          expect(told.length).toBe(1);
          expect(told[0].allowed_mentions.users).toEqual(sure);
          expect(told[0].content).toBe(
            `${mention(sure)} 🤔 ${out.unsure.map((p) => `<@${p}>`).join(" & ")} ${out.unsure.length > 1 ? "aren't" : "isn't"} sure yet, so it's on hold until <t:${until}:t> (<t:${until}:R>). Then I'll ask again ⬆️`,
          );
        }
        for (const p of P) expect(labels(yield* render(p))).toEqual(panel(v[p], false));
        expect(roasts).toEqual([]);
        return;
      }
      case "waiting": {
        expect([n.stage, n.maybes, n.paused_until]).toEqual(["ask", round - 1, null]);
        const card = yield* render();
        const hidden = round === 1;
        for (const p of P) expect(text(card)).toContain(`${!v[p] ? "⏳" : hidden ? "🗳️" : { yes: "✅", maybe: "🤔", no: "❌" }[v[p]!]} <@${p}>`);
        expect(text(card)).toContain(`Vote by <t:${opened + WINDOW[round]}:t>`);
        expect(labels(card)).toEqual(round === 3 ? ["I'm in", "Not today"] : ["I'm in", "Maybe", "Not today"]);
        if (round === 3) expect(text(card)).toContain("⏰ Final call! Are we playing today?");
        for (const p of P) expect(labels(yield* render(p))).toEqual(panel(v[p], round === 3));
        expect(roasts).toEqual([]);
        return;
      }
    }
  });
}

/** A round nobody finished: last call to whoever hasn't answered 30 min before, then it's off. */
function deadline(v: Votes, round: number, opened: number) {
  return Effect.gen(function* () {
    const end = opened + WINDOW[round];
    const missing = P.filter((p) => !v[p]);
    let before = posts().length;
    yield* setNow(end - 31 * 60);
    yield* maintain;
    expect(posts().slice(before).filter((m) => m.content?.includes("Last call"))).toEqual([]);
    yield* setNow(end - 29 * 60);
    yield* maintain;
    yield* maintain;
    const warned = posts().slice(before).filter((m) => m.content?.includes("Last call"));
    expect(warned.map((m) => [m.allowed_mentions.users, m.content.split(" ⏳")[0]])).toEqual([[missing, mention(missing)]]);
    before = posts().length;
    yield* setNow(end);
    yield* maintain;
    const n = yield* night();
    expect([n.stage, n.roast?.who]).toEqual(["off", atDeadline(v)]);
    expect(posts().slice(before).filter((m) => m.content?.startsWith("🔥")).length).toBe(1);
  });
}

/** A hold is up: the maybes are cleared and pinged, the rest stay; returns the votes left. */
function resume(v: Votes, round: number) {
  return Effect.gen(function* () {
    const unsure = P.filter((p) => v[p] === "maybe");
    const before = posts().length;
    yield* setNow(OPENS[round]);
    yield* Effect.all([maintain, maintain], { concurrency: "unbounded" }); // two ticks at once still resume once
    const n = yield* night();
    expect([n.stage, n.maybes, n.paused_until, n.stage_at]).toEqual(["ask", round - 1, null, OPENS[round]]);
    const asked = posts().slice(before).filter((m) => m.content?.includes(round === 3 ? "Final call" : "Decision time"));
    expect(asked.map((m) => m.allowed_mentions.users)).toEqual([unsure]);
    expect(asked[0].content).toContain(`Answer by <t:${OPENS[round] + 3600}:t>`);
    return Object.fromEntries(P.map((p) => [p, v[p] === "maybe" ? null : v[p]])) as Votes;
  });
}

function cast(v: Votes, round: number) {
  return Effect.gen(function* () {
    for (const p of P) {
      if (!v[p]) continue;
      const r = yield* answer(p, v[p]!);
      if (round === 3 && v[p] === "maybe") expect(r.notice).toContain("No more maybes");
    }
    // on the final call a maybe is refused: that player still hasn't answered
    return round === 3 ? (Object.fromEntries(Object.entries(v).map(([p, a]) => [p, a === "maybe" ? null : a])) as Votes) : v;
  });
}

const votes = (ps: string[], as: Answer[]) => Object.fromEntries(ps.map((p, i) => [p, as[i]])) as Votes;
const holdWith = (unsure: string[]) => Object.fromEntries(P.map((p) => [p, unsure.includes(p) ? "maybe" : "yes"])) as Votes;

/** Round 1 → hold → round 2 with everyone cleared → hold with `unsure` → round 3 (the final call). */
const toFinalCall = (unsure: string[]) =>
  Effect.gen(function* () {
    yield* startNight();
    yield* cast(holdWith(P), 1);
    const r2 = yield* resume(holdWith(P), 2);
    yield* cast(holdWith(unsure), 2);
    return { r2, held: holdWith(unsure) };
  });

// ---------------------------------------------------------------- the matrix

describe("round 1: every combination of answers (and no answer)", () => {
  it.effect.each(combos(3, ["yes", "maybe", "no", null]).map((c) => [show(votes(P, c)), votes(P, c)] as const))("%s", ([, v]) =>
    Effect.gen(function* () {
      yield* startNight(); // the 17:00 card, nobody's answered yet
      const before = posts().length;
      yield* cast(v, 1);
      yield* check(v, 1, OPENS[1], before);
      if (decide(v, 1).kind === "waiting") yield* deadline(v, 1, OPENS[1]);
    }).pipe(h.provide),
  );
});

const changes = subsets.flatMap((unsure) =>
  P.flatMap((p) => (["yes", "maybe", "no"] as const).filter((a) => a !== holdWith(unsure)[p]).map((a) => ({ unsure, p, a }))),
);

describe("hold 1: every change of mind while it waits", () => {
  it.effect.each(changes.map((c) => [`unsure ${c.unsure.join("")} · ${c.p} → ${c.a}`, c] as const))("%s", ([, { unsure, p, a }]) =>
    Effect.gen(function* () {
      yield* startNight();
      yield* cast(holdWith(unsure), 1);
      yield* setNow(T("18:00"));
      const before = posts().length;
      yield* answer(p, a);
      yield* check({ ...holdWith(unsure), [p]: a }, 1, OPENS[1], before, OPENS[1] + HOLD[1]);
    }).pipe(h.provide),
  );
});

const round2 = subsets.flatMap((unsure) => combos(unsure.length, ["yes", "maybe", "no", null]).map((as) => ({ unsure, as })));

describe("round 2: every way the unsure can answer again", () => {
  it.effect.each(round2.map((c) => [`unsure ${c.unsure.join("")} → ${c.as.map((a) => a ?? "—").join("/")}`, c] as const))("%s", ([, { unsure, as }]) =>
    Effect.gen(function* () {
      yield* startNight();
      yield* cast(holdWith(unsure), 1);
      const left = yield* resume(holdWith(unsure), 2);
      // the card after the hold: the yeses stayed, the unsure are back to ⏳ with a fresh hour
      yield* check(left, 2, OPENS[2], posts().length);
      const before = posts().length;
      const v = { ...left, ...votes(unsure, as) };
      yield* cast(votes(unsure, as), 2);
      yield* check(v, 2, OPENS[2], before);
      if (decide(v, 2).kind === "waiting") yield* deadline(v, 2, OPENS[2]);
    }).pipe(h.provide),
  );
});

describe("hold 2: every change of mind while it waits", () => {
  it.effect.each(changes.map((c) => [`unsure ${c.unsure.join("")} · ${c.p} → ${c.a}`, c] as const))("%s", ([, { unsure, p, a }]) =>
    Effect.gen(function* () {
      const { held } = yield* toFinalCall(unsure);
      yield* setNow(T("19:30"));
      const before = posts().length;
      yield* answer(p, a);
      yield* check({ ...held, [p]: a }, 2, OPENS[2], before, OPENS[2] + HOLD[2]);
    }).pipe(h.provide),
  );
});

const round3 = subsets.flatMap((unsure) => combos(unsure.length, ["yes", "maybe", "no", null]).map((as) => ({ unsure, as })));

describe("round 3, the final call: every answer, and maybes refused", () => {
  it.effect.each(round3.map((c) => [`unsure ${c.unsure.join("")} → ${c.as.map((a) => a ?? "—").join("/")}`, c] as const))("%s", ([, { unsure, as }]) =>
    Effect.gen(function* () {
      const { held } = yield* toFinalCall(unsure);
      const left = yield* resume(held, 3);
      yield* check(left, 3, OPENS[3], posts().length);
      const before = posts().length;
      const v = { ...left, ...(yield* cast(votes(unsure, as), 3)) };
      yield* check(v, 3, OPENS[3], before);
      if (decide(v, 3).kind === "waiting") yield* deadline(v, 3, OPENS[3]);
    }).pipe(h.provide),
  );
});

// ---------------------------------------------------------------- around the edges

it.effect("the last two answers at the same moment put it on hold once", () =>
  Effect.gen(function* () {
    yield* startNight();
    yield* answer("a", "yes");
    yield* Effect.all([act("b", "maybe"), act("c", "maybe")], { concurrency: "unbounded" });
    yield* flush;
    const n = yield* night();
    expect([n.maybes, n.paused_until]).toEqual([1, T("19:00")]);
    expect(posts().filter((m) => m.content?.includes("sure yet")).length).toBeLessThanOrEqual(1);
  }).pipe(h.provide),
);

it.effect("reopening after a final-call no starts over: round 1, secret, maybes allowed", () =>
  Effect.gen(function* () {
    const { held } = yield* toFinalCall(["c"]);
    yield* resume(held, 3);
    yield* answer("c", "no");
    expect((yield* night()).stage).toBe("off");
    yield* answer("a", "reopen");
    const n = yield* night();
    expect([n.stage, n.maybes, n.paused_until]).toEqual(["ask", 0, null]);
    const card = yield* render();
    expect(text(card)).toContain("🤫 Answers stay secret");
    expect(labels(card)).toEqual(["I'm in", "Maybe", "Not today"]);
  }).pipe(h.provide),
);

it.effect("midnight during a hold closes the card quietly (nobody to roast)", () =>
  Effect.gen(function* () {
    yield* setNow(T("22:30"));
    yield* startNight("a", true);
    yield* answer("b", "yes");
    yield* answer("c", "maybe"); // on hold until 00:30, past the day's end
    yield* setNow(Date.parse("2026-11-07T00:00:00+02:00") / 1000);
    yield* GameNight.use((g) => g.closeStale);
    const n = yield* night();
    expect([n.stage, n.roast, n.paused_until]).toEqual(["off", null, null]);
  }).pipe(h.provide),
);

it.effect("midnight with the unsure still to answer after a hold: quiet if their hour only just started, roasted after a full hour", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    for (const [start, who] of [
      ["21:30", null], // asked again at 23:30, half an hour before midnight
      ["21:00", { c: "ghost" }], // asked again at 23:00: a full hour
    ] as const) {
      yield* db.delete(gameNightVotes);
      yield* db.delete(gameNights);
      yield* setNow(T(start));
      yield* startNight("a", true);
      yield* answer("b", "yes");
      yield* answer("c", "maybe");
      yield* setNow((yield* night()).paused_until!);
      yield* maintain;
      yield* setNow(Date.parse("2026-11-07T00:00:00+02:00") / 1000);
      yield* GameNight.use((g) => g.closeStale);
      expect([(yield* night()).stage, (yield* night()).roast?.who ?? null]).toEqual(["off", who]);
    }
  }).pipe(h.provide),
);

const handle = (user: string, action: string, panel: boolean) =>
  Interactions.use((x) =>
    Effect.map(x.handle({ type: 3, token: "tok", data: { custom_id: `gn:${DAY}:${action}`, component_type: 2 }, message: { flags: (1 << 15) | (panel ? 64 : 0) }, member: { user: { id: user, username: user } } }), (r) => r as any),
  );

it.effect("taps: Maybe on the card opens your panel, on your panel updates it, and a stale one says why", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    h.race("each tap starts its panel's tracking in the background, and the next tap comes before it has landed", { mask: { panels: ["message_id"] }, calls: false });
    yield* startNight();
    const tap = (user: string, action: string, panel: boolean) => handle(user, action, panel);
    const fromCard = yield* tap("a", "maybe", false);
    expect([fromCard.type, fromCard.data.flags & 64]).toEqual([4, 64]); // a new message only a sees
    expect(text(fromCard.data)).toContain("You said **maybe**");
    expect(labels(fromCard.data)).toEqual(["Change to I'm in", "Change to Not today"]);
    const fromPanel = yield* tap("a", "yes", true);
    expect(fromPanel.type).toBe(7); // edits a's panel in place
    expect(labels(fromPanel.data)).toEqual(["Change to Maybe", "Change to Not today"]);
    // to the final call, then a's old panel still has a Maybe button
    yield* db.update(gameNights).set({ maybes: 2 });
    const stale = yield* tap("a", "maybe", true);
    expect(stale.type).toBe(7);
    expect(text(stale.data)).toContain("No more maybes: this is the final call.");
    expect(labels(stale.data)).toEqual(["Change to Not today"]);
  }).pipe(h.provide),
);

it.effect("taps: Maybe on the card opens your panel, on your panel updates it, and a stale one says why (each tap done before the next)", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* startNight();
    // each tap's background work (the panel's tracking and edits) lands before the next tap, as it would for a person
    const tap = (user: string, action: string, panel: boolean) =>
      Effect.gen(function* () {
        const out = yield* handle(user, action, panel);
        yield* h.settle;
        return out;
      });
    const fromCard = yield* tap("a", "maybe", false);
    expect([fromCard.type, fromCard.data.flags & 64]).toEqual([4, 64]); // a new message only a sees
    expect(text(fromCard.data)).toContain("You said **maybe**");
    expect(labels(fromCard.data)).toEqual(["Change to I'm in", "Change to Not today"]);
    const fromPanel = yield* tap("a", "yes", true);
    expect(fromPanel.type).toBe(7); // edits a's panel in place
    expect(labels(fromPanel.data)).toEqual(["Change to Maybe", "Change to Not today"]);
    // to the final call, then a's old panel still has a Maybe button
    yield* db.update(gameNights).set({ maybes: 2 });
    const stale = yield* tap("a", "maybe", true);
    expect(stale.type).toBe(7);
    expect(text(stale.data)).toContain("No more maybes: this is the final call.");
    expect(labels(stale.data)).toEqual(["Change to Not today"]);
  }).pipe(h.provide),
);

it.effect("a maybe on any later step, from an outsider, or on a closed card is turned away", () =>
  Effect.gen(function* () {
    yield* startNight();
    // (an outsider's tap is turned away before any slow work: nothing to wait for)
    expect((yield* act("zed", "maybe", (x) => Effect.asVoid(started(x)))).notice).toContain("trio");
    for (const p of P) yield* answer(p, "yes");
    expect((yield* answer("a", "maybe")).notice).toContain("past that step");
    yield* answer("a", "out");
    expect((yield* answer("b", "maybe")).notice).toContain("Game night's off");
  }).pipe(h.provide),
);
