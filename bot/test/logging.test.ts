// Logs through the app's runtime: one logfmt line per entry, the phrases the owner greps for whole,
// annotations as key=value, secrets redacted (plan 05, architecture.md §14).
import { expect, test, vi } from "vitest";
import { Effect, Redacted } from "effect";
import { run } from "./old/legacy.js";
import { harness } from "./harness.js";

const h = harness({ db: false });

test("one line per entry, logfmt, phrases whole, secrets redacted", async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  try {
    await run(
      h.env,
      Effect.gen(function* () {
        yield* Effect.logInfo("leader: took over");
        yield* Effect.logInfo("interaction 412 ms").pipe(Effect.annotateLogs({ what: "gn:2026-11-11:yes", who: "vithis" }));
        yield* Effect.logInfo(`token ${Redacted.make("discord-secret-token")}`);
      }),
    );
  } finally {
    spy.mockRestore();
  }
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/level=INFO .*message="leader: took over"/);
  expect(lines[1]).toContain('message="interaction 412 ms"');
  expect(lines[1]).toContain("what=gn:2026-11-11:yes who=vithis");
  expect(lines.join("\n")).not.toContain("discord-secret-token");
  for (const l of lines) expect(l).not.toContain("\n");
});
