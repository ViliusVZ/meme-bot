// Work that continues after we've answered Discord (followups, wheel animations, pings). Tracked,
// so a deploy or restart waits for it to finish before the process exits.

const pending = new Set<Promise<unknown>>();

/** Run `p` in the background; failures are logged with `label`, never thrown. */
export function defer(p: Promise<unknown>, label = "background") {
  const tracked = p.catch((e) => console.log(`${label} failed`, e)).finally(() => pending.delete(tracked));
  pending.add(tracked);
}

/** Wait for in-flight background work, up to `ms`. */
export async function drain(ms: number) {
  const deadline = new Promise((ok) => setTimeout(ok, ms).unref());
  while (pending.size) {
    const done = await Promise.race([Promise.allSettled([...pending]).then(() => true), deadline.then(() => false)]);
    if (!done) return pending.size;
  }
  return 0;
}

export const inFlight = () => pending.size;
