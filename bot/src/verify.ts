// The signature verifier: Discord signs every interaction (Ed25519), and anything that doesn't verify
// is rejected. Web Crypto is promise-based, so its calls are wrapped once, here (architecture §16).
import { Effect, Schema } from "effect";

const keys = new Map<string, Promise<import("node:crypto").webcrypto.CryptoKey>>();

/** The public key or the signature couldn't be read at all (not merely a wrong signature). */
export class SignatureUnreadable extends Schema.TaggedError<SignatureUnreadable>()("SignatureUnreadable", { detail: Schema.String }) {}

function hex(s: string) {
  return new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
}

async function verify(sig: string | undefined, ts: string | undefined, body: string, publicKey: string) {
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  if (!keys.has(publicKey)) keys.set(publicKey, crypto.subtle.importKey("raw", hex(publicKey), { name: "Ed25519" }, false, ["verify"]));
  return crypto.subtle.verify("Ed25519", await keys.get(publicKey)!, hex(sig), new TextEncoder().encode(ts + body));
}

/** Does `sig` sign `ts + body` with `publicKey`? */
export const verifySignature = (sig: string | undefined, ts: string | undefined, body: string, publicKey: string) =>
  Effect.tryPromise({ try: () => verify(sig, ts, body, publicKey), catch: (e) => new SignatureUnreadable({ detail: String(e) }) });
