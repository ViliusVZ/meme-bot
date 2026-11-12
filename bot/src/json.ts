// JSON text for plain data, through Schema's JSON codec (the same text JSON.stringify gives: request
// bodies and log lines stay byte for byte as they were).
import { Schema } from "effect";

const codec = Schema.fromJsonString(Schema.Unknown);

/** `value` as JSON text. For plain data (no BigInt, no cycles), which is all the bot sends or logs. */
export const jsonText: (value: unknown) => string = Schema.encodeSync(codec);
