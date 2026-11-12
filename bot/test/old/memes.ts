// The old functions of src/memes.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/memes.js";
import { run, runSync } from "./legacy.js";
import { Incoming, Memes, VoteKind, utcDayNow, type StreakRow } from "../../src/memes.js";
import type { Env } from "./env.js";
import { nowIso } from "../../src/clock.js";

// the old functions, for the code that isn't on Effect yet
export const now = () => runSync(nowIso);
export const utcDay = (offsetDays = 0) => runSync(utcDayNow(offsetDays));
export const ingest = (env: Env, incoming: Incoming[]) => run(env, Memes.use((m) => m.ingest(incoming)));
export const getMeme = (env: Env, id: string) => run(env, Memes.use((m) => m.get(id)));
export const tally = (env: Env, memeId: string) => run(env, Memes.use((m) => m.tally(memeId)));
export const voters = (env: Env, memeId: string) => run(env, Memes.use((m) => m.voters(memeId)));
export const claim = (env: Env, id: string, kind: "daily" | "request", extra: { day?: string; requestedBy?: string }) => run(env, Memes.use((m) => m.claim(id, kind, extra)));
export const unclaim = (env: Env, id: string) => run(env, Memes.use((m) => m.unclaim(id)));
export const setMessage = (env: Env, id: string, channelId: string, messageId: string) => run(env, Memes.use((m) => m.setMessage(id, channelId, messageId)));
export const castVote = (env: Env, memeId: string, userId: string, kind: VoteKind) => run(env, Memes.use((m) => m.castVote(memeId, userId, kind)));
export const bumpStreak = (env: Env, userId: string, name: string) => run(env, Memes.use((m) => m.bumpStreak(userId, name)));
export const liveStreak = (u: Pick<StreakRow, "streak" | "last_vote_day"> | null) => runSync(Memes.use((m) => m.liveStreak(u)));
export const leaderboard = (env: Env, sinceIso: string | null, untilIso: string | null, limit: number) => run(env, Memes.use((m) => m.leaderboard(sinceIso, untilIso, limit)));
export const topVoter = (env: Env, sinceIso: string, untilIso: string) => run(env, Memes.use((m) => m.topVoter(sinceIso, untilIso)));
export const longestLiveStreak = (env: Env) => run(env, Memes.use((m) => m.longestLiveStreak));
export const userStats = (env: Env, userId: string) => run(env, Memes.use((m) => m.userStats(userId)));
export const claimRecap = (env: Env, period: string) => run(env, Memes.use((m) => m.claimRecap(period)));
export const unclaimRecap = (env: Env, period: string) => run(env, Memes.use((m) => m.unclaimRecap(period)));
