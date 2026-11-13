// 🗣️ The speech engine and the spoken lines (plan 03): the Edge endpoint's token against values the
// `edge-tts` Python package printed, the request it gets, the answer it gives (on a fake WebSocket),
// every way it can fail as one typed error; and every spoken line checked as text: its Lithuanian
// spans, its placeholders, "1 minute" against "12 minutes", and nothing that can't be read aloud.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { Socket } from "effect/socket";
import * as TestClock from "effect/testing/TestClock";
import { secMsGec } from "../src/edgetoken.js";
import { EN_VOICE, LT_VOICE, Tts, edgeRequest, escapeXml, parseFrame } from "../src/tts.js";
import { EARLY, EARLY_PERSONAL, LATE, LATE_PERSONAL, LOBBY, SPOKEN_NAMES, START, clean, fill, minutesText, spans } from "../src/lines.js";

// ---------------------------------------------------------------- the endpoint's token

it("the token matches the Python package's, for the same moments", () => {
  // edge_tts 7.3.1: generate_sec_ms_gec_v2(t)
  expect(secMsGec(1763000000)).toBe("3689BC1F78238B9A-DD2A2B71647FAA9B316154E46E5EEA92B85708C5C753EC77984ED8A78A848763");
  expect(secMsGec(1794000000.5)).toBe("6EA6AF6A0550F520-17E5A544A1EFE811EA5248AFBD9780637964201A6D3A15ADE53A30AB9D066A4F");
  expect(secMsGec(1800000123)).toBe("99E54519B490BE5C-E162DB0977FBDCB9B86DD8148BF1BCDC3C0303176CE39852A42B415935C20654");
  expect(secMsGec(1763000000 + 99)).toBe(secMsGec(1763000000)); // one token per 5-minute window…
  expect(secMsGec(1763000000 + 100)).not.toBe(secMsGec(1763000000)); // …and the next one starts on the dot
});

// ---------------------------------------------------------------- a fake endpoint

const text = (path: string) => `X-RequestId:r\r\nContent-Type:application/json; charset=utf-8\r\nPath:${path}\r\n\r\n{}`;
const binary = (path: string, audio: number[], contentType: string | null = "audio/webm; codec=opus") => {
  const head = new TextEncoder().encode(`X-RequestId:r\r\n${contentType ? `Content-Type:${contentType}\r\n` : ""}Path:${path}\r\n`);
  const out = new Uint8Array(2 + head.length + audio.length);
  out[0] = head.length >> 8;
  out[1] = head.length & 0xff;
  out.set(head, 2);
  out.set(audio, 2 + head.length);
  return out.buffer;
};

type Script = "answer" | "silent" | "close" | "no-audio" | "refuse";
const seen = { urls: [] as string[], headers: [] as Record<string, string>[], sent: [] as string[] };

class FakeSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();
  constructor(private readonly script: Script) {
    // @effect-diagnostics-next-line effect/globalTimers:off a fake socket opens on the event loop, like a real one
    setTimeout(() => {
      if (script === "refuse") return this.emit("error", {});
      this.readyState = 1;
      this.emit("open", {});
    }, 0);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  private emit(type: string, e: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
  }
  send(data: string | Uint8Array) {
    seen.sent.push(String(data));
    if (seen.sent.length % 2) return; // the config message; the line comes next
    const reply = (frames: unknown[]) => frames.forEach((data) => this.emit("message", { data }));
    if (this.script === "answer")
      reply([text("turn.start"), text("response"), binary("audio", [1, 2, 3]), binary("audio", [4, 5]), binary("audio", [], null), text("turn.end")]);
    if (this.script === "no-audio") reply([text("turn.start"), text("turn.end")]);
    if (this.script === "close") {
      reply([text("turn.start"), binary("audio", [1])]);
      this.readyState = 3;
      this.emit("close", { code: 1007, reason: "" });
    }
  }
  close() {
    this.readyState = 3;
  }
}

const tts = (script: Script) =>
  Tts.layer.pipe(
    Layer.provide(
      Layer.succeed(Socket.WebSocketConstructor, (url: string, options?: Socket.WebSocketConstructorOptions) => {
        seen.urls.push(url);
        seen.headers.push((options as { headers: Record<string, string> }).headers);
        return new FakeSocket(script) as unknown as Socket.WebSocketLike;
      }),
    ),
  );
const synth = (script: Script, line = "Tom & Jerry <3", voice = LT_VOICE) => Tts.use((t) => t.synth(line, voice)).pipe(Effect.provide(tts(script)));

