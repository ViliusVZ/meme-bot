// 🤔 The whole "are we playing?" matrix: every combination of answers in every round, plus every
// change of mind during each hold, checked against a model of the rules (not the code):
//   round 1: 3 h to answer · everyone answered, nobody said no, someone said maybe → on hold 2 h
//   round 2: the maybes are cleared and get 1 h · another maybe → on hold 1 h more
//   round 3: final call, ✅ or ✖️ only, 1 h · a no always wins · no answer by a deadline = ghost
// Real Postgres, Discord stubbed, the clock moved by hand. Friday 2026-11-06, 17:00 Vilnius.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as gn from "./old/gamenight.js";
import { interaction } from "./old/interactions.js";
import { gameNights, gameNightVotes, nightAttendance, roastBags, settings } from "../src/db/schema.js";
import { harness, type TestDb } from "./harness.js";
import type { Env } from "./old/env.js";

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
let t: TestDb;
let env: Env;
beforeAll(() => void ({ t, env } = h));

// ---------------------------------------------------------------- harness

const setNow = (sec: number) => vi.setSystemTime(sec * 1000);
const pending: Promise<unknown>[] = [];
const flush = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
const answer = async (p: string, a: string) => {
  const r = await gn.act(env, DAY, p, a, undefined, (x) => void pending.push(x));
  await flush();
  return r;
};
const night = async () => (await gn.getNight(env, DAY))!;
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
async function check(v: Votes, round: number, opened: number, before: number, held?: number) {
  const n = await night();
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
      expect(text(await gn.render(env, DAY))).toContain("Reopen");
      return;
    case "hold": {
      const until = held ?? opened + HOLD[round];
      expect([n.stage, n.maybes, n.paused_until]).toEqual(["ask", round, until]);
      const card = await gn.render(env, DAY);
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
      for (const p of P) expect(labels(await gn.render(env, DAY, p))).toEqual(panel(v[p], false));
      expect(roasts).toEqual([]);
      return;
    }
    case "waiting": {
      expect([n.stage, n.maybes, n.paused_until]).toEqual(["ask", round - 1, null]);
      const card = await gn.render(env, DAY);
      const hidden = round === 1;
      for (const p of P) expect(text(card)).toContain(`${!v[p] ? "⏳" : hidden ? "🗳️" : { yes: "✅", maybe: "🤔", no: "❌" }[v[p]!]} <@${p}>`);
      expect(text(card)).toContain(`Vote by <t:${opened + WINDOW[round]}:t>`);
      expect(labels(card)).toEqual(round === 3 ? ["I'm in", "Not today"] : ["I'm in", "Maybe", "Not today"]);
      if (round === 3) expect(text(card)).toContain("⏰ Final call! Are we playing today?");
      for (const p of P) expect(labels(await gn.render(env, DAY, p))).toEqual(panel(v[p], round === 3));
      expect(roasts).toEqual([]);
      return;
    }
  }
}

/** A round nobody finished: last call to whoever hasn't answered 30 min before, then it's off. */
async function deadline(v: Votes, round: number, opened: number) {
  const end = opened + WINDOW[round];
  const missing = P.filter((p) => !v[p]);
  let before = posts().length;
  setNow(end - 31 * 60);
  await gn.maintain(env);
  expect(posts().slice(before).filter((m) => m.content?.includes("Last call"))).toEqual([]);
  setNow(end - 29 * 60);
  await gn.maintain(env);
  await gn.maintain(env);
  const warned = posts().slice(before).filter((m) => m.content?.includes("Last call"));
  expect(warned.map((m) => [m.allowed_mentions.users, m.content.split(" ⏳")[0]])).toEqual([[missing, mention(missing)]]);
  before = posts().length;
  setNow(end);
  await gn.maintain(env);
  const n = await night();
  expect([n.stage, n.roast?.who]).toEqual(["off", atDeadline(v)]);
  expect(posts().slice(before).filter((m) => m.content?.startsWith("🔥")).length).toBe(1);
}

