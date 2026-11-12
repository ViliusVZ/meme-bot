// 🧠 Google's Gemini, free tier, for the few calls with no clear rule (is this Discord game name one
// of our games?) and the WoW news's triage and write-ups (news.ts, plan 06). Never on a path anyone
// waits for: the free tier allows 20 requests a day, is often slow (minutes) and sometimes down.
// Every caller copes without an answer, so `ask` answers null on any trouble with Gemini (no key,
// over budget, timeout, refusal, an answer that doesn't fit the schema).
import { eq } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { settings } from "./db/schema.js";
import { AppConfig } from "./config.js";
import { Db, type DbError } from "./db/db.js";
import { LocalTime } from "./localtime.js";
import { jsonText } from "./json.js";

const MODEL = "gemini-3.8-flash";
/** The fast one first; when it's busy (the free tier often is), the newer, slower one (news.ts). */
export const FAST_THEN_NEWER = ["gemini-3.5-flash", "gemini-3.8-flash"] as const;
export const DAILY = 15; // of the free tier's 20 a day, so a stray retry can't use them all
/**
 * The news's share of DAILY (its triage and write-ups, live and backtest alike): at most this many
 * a day, so game-name matching always keeps DAILY - NEWS_SHARE (5) for itself.
 */
export const NEWS_SHARE = 10;
const TIMEOUT = Duration.minutes(5); // a thinking model can take minutes; nothing waits on this
const KEY = "gemini_budget";
const NEWS_KEY = "gemini_budget_news"; // the news's own count, the same shape (it counts in KEY too)

/** Whose budget a call comes out of: everyone's (DAILY), or the news's share of it as well. */
export type Share = "news";

/** Why there's no answer (logged; the caller only sees null). */
export class GeminiError extends Schema.TaggedError<GeminiError>()("GeminiError", { reason: Schema.String }) {}

const Answer = Schema.Struct({
  candidates: Schema.optional(Schema.Array(Schema.Struct({ content: Schema.optional(Schema.Struct({ parts: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))) })) }))),
});
const Budget = Schema.Struct({ day: Schema.String, used: Schema.Number });

export class Gemini extends Context.Service<
  Gemini,
  {
    /**
     * One question with a JSON answer in the shape of `schema` (Gemini's OpenAPI subset), decoded
     * with `decode`, or null when there's no answer to be had right now. `models` are tried in turn
     * while one is busy or failing (one request of the day's budget either way).
     */
    ask<T>(prompt: string, schema: object, decode: Schema.Decoder<T>, models?: ReadonlyArray<string>, share?: Share): Effect.Effect<T | null, DbError>;
    /** How many requests are left today: everyone's, or (with a share) what that share may still use. */
    left(share?: Share): Effect.Effect<number, DbError>;
  }
>()("meme-bot/gemini") {
  static readonly layer = Layer.effect(
    Gemini,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const time = yield* LocalTime;
      const http = yield* HttpClient.HttpClient;

      /** Today's requests so far under `key` (Vilnius day), from the database so restarts don't reset it. */
      const usedToday = Effect.fnUntraced(function* (key: string) {
        const day = (yield* time.now).day;
        const [row] = yield* db.select().from(settings).where(eq(settings.key, key));
        const b = Option.getOrUndefined(Schema.decodeUnknownOption(Budget)(row?.value));
        return { day, used: b?.day === day ? b.used : 0 };
      });
      const count = Effect.fnUntraced(function* (key: string, day: string, used: number) {
        const at = DateTime.toDate(yield* DateTime.now);
        yield* db
          .insert(settings)
          .values({ key, value: { day, used } })
          .onConflictDoUpdate({ target: settings.key, set: { value: { day, used }, updated_at: at } });
      });

      const left = Effect.fn("Gemini.left")(function* (share?: Share) {
        const all = DAILY - (yield* usedToday(KEY)).used;
        if (!share) return Math.max(0, all);
        return Math.max(0, Math.min(all, NEWS_SHARE - (yield* usedToday(NEWS_KEY)).used));
      });

      /** One request of today's budget (and of the share's), if there's one left. */
      const spend = Effect.fnUntraced(function* (share?: Share) {
        const { day, used } = yield* usedToday(KEY);
        if (used >= DAILY) return false;
        if (share) {
          const mine = yield* usedToday(NEWS_KEY);
          if (mine.used >= NEWS_SHARE) return false;
          yield* count(NEWS_KEY, mine.day, mine.used + 1);
        }
        yield* count(KEY, day, used + 1);
        return true;
      });

      const ask = Effect.fn("Gemini.ask")(function* <T>(prompt: string, schema: object, decode: Schema.Decoder<T>, models: ReadonlyArray<string> = [MODEL], share?: Share) {
        const key = config.geminiApiKey;
        if (!key) return null;
        // (the budget's database round trip can fail, as it always could: that isn't "no answer")
        if (!(yield* spend(share))) {
          yield* Effect.logInfo(share ? `gemini: the ${share}'s share of today's budget used up` : "gemini: daily budget used up");
          return null;
        }
        const request = (model: string) => HttpClientRequest.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`).pipe(
          HttpClientRequest.setHeaders({ "Content-Type": "application/json", "x-goog-api-key": Redacted.value(key) }),
          HttpClientRequest.bodyText(
            jsonText({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0, thinkingConfig: { thinkingLevel: "low" } },
            }),
            "application/json",
          ),
        );
        const answer = (model: string) => Effect.gen(function* () {
          const res = yield* http.execute(request(model));
          if (res.status < 200 || res.status >= 300) {
            const text = yield* res.text;
            return yield* new GeminiError({ reason: `${res.status} ${text.slice(0, 200)}` });
          }
          const data = yield* Schema.decodeUnknownEffect(Answer)(yield* res.json);
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) return null;
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(decode))(text);
        }).pipe(Effect.timeout(TIMEOUT));
        // any trouble: the next model, then no answer (the caller has its plain fallback)
        for (const model of models) {
          const got = yield* answer(model).pipe(
            Effect.map((a) => ({ a })),
            Effect.catch((e) => Effect.as(Effect.logInfo(`gemini: ${models.length > 1 ? `${model} ` : ""}${"reason" in e ? e.reason : String(e)}`), undefined)),
          );
          if (got) return got.a;
        }
        return null;
      });
      return Gemini.of({ ask, left });
    }),
  );
}
