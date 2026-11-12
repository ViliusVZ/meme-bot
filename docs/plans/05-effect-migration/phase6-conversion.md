# Phase 6: converting a test file to the Effect harness

For the sessions converting `bot/test/*.test.ts` one file at a time. Read STATUS.md's "Phase 6
design" first. Effect is version 4.1.4: take every API from `bot/node_modules/effect` (its `.d.ts`
files, `AGENTS.md`, `ai-docs`), never from memory of Effect 3.

## What must not change

- **Every assertion.** The ledger (`node scripts/assertions.mjs --check`) records, per test, the
  matcher chain after `expect(…)` with its arguments (`.not.toBe(401)`, `.rejects.toThrow("x")`).
  Only the value under test may change (the call expression). Same test titles, same order of
  assertions, same describe blocks. Never add, drop or reorder an `expect`.
- **Every recording.** `test/__recordings__/<file>.json` must be byte-identical after running the
  file (`git diff --stat test/__recordings__/<file>.json` empty). It records every outbound HTTP
  call and the database after each test, so the calls the code makes, in order, and the rows it
  writes must stay the same.
- **`src` is frozen.** Don't edit anything in `bot/src`. If a converted test seems to need a src
  change, stop and report it.
- **Shared files.** Don't edit `test/fx.ts`, `test/harness.ts`, `test/pg.ts`, `test/old/*`,
  `scripts/*`, the ledger or the gates. If the harness lacks something, put a small helper in your
  own test file, or report it.
- Never commit, stash, push, deploy, or touch `C:\p\meme-bot`. Leave your edits in the working tree.

## The harness (`test/fx.ts`)

```ts
import { expect, it, describe } from "@effect/vitest";
import { Effect } from "effect";
import { harness, json, routes } from "./fx.js";

const h = harness({ tables: […], discord: { firstId: …, routes: […] }, clock: "2026-11-06T15:00:00Z" });

it.effect("title unchanged", () =>
  Effect.gen(function* () {
    const gn = yield* GameNight;            // services from src
    expect(yield* gn.startNight("a")).toEqual(…);
  }).pipe(h.provide),
);
```

- `harness(options)`: the same options as the old `harness()` (`tables`, `discord`, `setup`,
  `seed`, `env`, `db: false`). `clock`: a time freezes the app's clock there for each test (sleeps
  still take real time, exactly like the old fake `Date`); `"test"` leaves the test's TestClock;
  none is the live clock. Keep the file's existing clock option as it is.
- `h.provide`: wrap every test's Effect with it (fresh services per test, seeded Random, the
  clock, the test logger, and a wait for background work at the end).
- `h.t`: the throwaway schema through node-postgres (`h.t.db`, `h.t.pool`), for setup rows and
  raw SQL (triggers). Prefer the app's `Db` (`const db = yield* Db; yield* db.select()…`) for
  reads and writes inside a test; both see the same schema.
- `h.env`: the old env object (read-only now: for values like `h.env.GAME_CHANNEL_ID`);
  `h.config`: the same as `AppConfigShape`.
- `h.calls`, `h.override`, `h.race(…)`: as before.
- `h.fetch`: get/set the fetch behind the recorder (replaces `globalThis.fetch = …` and reading
  `globalThis.fetch`). Reset per test.
- `h.logs`: the test's log lines (logfmt, as the app's console logger printed them) — replaces
  `vi.spyOn(console, "log")`. A spy used only to keep the output quiet can simply go.
- `h.setTime(t)`: move the frozen clock (replaces `vi.setSystemTime` in files with a `clock`).
- `h.settle`: an Effect that waits for background work (replaces `await h.settle()`).
- `h.withConfig({ presences: true, geminiApiKey: "k" })(effect)`: what `{ ...env, PRESENCES: true,
  GEMINI_API_KEY: "k" }` did for one call.
- `h.run(effect)`: a Promise of the effect with `h.provide`, rejecting with the failure itself.
  Only for assertions that need a promise (`await expect(h.run(x)).rejects.toThrow("…")`); such a
  test can stay a plain `test(…, async () => …)`.
- `h.runtime`: the test's ManagedRuntime (for forking and interrupting, as before).

## Converting calls

The old functions in `test/old/<module>.ts` show what each call did: usually
`run(env, Service.use((s) => s.method(args)))`. Replace the call with the service call:
`await gn.startNight(env, "a")` → `yield* GameNight.use((g) => g.startNight("a"))` (or take the
service once: `const gn = yield* GameNight`). Watch for:

- **Overrides in the env:** `{ ...env, QUIET: true }` → `withOverrides({ quiet: true })(effect)`;
  `{ ...env, PLAYERS: "x,y" }` → `withOverrides({ players: ["x", "y"] })` (`withOverrides` is in
  `src/config.ts`). `PRESENCES` / `GEMINI_API_KEY` → `h.withConfig`.
- **`.catch(asOld)` in an old function:** it turned typed Discord errors into `new Error(message)`.
  A test that matches the error's text keeps working with the typed error when the text is in its
  `message`; check.
- **`run` squashed failures:** with `yield*`, a failing call fails the test's Effect. Where a test
  expected a rejection, use `h.run` and keep the matcher chain.
- **Callbacks and promise helpers in the test** (`async () => …` passed to old code) become Effects.
- **`await new Promise(setTimeout)` waits** on the live clock become `Effect.sleep` (the frozen
  clock's sleeps are live, so the duration means the same).
- **`vi.useFakeTimers(...)` in a test** (fake setTimeout): those tests need time that moves; use
  `clock: "test"` for that file (or keep the test on the frozen clock if it only faked `Date`).
  Ask if unsure: this is where recordings can move.

## Checking your file

From `C:\p\meme-bot-effect\bot`:

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres npx vitest run test/<file>.test.ts
git diff --stat test/__recordings__/<file>.test.json      # must be empty
node scripts/assertions.mjs --check                        # must say identical (other files' work in progress may show; only yours counts)
npx tsc --noEmit -p tsconfig.test.json 2>&1 | grep "<file>.test" | grep -v warning   # no errors
```

Several sessions run tests at the same time on the same Postgres. A recording that differs only
under load (ids shifted by one, a timing race) is a flake: rerun the file alone before changing
anything. If it differs alone too, the conversion changed behaviour: find out why.

## Report

Per file: converted or not, the checks' results, anything you couldn't keep identical and why,
and anything the harness should offer. Keep the report short.
