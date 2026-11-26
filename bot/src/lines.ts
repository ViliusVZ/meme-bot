// 🗣️ What the bot says out loud (plan 03), hand-written in the voice of roasts.ts and tone-read on
// 2026-11-13. Put in code exactly as written; change them here and nowhere else.
//
// Markup (26 Nov: "the cringe is the feature", voices.ts casts every span at random):
//   English by default.
//   `‹…›`        a Lithuanian span.
//   `⟦de:…⟧`     a span in another language: de es it pl ja la fr.
//   `‖`          a hand-over: what follows is said by another voice, as unlike the last as possible.
//   a leading `[slow]` `[fast]` `[whisper]` `[shout]`: how the whole line is delivered (speed, pitch, volume);
//   a leading `[gemini: <direction>]`: Gemini reads the whole line that way, made ahead within its
//     daily allowance; without a clip made in time, Edge reads it plainly.
// Placeholders: {who} the person, {V} Vithis, {K} Koral, {L} Ieva, {game} the night's game,
// {mins} minutes late, always written "{mins} minutes" (it becomes "1 minute" or "12 minutes"),
// never inside a ‹…› or ⟦…⟧ span (those languages inflect it). Names are spoken names, never
// Discord's, and always outside the spans. No emoji, no markdown: these are read aloud. A night-start
// line always says {game}. A visit is a jingle and about ten seconds: keep a line under ~140 letters
// (~100 for [slow] ones).
//
// Each moment draws from one shuffle-bag shared by everybody (roasts.ts `draw`, family `voice:*`):
// the shared lines plus each person's own, so nothing repeats until the bag has gone round.
import type { Lang } from "./voices.js";

const V = "306836805825593344"; // Vithis
const K = "212567787896307713"; // Koral
const L = "747902984003780651"; // Ieva (Lionixity)

/** How the bot says each of us (confirm with the owner at the listening step). */
export const SPOKEN_NAMES: Readonly<Record<string, string>> = { [V]: "Vithis", [K]: "Koral", [L]: "Ieva" };
const NOBODY = "you there"; // a stand-in player (QA) has no spoken name

/** 1. A planned night starts (after the jingle). Every line says {game}. */
export const START = [
  // the originals
  "{game} tonight. Nobody bails. ‹Pažadėjot.›",
  "‹Žaidimų vakaras:› {game}. Let's go.",
  "{game}. ‹Pradedam.›",
  // film trailer
  "[slow] In a world where nobody answered the poll, three heroes rose. {game}. This winter.",
  "[gemini: Say it like a deep, dramatic movie trailer narrator, full of gravel] Three legends. Zero preparation. {game}.",
  // football commentator
  "[fast] And it's {game}! What a start! ‹Kokia pradžia!› The crowd goes absolutely mild!",
  "[gemini: Say it like a football commentator losing his mind after a last-minute goal, very fast and loud] Vithis to Koral, Koral to Ieva, Ieva logs in, {game}! Game night is ON!",
  // airport gate
  "Attention please. Flight {game} is now boarding at gate three. ‖ ‹Keleiviai, prašome nesivėluoti.›",
  "‹Dėmesio.› This is the final call for {game}. Cats named Pūkis must stay at home.",
  // sat-nav
  "In two hundred metres, turn left into {game}. ‖ ‹Perskaičiuojamas maršrutas.›",
  "You have arrived at {game}. ‖ ‹Jūsų kelionės tikslas dešinėje.›",
  // meditation app
  "[whisper] Breathe in. Breathe out. Feel the {game} flowing through you. ‹Ramiai.›",
  "[gemini: Say it like a calm meditation app voice, soothing, almost whispering] Close your eyes. Imagine no lag. Now open them. {game}.",
  // corporate stand-up
  "Quick sync before we start. Agenda item one: {game}. Agenda item two: also {game}. Any blockers? Great.",
  "Let's take this offline and circle back to {game}. ‖ ‹Šitas susitikimas galėjo būti laiškas.›",
  // news flash
  "Breaking news. Three adults in Lithuania have started {game}. More at eleven.",
  "‹Skubios žinios.› {game} has begun. ‖ Experts say nobody will sleep tonight.",
  // medieval herald
  "Hear ye, hear ye! By order of the Trio, {game} doth commence! ‹Tegyvuoja karalius!›",
  "[gemini: Say it like a pompous medieval herald with trumpets in his voice] Lords and ladies! {game} begins! Bring snacks or be banished!",
  // kindergarten teacher
  "Okay everyone, sit nicely! Today we are playing {game}! ‖ ‹Visi pasiruošę?› Wonderful!",
  "[gemini: Say it like a sweet, extremely patient kindergarten teacher] Inside voices, please. It's {game} time. Hands where I can see them.",
  // radio DJ
  "[fast] You're listening to Trio FM, number one for {game}! Up next: zero sleep!",
  "Good evening, night owls. Coming up after the break: {game}, and regret. ‖ Stay tuned.",
  // customer service hold
  "Your game night is important to us. Please hold. {game} will begin shortly. ‖ ‹Ačiū už kantrybę.›",
  "Thank you for calling {game} support. For Koral, press one. For snacks, press two.",
  // weather, robots, small print
  "Tonight's forecast: heavy {game}, with a strong chance of nobody going to bed.",
  "[slow] Game. Night. Has. Begun. {game}. Beep.",
  "[whisper] Psst. It's {game}. ‖ Pass it on.",
  "[fast] {game} may cause sleep loss, rage and mild friendship. Terms and conditions apply.",
  "We are gathered here today ‖ to play {game}. ‖ ‹Amen.›",
  "Ladies and gentlemen, tonight's main event ‖ is {game}, ‖ ‹ir niekas nepabėgs.›",
  "[shout] {game}! ‹Visi į vietas!›",
  "‹Dėmesio, dėmesio!› {game}. ‖ ‹Telefonus padėti, užkandžius paruošti.›",
  // a surprise language
  "⟦de:Achtung! Der Spieleabend beginnt jetzt. Heute spielen wir⟧ {game}. ⟦de:Ordnung muss sein.⟧",
  "⟦es:¡Atención, amigos! Esta noche jugamos a⟧ {game}. ⟦es:¡Vamos!⟧",
  "⟦it:Mamma mia, che serata! Stasera si gioca a⟧ {game}. ⟦it:Andiamo!⟧",
  "⟦pl:Uwaga, uwaga! Dzisiaj gramy w⟧ {game}. ⟦pl:Do boju!⟧",
  "⟦ja:皆さん、こんばんは。今夜のゲームは⟧ {game} ⟦ja:です。頑張りましょう！⟧",
  "[slow] ⟦la:Alea iacta est. Hodie ludimus⟧ {game}. ⟦la:Ave, amici.⟧",
  "⟦fr:Mesdames et messieurs, ce soir c'est⟧ {game}. ‖ ⟦fr:Bonne chance, mes amis.⟧",
];

