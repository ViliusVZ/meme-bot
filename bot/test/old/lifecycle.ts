// The old functions of src/lifecycle.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/lifecycle.js";
import { runSync } from "../../src/legacy.js";
import { Lifecycle } from "../../src/lifecycle.js";

// for main.ts and app.ts until they move to Effect
export const isLeader = () => runSync(Lifecycle.use((l) => l.leader));
export const isShuttingDown = () => runSync(Lifecycle.use((l) => l.shuttingDown));
export const setLeader = (leading: boolean) => runSync(Lifecycle.use((l) => l.setLeader(leading)));
export const markShuttingDown = () => runSync(Lifecycle.use((l) => l.markShuttingDown));
