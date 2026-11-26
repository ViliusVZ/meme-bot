// 🗣️ Speech synthesis for the bot's voice (plan 03). Microsoft's neural voices through the Edge
// read-aloud endpoint, the protocol the `edge-tts` Python package speaks: one WebSocket per line, a
// config message and the SSML out, the audio back in binary frames until `turn.end`. No account and
// no key, but unofficial: it can change or vanish without notice, so every failure is one typed
// error (TtsUnavailable) and the clip cache (clips.ts) keeps every line already spoken.
//
// The audio is WebM Opus (`webm-24khz-16bit-mono-opus`, the only Opus format the endpoint serves:
// its Ogg formats close the socket with 1007): 20 ms mono frames, which @discordjs/voice's WebM
// demuxer passes straight to Discord (an Opus decoder plays at 48 kHz whatever the input rate, and a
// mono frame is valid in Discord's stereo stream). Measured 2026-11-13: one line in 1 to 4 s.
//
// Which voice says what is voices.ts's business (every span is cast at random since 26 Nov); a span
// can carry Edge prosody (rate, pitch, volume), and a span in a `gemini:<Name>` voice goes to Gemini
// with its style direction.
//
// Gemini (`gemini-3.8-flash-tts`) on the GEMINI_API_KEY, at most 20 lines a day (its own budget in
// `settings`): the spare engine when Edge doesn't answer (voice Charon), and the voice of lines with a
// Gemini direction. It gives back PCM, encoded here to Ogg Opus (opusogg.ts).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Socket } from "effect/socket";
import { CHROMIUM_FULL_VERSION, SEC_MS_GEC_VERSION, TRUSTED_CLIENT_TOKEN, secMsGec } from "./edgetoken.js";
import { AppConfig } from "./config.js";
import { Db } from "./db/db.js";
import { settings } from "./db/schema.js";
import { encodeOggOpus, pcmOf } from "./opusogg.js";
import { jsonText } from "./json.js";

export const EN_VOICE = "en-US-BrianMultilingualNeural";
export const LT_VOICE = "lt-LT-LeonasNeural";
export const FORMAT = "webm-24khz-16bit-mono-opus";
const WSS = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const MAJOR = CHROMIUM_FULL_VERSION.split(".")[0];
const SYNTH_TIMEOUT = Duration.seconds(15); // a line takes 1-4 s; the caller's own deadline is usually shorter
const OPEN_TIMEOUT = Duration.seconds(5);
export const GEMINI_TTS = "gemini-3.8-flash-tts";
export const GEMINI_VOICE = "Charon";
export const GEMINI_DAILY = 20; // lines a day through Gemini, at most (Edge is the engine; this is the spare)
const GEMINI_TIMEOUT = Duration.seconds(15); // a line took 2-3 s in Step 0
export const GEMINI_MAX_SECONDS = 13; // longer than that, a Gemini reading isn't kept (Edge reads the line)
const BUDGET = "gemini_tts_budget";
const Budget = Schema.Struct({ day: Schema.String, used: Schema.Number });
const Spoken = Schema.Struct({
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(Schema.Struct({ parts: Schema.optional(Schema.Array(Schema.Struct({ inlineData: Schema.optional(Schema.Struct({ mimeType: Schema.String, data: Schema.String })) }))) })),
      }),
    ),
  ),
});

/** A span's audio, and which engine made it. */
export type Speech = { readonly audio: Uint8Array; readonly engine: "edge" | "gemini" };

/** The speech engine didn't give us audio (unreachable, refused, changed its protocol, timed out). */
export class TtsUnavailable extends Schema.TaggedError<TtsUnavailable>()("TtsUnavailable", { engine: Schema.String, detail: Schema.String }) {
  override get message() {
    return `${this.engine}: ${this.detail}`;
  }
}

const id = () => randomUUID().replaceAll("-", "");

/** The text as SSML content: XML's five specials escaped, and the control characters the service refuses blanked. */
export const escapeXml = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** Edge's prosody: rate and volume in percent, pitch in Hz, all relative to the voice's own. */
export type Prosody = { readonly rate?: number; readonly pitch?: number; readonly volume?: number };
const signed = (n: number | undefined, unit: string) => `${(n ?? 0) >= 0 ? "+" : ""}${Math.round(n ?? 0)}${unit}`;