/** A hold is up: the maybes are cleared and pinged, the rest stay; returns the votes left. */
async function resume(v: Votes, round: number) {
  const unsure = P.filter((p) => v[p] === "maybe");
  const before = posts().length;
  setNow(OPENS[round]);
  await Promise.all([gn.maintain(env), gn.maintain(env)]); // two ticks at once still resume once
  const n = await night();
  expect([n.stage, n.maybes, n.paused_until, n.stage_at]).toEqual(["ask", round - 1, null, OPENS[round]]);
  const asked = posts().slice(before).filter((m) => m.content?.includes(round === 3 ? "Final call" : "Decision time"));
  expect(asked.map((m) => m.allowed_mentions.users)).toEqual([unsure]);
  expect(asked[0].content).toContain(`Answer by <t:${OPENS[round] + 3600}:t>`);
  return Object.fromEntries(P.map((p) => [p, v[p] === "maybe" ? null : v[p]])) as Votes;
}

async function cast(v: Votes, round: number) {
  for (const p of P) {
    if (!v[p]) continue;
    const r = await answer(p, v[p]!);
    if (round === 3 && v[p] === "maybe") expect(r.notice).toContain("No more maybes");
  }
  // on the final call a maybe is refused: that player still hasn't answered
  return round === 3 ? (Object.fromEntries(Object.entries(v).map(([p, a]) => [p, a === "maybe" ? null : a])) as Votes) : v;
}

const votes = (ps: string[], as: Answer[]) => Object.fromEntries(ps.map((p, i) => [p, as[i]])) as Votes;
const holdWith = (unsure: string[]) => Object.fromEntries(P.map((p) => [p, unsure.includes(p) ? "maybe" : "yes"])) as Votes;

/** Round 1 → hold → round 2 with everyone cleared → hold with `unsure` → round 3 (the final call). */
async function toFinalCall(unsure: string[]) {
  await gn.startNight(env);
  await cast(holdWith(P), 1);
  const r2 = await resume(holdWith(P), 2);
  await cast(holdWith(unsure), 2);
  return { r2, held: holdWith(unsure) };
}

// ---------------------------------------------------------------- the matrix

describe("round 1: every combination of answers (and no answer)", () => {
  test.each(combos(3, ["yes", "maybe", "no", null]).map((c) => [show(votes(P, c)), votes(P, c)] as const))("%s", async (_, v) => {
    await gn.startNight(env); // the 17:00 card, nobody's answered yet
    const before = posts().length;
    await cast(v, 1);
    await check(v, 1, OPENS[1], before);
    if (decide(v, 1).kind === "waiting") await deadline(v, 1, OPENS[1]);
  });
});

const changes = subsets.flatMap((unsure) =>
  P.flatMap((p) => (["yes", "maybe", "no"] as const).filter((a) => a !== holdWith(unsure)[p]).map((a) => ({ unsure, p, a }))),
);

describe("hold 1: every change of mind while it waits", () => {
  test.each(changes.map((c) => [`unsure ${c.unsure.join("")} · ${c.p} → ${c.a}`, c] as const))("%s", async (_, { unsure, p, a }) => {
    await gn.startNight(env);
    await cast(holdWith(unsure), 1);
    setNow(T("18:00"));
    const before = posts().length;
    await answer(p, a);
    await check({ ...holdWith(unsure), [p]: a }, 1, OPENS[1], before, OPENS[1] + HOLD[1]);
  });
});

const round2 = subsets.flatMap((unsure) => combos(unsure.length, ["yes", "maybe", "no", null]).map((as) => ({ unsure, as })));

