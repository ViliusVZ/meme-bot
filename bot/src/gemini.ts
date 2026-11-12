// 🧠 Google's Gemini, free tier, for the few judgment calls with no clear rule (is this Discord game
// name one of our games? is this Blizzard post about WoW: Forever?). Never for anything the trio
// reads in the bot's voice, and never on a path anyone waits for: the free tier allows 20 requests
// a day, is often slow (minutes) and sometimes down. Every caller has a plain fallback, so `ask`
// answers null on any trouble with Gemini (no key, over budget, timeout, refusal).
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
const TIMEOUT = Duration.minutes(5); // a thinking model can take minutes; nothing waits on this
const KEY = "gemini_budget";

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
    ask<T>(prompt: string, schema: object, decode: Schema.Decoder<T>, models?: ReadonlyArray<string>): Effect.Effect<T | null, DbError>;
  }
>()("meme-bot/gemini") {
  static readonly layer = Layer.effect(
    Gemini,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const time = yield* LocalTime;
      const http = yield* HttpClient.HttpClient;

      /** Today's requests so far (Vilnius day), from the database so restarts don't reset it. */
      const spend = Effect.gen(function* () {
        const day = (yield* time.now).day;
        const [row] = yield* db.select().from(settings).where(eq(settings.key, KEY));
        const b = Option.getOrUndefined(Schema.decodeUnknownOption(Budget)(row?.value));
        const used = b?.day === day ? b.used : 0;
        if (used >= DAILY) return false;
        const at = DateTime.toDate(yield* DateTime.now);
        yield* db
          .insert(settings)
          .values({ key: KEY, value: { day, used: used + 1 } })
          .onConflictDoUpdate({ target: settings.key, set: { value: { day, used: used + 1 }, updated_at: at } });
        return true;
      });

      const ask = Effect.fn("Gemini.ask")(function* <T>(prompt: string, schema: object, decode: Schema.Decoder<T>, models: ReadonlyArray<string> = [MODEL]) {
        const key = config.geminiApiKey;
        if (!key) return null;
        // (the budget's database round trip can fail, as it always could: that isn't "no answer")
        if (!(yield* spend)) {
          yield* Effect.logInfo("gemini: daily budget used up");
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
      return Gemini.of({ ask });
    }),
  );
}