describe("the Edge read-aloud endpoint (a fake one)", () => {
  it.effect("asks for WebM Opus in the given voice, the text escaped, with the browser's headers and this window's token; the audio comes back whole", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-13T07:00:00Z"));
      Object.assign(seen, { urls: [], headers: [], sent: [] });
      const audio = yield* synth("answer");
      expect([...audio]).toEqual([1, 2, 3, 4, 5]);
      expect(seen.urls[0]).toContain("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=");
      expect(seen.urls[0]).toContain(`&Sec-MS-GEC=${secMsGec(Date.parse("2026-11-13T07:00:00Z") / 1000)}&Sec-MS-GEC-Version=2-143.0.3650.75`);
      expect(seen.headers[0].Origin).toBe("chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
      expect(seen.headers[0]["User-Agent"]).toContain("Edg/143.0.0.0");
      expect(seen.headers[0].Cookie).toMatch(/^muid=[0-9A-F]{32};$/);
      expect(seen.sent[0]).toContain("Path:speech.config");
      expect(seen.sent[0]).toContain('"outputFormat":"webm-24khz-16bit-mono-opus"');
      expect(seen.sent[1]).toContain("Path:ssml");
      expect(seen.sent[1]).toContain("<voice name='lt-LT-LeonasNeural'>");
      expect(seen.sent[1]).toContain("Tom &amp; Jerry &lt;3");
      expect(seen.sent[1]).toContain("X-Timestamp:Fri, 13 Nov 2026 07:00:00 GMTZ"); // the Z is Edge's own quirk
    }),
  );

  it.effect("closed before the end, no audio, refused, or no answer at all: each is TtsUnavailable", () =>
    Effect.gen(function* () {
      for (const script of ["close", "no-audio", "refuse"] as const) {
        const e = yield* Effect.flip(synth(script));
        expect(e._tag).toBe("TtsUnavailable");
        expect(e.engine).toBe("edge");
      }
      expect((yield* Effect.flip(synth("no-audio"))).detail).toBe("no audio in the answer");
      const hung = yield* Effect.forkChild(Effect.flip(synth("silent")));
      yield* TestClock.withLive(Effect.sleep(50)); // open, asked, and no answer
      yield* TestClock.adjust("16 seconds");
      const e = yield* Fiber.await(hung);
      expect(e._tag === "Success" && e.value.detail).toBe("timed out");
    }),
  );
});

it("an answer's frames: text frames by their path; audio frames with their audio; the empty last one without", () => {
  expect(parseFrame(text("turn.end"))).toEqual({ path: "turn.end" });
  expect(parseFrame(new Uint8Array(binary("audio", [9, 8])))).toEqual({ path: "audio", audio: new Uint8Array([9, 8]) });
  expect(parseFrame(new Uint8Array(binary("audio", [], null)))).toEqual({ path: "audio" });
  expect(parseFrame(new Uint8Array([1]))).toEqual({ path: undefined });
  expect(escapeXml(`a<b>&"c"'\u0007`)).toBe("a&lt;b&gt;&amp;&quot;c&quot;&apos; ");
  expect(edgeRequest("Hi", EN_VOICE, "D", "id")[1]).toContain("X-RequestId:id\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:DZ\r\nPath:ssml\r\n\r\n<speak");
});

// ---------------------------------------------------------------- the spoken lines

const every = [
  ...START,
  ...LATE,
  ...Object.values(LATE_PERSONAL).flat(),
  ...LOBBY,
  ...EARLY,
  ...Object.values(EARLY_PERSONAL).flat(),
];

describe("the spoken lines", () => {
  it("are as written: 3 for a start, 11 for latecomers, 3 for the Lobby, 24 for early birds", () => {
    expect([START.length, LATE.length + Object.values(LATE_PERSONAL).flat().length, LOBBY.length, EARLY.length + Object.values(EARLY_PERSONAL).flat().length]).toEqual([3, 11, 3, 24]);
    expect(SPOKEN_NAMES).toEqual({ "306836805825593344": "Vithis", "212567787896307713": "Koral", "747902984003780651": "Ieva" });
  });

  it("never put a placeholder inside a Lithuanian span; {mins} always reads '{mins} minutes'; nothing that can't be read aloud", () => {
    for (const l of every) {
      for (const lt of l.match(/‹[^›]*›/g) ?? []) expect(lt).not.toMatch(/\{/);
      expect(l.replaceAll("{mins} minutes", "")).not.toContain("{mins}");
      expect(clean(l)).toBe(l); // no emoji, no markdown, no mentions
      expect((l.match(/‹/g) ?? []).length).toBe((l.match(/›/g) ?? []).length);
    }
  });

  it("fill in the person, the game and the minutes: 1 minute, 12 minutes", () => {
    expect(fill("{who}, {mins} minutes late. We noticed.", { who: "212567787896307713", mins: 1 })).toBe("Koral, 1 minute late. We noticed.");
    expect(fill("{L}, {mins} minutes late. ‹Vieną seriją, sakei.›", { mins: 12 })).toBe("Ieva, 12 minutes late. ‹Vieną seriją, sakei.›");
    expect(fill("{game}. ‹Pradedam.›", { game: "🐉 **World of Warcraft**" })).toBe("World of Warcraft. ‹Pradedam.›");
    expect(fill("Beep beep, {who}.", { who: "stranger" })).toBe("Beep beep, you there.");
  });

  it("split into what each voice says, in order; a span with nothing to say is dropped", () => {
    expect(spans("‹Labas,› Koral. Only 12 minutes late. ‹Rekordas.›")).toEqual([
      { voice: LT_VOICE, text: "Labas," },
      { voice: EN_VOICE, text: "Koral. Only 12 minutes late." },
      { voice: LT_VOICE, text: "Rekordas." },
    ]);
    expect(spans("Koral, ‹ko lauki?› The others aren't even out for delivery yet.").map((s) => s.voice)).toEqual([EN_VOICE, LT_VOICE, EN_VOICE]);
    expect(spans("‹Tylu, ramu, jauku.› .")).toEqual([{ voice: LT_VOICE, text: "Tylu, ramu, jauku." }]);
  });

  it("text read aloud is cleaned: no emoji, markdown, small print or mentions", () => {
    expect(clean("🎮 **R.E.P.O.** with <@212567787896307713> in <#123> 🔥\n-# small print")).toBe("R.E.P.O. with Koral in the channel");
    expect(clean("~~Party~~ _Pooper_ `x` <:pog:123> 🇱🇹")).toBe("Party Pooper x");
  });

  it("'1 minute' is singular", () => {
    expect([minutesText(1), minutesText(2), minutesText(45)]).toEqual(["1 minute", "2 minutes", "45 minutes"]);
  });
});
