// The signature verifier: Discord signs every interaction (Ed25519), and anything that doesn't verify
// is rejected. Web Crypto is promise-based, so its two calls are wrapped once each, here
// (architecture §16).
import { Effect, Schema } from "effect";

type Key = import("node:crypto").webcrypto.CryptoKey;

/** The public key or the signature couldn't be read at all (not merely a wrong signature). */
export class SignatureUnreadable extends Schema.TaggedError<SignatureUnreadable>()("SignatureUnreadable", { detail: Schema.String }) {}

const unreadable = (e: unknown) => new SignatureUnreadable({ detail: String(e) });

function hex(s: string) {
  return new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** The app's public key (hex), ready to check signatures with. */
export const importPublicKey = (publicKey: string) =>
  Effect.tryPromise({ try: () => crypto.subtle.importKey("raw", hex(publicKey), { name: "Ed25519" }, false, ["verify"]), catch: unreadable });

/** Does `sig` sign `ts + body` with `key`? (The key is only needed once the signature looks like one.) */
export const verifySignature = (sig: string | undefined, ts: string | undefined, body: string, key: Effect.Effect<Key, SignatureUnreadable>) =>
  Effect.gen(function* () {
    if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return false;
    const k = yield* key;
    return yield* Effect.tryPromise({ try: () => crypto.subtle.verify("Ed25519", k, hex(sig), new TextEncoder().encode(ts + body)), catch: unreadable });
  });
