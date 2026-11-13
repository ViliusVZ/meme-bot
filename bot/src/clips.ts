// 🔊 The clip cache (plan 03): every span the bot has spoken, as audio, in Postgres (voice_clips),
// keyed by a hash of the voice and the text. A line said once plays forever after, even if the
// speech engine is gone; only new text needs it. The filesystem is read-only, so not on disk.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { voiceClips } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { Tts, type TtsUnavailable } from "./tts.js";
import type { Span } from "./lines.js";
import { nowSec } from "./clock.js";

export const clipKey = (s: Span) => createHash("sha256").update(`${s.voice}\n${s.text}`).digest("hex");

export class Clips extends Context.Service<
  Clips,
  {
    /** The span's audio: from the cache, or made now (and kept). */
    get(span: Span): Effect.Effect<Uint8Array, DbError | TtsUnavailable>;
    /** Only what's already made (null: not in the cache). */
    cached(span: Span): Effect.Effect<Uint8Array | null, DbError>;
  }
>()("meme-bot/clips") {
  static readonly layer = Layer.effect(
    Clips,
    Effect.gen(function* () {
      const db = yield* Db;
      const tts = yield* Tts;
      const cached = Effect.fn("Clips.cached")(function* (span: Span) {
        const [row] = yield* db.select({ audio: voiceClips.audio }).from(voiceClips).where(eq(voiceClips.key, clipKey(span)));
        return row ? new Uint8Array(row.audio) : null;
      });
      return Clips.of({
        cached,
        get: Effect.fn("Clips.get")(function* (span: Span) {
          const hit = yield* cached(span);
          if (hit) return hit;
          const { audio, engine } = yield* tts.synth(span.text, span.voice);
          yield* db
            .insert(voiceClips)
            .values({ key: clipKey(span), voice: span.voice, text: span.text, audio: Buffer.from(audio), engine, created_at: yield* nowSec })
            .onConflictDoNothing();
          return audio;
        }),
      });
    }),
  );
}
