// 🎭 Who says what (26 Nov, the owner: "the cringe is the feature"). Every line is cast at the moment
// it's spoken: each span of it gets a voice drawn from a no-repeat bag (roasts.ts `draw`, one bag per
// language), so a voice doesn't come back until the rest have had a turn. English text goes to any
// English accent Edge has, or to a voice of another language reading English; Lithuanian text to
// the two Lithuanian voices or to someone who has never seen Lithuanian before; a line in German,
// Spanish and so on mostly to its own voices, now and then to someone else's. A hand-over (‖ in a
// line) goes to the voice least like the one before: the other gender, another language.
//
// Every name here is a Microsoft voice served by the Edge read-aloud endpoint (tts.ts), checked
// against its voice list on 2026-11-26 (318 voices). Gemini's prebuilt voices (30, the same for all
// its speech models) are named `gemini:<Name>`; they're only used for lines with a Gemini direction,
// made ahead within the day's allowance (botvoice.ts prewarm).

/** A text language a line can be written in (lines.ts markup). */
export type Lang = "en" | "lt" | "de" | "es" | "it" | "pl" | "ja" | "la" | "fr";

type V = { readonly name: string; readonly locale: string; readonly gender: "M" | "F" };

const ev = (locale: string, list: string) =>
  list.split(" ").map((x) => {
    const [n, g] = x.split(":");
    return { name: `${locale}-${n}Neural`, locale, gender: g as "M" | "F" };
  });

/** Every English voice Edge has (14 accents). */
export const ENGLISH: ReadonlyArray<V> = [
  ...ev("en-AU", "WilliamMultilingual:M Natasha:F"),
  ...ev("en-CA", "Clara:F Liam:M"),
  ...ev("en-HK", "Yan:F Sam:M"),
  ...ev("en-IN", "NeerjaExpressive:F Neerja:F Prabhat:M"),
  ...ev("en-IE", "Connor:M Emily:F"),
  ...ev("en-KE", "Asilia:F Chilemba:M"),
  ...ev("en-NZ", "Mitchell:M Molly:F"),
  ...ev("en-NG", "Abeo:M Ezinne:F"),
  ...ev("en-PH", "James:M Rosa:F"),
  ...ev("en-SG", "Luna:F Wayne:M"),
  ...ev("en-ZA", "Leah:F Luke:M"),
  ...ev("en-TZ", "Elimu:M Imani:F"),
  ...ev("en-GB", "Libby:F Maisie:F Ryan:M Sonia:F Thomas:M"),
  ...ev(
    "en-US",
    "Ava:F Andrew:M Emma:F Brian:M Ana:F AndrewMultilingual:M Aria:F AvaMultilingual:F BrianMultilingual:M Christopher:M EmmaMultilingual:F Eric:M Guy:M Jenny:F Michelle:F Roger:M Steffan:M",
  ),
];

/** Voices of the languages lines can be written in. */
export const NATIVE: Readonly<Record<Exclude<Lang, "en">, ReadonlyArray<V>>> = {
  lt: ev("lt-LT", "Leonas:M Ona:F"),
  de: ev("de-DE", "Christoph:M Tanja:F"),
  es: [...ev("es-ES", "Alvaro:M Elvira:F Ximena:F"), ...ev("es-MX", "Jorge:M Dalia:F")],
  it: ev("it-IT", "GiuseppeMultilingual:M Diego:M Elsa:F Isabella:F"),
  pl: ev("pl-PL", "Marek:M Zofia:F"),
  ja: ev("ja-JP", "Keita:M Nanami:F"),
  la: ev("it-IT", "Diego:M Isabella:F"), // nobody speaks Latin: Italians are the closest we have
  fr: ev("fr-FR", "Henri:M Denise:F Eloise:F RemyMultilingual:M VivienneMultilingual:F"),
};

