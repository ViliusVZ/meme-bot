// Discord's real error answers (captured from the test bot by scripts/capture_discord_errors.py into
// test/fixtures/discord-errors/), fed through the real REST client and today's matchers. This is
// what the typed errors are built from (plan 05, verification.md §2d).
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Discord } from "../src/discord.js";
import { Voice } from "../src/voice.js";
import { harness, json } from "./fx.js";

type Fixture = { note: string; request: { method: string; path: string }; status: number; body: { message: string; code: number; errors?: unknown; retry_after?: number } };
const dir = new URL("./fixtures/discord-errors/", import.meta.url);
const fixtures: Record<string, Fixture> = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(f, dir), "utf8"))]),
);

const h = harness({ db: false, discord: { firstId: 0 } });

/** Discord answers this call with the fixture; returns the error the REST client fails with. */
function failWith(name: string, method = fixtures[name].request.method, path = "/x") {
  const f = fixtures[name];
  h.override = () => json(f.body, f.status);
  return Discord.use((d) => d.request(method, path)).pipe(Effect.match({ onSuccess: (): unknown => null, onFailure: (e): unknown => e }));
}
/** True when the error is Discord's 404 (the thing is gone), read from its text as callers once did. */
const isNotFound = (e: unknown) => / -> 404 /.test(String(e));

it.effect("every capture is a real Discord error body", () =>
  Effect.sync(() => {
    expect(Object.keys(fixtures).sort()).toEqual([
      "deleted-event-extend",
      "ended-event-end",
      "ended-event-extend",
      "expired-interaction-token",
      "missing-access",
      "rate-limited",
      "unknown-channel",
      "unknown-guild",
      "unknown-message",
      "unknown-message-patch",
      "unknown-voice-state",
    ]);
    for (const f of Object.values(fixtures)) {
      expect(typeof f.body.message).toBe("string");
      expect(f.status).toBeGreaterThanOrEqual(400);
    }
  }).pipe(h.provide),
);

it.effect("gone things are 404s, and isNotFound says so", () =>
  Effect.gen(function* () {
    for (const name of ["unknown-voice-state", "unknown-channel", "unknown-message", "unknown-message-patch", "unknown-guild", "deleted-event-extend"]) {
      expect(isNotFound(yield* failWith(name))).toBe(true);
    }
    for (const name of ["missing-access", "ended-event-end", "ended-event-extend"]) {
      expect(isNotFound(yield* failWith(name))).toBe(false);
    }
  }).pipe(h.provide),
);

it.effect("not in voice: Discord's Unknown Voice State reads as null", () =>
  Effect.gen(function* () {
    h.override = (c) => (c.path.includes("/voice-states/") ? json(fixtures["unknown-voice-state"].body, 404) : undefined);
    expect(yield* Voice.use((v) => v.voiceChannel("someone"))).toBeNull();
  }).pipe(h.provide),
);

it.effect("today's text match can't tell a 403 whose path holds 10065 from 'not in voice'", () =>
  Effect.gen(function* () {
    // what voice.ts matches on (String(e).includes("10065")) is in this error's text, though Discord
    // said Missing Access: the false match plan 05's typed errors remove (README, intended difference 1)
    const e = yield* failWith("missing-access", "GET", "/guilds/guild/voice-states/10065");
    expect(String(e)).toContain("10065");
    expect(String(e)).toContain(" 403 ");
  }).pipe(h.provide),
);

it.effect("an ended event: Discord's answer to pushing its end back holds INVALID_END_BY_STATUS", () =>
  Effect.gen(function* () {
    // voice.ts keepEventAlive treats this text (or a 404) as "the event is over"
    expect(String(yield* failWith("ended-event-extend"))).toContain("INVALID_END_BY_STATUS");
    // ending it again is refused differently (archiveIfIdle ignores any failure of that call)
    expect(String(yield* failWith("ended-event-end"))).toContain(" 403 ");
    expect(String(yield* failWith("ended-event-end"))).not.toContain("INVALID_END_BY_STATUS");
  }).pipe(h.provide),
);

it.effect("a rate limit is waited out (retry_after) and retried, whatever the method", () =>
  Effect.gen(function* () {
    let n = 0;
    h.override = () => (n++ === 0 ? json(fixtures["rate-limited"].body, 429) : json({ id: "ok" }));
    expect(yield* Discord.use((d) => d.request("POST", "/x", {}))).toEqual({ id: "ok" });
    expect(n).toBe(2);
  }).pipe(h.provide),
);

it.effect("an expired interaction token: one attempt, no retries, the caller gets the refusal", () =>
  Effect.gen(function* () {
    // 401 is neither "not processed yet" (404) nor transient (429, 5xx): webhook() gives it back at once
    let n = 0;
    h.override = (c) => (c.path.startsWith("/webhooks/") ? (n++, json(fixtures["expired-interaction-token"].body, 401)) : undefined);
    const r = yield* Discord.use((d) => d.editOriginal("tok", { content: "x" }));
    expect(r?.status).toBe(401);
    expect(n).toBe(1);
  }).pipe(h.provide),
);
