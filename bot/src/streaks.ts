// 🐌 Late answerers: who keeps answering the game-night card only after the bot came looking for
// them (a "⏳ still waiting on you" or a last call), or not at all, and an extra roast for them.
//
// Per card and person, LATE means: chased on that card (chases), or a 👻 in its roast (didn't vote
// in time). Cards from before the bot kept track (TRACKED_FROM) have no chases, so for them a vote
// that came in more than an hour after its step opened (when the "still waiting" ping would have
// gone out) counts instead, or the 👻; see `lateOn`.
//
// Counted over the finished cards (locked in or called off), newest first: the streak (late cards
// in a row) and the window (late cards among the last WINDOW). A reminder counts the card it's on.
// The extra roast goes with someone's first reminder on a card, from the tier their numbers put
// them in (`tierFor`); one slip after answering on time gets none. Answering on time after a streak
// of 2 or more ends it, and the next card says so once (streak_breaks is the key).
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { AppConfig, players } from "./config.js";
import { Db, type DbError } from "./db/db.js";
import { LocalTime } from "./localtime.js";
import { nowSec } from "./clock.js";
import { K, L, Roasts, V } from "./roasts.js";
import { chases, gameNights, gameNightVotes, streakBreaks, type Roast } from "./db/schema.js";

/** The window: how many of the latest cards the "{late} of the last {of}" counts. */
export const WINDOW = 14;
/** From this card on the bot records who it chased; before it, the vote times stand in. */
export const TRACKED_FROM = "2026-11-16";
/** A vote this long after its step opened would have had its "still waiting" ping (= RENUDGE_AFTER). */
const SLOW = 3600;
/** How far back a streak is followed. */
const HISTORY = 60;

// Placeholders: {who} the late one, {n} the streak (cards in a row), {nth} the same as a word
// ("third"), {late} {of} the window ("reminded {late} of the last {of} times").

/** 2–3 cards in a row. */
const TWO = [
  "{who}: {nth} card in a row you needed a reminder. Pradedam pastebėt.",
  "{nth} time running, {who}. Čia jau ne atsitiktinumas, čia tradicija.",
  "{who}, {n} nights straight on the reminder list. Mano cron'as jau žino tavo vardą.",
  "Again, {who}? That's the {nth} card running. Aš tik botas, bet atmintį turiu.",
  "{who} answers game night like an email from HR: eventually, after a reminder. ×{n}",
  "{nth} night in a row I had to come find you, {who}. Slėpynių čempionas 🏆",
  "{who}: {n} in a row. Dar vienas, ir tai jau charakterio bruožas.",
  "Reminder #{n} in a row for {who}. Kolekcionuoji juos ar ką?",
  "{who}, tas mygtukas nekanda. {nth} night running.",
  "Statistika: {who} needed a nudge {late} of the last {of} times. Statistika neguli.",
  "{who} has a {n}-card streak going. Ne tas streak'as, kuriuo giriamasi 🔥",
];
const TWO_OF: Record<string, string[]> = {
  [V]: [
    "{who} built the reminder and is now its most loyal user. {nth} night running.",
    "{who} muted notifications \"just for this deploy\". {nth} card running.",
  ],
  [K]: [
    "{who}, tavo atsakymas vėluoja kaip Venipak siunta. {n} iš eilės 📦",
    "Venipak tracking: {who}'s answer, delayed for the {nth} night running. Nauja pristatymo data: kada nors.",
  ],
  [L]: [
    "{who} is answering after \"just one more episode\". {nth} night running 📺",
    "Pūkis answered on time. {who} didn't, {nth} card running 🐈",
  ],
};

/** 4–6 in a row. */
const FOUR = [
  "{who}: {n} cards running without answering on time. Mes jau nebeklausiam, mes tiesiog laukiam.",
  "{nth} night in a row I'm chasing {who}. Aš jau ne botas, aš tavo sekretorė.",
  "{who} has been reminded {late} of the last {of} times. Tai jau ne vėlavimas, tai gyvenimo būdas.",
  "{n} nights straight, {who}. Pradedu galvoti, kad tu mane ignoruoji. Asmeniškai.",
  "{who}, {nth} night running. Jei būtum serveris, jau seniai būtum restartintas.",
  "Daily reminder for {who}, now in its {nth} straight edition. Prenumeratos atsisakyti negalima.",
  "{who}, {n} in a row. Even the card is starting to take it personally.",
  "{who} treats game night like Terms of Service: scroll, ignore, get reminded. ×{n}",
];
const FOUR_OF: Record<string, string[]> = {
  [V]: [
    "{who}, {n} nights running. You wrote the code that pings you and you STILL ignore it. Įspūdinga.",
    "{who}'s answer is in the backlog, priority: low. {nth} sprint running.",
  ],
  [K]: [
    "{who}: {nth} failed delivery attempt in a row. Siunta grąžinama siuntėjui 📦",
    "{who} is on his {nth} straight \"fap and nap\" before answering. Respect the consistency.",
  ],
  [L]: [
    "{who} answered Pūkis, Netflix and the nail lady first. Us: {nth} night running in the queue 💅",
    "Netflix asks {who} \"Are you still watching?\" and gets an answer. Aš klausiu jau {n} vakarus iš eilės.",
  ],
};