describe("round 2: every way the unsure can answer again", () => {
  test.each(round2.map((c) => [`unsure ${c.unsure.join("")} → ${c.as.map((a) => a ?? "—").join("/")}`, c] as const))("%s", async (_, { unsure, as }) => {
    await gn.startNight(env);
    await cast(holdWith(unsure), 1);
    const left = await resume(holdWith(unsure), 2);
    // the card after the hold: the yeses stayed, the unsure are back to ⏳ with a fresh hour
    await check(left, 2, OPENS[2], posts().length);
    const before = posts().length;
    const v = { ...left, ...votes(unsure, as) };
    await cast(votes(unsure, as), 2);
    await check(v, 2, OPENS[2], before);
    if (decide(v, 2).kind === "waiting") await deadline(v, 2, OPENS[2]);
  });
});

describe("hold 2: every change of mind while it waits", () => {
  test.each(changes.map((c) => [`unsure ${c.unsure.join("")} · ${c.p} → ${c.a}`, c] as const))("%s", async (_, { unsure, p, a }) => {
    const { held } = await toFinalCall(unsure);
    setNow(T("19:30"));
    const before = posts().length;
    await answer(p, a);
    await check({ ...held, [p]: a }, 2, OPENS[2], before, OPENS[2] + HOLD[2]);
  });
});

const round3 = subsets.flatMap((unsure) => combos(unsure.length, ["yes", "maybe", "no", null]).map((as) => ({ unsure, as })));

describe("round 3, the final call: every answer, and maybes refused", () => {
  test.each(round3.map((c) => [`unsure ${c.unsure.join("")} → ${c.as.map((a) => a ?? "—").join("/")}`, c] as const))("%s", async (_, { unsure, as }) => {
    const { held } = await toFinalCall(unsure);
    const left = await resume(held, 3);
    await check(left, 3, OPENS[3], posts().length);
    const before = posts().length;
    const v = { ...left, ...(await cast(votes(unsure, as), 3)) };
    await check(v, 3, OPENS[3], before);
    if (decide(v, 3).kind === "waiting") await deadline(v, 3, OPENS[3]);
  });
});

// ---------------------------------------------------------------- around the edges

test("the last two answers at the same moment put it on hold once", async () => {
  await gn.startNight(env);
  await answer("a", "yes");
  await Promise.all([gn.act(env, DAY, "b", "maybe", undefined, (x) => void pending.push(x)), gn.act(env, DAY, "c", "maybe", undefined, (x) => void pending.push(x))]);
  await flush();
  const n = await night();
  expect([n.maybes, n.paused_until]).toEqual([1, T("19:00")]);
  expect(posts().filter((m) => m.content?.includes("sure yet")).length).toBeLessThanOrEqual(1);
});

test("reopening after a final-call no starts over: round 1, secret, maybes allowed", async () => {
  const { held } = await toFinalCall(["c"]);
  await resume(held, 3);
  await answer("c", "no");
  expect((await night()).stage).toBe("off");
  await answer("a", "reopen");
  const n = await night();
  expect([n.stage, n.maybes, n.paused_until]).toEqual(["ask", 0, null]);
  const card = await gn.render(env, DAY);
  expect(text(card)).toContain("🤫 Answers stay secret");
  expect(labels(card)).toEqual(["I'm in", "Maybe", "Not today"]);
});

test("midnight during a hold closes the card quietly (nobody to roast)", async () => {
  setNow(T("22:30"));
  await gn.startNight(env, "a", true);
  await answer("b", "yes");
  await answer("c", "maybe"); // on hold until 00:30, past the day's end
  setNow(Date.parse("2026-11-07T00:00:00+02:00") / 1000);
  await gn.closeStale(env);
  const n = await night();
  expect([n.stage, n.roast, n.paused_until]).toEqual(["off", null, null]);
});

