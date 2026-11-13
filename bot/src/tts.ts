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
// English lines go to `en-US-BrianMultilingualNeural`, Lithuanian ones to `lt-LT-LeonasNeural`
// (lines.ts marks which is which).
import { randomUUID } from "node:crypto";
import { Clock, Context, DateTime, Duration, Effect, Layer, Schema } from "effect";
import { Socket } from "effect/socket";
import { CHROMIUM_FULL_VERSION, SEC_MS_GEC_VERSION, TRUSTED_CLIENT_TOKEN, secMsGec } from "./edgetoken.js";

export const EN_VOICE = "en-US-BrianMultilingualNeural";
export const LT_VOICE = "lt-LT-LeonasNeural";
export const FORMAT = "webm-24khz-16bit-mono-opus";
const WSS = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const MAJOR = CHROMIUM_FULL_VERSION.split(".")[0];
const SYNTH_TIMEOUT = Duration.seconds(15); // a line takes 1-4 s; the caller's own deadline is usually shorter
const OPEN_TIMEOUT = Duration.seconds(5);

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

/** The two messages a synthesis sends: the audio format, then the line. */
export function edgeRequest(text: string, voice: string, date: string, requestId: string) {
  return [
    `X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${FORMAT}"}}}}\r\n`,
    `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n` +
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`,
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
    /** One span of a line in one voice, as WebM Opus. */
    synth(text: string, voice: string): Effect.Effect<Uint8Array, TtsUnavailable>;
  }
>()("meme-bot/tts") {
  static readonly layer = Layer.effect(
    Tts,
    Effect.gen(function* () {
      const ctor = yield* Socket.WebSocketConstructor;
      const unavailable = (detail: string) => new TtsUnavailable({ engine: "edge", detail });

      const edge = Effect.fnUntraced(function* (text: string, voice: string) {
        const ms = yield* Clock.currentTimeMillis;
        const date = DateTime.toDateUtc(DateTime.makeUnsafe(ms)).toUTCString();
        const socket = yield* Socket.makeWebSocket(edgeUrl(ms, id()), { headers: { ...EDGE_HEADERS, Cookie: `muid=${id().toUpperCase()};` }, openTimeout: OPEN_TIMEOUT });
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        for (const m of edgeRequest(text, voice, date, id())) yield* writer.write(m);
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

      return Tts.of({
        synth: (text, voice) =>
          Effect.scoped(edge(text, voice)).pipe(
            Effect.provideService(Socket.WebSocketConstructor, ctor),
            // closed early, refused (a changed protocol closes with 1007), unreachable: all the same to us
            Effect.catchTag("SocketError", (e) => Effect.fail(unavailable(e.message))),
            Effect.timeoutOrElse({ duration: SYNTH_TIMEOUT, orElse: () => Effect.fail(unavailable("timed out")) }),
            Effect.withSpan("Tts.synth", { attributes: { voice } }),
          ),
      });
    }),
  );
}