/** Voices that read whatever they're given in their own language's accent: the "wrong" voices. */
export const STRANGERS: ReadonlyArray<V> = [
  ...ev("de-DE", "Christoph:M Tanja:F"),
  ...ev("fr-FR", "Henri:M Denise:F"),
  ...ev("es-ES", "Alvaro:M Elvira:F"),
  ...ev("it-IT", "Diego:M Elsa:F"),
  ...ev("pl-PL", "Marek:M Zofia:F"),
  ...ev("ja-JP", "Keita:M Nanami:F"),
  ...ev("ko-KR", "InJoon:M SunHi:F"),
  ...ev("zh-CN", "Yunxi:M Xiaoxiao:F"),
  ...ev("hi-IN", "Madhur:M Swara:F"),
  ...ev("tr-TR", "Ahmet:M Emel:F"),
  // (fi Harri, sv Mattias and Sofie, nl Maarten and el Athina left out: on 26 Nov they gave no audio
  // for text in another language one time in two)
  ...ev("fi-FI", "Noora:F"),
  ...ev("nl-NL", "Colette:F"),
  ...ev("pt-BR", "Antonio:M Francisca:F"),
  ...ev("cs-CZ", "Antonin:M Vlasta:F"),
  ...ev("hu-HU", "Tamas:M Noemi:F"),
  ...ev("el-GR", "Nestoras:M"),
  ...ev("lv-LV", "Nils:M Everita:F"),
  ...ev("et-EE", "Kert:M Anu:F"),
  ...ev("is-IS", "Gunnar:M Gudrun:F"),
  ...ev("cy-GB", "Aled:M Nia:F"),
  ...ev("sw-KE", "Rafiki:M Zuri:F"),
  ...ev("af-ZA", "Willem:M Adri:F"),
];

/** Gemini's prebuilt voices (for lines with a Gemini direction only). */
export const GEMINI_VOICES: ReadonlyArray<string> = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
].map((n) => `gemini:${n}`);

const byName = new Map<string, V>([...ENGLISH, ...STRANGERS, ...Object.values(NATIVE).flat()].map((v) => [v.name, v]));
export const voiceInfo = (name: string): V | undefined => byName.get(name);

const uniq = (vs: ReadonlyArray<V>) => [...new Map(vs.map((v) => [v.name, v])).values()];

/**
 * Who may read text in `lang`. English: every English accent plus the strangers (an accent per
 * line, the odd one entirely wrong). Lithuanian: the two Lithuanian voices, a few multilingual
 * English ones and a handful of neighbours and strangers (the owner laughs hardest at those). A
 * foreign line: its own voices, plus a few strangers.
 */
export function castPool(lang: Lang): ReadonlyArray<string> {
  if (lang === "en") return uniq([...ENGLISH, ...STRANGERS]).map((v) => v.name);
  const own = NATIVE[lang];
  const some = (locales: string) => STRANGERS.filter((v) => locales.split(" ").includes(v.locale));
  if (lang === "lt")
    return uniq([
      ...own,
      ...ENGLISH.filter((v) => v.name.includes("Multilingual") || ["en-GB-RyanNeural", "en-IN-PrabhatNeural", "en-IE-ConnorNeural"].includes(v.name)),
      ...some("lv-LV et-EE pl-PL de-DE ja-JP it-IT es-ES fi-FI zh-CN is-IS"),
    ]).map((v) => v.name);
  // Japanese script: only voices that can read it (every other voice gives no audio at all)
  if (lang === "ja") return uniq([...own, ...some("ko-KR zh-CN")]).map((v) => v.name);
  return uniq([...own, ...some("de-DE ja-JP fi-FI lv-LV"), ...NATIVE.lt]).map((v) => v.name);
}

/** The voice that always reads `lang` (a cast voice gave no audio: the span is said again in this one). */
export const safeVoice = (lang: Lang): string =>
  lang === "en" ? "en-US-BrianMultilingualNeural" : lang === "lt" ? "lt-LT-LeonasNeural" : NATIVE[lang][0].name;

/** A voice as unlike `prev` as possible: the other gender, another language (for a hand-over ‖). */
export function contrasts(prev: string, pool: ReadonlyArray<string>): ReadonlyArray<string> {
  const p = voiceInfo(prev);
  if (!p) return pool.filter((n) => n !== prev);
  const lang = (l: string) => l.slice(0, 2);
  const best = pool.filter((n) => {
    const v = voiceInfo(n);
    return v && v.gender !== p.gender && lang(v.locale) !== lang(p.locale);
  });
  return best.length ? best : pool.filter((n) => n !== prev);
}
