// The Reddit feed parser, on a real copy of the feed (test/fixtures/feed.xml).
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseFeed } from "../src/reddit.js";

test("image posts come out ranked, with titles decoded", () => {
  const memes = parseFeed(readFileSync(new URL("./fixtures/feed.xml", import.meta.url), "utf8"));
  expect(memes.length).toBeGreaterThan(20);
  for (const m of memes) {
    expect(m.id).toMatch(/^t3_\w+$/);
    expect(m.image).toMatch(/^https:\/\/i\.redd\.it\/.+\.(png|jpe?g|gif|webp)$/);
    expect(m.link).toMatch(/^https:\/\/www\.reddit\.com\/r\/ProgrammerHumor\/comments\//);
    expect(m.author).toMatch(/^\/u\//);
    expect(m.published).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(m.title).not.toMatch(/&(amp|quot|#\d+);/);
  }
  const ranks = memes.map((m) => m.rank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a! - b!)); // feed order kept; videos etc. leave gaps
});

test("a feed with a single entry still parses", () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><author><name>/u/x</name></author>
    <content type="html">&lt;a href=&quot;https://i.redd.it/abc.png&quot;&gt;[link]&lt;/a&gt;</content>
    <id>t3_abc</id><link href="https://www.reddit.com/r/ProgrammerHumor/comments/abc/x/" /><published>2026-11-04T10:00:00+00:00</published>
    <title>Tom &amp;amp; Jerry &amp;#39;s code</title></entry></feed>`;
  expect(parseFeed(xml)).toEqual([
    { id: "t3_abc", title: "Tom & Jerry 's code", image: "https://i.redd.it/abc.png", link: "https://www.reddit.com/r/ProgrammerHumor/comments/abc/x/", author: "/u/x", published: "2026-11-04T10:00:00+00:00", rank: 1 },
  ]);
});