/** 2. A latecomer arrives in the night's room. */
export const LATE = [
  "{who}, {mins} minutes late. We noticed.",
  "‹Labas,› {who}. Only {mins} minutes late. ‹Rekordas.›",
  "Look who it is. {who}. {mins} minutes, fashionably late.",
  "‹Pagaliau,› {who}. Now the party can actually start.",
  "Breaking news: {who} has arrived, {mins} minutes late. More at eleven.",
  "Attention please. Passenger {who}, you are {mins} minutes late. ‖ ‹Lėktuvas jau pakilo.›",
  "[whisper] {who} is here. Don't look. Just act normal.",
  "Recalculating. {who}, {mins} minutes behind schedule. ‖ ‹Perskaičiuojamas maršrutas.›",
  "⟦de:Pünktlichkeit ist eine Tugend,⟧ {who}. {mins} minutes late.",
  "Hear ye! {who} hath arrived, {mins} minutes tardy! ‖ ‹Gėda, gėda.›",
  "Your arrival is important to us, {who}. {mins} minutes late. ‖ ‹Ačiū, kad laukėte.›",
  "[fast] And {who} enters the pitch! {mins} minutes late, but who's counting? Everyone is counting.",
  "⟦it:Finalmente!⟧ {who}, {mins} minutes late. ⟦it:Mamma mia.⟧",
  "⟦ja:遅いですよ、⟧ {who}. {mins} minutes. ‖ ‹Labas vakaras.›",
];
export const LATE_PERSONAL: Readonly<Record<string, ReadonlyArray<string>>> = {
  [K]: ["{K}, {mins} minutes late. ‹Kaip visada, Venipak'o standartas.›", "{K}, ‹siunta pristatyta.› Signature not required."],
  [V]: ["{V} finally deployed himself. {mins} minutes late. No rollback.", "{V} is here. The build only took {mins} minutes longer than promised."],
  [L]: ["{L}, welcome. Pūkis let you go. ‹Ačiū, Pūki.›", "{L}, {mins} minutes late. ‹Vieną seriją, sakei.›", "{L}, {mins} minutes late. ‹Suprantam, nagai turėjo išdžiūti.›"],
};