/** The two messages a synthesis sends: the audio format, then the line. */
export function edgeRequest(text: string, voice: string, date: string, requestId: string, prosody: Prosody = {}) {
  return [
    `X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${FORMAT}"}}}}\r\n`,
    `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n` +
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='${signed(prosody.pitch, "Hz")}' rate='${signed(prosody.rate, "%")}' volume='${signed(prosody.volume, "%")}'>${escapeXml(text)}</prosody></voice></speak>`,
  ] as const;
}

/** The endpoint's URL for a moment (unix ms): the token is the 5-minute window's. */
export const edgeUrl = (ms: number, connectionId: string) =>
  `${WSS}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectionId}&Sec-MS-GEC=${secMsGec(ms / 1000)}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

export const EDGE_HEADERS: Readonly<Record<string, string>> = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
};

const headerOf = (head: string, name: string) =>
  head
    .split("\r\n")
    .map((l) => l.split(":"))
    .find(([k]) => k === name)?.[1];

/** One frame of the answer: the `Path` it's on, and its audio if it carries some. */
export function parseFrame(frame: Uint8Array | string): { path: string | undefined; audio?: Uint8Array } {
  if (typeof frame === "string") return { path: headerOf(frame.slice(0, frame.indexOf("\r\n\r\n")), "Path") };
  if (frame.length < 2) return { path: undefined };
  const length = (frame[0] << 8) | frame[1];
  const head = new TextDecoder().decode(frame.subarray(2, 2 + length));
  const path = headerOf(head, "Path");
  // the stream ends with an audio frame that has no Content-Type and no data
  return path === "audio" && headerOf(head, "Content-Type") ? { path, audio: frame.subarray(2 + length) } : { path };
}

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export class Tts extends Context.Service<
  Tts,
  {
    /**
     * One span of a line in one voice: WebM Opus from Edge, or (Edge failing, `spare` not false) Ogg
     * Opus from Gemini. Clips made ahead pass `spare: false`: Gemini's few lines a day are for speech
     * that's due now, and for the `gemini:<Name>` voices (always Gemini, with `style`, never a spare).
     */
    synth(
      text: string,
      voice: string,
      options?: { readonly spare?: boolean; readonly prosody?: Prosody; readonly style?: string },
    ): Effect.Effect<Speech, TtsUnavailable>;
  }
