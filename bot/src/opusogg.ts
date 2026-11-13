// 🔊 PCM to Ogg Opus, for the second speech engine (Gemini's speech comes back as plain PCM). The
// encoder is libopus compiled to WebAssembly (`opusscript`): no ffmpeg and nothing native in the
// image. 20 ms frames, mono, as @discordjs/voice's Ogg demuxer passes them to Discord; the Ogg
// container (RFC 7845) is written here: an OpusHead page, an OpusTags page, then the audio.
import OpusScript from "opusscript";
import { Effect } from "effect";

/** The rates libopus takes as they are. */
export const RATES = [8000, 12000, 16000, 24000, 48000] as const;
export type Rate = (typeof RATES)[number];
const PRE_SKIP = 312; // libopus's look-ahead, in 48 kHz samples
const PACKETS_PER_PAGE = 50; // a second of audio per page

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
const crc = (b: Uint8Array) => {
  let c = 0;
  for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 0xff]) >>> 0;
  return c;
};

/** One Ogg page holding whole packets. */
function page(packets: ReadonlyArray<Uint8Array>, granule: bigint, sequence: number, flags: number) {
  const lacing: number[] = [];
  for (const p of packets) {
    for (let n = p.length; ; n -= 255) {
      lacing.push(Math.min(n, 255));
      if (n < 255) break;
    }
  }
  const body = packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + body);
  const v = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  out[5] = flags;
  v.setBigInt64(6, granule, true);
  v.setUint32(14, 1, true); // the stream's serial number
  v.setUint32(18, sequence, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, at);
    at += p.length;
  }
  v.setUint32(22, crc(out), true);
  return out;
}

const ascii = (s: string) => new TextEncoder().encode(s);

/** The two header packets. */
function headers(rate: Rate) {
  const head = new Uint8Array(19);
  const v = new DataView(head.buffer);
  head.set(ascii("OpusHead"));
  head[8] = 1; // version
  head[9] = 1; // mono
  v.setUint16(10, PRE_SKIP, true);
  v.setUint32(12, rate, true);
  const vendor = ascii("meme-bot");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(ascii("OpusTags"));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  return [head, tags] as const;
}

/** Mono 16-bit PCM as 20 ms Opus packets (the last one padded with silence); the encoder is freed after. */
const encode = (pcm: Int16Array, rate: Rate) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new OpusScript(rate, 1, OpusScript.Application.VOIP)),
    (encoder) =>
      Effect.sync(() => {
        const frame = rate / 50;
        const packets: Uint8Array[] = [];
        encoder.setBitrate(32_000);
        for (let i = 0; i < pcm.length; i += frame) {
          const chunk = new Int16Array(frame);
          chunk.set(pcm.subarray(i, i + frame));
          packets.push(new Uint8Array(encoder.encode(Buffer.from(chunk.buffer), frame)));
        }
        return packets;
      }),
    (encoder) => Effect.sync(() => encoder.delete()),
  );

/** Mono 16-bit PCM at `rate` as Ogg Opus. */
export const encodeOggOpus = (pcm: Int16Array, rate: Rate) => Effect.map(encode(pcm, rate), (packets) => oggOf(packets, rate));

function oggOf(packets: ReadonlyArray<Uint8Array>, rate: Rate) {
  const [head, tags] = headers(rate);
  const pages = [page([head], 0n, 0, 0x02), page([tags], 0n, 1, 0)];
  for (let i = 0; i < packets.length || i === 0; i += PACKETS_PER_PAGE) {
    const group = packets.slice(i, i + PACKETS_PER_PAGE);
    const last = i + PACKETS_PER_PAGE >= packets.length;
    pages.push(page(group, BigInt(PRE_SKIP + 960 * (i + group.length)), pages.length, last ? 0x04 : 0));
  }
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Ogg ("OggS") or WebM (EBML): which demuxer a clip needs. */
export const isOgg = (clip: Uint8Array) => clip[0] === 0x4f && clip[1] === 0x67 && clip[2] === 0x67 && clip[3] === 0x53;

/**
 * What Gemini's speech gives back: raw 16-bit PCM (its mime type says the rate), or a WAV file.
 * Null when it's neither, or at a rate libopus won't take.
 */
export function pcmOf(bytes: Uint8Array, mimeType: string): { pcm: Int16Array; rate: Rate } | null {
  let data = bytes;
  let rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000);
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF") {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 12;
    data = new Uint8Array();
    while (at + 8 <= bytes.length) {
      const id = String.fromCharCode(...bytes.subarray(at, at + 4));
      const size = v.getUint32(at + 4, true);
      if (id === "fmt ") {
        // plain PCM, mono, 16-bit only
        if (v.getUint16(at + 8, true) !== 1 || v.getUint16(at + 8 + 2, true) !== 1 || v.getUint16(at + 8 + 14, true) !== 16) return null;
        rate = v.getUint32(at + 8 + 4, true);
      }
      if (id === "data") data = bytes.subarray(at + 8, at + 8 + size);
      at += 8 + size + (size % 2);
    }
  }
  if (!RATES.includes(rate as Rate) || !data.length) return null;
  const copy = new Uint8Array(data.length - (data.length % 2));
  copy.set(data.subarray(0, copy.length));
  return { pcm: new Int16Array(copy.buffer), rate: rate as Rate };
}
