// 🗣️ What the bot says out loud (plan 03), hand-written in the voice of roasts.ts and tone-read on
// 2026-11-13. Put in code exactly as written; change them here and nowhere else.
//
// Markup: English by default; `‹…›` is a Lithuanian span, spoken in the Lithuanian voice (tts.ts).
// Placeholders: {who} the person, {V} Vithis, {K} Koral, {L} Ieva, {game} the night's game,
// {mins} minutes late, always written "{mins} minutes" (it becomes "1 minute" or "12 minutes"),
// never inside a ‹…› span (Lithuanian inflects it). Names are spoken names, never Discord's, and
// always outside the Lithuanian spans. No emoji, no markdown: these are read aloud.
//
// Each moment draws from one shuffle-bag shared by everybody (roasts.ts `draw`, family `voice:*`):
// the shared lines plus each person's own, so nothing repeats until the bag has gone round.
import { EN_VOICE, LT_VOICE } from "./tts.js";

const V = "306836805825593344"; // Vithis
const K = "212567787896307713"; // Koral
const L = "747902984003780651"; // Ieva (Lionixity)

/** How the bot says each of us (confirm with the owner at the listening step). */
export const SPOKEN_NAMES: Readonly<Record<string, string>> = { [V]: "Vithis", [K]: "Koral", [L]: "Ieva" };
const NOBODY = "you there"; // a stand-in player (QA) has no spoken name

/** 1. A planned night starts (after the jingle). */
export const START = ["{game} tonight. Nobody bails. ‹Pažadėjot.›", "‹Žaidimų vakaras:› {game}. Let's go.", "{game}. ‹Pradedam.›"];

/** 2. A latecomer arrives in the night's room. */
export const LATE = [
  "{who}, {mins} minutes late. We noticed.",
  "‹Labas,› {who}. Only {mins} minutes late. ‹Rekordas.›",
  "Look who it is. {who}. {mins} minutes, fashionably late.",
  "‹Pagaliau,› {who}. Now the party can actually start.",
];
export const LATE_PERSONAL: Readonly<Record<string, ReadonlyArray<string>>> = {
  [K]: ["{K}, {mins} minutes late. ‹Kaip visada, Venipak'o standartas.›", "{K}, ‹siunta pristatyta.› Signature not required."],
  [V]: ["{V} finally deployed himself. {mins} minutes late. No rollback.", "{V} is here. The build only took {mins} minutes longer than promised."],
  [L]: ["{L}, welcome. Pūkis let you go. ‹Ačiū, Pūki.›", "{L}, {mins} minutes late. ‹Vieną seriją, sakei.›", "{L}, {mins} minutes late. ‹Suprantam, nagai turėjo išdžiūti.›"],
};

/** 3. The Lobby question, aloud (when the bot posts "Playing something?"). */
export const LOBBY = ["Playing something? ‹Ką žaidžiam?›", "‹Labas.› What are we playing?", "‹Nu, ką žaidžiam?› Pick something."];

/** 4. The lone early bird (the beep plays first, then one line). */
export const EARLY = [
  "Beep beep. What are you waiting for, {who}? Chilling alone?",
  "‹Labas,› {who}. ‹Ko čia sėdi tamsoje?›",
  "{who}, it's not time yet. ‹Bet gerai, sėdėk.›",
  "{who}, early? ‹Gerai, aš irgi niekur neskubu.›",
  "Just checking you're alive, {who}. ‹Viskas gerai?›",
  "‹Tylu, ramu, jauku.› Peak gaming, {who}.",
  "Table for one? Right this way, {who}.",
  "‹Aš irgi čia vienas sėdžiu.› Want to be friends, {who}?",
];
export const EARLY_PERSONAL: Readonly<Record<string, ReadonlyArray<string>>> = {
  [K]: [
    "Beep beep, {K}. ‹Kurjeris atvyko anksčiau nei siunta.›",
    "{K}, early for once. ‹Pasižymėsiu kalendoriuje.›",
    "{K} delivered himself ahead of schedule. ‹Venipak'as niekada taip nedaro.›",
    "{K}, ‹ko lauki?› The others aren't even out for delivery yet.",
    "{K} is here, but nobody's home. ‹Paliksim prie durų.›",
    "{K}, here early. ‹Kurjeriai tave išmetė iš grupės?›",
  ],
  [V]: [
    "Beep beep, {V}. Waiting for your own bot to start the night?",
    "{V}, ‹taip anksti? Vėl testuoji ant prodo?›",
    "{V} is here first. Of course. He built the waiting room.",
    "{V}, compiling friends. Please wait.",
    "‹Labas,› {V}. Even I'm not ready, and you wrote me.",
  ],
  [L]: [
    "{L}, early? Pūkis must be asleep.",
    "{L}, here first. ‹Netflix'as palauks.›",
    "{L}, early? ‹Nagai jau išdžiūvo?›",
    "{L}, straight from the pole gym? ‹Bent kažkas čia sportuoja.›",
    "{L}, ‹ko čia viena sėdi?› The boys are still loading.",
  ],
};

/** A family for roasts.ts `draw`: every line in its bag, and the ones that fit this person. */
export function family(shared: ReadonlyArray<string>, personal: Readonly<Record<string, ReadonlyArray<string>>>, user: string) {
  return { all: [...shared, ...Object.values(personal).flat()], fits: [...shared, ...(personal[user] ?? [])] };
}

export const spokenName = (user: string) => SPOKEN_NAMES[user] ?? NOBODY;

/**
 * Text fit to be read aloud: no emoji, no markdown, no small print, mentions as spoken names. Game
 * names come from people (the 🕹️ list), so they go through this too.
 */
export function clean(text: string) {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("-#"))
    .join(" ")
    .replace(/<@!?(\d+)>/g, (_, id: string) => spokenName(id))
    .replace(/<#\d+>/g, "the channel")
    .replace(/<a?:\w+:\d+>/g, "") // custom emoji
    .replace(/<t:\d+(:\w)?>/g, "")
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[*_~`|>#]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?:;])/g, "$1")
    .trim();
}

/** "1 minute", "12 minutes". */
export const minutesText = (mins: number) => (mins === 1 ? "1 minute" : `${mins} minutes`);

/** A line with its placeholders filled (still marked up). */
export function fill(line: string, values: { who?: string; game?: string; mins?: number }) {
  return line
    .replaceAll("{mins} minutes", minutesText(values.mins ?? 0))
    .replaceAll("{who}", values.who ? spokenName(values.who) : NOBODY)
    .replaceAll("{V}", spokenName(V))
    .replaceAll("{K}", spokenName(K))
    .replaceAll("{L}", spokenName(L))
    .replaceAll("{game}", clean(values.game ?? ""));
}

export type Span = { readonly voice: string; readonly text: string };

/** A filled line, split into what each voice says, in order. A span with nothing to say is dropped. */
export function spans(line: string): Span[] {
  const out: Span[] = [];
  const re = /‹([^›]*)›/g;
  let at = 0;
  const push = (voice: string, raw: string) => {
    const text = clean(raw);
    if (/[\p{L}\p{N}]/u.test(text)) out.push({ voice, text });
  };
  for (let m = re.exec(line); m; m = re.exec(line)) {
    push(EN_VOICE, line.slice(at, m.index));
    push(LT_VOICE, m[1]);
    at = m.index + m[0].length;
  }
  push(EN_VOICE, line.slice(at));
  return out;
}

export const _pools = { START, LATE, LATE_PERSONAL, LOBBY, EARLY, EARLY_PERSONAL };