>()("meme-bot/tts") {
  static readonly layer = Layer.effect(
    Tts,
    Effect.gen(function* () {
      const ctor = yield* Socket.WebSocketConstructor;
      const config = yield* AppConfig;
      const db = yield* Db;
      const http = yield* HttpClient.HttpClient;
      const unavailable = (detail: string) => new TtsUnavailable({ engine: "edge", detail });

      const edge = Effect.fnUntraced(function* (text: string, voice: string, prosody: Prosody) {
        const ms = yield* Clock.currentTimeMillis;
        const date = DateTime.toDateUtc(DateTime.makeUnsafe(ms)).toUTCString();
        const socket = yield* Socket.makeWebSocket(edgeUrl(ms, id()), { headers: { ...EDGE_HEADERS, Cookie: `muid=${id().toUpperCase()};` }, openTimeout: OPEN_TIMEOUT });
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        for (const m of edgeRequest(text, voice, date, id(), prosody)) yield* writer.write(m);
        const audio: Uint8Array[] = [];
        for (;;) {
          const frames = yield* reader.pull;
          for (const f of frames) {
            const { path, audio: a } = parseFrame(f);
            if (a?.length) audio.push(a);
            if (path === "turn.end") {
              if (!audio.length) return yield* unavailable("no audio in the answer");
              return concat(audio);
            }
          }
        }
      });

      const viaEdge = (text: string, voice: string, prosody: Prosody = {}) =>
        Effect.scoped(edge(text, voice, prosody)).pipe(
          Effect.provideService(Socket.WebSocketConstructor, ctor),
          // closed early, refused (a changed protocol closes with 1007), unreachable: all the same to us
          Effect.catchTag("SocketError", (e) => Effect.fail(unavailable(e.message))),
          Effect.timeoutOrElse({ duration: SYNTH_TIMEOUT, orElse: () => Effect.fail(unavailable("timed out")) }),
          Effect.map((audio): Speech => ({ audio, engine: "edge" })),
        );

      const geminiFailed = (detail: string) => new TtsUnavailable({ engine: "gemini", detail });

      /** One of today's Gemini lines (UTC day), from the database so restarts don't reset it; false when they're used up. */
      const spend = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const day = DateTime.formatIso(now).slice(0, 10);
        const [row] = yield* db.select().from(settings).where(eq(settings.key, BUDGET));
        const b = Option.getOrUndefined(Schema.decodeUnknownOption(Budget)(row?.value));
        const used = b?.day === day ? b.used : 0;
        if (used >= GEMINI_DAILY) return false;
        const value = { day, used: used + 1 };
        yield* db.insert(settings).values({ key: BUDGET, value }).onConflictDoUpdate({ target: settings.key, set: { value, updated_at: DateTime.toDate(now) } });
        return true;
      }).pipe(Effect.mapError((e) => geminiFailed(`its budget: ${e.message}`)));

      const viaGemini = Effect.fnUntraced(function* (text: string, voice: string = GEMINI_VOICE, style?: string) {
        const key = config.geminiApiKey;
        if (!key) return yield* geminiFailed("no GEMINI_API_KEY");
        if (!(yield* spend)) return yield* geminiFailed(`today's ${GEMINI_DAILY} lines are used up`);
        const request = HttpClientRequest.post(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS}:generateContent`).pipe(
          HttpClientRequest.setHeaders({ "Content-Type": "application/json", "x-goog-api-key": Redacted.value(key) }),
          HttpClientRequest.bodyText(
            jsonText({
              // a style is said as Gemini expects it: "<direction>: <text>"
              contents: [{ parts: [{ text: style ? `${style}: ${text}` : text }] }],
              generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
            }),
            "application/json",
          ),
        );
        const res = yield* http.execute(request);
        if (res.status === 429) {
          // Google's own daily quota is smaller than ours: today's allowance is spent, ask again tomorrow
          const day = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
          yield* db
            .insert(settings)
            .values({ key: BUDGET, value: { day, used: GEMINI_DAILY } })
            .onConflictDoUpdate({ target: settings.key, set: { value: { day, used: GEMINI_DAILY } } })
            .pipe(Effect.ignore);
          return yield* geminiFailed("429: today's quota is used up");
        }
        if (res.status < 200 || res.status >= 300) return yield* geminiFailed(`${res.status} ${(yield* res.text).slice(0, 200)}`);
        const data = (yield* Schema.decodeUnknownEffect(Spoken)(yield* res.json)).candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
        if (!data) return yield* geminiFailed("no audio in the answer");
        const bytes = Base64.decode(data.data);
        if (Result.isFailure(bytes)) return yield* geminiFailed("its audio isn't base64");
        const pcm = pcmOf(bytes.success, data.mimeType);
        if (!pcm) return yield* geminiFailed(`audio it can't encode (${data.mimeType})`);
        // a visit is a jingle and about ten seconds: a reading that ran long is not kept
        if (pcm.pcm.length / pcm.rate > GEMINI_MAX_SECONDS) return yield* geminiFailed(`too long (${(pcm.pcm.length / pcm.rate).toFixed(1)} s)`);
        return { audio: yield* encodeOggOpus(pcm.pcm, pcm.rate), engine: "gemini" } satisfies Speech;
      });

      const gemini = (text: string, voice: string, style?: string) =>
        viaGemini(text, voice, style).pipe(
          Effect.catchTags({
            HttpClientError: (e) => Effect.fail(geminiFailed(e.message)),
            SchemaError: (e) => Effect.fail(geminiFailed(`its answer: ${e.message}`)),
          }),
          Effect.timeoutOrElse({ duration: GEMINI_TIMEOUT, orElse: () => Effect.fail(geminiFailed("timed out")) }),
        );

      return Tts.of({
        synth: (text, voice, options) =>
          // a Gemini voice: Gemini, with its direction (no spare: the caller falls back to Edge itself)
          voice.startsWith("gemini:")
            ? gemini(text, voice.slice("gemini:".length), options?.style).pipe(Effect.withSpan("Tts.synth", { attributes: { voice } }))
            : viaEdge(text, voice, options?.prosody).pipe(
            // Edge said no: the spare engine, if there's a key (both failures reach the caller as one)
            Effect.catch((edgeFailed) =>
              config.geminiApiKey && options?.spare !== false
                ? gemini(text, GEMINI_VOICE).pipe(
                    Effect.mapError((e) => new TtsUnavailable({ engine: "edge, gemini", detail: `${edgeFailed.detail}; ${e.detail}` })),
                  )
                : Effect.fail(edgeFailed),
            ),
            Effect.withSpan("Tts.synth", { attributes: { voice } }),
          ),
      });
    }),
  );
}
