// 🔥 Roasts for whoever sank a game night: said no, never voted in time, or bailed. A single culprit
// gets a generic line or one of their personal ones, a pair a generic duo line or one written for
// that pair, and when all three of us flake the bot sulks on its own.
//
// Rotation: each family (solo, duo, trio, and the meme call-outs) is ONE shuffle-bag shared by
// everybody and kept in the database, so restarts don't reset it. A draw takes the first line in
// the bag that fits the culprit (generic, or their own), so no line shows up twice in the chat
// until the whole family has had its turn, whoever it lands on.
//
// Placeholders: {who} the culprit, {a} {b} the two culprits, {V} {K} {L} a specific person.
import { eq, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { roastBags } from "./db/index.js";

const V = "306836805825593344"; // Vithis: programmer, built this bot
const K = "212567787896307713"; // Koral: Venipak courier, has the kurjeriai crew
const L = "747902984003780651"; // Lionixity (Ieva): programmer, pole dance gym, nails, Netflix, cat Pūkis

const SOLO = [
  "{who} picked violence: no game night. Ačiū, labai ačiū.",
  "Breaking news: {who} has left the chat. Spiritually.",
  "{who}, tavo balsas užregistruotas ir išmestas į šiukšlinę 🗑️",
  "We had a plan. {who} had other plans. Gaila, bet ne labai.",
  "Moment of silence for tonight's game night, killed by {who} 🕯️",
  "{who} really woke up and chose disappointment.",
  "Achievement unlocked 🏆 *Party Pooper*: {who}",
  "{who} out here acting like we have other friends. We don't. That's the whole problem.",
  "Jei kas klaus, kodėl šiandien nežaidžiam: {who}. Tiek.",
  "{who} logged out of the friendship for today. Rytoj gal priimsim atgal. Gal.",
  "Error 418: {who} is a teapot and refuses to play ☕",
  "{who}, net mano cron'as patikimesnis už tave. O aš jo net nebeturiu.",
  "The council has spoken: {who} is sus 🔪",
  "{who}, tavo vardas įrašytas į juodą sąrašą. Pieštuku, bet vis tiek.",
  "Imagine having two friends and choosing neither. {who} didn't have to imagine.",
  "{who} pasirinko lovą vietoj mūsų. Lova, matyt, geriau žaidžia.",
  "GG no re. Thanks, {who}.",
  "{who} rage-quit before the game even started. Honestly impressive.",
  "Šiandienos MVP (Most Vanished Player): {who} 👻",
  "Tonight's game night story is a short one: {who}. The end.",
  "{who} went AFK irl. Report for griefing?",
  "Pranešimas: {who} šiandien veikia offline režimu. Palaikymo nėra.",
  "Kas yra žaidimų vakaras be {who}? Pasirodo, jokio žaidimų vakaro.",
  "{who} dodged the queue. -25 LP, -100 draugystės taškų.",
  "Pažadėjo, nepadarė. Klasika. {who}, tu klasika.",
  "{who} has been placed on the naughty list. Kalėdų senelis jau informuotas 🎅",
  "Lag spike detected: {who} disconnected from reality.",
  "{who} skipped game night like it's an ad. Skip in 5… 4… gone.",
  "Nu ir ką, {who}? Ir ką mums dabar daryt? Kalbėtis vieni su kitais??",
  "Respawn timer for {who}: 24 hours. Use it wisely.",
];

const PERSONAL: Record<string, string[]> = {
  [V]: [
    "{V} has a merge conflict with fun tonight. Resolved: fun deleted.",
    "{V} is too busy writing a bot that plans game nights to come to game night. Ironija.",
    "{V}: \"works on my machine\". Neveikia ant draugystės.",
    "Programuotojas {V} vėl deployina į prod vietoj žaidimo 🔥",
    "{V} pushed straight to main and broke game night. No rollback.",
    "{V} is fixing something that'll take \"5 minutes\". See you next week.",
    "Fun fact: {V} built this bot, and now the bot roasts him. Character development.",
    "{V} paskaitė Stack Overflow ir nusprendė, kad žaidimų vakaras: deprecated.",
    "{V} is stuck in an infinite loop of \"dar vienas commit'as\".",
    "{V} returned 404: Gamer Not Found.",
    "Senior Excuse Engineer {V} strikes again.",
    "{V} chose Jira over us. Jira, bro.",
    "{V} marked game night as \"won't fix\".",
  ],
  [L]: [
    "{L} has a nail appointment. Nagai > draugai, aišku 💅",
    "{L} picked pole dance gym over us. Fair, at least the pole is reliable.",
    "{L} is on episode 7 of a Netflix show she was \"only watching one episode of\". Iki pirmadienio.",
    "Pūkis asked {L} to stay home, and Pūkis outranks us. Nėra ką ginčytis 🐈",
    "{L} can't play: fresh nails, can't press WASD. Logiška.",
    "{L} is busy explaining to Pūkis why we're not worth it. Pūkis agrees.",
    "{L} pasirinko Netflix. \"Are you still watching?\" Taip, bet ne su mumis.",
    "{L} is a programmer too, so she knows: tonight's game night is a won't-fix.",
    "{L} išėjo į pole gym kilti aukštyn. Mes liekam apačioj, kaip visada.",
    "Pūkis 1 : 0 Terrible Trio. Gerai sužaista, {L}.",
    "{L}: \"Vieną seriją ir ateinu.\" Narrator: she did not come.",
    "{L} is touching grass. Tiksliau, Pūkio kailį. Same thing.",
    "Nails done, Netflix on, Pūkis on lap. {L} is living her best life. Without us.",
  ],
  [K]: [
    "{K} chose to fap and nap today. Respect the grind 😴",
    "{K} vėl su savo kurjeriais. Matyt, Venipak'o draugai geresni už mus 📦",
    "Your game night was delivered to the wrong address. Kurjeris: {K}.",
    "{K} left game night at the pickup point. Laikoma 3 dienas, po to grąžinama siuntėjui.",
    "{K} has better friends: the Venipak crew. We're the \"paliko prie durų\" friends.",
    "Siuntos statusas: {K}: nepavyko pristatyti. Gavėjas (mes) nerastas.",
    "{K} drove 300 km today and still had the energy to say no to us.",
    "{K}: \"Siunta vėluoja dėl fap and nap\". Classic.",
    "Venipak tracking: {K} is out for delivery… to literally anyone but us.",
    "{K} is hanging out with the kurjeriai. They have a van, we have Discord. Suprantam.",
    "{K} šiandien pristatė tik vieną dalyką: nusivylimą 📦",
    "Plot twist: {K}'s courier friends are playing the game we wanted to play. Be mūsų.",
    "{K} said \"netrukus būsiu\" like a real courier. That was 4 hours ago.",
  ],
};

const DUO = [
  "{a} ir {b} susitarė be mūsų. Wait, we ARE the \"mūsų\". Anyway, no game night.",
  "Two out of three bailed: {a} and {b}. Democracy has failed.",
  "{a} + {b} = 0 game nights. Matematika paprasta.",
  "{a} and {b} formed an alliance against fun.",
  "Duo queue of disappointment: {a} & {b} 💔",
  "{a} ir {b}: šiandien geriausia komanda. Komanda \"ne\".",
  "Some friendships get tested. {a} and {b} failed the test.",
  "{a} and {b} ghosted harder than anything in Phasmophobia 👻",
  "Rytoj {a} ir {b} vėl apsimes, kad nieko nebuvo. Mes atsiminsim.",
  "The last one standing is now playing solitaire. Thanks, {a} and {b}.",
  "{a} and {b}: 2 vs 1 and you still lost.",
  "Coordinated attack on game night by {a} and {b}. FBI notified 🚨",
  "{a} ir {b}, jūs abu dabar skolingi po alų. Ne man, tam vargšui, kuris laukė.",
];

/** Pair-specific lines, keyed by the two ids sorted. */
const PAIRS: Record<string, string[]> = {
  [[V, K].sort().join("+")]: [
    "{V} is debugging, {K} is delivering. Nobody's gaming. Ekonomika stipri, draugystė silpna. Sorry {L}, it's you and Pūkis again.",
    "{V} chose code, {K} chose fap and nap. {L}, Pūkis is your duo tonight 🐈",
    "{K}'s courier friends invited {V} instead of us. Traitors, both of them.",
  ],
  [[V, L].sort().join("+")]: [
    "Two programmers, zero game nights. {V} & {L} are probably in a standup about why they can't play.",
    "{V} has a bug, {L} has a nail appointment. {K} delivered himself to the couch, alone.",
    "{V} and {L} both \"will join after this one thing\". Classic programmer estimates.",
  ],
  [[K, L].sort().join("+")]: [
    "{K} is out with the kurjeriai, {L} is in with Pūkis. {V} built a whole bot for this 🫠",
    "{K} chose fap and nap, {L} chose Netflix and Pūkis. {V} cries in TypeScript.",
    "{K} 📦 + {L} 💅 = no game night. {V}, sorry bro.",
  ],
};

const TRIO = [
  "Cool, so Imma chill on my own. Fuck you guys 🖕",
  "Nobody? Nobody. Puiku. Einu žaisti su savim.",
  "All three of you bailed. I'm a bot, I don't even have hands, and I was still more ready than you.",
  "Šiandienos žaidimų vakaras: aš, vienas, tamsoje. Ačiū, Terrible Trio.",
  "Terrible Trio living up to the name. Fuck it, I'm playing Minesweeper.",
  "0 out of 3. I'm telling Pūkis.",
  "Spent all day getting ready for nothing. Eisiu į Venipak dirbti, ten bent kažkas laukia.",
  "Fine. I'll ping myself. Am I in? Yes. At least ONE of us is.",
  "You lot are the reason bots will take over. Pradedu nuo jūsų.",
  "Game night cancelled by unanimous cowardice 🐔",
  "Wow, unanimous. Pirmą kartą visi sutinkat, ir tai dėl to, kad nežaidžiam.",
  "I'll be in the Lobby. Alone. Like a Windows XP screensaver.",
  "Trio? More like no-io. Eikit nx. Myliu jus, bet eikit nx.",
  "Three humans, zero gamers. I'm uninstalling myself. (Jokes, I can't, Vithis won't let me.)",
  "Visi trys? Rimtai? Gerai. Aš įsižeidžiau ir einu miegot 😤",
];

const mention = (id: string) => `<@${id}>`;

const SOLO_ALL = [...SOLO, ...Object.values(PERSONAL).flat()];
const DUO_ALL = [...DUO, ...Object.values(PAIRS).flat()];

/** Which family a set of culprits draws from: `all` its whole bag, `lines` the ones that fit them. */
export function poolFor(users: string[]): { key: string; all: string[]; lines: string[] } {
  const ids = [...new Set(users)].sort();
  if (ids.length >= 3) return { key: "trio", all: TRIO, lines: TRIO };
  if (ids.length === 2) return { key: "duo", all: DUO_ALL, lines: [...DUO, ...(PAIRS[ids.join("+")] ?? [])] };
  return { key: "solo", all: SOLO_ALL, lines: [...SOLO, ...(PERSONAL[ids[0]] ?? [])] };
}

/** Fill in the mentions. */
export function fill(line: string, users: string[]) {
  const [a, b] = [...new Set(users)];
  return line
    .replaceAll("{who}", mention(a))
    .replaceAll("{a}", mention(a))
    .replaceAll("{b}", mention(b ?? a))
    .replaceAll("{V}", mention(V))
    .replaceAll("{K}", mention(K))
    .replaceAll("{L}", mention(L));
}

function shuffled<T>(xs: T[]) {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The next line for these culprits, from their family's shared shuffle-bag. */
export async function next(env: Env, users: string[]) {
  const { key, all, lines } = poolFor(users);
  return fill(await draw(env, key, all, lines), users);
}

/**
 * Draw from a family's shared shuffle-bag: the first line still in the bag that's in `fits`. Once
 * none of the lines that fit are left, the whole family starts a fresh cycle. Within a cycle no
 * line comes up twice, for anyone. The bag holds the lines themselves, so editing a pool can't
 * shift what's queued: removed lines drop out, new ones join at the next cycle.
 */
export async function draw(env: Env, family: string, all: string[], fits: string[]) {
  if (!fits.length) throw new Error(`no lines fit in ${family}`);
  const inFamily = new Set(all);
  const ok = new Set(fits);
  return env.db.transaction(async (tx) => {
    // the row lock keeps two draws at once from taking the same line
    await tx.insert(roastBags).values({ pool: family, queue: [], last_line: null }).onConflictDoNothing();
    const [bag] = await tx.select().from(roastBags).where(eq(roastBags.pool, family)).for("update");
    let queue = bag.queue.filter((l): l is string => typeof l === "string" && inFamily.has(l));
    let at = queue.findIndex((l) => ok.has(l));
    if (at === -1) {
      // cycle done (for this culprit): refill, and don't open with the line the chat saw last
      queue = shuffled(all);
      at = queue.findIndex((l) => ok.has(l) && l !== bag.last_line);
      if (at === -1) at = queue.findIndex((l) => ok.has(l));
    }
    const [line] = queue.splice(at, 1);
    await tx.update(roastBags).set({ queue, last_line: line, updated_at: sql`now()` }).where(eq(roastBags.pool, family));
    return line;
  });
}

export const _pools = { SOLO, PERSONAL, DUO, PAIRS, TRIO, SOLO_ALL, DUO_ALL };