/** 7 or more in a row. */
const SEVEN = [
  "{n} in a row, {who}. Šitas priminimas jau turi savo priminimą.",
  "{who}, {nth} night running. {late} of the last {of}. Gal tiesiog pasakyk, kad mūsų nemyli.",
  "{n}-card streak for {who}. Achievement unlocked 🏆 *Professional Ghost*",
  "{who}, at {n} nights running you're not late, you're a scheduled event.",
  "{nth} straight night of me chasing {who}. Kviečiu policiją, paieškos skelbimas jau rašomas 🚨",
  "{who}: only after a reminder, {late} of the last {of} times. Ieškom naujo trečio. Kandidatų nėra, todėl tu dar čia.",
];
const SEVEN_OF: Record<string, string[]> = {
  [V]: ["{who}, {n} nights running. The bot you built now roasts you on its own. Tai ne bug'as, tai feature."],
  [K]: ["{who}: {nth} undelivered night in a row. Venipak'e už tokį pristatymą jau būtų atleidę 📦"],
  [L]: ["{n} nights running, {who}. Pūkis has started answering for you. Pūkis says yes 🐈"],
};

/** Not a streak, but late at least every other time (over at least 6 cards). */
const HABIT = [
  "{who} needed a reminder {late} of the last {of} times. Ne streak'as, bet ir ne garbė.",
  "{late} of the last {of}, {who}. Bent kas antrą kartą tave reikia vytis.",
  "{who}: reminded {late} of the last {of} times. Consistency is key, and you found the wrong one.",
  "Fun fact: {who} answers on time only when nobody expects it. {late} of the last {of} late.",
  "{who}, {late} reminders in the last {of} cards. Aš jau turiu tau atskirą aplanką 📁",
  "{who} is on time just often enough to make the other {late} of {of} look like an accident. Nėra.",
];
const HABIT_OF: Record<string, string[]> = {
  [V]: ["{who}: {late} of the last {of} cards answered only after a ping. Works on his machine, only when pinged."],
  [K]: ["{who} answers like Venipak delivers: {late} of the last {of} times late, the rest by accident."],
  [L]: ["{who}: late {late} of the last {of} times. Netflix autoplay strikes again 📺"],
};

/** The next card, once, after someone answered on time and ended a streak of {n}. */
const BROKEN = [
  "{who} answered the last card on time. Streak over at {n}. Niekas neplojo.",
  "{who} broke a {n}-card reminder streak. Sveikinu, turbūt.",
  "Last card, {who} answered without a reminder. Streak {n} → 0. Neįprasta. Įtartina.",
  "{who} answered on time, after {n} in a row. Pažymėjau kalendoriuje 📅",
  "{n}-card streak over: {who} was on time. Don't get used to it, we won't.",
  "Credit where it's due: {who} answered on time after {n} late ones. Kreditas mažas, kaip ir pastangos.",
  "{who}'s reminder streak ended at {n}. Mano cron'as net pasiilgo.",
];
const BROKEN_OF: Record<string, string[]> = {
  [V]: ["{who} answered on time, streak of {n} over. Probably just testing the bot."],
  [K]: ["{who} delivered an answer on time. Streak of {n} over. Venipak'ui tai būtų rekordas 📦"],
  [L]: ["{who} answered on time, streak of {n} over. Turbūt Pūkis paspaudė už ją 🐈"],
};

export type Tier = "two" | "four" | "seven" | "habit";
const POOLS: Record<Tier | "broken", { lines: string[]; of: Record<string, string[]> }> = {
  two: { lines: TWO, of: TWO_OF },
  four: { lines: FOUR, of: FOUR_OF },
  seven: { lines: SEVEN, of: SEVEN_OF },
  habit: { lines: HABIT, of: HABIT_OF },
  broken: { lines: BROKEN, of: BROKEN_OF },
};