/** 3. The Lobby question, aloud (when the bot posts "Playing something?"). */
export const LOBBY = [
  "Playing something? ‹Ką žaidžiam?› Tap the game in game night.",
  "‹Labas.› What are we playing? The buttons are in game night.",
  "‹Nu, ką žaidžiam?› Pick it in the game night channel.",
  "Welcome to the Lobby. Please hold. The buttons are in game night. ‖ ‹Ačiū.›",
  "[whisper] What are we playing? Tap it in game night. Quietly.",
  "⟦de:Was spielen wir?⟧ ‖ The buttons are in game night.",
  "Two players detected. ‖ ‹Ką žaidžiam?› Pick it in game night.",
  "Attention, passengers in the Lobby. Please select your game in game night.",
];

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
  "[whisper] {who}... are you alone? ‖ ‹Labas.›",
  "⟦es:Hola,⟧ {who}. ⟦es:¿Estás solo?⟧ ‖ Waiting is a lifestyle.",
  "This is your captain speaking. {who}, we are early. Please remain seated.",
  "In two hundred metres, the others will arrive. Probably. ‖ Please wait, {who}.",
  "[slow] {who}. Breathe in. The others are coming. Breathe out. They are not.",
  "Your wait time is approximately: forever. ‖ ‹Ačiū už kantrybę,› {who}.",
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

/** 🎧 "@third, A and B are in #channel (for 🎮 **game**). Coming?": the third is pinged, the two named. */
export const comingLine = (third: string, two: ReadonlyArray<string>, channel: string, what: string) =>
  `🎧 <@${third}>, ${two.map(spokenName).join(" and ")} are in <#${channel}>${what}. Coming?`;

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

/**
 * A span as the speech engine gets it: who, what, and how (Edge's prosody: rate and volume in
 * percent, pitch in Hz; Gemini's `style` direction). No prosody and no style is the plain voice.
 */
export type Span = {
  readonly voice: string;
  readonly text: string;
  readonly rate?: number;
  readonly pitch?: number;
  readonly volume?: number;
  readonly style?: string;
};

/** How a whole line is delivered (its leading tag). */
export type Delivery = "plain" | "slow" | "fast" | "whisper" | "shout";
/** A piece of a line in one language; `handover`: a new voice starts here even in the same language. */
export type Piece = { readonly lang: Lang; readonly text: string; readonly handover: boolean };
export type Parsed = { readonly delivery: Delivery; readonly gemini: string | null; readonly pieces: ReadonlyArray<Piece> };

const LANGS: ReadonlyArray<Lang> = ["en", "lt", "de", "es", "it", "pl", "ja", "la", "fr"];

/** A filled line, split into what's said in which language, in order (an empty piece is dropped). */
export function parse(line: string): Parsed {
  let rest = line.trim();
  let delivery: Delivery = "plain";
  let gemini: string | null = null;
  const tag = /^\[(slow|fast|whisper|shout|gemini:([^\]]*))\]\s*/.exec(rest);
  if (tag) {
    if (tag[2] !== undefined) gemini = tag[2].trim();
    else delivery = tag[1] as Delivery;
    rest = rest.slice(tag[0].length);
  }
  const pieces: Piece[] = [];
  let handover = false;
  const push = (lang: Lang, raw: string) => {
    // a hand-over mark inside the stretch splits it
    raw.split("‖").forEach((part, i) => {
      if (i > 0) handover = true;
      const text = clean(part);
      if (/[\p{L}\p{N}]/u.test(text)) {
        pieces.push({ lang, text, handover });
        handover = false;
      }
    });
  };
  const re = /‹([^›]*)›|⟦([a-z]{2}):([^⟧]*)⟧/g;
  let at = 0;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    push("en", rest.slice(at, m.index));
    if (m[1] !== undefined) push("lt", m[1]);
    else push((LANGS.includes(m[2] as Lang) ? m[2] : "en") as Lang, m[3]);
    at = m.index + m[0].length;
  }
  push("en", rest.slice(at));
  return { delivery, gemini, pieces };
}

/** The line as plain text, for Gemini (which reads every language itself) and for logs. */
export const plainText = (p: Parsed) => p.pieces.map((x) => x.text).join(" ");

/**
 * 5. WoW Forever downtime (downtime.ts): one line when its card or its reminder goes out and any of
 * us is in voice. {when} is "30 minutes", "1 hour", "2 hours".
 */
export const DOWNTIME = {
  soon: "Heads up: WoW servers go down for maintenance in about {when}.",
  now: "Heads up: WoW servers are down for maintenance right now.",
  later: "Heads up: Blizzard announced WoW server maintenance. Details in the news channel.",
  players: "Heads up: players say the WoW servers are going down.",
  realms: "Heads up: Blizzard's status page shows WoW realms offline.",
} as const;

export const _pools = { START, LATE, LATE_PERSONAL, LOBBY, EARLY, EARLY_PERSONAL };
