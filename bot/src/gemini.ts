// 🧠 Google's Gemini, free tier, for the few calls with no clear rule (is this Discord game name one
// of our games?) and the WoW news's triage and write-ups (news.ts, plan 06). Never on a path anyone
// waits for: the free tier is often slow (minutes) and sometimes down. Every caller copes without an
// answer, so `ask` answers null on any trouble with Gemini (no key, over budget, timeout, refusal,
// an answer that doesn't fit the schema).
//
// The free tier's limit is per model, per project, per day (about 20 requests a day each, the day
// being Google's: it starts at midnight Pacific time). So the budget is counted per model: every
// request that goes out counts against its model's day (a 503 or a timeout too: Google counts what
// reaches it), at most PER_MODEL_DAILY each, counted across every use on this bot. Game-name
// matching asks its model first; the news has its own model lists (config) and leaves NAMES_KEEP of
// each model game names use, so game names always have requests left.
import { inArray } from "drizzle-orm";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { settings } from "./db/schema.js";
import { AppConfig } from "./config.js";
import { Db, type DbError } from "./db/db.js";
import { localAt } from "./localtime.js";
import { jsonText } from "./json.js";

/** What game-name matching asks. */
export const NAMES_MODEL = "gemini-3.8-flash";
/** The models game names have room kept on: their own, and the one the news shares with them. */
export const NAMES_MODELS: ReadonlyArray<string> = ["gemini-3.8-flash", "gemini-3.5-flash"];
/** Every model's requests a day, of the free tier's 20 (so a stray retry can't use them all). */
export const PER_MODEL_DAILY = 18;
/** On NAMES_MODELS, the news stops this many short of PER_MODEL_DAILY: game names keep them. */
export const NAMES_KEEP = 5;
/** Google's day, by which the free tier's daily limits reset. */
const QUOTA_ZONE = "America/Los_Angeles";
const TIMEOUT = Duration.minutes(5); // a thinking model can take minutes; nothing waits on this
/** A model's count for the day: game names' model keeps the key the one shared budget always had. */
export const budgetKey = (model: string) => (model === NAMES_MODEL ? "gemini_budget" : `gemini_budget:${model}`);

/** Whose requests: game names' (undefined) or the news's, which leaves game names their room. */
export type Use = "news";
/** A news request may not leave the news fewer than `requests` on `models` today (the backtest keeps the live runs theirs). */
export type Keep = { readonly models: ReadonlyArray<string>; readonly requests: number };
export type AskOptions = {
  /** Tried in turn while one is busy or failing; each request counts against its own model. */
  readonly models?: ReadonlyArray<string>;
  readonly use?: Use;
  readonly keep?: ReadonlyArray<Keep>;
  /** At most this many requests for this question. */
  readonly limit?: number;
};
/** One request that went out, and how it went. */
export type Attempt = { readonly model: string; readonly outcome: "answered" | "malformed" | "failed" };
/**
 * What came of a question: the answer (null: none), whether a model answered something that didn't
 * fit the schema (asked no further: it's the question, not the model), every request made, and
 * whether a model was passed over for the budget (or the limit).
 */
export type Asked<T> = { readonly answer: T | null; readonly malformed: boolean; readonly attempts: ReadonlyArray<Attempt>; readonly refused: boolean };

/** Why there's no answer (logged; the caller only sees null). */
export class GeminiError extends Schema.TaggedError<GeminiError>()("GeminiError", { reason: Schema.String, malformed: Schema.optional(Schema.Boolean) }) {}

const Answer = Schema.Struct({
  candidates: Schema.optional(Schema.Array(Schema.Struct({ content: Schema.optional(Schema.Struct({ parts: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))) })) }))),
});
const Budget = Schema.Struct({ day: Schema.String, used: Schema.Number });

/** The most `use` may have used on `model` today. */
export const capOf = (model: string, use?: Use) => (use === "news" && NAMES_MODELS.includes(model) ? PER_MODEL_DAILY - NAMES_KEEP : PER_MODEL_DAILY);
/** What the news may still make on these models, given today's counts. */
const newsRoom = (models: ReadonlyArray<string>, used: Readonly<Record<string, number>>) => [...new Set(models)].reduce((n, m) => n + Math.max(0, capOf(m, "news") - (used[m] ?? 0)), 0);
/** Whether one more request on `model` stays within its day and every keep. */
const allowed = (model: string, used: Readonly<Record<string, number>>, use: Use | undefined, keep: ReadonlyArray<Keep>) => {
  if ((used[model] ?? 0) >= capOf(model, use)) return false;
  const after = { ...used, [model]: (used[model] ?? 0) + 1 };
  return keep.every((k) => !k.models.includes(model) || newsRoom(k.models, after) >= k.requests);
};

export class Gemini extends Context.Service<
  Gemini,
  {
    /**
     * One question with a JSON answer in the shape of `schema` (Gemini's OpenAPI subset), decoded
     * with `decode`, or null when there's no answer to be had right now. Game names' model unless
     * `options.models` says otherwise.
     */
    ask<T>(prompt: string, schema: object, decode: Schema.Decoder<T>, options?: AskOptions): Effect.Effect<T | null, DbError>;
    /** The same, with what came of it (the news: which models answered, what was spent). */
    request<T>(prompt: string, schema: object, decode: Schema.Decoder<T>, options?: AskOptions): Effect.Effect<Asked<T>, DbError>;
    /** How many requests `use` could still make on these models today, one after another, within every keep. */
    left(models: ReadonlyArray<string>, use?: Use, keep?: ReadonlyArray<Keep>): Effect.Effect<number, DbError>;
  }