/** Someone's numbers: the streak (in a row, newest first), and late cards among the last `of`. */
export type Standing = { streak: number; late: number; of: number };

/** Which extra roast, if any: by the streak, or a window at least half late. One slip: none. */
export function tierFor(s: Standing): Tier | null {
  if (s.streak >= 7) return "seven";
  if (s.streak >= 4) return "four";
  if (s.streak >= 2) return "two";
  if (s.of >= 6 && s.late * 2 >= s.of) return "habit";
  return null;
}

/** A finished card, as much of it as the counting needs. */
export type Card = {
  day: string;
  started_by: string | null;
  roast: Roast | null;
  /** Who the bot chased on it (from TRACKED_FROM on). */
  chased: ReadonlyArray<string>;
  votes: ReadonlyArray<{ stage: string; user_id: string; choice: string; voted_at: string }>;
  /** When the daily card goes up that day (unix seconds), for cards before TRACKED_FROM. */
  posted: number;
};

const secOf = (iso: string) => Date.parse(iso) / 1000;

/**
 * Was `p` late on this card? Chased on it, or a 👻 in its roast. Before TRACKED_FROM: a 👻, or a vote
 * more than an hour after its step opened. A step opens: "are we playing?" when the daily card goes
 * up (or with the first answer, on a card started by hand); the game vote with the last answer; the
 * time vote with the last game vote. A "maybe" isn't timed: a 🤔 hold wipes maybes and asks again,
 * so what's left is an answer to that second ask.
 */
export function lateOn(c: Card, p: string): boolean {
  if (c.roast?.who[p] === "ghost") return true;
  if (c.day >= TRACKED_FROM) return c.chased.includes(p);
  const times = (stage: string) => c.votes.filter((v) => v.stage === stage).map((v) => secOf(v.voted_at));
  const ask = times("ask");
  const game = times("game");
  const opened: Record<string, number> = {
    ask: Math.min(c.started_by ? Infinity : c.posted, ...ask),
    ...(ask.length ? { game: Math.max(...ask) } : {}),
    ...(game.length ? { time: Math.max(...game) } : {}),
  };
  return c.votes.some((v) => v.user_id === p && v.choice !== "maybe" && v.stage in opened && secOf(v.voted_at) - opened[v.stage] > SLOW);
}

/** `p`'s numbers over these cards (newest first); `now`: being reminded on the card after them. */
export function standingOf(cards: ReadonlyArray<Card>, p: string, now = false): Standing {
  const seq = [...(now ? [true] : []), ...cards.map((c) => lateOn(c, p))];
  let streak = 0;
  while (streak < seq.length && seq[streak]) streak++;
  const win = seq.slice(0, WINDOW);
  return { streak, late: win.filter(Boolean).length, of: win.length };
}

/** The streak `p` ended by answering the newest of these cards on time (2 or more), else 0. */
export function brokenStreak(cards: ReadonlyArray<Card>, p: string): number {
  if (!cards.length || lateOn(cards[0], p)) return 0;
  let n = 0;
  while (n + 1 < cards.length && lateOn(cards[n + 1], p)) n++;
  return n >= 2 ? n : 0;
}