test("midnight with the unsure still to answer after a hold: quiet if their hour only just started, roasted after a full hour", async () => {
  for (const [start, who] of [
    ["21:30", null], // asked again at 23:30, half an hour before midnight
    ["21:00", { c: "ghost" }], // asked again at 23:00: a full hour
  ] as const) {
    await t.db.delete(gameNightVotes);
    await t.db.delete(gameNights);
    setNow(T(start));
    await gn.startNight(env, "a", true);
    await answer("b", "yes");
    await answer("c", "maybe");
    setNow((await night()).paused_until!);
    await gn.maintain(env);
    setNow(Date.parse("2026-11-07T00:00:00+02:00") / 1000);
    await gn.closeStale(env);
    expect([(await night()).stage, (await night()).roast?.who ?? null]).toEqual(["off", who]);
  }
});

test("taps: Maybe on the card opens your panel, on your panel updates it, and a stale one says why", async () => {
  h.race("each tap starts its panel's tracking in the background, and the next tap comes before it has landed", { mask: { panels: ["message_id"] }, calls: false });
  await gn.startNight(env);
  const tap = (user: string, action: string, panel: boolean) =>
    interaction({ type: 3, token: "tok", data: { custom_id: `gn:${DAY}:${action}`, component_type: 2 }, message: { flags: (1 << 15) | (panel ? 64 : 0) }, member: { user: { id: user, username: user } } }, env) as Promise<any>;
  const fromCard = await tap("a", "maybe", false);
  expect([fromCard.type, fromCard.data.flags & 64]).toEqual([4, 64]); // a new message only a sees
  expect(text(fromCard.data)).toContain("You said **maybe**");
  expect(labels(fromCard.data)).toEqual(["Change to I'm in", "Change to Not today"]);
  const fromPanel = await tap("a", "yes", true);
  expect(fromPanel.type).toBe(7); // edits a's panel in place
  expect(labels(fromPanel.data)).toEqual(["Change to Maybe", "Change to Not today"]);
  // to the final call, then a's old panel still has a Maybe button
  await t.db.update(gameNights).set({ maybes: 2 });
  const stale = await tap("a", "maybe", true);
  expect(stale.type).toBe(7);
  expect(text(stale.data)).toContain("No more maybes: this is the final call.");
  expect(labels(stale.data)).toEqual(["Change to Not today"]);
});

test("taps: Maybe on the card opens your panel, on your panel updates it, and a stale one says why (each tap done before the next)", async () => {
  await gn.startNight(env);
  // each tap's background work (the panel's tracking and edits) lands before the next tap, as it would for a person
  const tap = async (user: string, action: string, panel: boolean) => {
    const out = (await interaction({ type: 3, token: "tok", data: { custom_id: `gn:${DAY}:${action}`, component_type: 2 }, message: { flags: (1 << 15) | (panel ? 64 : 0) }, member: { user: { id: user, username: user } } }, env)) as any;
    await h.settle();
    return out;
  };
  const fromCard = await tap("a", "maybe", false);
  expect([fromCard.type, fromCard.data.flags & 64]).toEqual([4, 64]); // a new message only a sees
  expect(text(fromCard.data)).toContain("You said **maybe**");
  expect(labels(fromCard.data)).toEqual(["Change to I'm in", "Change to Not today"]);
  const fromPanel = await tap("a", "yes", true);
  expect(fromPanel.type).toBe(7); // edits a's panel in place
  expect(labels(fromPanel.data)).toEqual(["Change to Maybe", "Change to Not today"]);
  // to the final call, then a's old panel still has a Maybe button
  await t.db.update(gameNights).set({ maybes: 2 });
  const stale = await tap("a", "maybe", true);
  expect(stale.type).toBe(7);
  expect(text(stale.data)).toContain("No more maybes: this is the final call.");
  expect(labels(stale.data)).toEqual(["Change to Not today"]);
});

test("a maybe on any later step, from an outsider, or on a closed card is turned away", async () => {
  await gn.startNight(env);
  expect((await gn.act(env, DAY, "zed", "maybe", undefined, () => {})).notice).toContain("trio");
  for (const p of P) await answer(p, "yes");
  expect((await answer("a", "maybe")).notice).toContain("past that step");
  await answer("a", "out");
  expect((await answer("b", "maybe")).notice).toContain("Game night's off");
});
