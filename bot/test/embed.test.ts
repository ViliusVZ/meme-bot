// 🌉 The embed widget (the bridge while the Devvit API waits for approval), on real copies taken on
// 18 Nov 2026: a week's top of r/ProgrammerHumor, a day's top of r/wow, a r/wowforever thread.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseEmbedListing, parseEmbedThread } from "../src/newsfeeds.js";
import { fromListing } from "../src/reddit.js";

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const NOW = 1_795_000_000;

it("a week's listing: posts in order, images for the meme pool", () => {
  const posts = parseEmbedListing(read("embed-week.txt"), NOW);
  expect(posts.length).toBeGreaterThan(80);
  expect(posts.map((p) => p.rank)).toEqual(posts.map((_, i) => i + 1));
  for (const p of posts) {
    expect(p.id).toMatch(/^t3_\w+$/);
    expect(p.link).toMatch(/^https:\/\/www\.reddit\.com\/r\/ProgrammerHumor\/comments\//);
    expect(p.title).not.toMatch(/&(amp|quot|#\d+);|<\w/);
    expect(p.created).toBe(NOW);
  }
  const memes = fromListing(posts);
  expect(memes.length).toBeGreaterThan(60);
  for (const m of memes) expect(m.image).toMatch(/^https:\/\/i\.redd\.it\/\w+\.(png|jpe?g|gif|webp)$/);
});

it("a day's listing: text posts have no target", () => {
  const posts = parseEmbedListing(read("embed-day.txt"), NOW);
  expect(posts).toHaveLength(25);
  expect(posts.some((p) => p.url === "")).toBe(true);
});

it("a thread: comments as text, with their age", () => {
  const t = parseEmbedThread(read("embed-thread.txt"), NOW);
  expect(t.post).toBeNull();
  expect(t.comments.length).toBeGreaterThan(20);
  expect(t.comments.every((c) => c.length > 0 && !/<\w/.test(c))).toBe(true);
  expect(t.times!.every((at) => at > NOW - 30 * 86400 && at <= NOW)).toBe(true);
});

it("anything else is no posts, not a crash", () => {
  expect(parseEmbedListing("<html>blocked</html>", NOW)).toEqual([]);
  expect(parseEmbedThread("", NOW).comments).toEqual([]);
});