const WORDS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth"];
/** "third", "21st". */
export function nth(n: number) {
  if (n < WORDS.length) return WORDS[n];
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** Fill in a line's placeholders (a line opening with "{nth}" gets its capital). */
export function fillLate(line: string, who: string, s: Standing) {
  const out = line
    .replaceAll("{who}", `<@${who}>`)
    .replaceAll("{nth}", nth(s.streak))
    .replaceAll("{n}", String(s.streak))
    .replaceAll("{late}", String(s.late))
    .replaceAll("{of}", String(s.of));
  return out[0].toUpperCase() + out.slice(1);
}

export class Streaks extends Context.Service<
  Streaks,
  {
    /** Everyone's numbers over the finished cards before `day` (the standings). */
    standings(day: string): Effect.Effect<Record<string, Standing>, DbError>;
    /** The extra roasts for a reminder on `day`'s card, one per repeat offender not chased on it yet. */
    extras(day: string, who: ReadonlyArray<string>): Effect.Effect<string[], DbError>;
    /** They were just chased on `day`'s card. */
    chased(day: string, who: ReadonlyArray<string>): Effect.Effect<void, DbError>;
    /** A new card for `day`: claims the streaks the card before it broke, once each. */
    claimBreaks(day: string): Effect.Effect<void, DbError>;
    /** The "streak over" lines `day`'s card shows. */
    breaksOn(day: string): Effect.Effect<string[], DbError>;
  }
>()("meme-bot/streaks") {
  static readonly layer = Layer.effect(
    Streaks,
    Effect.gen(function* () {
      const db = yield* Db;
      const roasts = yield* Roasts;
      const time = yield* LocalTime;
      const theTrio = Effect.provideService(players, AppConfig, yield* AppConfig);

      /** The finished cards before `day`, newest first. */
      const history = Effect.fnUntraced(function* (day: string) {
        const nights = yield* db
          .select({ day: gameNights.day, started_by: gameNights.started_by, roast: gameNights.roast })
          .from(gameNights)
          .where(and(lt(gameNights.day, day), inArray(gameNights.stage, ["set", "off"])))
          .orderBy(desc(gameNights.day))
          .limit(HISTORY);
        if (!nights.length) return [];
        const days = nights.map((n) => n.day);
        const votes = yield* db.select().from(gameNightVotes).where(inArray(gameNightVotes.day, days));
        const chasedOn = yield* db.select({ day: chases.day, user_id: chases.user_id }).from(chases).where(inArray(chases.day, days));
        return nights.map((n): Card => {
          const [y, m, d] = n.day.split("-").map(Number);
          return {
            ...n,
            votes: votes.filter((v) => v.day === n.day),
            chased: chasedOn.filter((c) => c.day === n.day).map((c) => c.user_id),
            posted: time.wallToUnix(y, m, d, time.pollHour(n.day), 0),
          };
        });
      });

      /** A line from a tier's shared bag (roasts.draw: no repeats until the tier's had its turn). */
      const lineFor = (tier: Tier | "broken", who: string) => {
        const pool = POOLS[tier];
        return roasts.draw(`late:${tier}`, [...pool.lines, ...Object.values(pool.of).flat()], [...pool.lines, ...(pool.of[who] ?? [])]);
      };

      return Streaks.of({
        standings: Effect.fn("Streaks.standings")(function* (day: string) {
          const cards = yield* history(day);
          return Object.fromEntries((yield* theTrio).map((p) => [p, standingOf(cards, p)]));
        }),
        extras: Effect.fn("Streaks.extras")(function* (day: string, who: ReadonlyArray<string>) {
          if (!who.length) return [];
          const already = yield* db.select({ user_id: chases.user_id }).from(chases).where(and(eq(chases.day, day), inArray(chases.user_id, [...who])));
          const fresh = who.filter((p) => !already.some((a) => a.user_id === p));
          if (!fresh.length) return [];
          const cards = yield* history(day);
          const out: string[] = [];
          for (const p of fresh) {
            const s = standingOf(cards, p, true);
            const tier = tierFor(s);
            if (tier) out.push(fillLate(yield* lineFor(tier, p), p, s));
          }
          return out;
        }),
        chased: Effect.fn("Streaks.chased")(function* (day: string, who: ReadonlyArray<string>) {
          if (!who.length) return;
          const at = yield* nowSec;
          yield* db
            .insert(chases)
            .values(who.map((user_id) => ({ day, user_id, at })))
            .onConflictDoNothing();
        }),
        claimBreaks: Effect.fn("Streaks.claimBreaks")(function* (day: string) {
          const cards = yield* history(day);
          for (const p of yield* theTrio) {
            const n = brokenStreak(cards, p);
            if (!n) continue;
            const key = and(eq(streakBreaks.user_id, p), eq(streakBreaks.broken_on, cards[0].day));
            if ((yield* db.select({ user_id: streakBreaks.user_id }).from(streakBreaks).where(key)).length) continue; // said already
            const line = fillLate(yield* lineFor("broken", p), p, { streak: n, late: 0, of: 0 });
            yield* db.insert(streakBreaks).values({ user_id: p, broken_on: cards[0].day, card_day: day, streak: n, line }).onConflictDoNothing();
          }
        }),
        breaksOn: Effect.fn("Streaks.breaksOn")(function* (day: string) {
          const rows = yield* db.select({ line: streakBreaks.line }).from(streakBreaks).where(eq(streakBreaks.card_day, day)).orderBy(streakBreaks.user_id);
          return rows.map((r) => r.line);
        }),
      });
    }),
  );
}

export const _latePools = POOLS;
