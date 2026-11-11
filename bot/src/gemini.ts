// 🧠 Google's Gemini, free tier, for the few judgment calls with no clear rule (is this Discord game
// name one of our games? is this Blizzard post about WoW: Forever?). Never for anything the trio
// reads in the bot's voice, and never on a path anyone waits for: the free tier allows 20 requests
// a day, is often slow (minutes) and sometimes down. Every caller has a plain fallback, so `ask`
// answers null on any trouble (no key, over budget, timeout, refusal) and never throws.
import { eq } from "drizzle-orm";
import type { Env } from "./env.js";
import { settings } from "./db/index.js";
import { local } from "./gamenight.js";

// the fast one first; when it's busy (the free tier often is), the newer, slower one
const MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"];
export const DAILY = 15; // of the free tier's 20 a day, so a stray retry can't use them all
const TIMEOUT = 280_000; // a thinking model can take minutes (and Node's fetch gives up at 300 s anyway)
const KEY = "gemini_budget";

/** Today's requests so far (Vilnius day), from the database so restarts don't reset it. */
async function spend(env: Env) {
  const day = local(env).day;
  const [row] = await env.db.select().from(settings).where(eq(settings.key, KEY));
  const b = row?.value as { day: string; used: number } | undefined;
  const used = b?.day === day ? b.used : 0;
  if (used >= DAILY) return false;
  await env.db
    .insert(settings)
    .values({ key: KEY, value: { day, used: used + 1 } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { day, used: used + 1 }, updated_at: new Date() } });
  return true;
}

/**
 * One question with a JSON answer in the shape of `schema` (Gemini's OpenAPI subset), or null when
 * there's no answer to be had right now.
 */
export async function ask<T>(env: Env, prompt: string, schema: object): Promise<T | null> {
  if (!env.GEMINI_API_KEY) return null;
  if (!(await spend(env))) {
    console.log("gemini: daily budget used up");
    return null;
  }
  for (const model of MODELS) {
    const answer = await once<T>(env.GEMINI_API_KEY, model, prompt, schema);
    if (answer !== undefined) return answer;
  }
  return null;
}

/** One model's answer; undefined when it's busy or failed (try the next), null when it said nothing usable. */
async function once<T>(key: string, model: string, prompt: string, schema: object): Promise<T | null | undefined> {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0, thinkingConfig: { thinkingLevel: "low" } },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) {
      console.log("gemini:", model, r.status, (await r.text()).slice(0, 200));
      return undefined;
    }
    const data = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? (JSON.parse(text) as T) : null;
  } catch (e) {
    console.log("gemini:", model, String(e));
    return undefined;
  }
}
