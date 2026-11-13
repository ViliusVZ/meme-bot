// The Edge read-aloud endpoint's request token (`Sec-MS-GEC`), as the `edge-tts` Python package
// (7.3.1, drm.py) computes it: a keyed SHA-256 and a CS64 checksum of the 5-minute Windows file time
// and the public client token, "<16 hex>-<64 hex>". Pure arithmetic, ported line for line (every
// sum is taken mod 2^32, as the original masks them); test/tts.test.ts checks it against values the
// Python package printed. The endpoint is unofficial: when Microsoft changes this, Tts fails with
// TtsUnavailable and the clip cache keeps what was already said.

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const CHROMIUM_FULL_VERSION = "143.0.3650.75";
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH = 11644473600n;

const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const SHA256_STATE = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const ADJUSTMENT = 0xc9dc06a7;
const BLOCK_K = [...K.slice(0, 14), ADJUSTMENT, ...K.slice(15)];
const SIGMA0_ADJUSTMENT = 0x059c0b80;
const SIGMA1_ADJUSTMENT = 0x000b92c0;
const CS64: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const u = (x: number) => x >>> 0;
const add = (...xs: number[]) => xs.reduce((a, b) => (a + b) >>> 0, 0);
const mul = (a: number, b: number) => Math.imul(a, b) >>> 0;
const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;
const rol16 = (x: number) => ((x << 16) | (x >>> 16)) >>> 0;
const sigma0 = (x: number) => u(rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3));
const sigma1 = (x: number) => u(rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10));
const be32 = (b: Uint8Array, at: number) => u((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);

function rounds(state: ReadonlyArray<number>, words: ReadonlyArray<number>, first = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const k = first === 14 ? BLOCK_K : K;
  for (let i = first; i < 64; i++) {
    const t1 = add(h, u(rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)), u(g ^ (e & (f ^ g))), k[i], words[i]);
    const t2 = add(u(rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)), u((a & b) | (c & (a | b))));
    [a, b, c, d, e, f, g, h] = [add(t1, t2), a, b, c, add(d, t1), e, f, g];
  }
  return [a, b, c, d, e, f, g, h];
}

function expand(words: number[], first = 16) {
  for (let i = first; i < 64; i++) words.push(add(sigma1(words[i - 2]), words[i - 7], sigma0(words[i - 15]), words[i - 16]));
}

function init(data: Uint8Array) {
  const words: number[] = [...Array<number>(14).fill(0), u((data[0] << 16) | (data[1] << 8) | data[2]), be32(data, 3)];
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) value = add(value, i === 16 ? u(sigma1(words[i - 2]) ^ SIGMA1_ADJUSTMENT) : sigma1(words[i - 2]));
    if (i - 7 >= 14) value = add(value, words[i - 7]);
    if (i - 15 >= 14) value = add(value, i === 29 ? u(sigma0(words[i - 15]) ^ SIGMA0_ADJUSTMENT) : sigma0(words[i - 15]));
    words.push(value);
  }
  words.push(u(add(sigma1(words[28]), words[23], sigma0(words[15]), words[14], ADJUSTMENT) - K[14]));
  expand(words, 31);
  const working = rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => add(x, working[i]));
}

function sha256(data: Uint8Array) {
  const length = 57 + data.length;
  const padLen = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(data.length - 7 + 1 + padLen + 8);
  padded.set(data.subarray(7));
  padded[data.length - 7] = 0x80;
  new DataView(padded.buffer).setBigUint64(padded.length - 8, BigInt(length * 8));
  let state = init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const words = Array.from({ length: 16 }, (_, i) => be32(padded, off + i * 4));
    expand(words);
    const working = rounds(state, words);
    state = state.map((x, i) => add(x, working[i]));
  }
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  state.forEach((x, i) => view.setUint32(i * 4, x));
  return out;
}

function wordsLe(data: Uint8Array) {
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  const view = new DataView(padded.buffer);
  const words = Array.from({ length: padded.length / 4 }, (_, i) => view.getUint32(i * 4, true));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64(data: Uint8Array, digest: Uint8Array): [number, number] {
  const dv = new DataView(digest.buffer, digest.byteOffset);
  const keyA = u(dv.getUint32(0, true) | 1);
  const keyB = u(dv.getUint32(4, true) | 1);
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64.map(([c], i) => mul(c, factors[i % 2]));
  const offsets = CS64.map(([, o]) => o);
  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  wordsLe(prefixed).forEach((word, i) => {
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = add(term, mul(CS64_ADJUSTMENT0, factors[0]));
      offset = add(offset, CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const [x, y] = [terms[i], terms[i + 1]];
    let t = rol16(add(offsets[i], x));
    let q = mul(t, 0x76f50f34);
    swapAcc = add(swapAcc, add(mul(rol16(q), 0xc3efea97), q));
    t = rol16(add(offsets[i + 1], y));
    q = mul(t, 0x1881ce3c);
    swapLast = add(mul(rol16(q), 0x35bd1ec9), q);
    swapAcc = add(swapAcc, swapLast);
    state = add(mul(state, keyA), x);
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = add(acc, state);
    t = add(mul(state, keyB), y);
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = add(acc, state);
  }
  return [u(swapLast ^ state), u(swapAcc ^ acc)];
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();

/** The token for a moment (unix seconds): the same for the whole 5-minute window it falls in. */
export function secMsGec(unixSeconds: number) {
  let ticks = BigInt(Math.floor(unixSeconds)) + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10_000_000n;
  const data = new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`);
  const digest = sha256(data);
  const [a, b] = cs64(data, digest);
  const words = new Uint8Array(8);
  const view = new DataView(words.buffer);
  view.setUint32(0, a, true);
  view.setUint32(4, b, true);
  return `${hex(words)}-${hex(digest)}`;
}
