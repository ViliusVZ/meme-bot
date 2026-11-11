// 🧠 Google's Gemini, free tier, for the few judgment calls with no clear rule (is this Discord game
// name one of our games? is this Blizzard post about WoW: Forever?). Never for anything the trio
// reads in the bot's voice, and never on a path anyone waits for: the free tier allows 20 requests
// a day, is often slow (minutes) and sometimes down. Every caller has a plain fallback, so `ask`
// answers null on any trouble with Gemini (no key, over budget, timeout, refusal).
import { eq } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Env } from "./env.js";
import { settings } from "./db/index.js";
import { AppConfig } from "./config.js";
import { Db, type DbError } from "./db/db.js";
import { LocalTime } from "./localtime.js";
import { LegacyGeminiKey, run } from "./legacy.js"; // LEGACY-BRIDGE

const MODEL = "gemini-3.8-flash";
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
     * with `decode`, or null when there's no answer to be had right now.
     */
    ask<T>(prompt: string, schema: object, decode: Schema.Decoder<T>): Effect.Effect<T | null, DbError>;
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

      const ask = Effect.fn("Gemini.ask")(function* <T>(prompt: string, schema: object, decode: Schema.Decoder<T>) {
        const legacy = yield* LegacyGeminiKey; // LEGACY-BRIDGE
        const key = legacy === null ? config.geminiApiKey : legacy === undefined ? undefined : Redacted.make(legacy); // LEGACY-BRIDGE
        if (!key) return null;
        // (the budget's database round trip can fail, as it always could: that isn't "no answer")
        if (!(yield* spend)) {
          yield* Effect.logInfo("gemini: daily budget used up");
          return null;
        }
        const req = HttpClientRequest.post(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`).pipe(
          HttpClientRequest.setHeaders({ "Content-Type": "application/json", "x-goog-api-key": Redacted.value(key) }),
          HttpClientRequest.bodyText(
            JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0, thinkingConfig: { thinkingLevel: "low" } },
            }),
            "application/json",
          ),
        );
        const answer = Effect.gen(function* () {
          const res = yield* http.execute(req);
          if (res.status < 200 || res.status >= 300) {
            const text = yield* res.text;
            return yield* new GeminiError({ reason: `${res.status} ${text.slice(0, 200)}` });
          }
          const data = yield* Schema.decodeUnknownEffect(Answer)(yield* res.json);
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) return null;
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(decode))(text);
        }).pipe(Effect.timeout(TIMEOUT));
        // any trouble: no answer (the caller has its plain fallback)
        return yield* answer.pipe(Effect.catch((e) => Effect.as(Effect.logInfo(`gemini: ${"reason" in e ? e.reason : String(e)}`), null)));
      });
      return Gemini.of({ ask });
    }),
  );
}

// the old function, for the code that isn't on Effect yet: any JSON answer, typed by the caller
export const ask = <T>(env: Env, prompt: string, schema: object): Promise<T | null> => // LEGACY-BRIDGE
  run(env, Gemini.use((g) => g.ask(prompt, schema, Schema.Unknown))) as Promise<T | null>; // LEGACY-BRIDGE