>()("meme-bot/gemini") {
  static readonly layer = Layer.effect(
    Gemini,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const http = yield* HttpClient.HttpClient;

      const today = Effect.map(Clock.currentTimeMillis, (ms) => localAt(QUOTA_ZONE, ms).day);
      /** Today's requests so far on each of these models, from the database so restarts don't reset them. */
      const usedToday = Effect.fnUntraced(function* (models: ReadonlyArray<string>) {
        const day = yield* today;
        const all = [...new Set(models)];
        const rows = all.length ? yield* db.select().from(settings).where(inArray(settings.key, all.map(budgetKey))) : [];
        const used: Record<string, number> = {};
        for (const m of all) {
          const b = Option.getOrUndefined(Schema.decodeUnknownOption(Budget)(rows.find((r) => r.key === budgetKey(m))?.value));
          used[m] = b?.day === day ? b.used : 0;
        }
        return { day, used };
      });
      const count = Effect.fnUntraced(function* (model: string, day: string, used: number) {
        const at = DateTime.toDate(yield* DateTime.now);
        const key = budgetKey(model);
        yield* db
          .insert(settings)
          .values({ key, value: { day, used } })
          .onConflictDoUpdate({ target: settings.key, set: { value: { day, used }, updated_at: at } });
      });

      const left = Effect.fn("Gemini.left")(function* (models: ReadonlyArray<string>, use?: Use, keep: ReadonlyArray<Keep> = []) {
        const { used } = yield* usedToday([...models, ...keep.flatMap((k) => k.models)]);
        const now = { ...used };
        let n = 0;
        for (let m = models.find((x) => allowed(x, now, use, keep)); m !== undefined && n < 1000; m = models.find((x) => allowed(x, now, use, keep))) {
          now[m] = (now[m] ?? 0) + 1;
          n++;
        }
        return n;
      });

      const request = Effect.fn("Gemini.request")(function* <T>(prompt: string, schema: object, decode: Schema.Decoder<T>, options: AskOptions = {}) {
        const models = options.models ?? [NAMES_MODEL];
        const keep = options.keep ?? [];
        const key = config.geminiApiKey;
        const attempts: Attempt[] = [];
        let refused = false;
        if (!key) return { answer: null, malformed: false, attempts, refused } as Asked<T>;
        const req = (model: string) => HttpClientRequest.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`).pipe(
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
          const res = yield* http.execute(req(model));
          if (res.status < 200 || res.status >= 300) {
            const text = yield* res.text;
            return yield* new GeminiError({ reason: `${res.status} ${text.slice(0, 200)}` });
          }
          const data = yield* Schema.decodeUnknownEffect(Answer)(yield* res.json);
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) return yield* new GeminiError({ reason: "an empty answer", malformed: true });
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(decode))(text).pipe(Effect.mapError((e) => new GeminiError({ reason: `an answer off the schema: ${String(e).slice(0, 200)}`, malformed: true })));
        }).pipe(Effect.timeout(TIMEOUT));
        for (const model of models) {
          if (options.limit !== undefined && attempts.length >= options.limit) {
            refused = true;
            break;
          }
          // (the budget's database round trip can fail, as it always could: that isn't "no answer")
          const { day, used } = yield* usedToday([model, ...keep.flatMap((k) => k.models)]);
          if (!allowed(model, used, options.use, keep)) {
            refused = true;
            continue;
          }
          yield* count(model, day, (used[model] ?? 0) + 1);
          // any trouble: the next model, then no answer (the caller has its plain fallback)
          const got = yield* answer(model).pipe(
            Effect.map((a) => ({ a })),
            Effect.catch((e) =>
              Effect.as(Effect.logInfo(`gemini: ${models.length > 1 ? `${model} ` : ""}${"reason" in e ? e.reason : String(e)}`), { malformed: e._tag === "GeminiError" && e.malformed === true }),
            ),
          );
          if ("a" in got) {
            attempts.push({ model, outcome: "answered" });
            return { answer: got.a, malformed: false, attempts, refused } as Asked<T>;
          }
          attempts.push({ model, outcome: got.malformed ? "malformed" : "failed" });
          // a model that answered off the schema was asked too much at once: no other is asked it
          if (got.malformed) return { answer: null, malformed: true, attempts, refused } as Asked<T>;
        }
        if (refused && !attempts.length) yield* Effect.logInfo(`gemini: today's budget for ${models.join(", ")} is used up${options.use ? ` (the ${options.use}'s part)` : ""}`);
        return { answer: null, malformed: false, attempts, refused } as Asked<T>;
      });

      const ask = <T>(prompt: string, schema: object, decode: Schema.Decoder<T>, options?: AskOptions) => Effect.map(request(prompt, schema, decode, options), (r) => r.answer);
      return Gemini.of({ ask, request, left });
    }),
  );
}
