// The time, from Effect's Clock (so tests set it with TestClock): the one place the many old
// `nowSec()` helpers and memes.ts `now()` became.
import { Clock, DateTime, Effect } from "effect";

/** Unix seconds. */
export const nowSec = Effect.map(Clock.currentTimeMillis, (ms) => Math.floor(ms / 1000));

/** The ISO timestamp stored in text columns (posted_at, voted_at, added_at…): `2026-11-06T15:00:00.000Z`. */
export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
