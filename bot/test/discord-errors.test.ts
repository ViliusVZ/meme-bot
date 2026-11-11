// Discord's real error answers (captured from the test bot by scripts/capture_discord_errors.py into
// test/fixtures/discord-errors/), fed through the real REST client and today's matchers. This is
// what the typed errors are built from (plan 05, verification.md §2d).
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import { api, editOriginal, isNotFound } from "../src/discord.js";
import * as voice from "../src/voice.js";
import * as presence from "../src/presence.js";
import type { Env } from "../src/env.js";
import { harness, json } from "./harness.js";

type Fixture = { note: string; request: { method: string; path: string }; status: number; body: { message: string; code: number; errors?: unknown; retry_after?: number } };
const dir = new URL("./fixtures/discord-errors/", import.meta.url);
const fixtures: Record<string, Fixture> = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(f, dir), "utf8"))]),
);

const h = harness({ db: false, discord: { firstId: 0 } });
let env: Env;
beforeAll(() => void ({ env } = h));

/** Discord answers this call with the fixture; returns the error api() throws. */
async function failWith(name: string, method = fixtures[name].request.method, path = "/x") {
  const f = fixtures[name];
  h.override = () => json(f.body, f.status);
  return api(env, method, path).then(
    () => null,
    (e: unknown) => e,
  );
}

test("every capture is a real Discord error body", () => {
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
});

test("gone things are 404s, and isNotFound says so", async () => {
  for (const name of ["unknown-voice-state", "unknown-channel", "unknown-message", "unknown-message-patch", "unknown-guild", "deleted-event-extend"]) {
    expect(isNotFound(await failWith(name))).toBe(true);
  }
  for (const name of ["missing-access", "ended-event-end", "ended-event-extend"]) {
    expect(isNotFound(await failWith(name))).toBe(false);
  }
});

test("not in voice: Discord's Unknown Voice State reads as null", async () => {
  presence._reset();
  h.override = (c) => (c.path.includes("/voice-states/") ? json(fixtures["unknown-voice-state"].body, 404) : undefined);
  expect(await voice.voiceChannel(env, "someone")).toBeNull();
});

test("today's text match can't tell a 403 whose path holds 10065 from 'not in voice'", async () => {
  // what voice.ts matches on (String(e).includes("10065")) is in this error's text, though Discord
  // said Missing Access: the false match plan 05's typed errors remove (README, intended difference 1)
  const e = await failWith("missing-access", "GET", "/guilds/guild/voice-states/10065");
  expect(String(e)).toContain("10065");
  expect(String(e)).toContain(" 403 ");
});

test("an ended event: Discord's answer to pushing its end back holds INVALID_END_BY_STATUS", async () => {
  // voice.ts keepEventAlive treats this text (or a 404) as "the event is over"
  expect(String(await failWith("ended-event-extend"))).toContain("INVALID_END_BY_STATUS");
  // ending it again is refused differently (archiveIfIdle ignores any failure of that call)
  expect(String(await failWith("ended-event-end"))).toContain(" 403 ");
  expect(String(await failWith("ended-event-end"))).not.toContain("INVALID_END_BY_STATUS");
});

test("a rate limit is waited out (retry_after) and retried, whatever the method", async () => {
  let n = 0;
  h.override = () => (n++ === 0 ? json(fixtures["rate-limited"].body, 429) : json({ id: "ok" }));
  expect(await api(env, "POST", "/x", {})).toEqual({ id: "ok" });
  expect(n).toBe(2);
});

test("an expired interaction token: one attempt, no retries, the caller gets the refusal", async () => {
  // 401 is neither "not processed yet" (404) nor transient (429, 5xx): webhook() gives it back at once
  let n = 0;
  h.override = (c) => (c.path.startsWith("/webhooks/") ? (n++, json(fixtures["expired-interaction-token"].body, 401)) : undefined);
  const r = await editOriginal(env, "tok", { content: "x" });
  expect(r?.status).toBe(401);
  expect(n).toBe(1);
});
