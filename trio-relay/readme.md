# trio-relay

A private, read-only [Devvit](https://developers.reddit.com/) app that gives our Discord bot (`../bot`)
Reddit posts. Reddit closed its public RSS and JSON feeds to logged-out readers in November 2026, and
new Data API apps aren't approved any more, so the bot asks this app instead.

It is installed on r/trio_relay_dev, a private playtest subreddit Devvit made for it. Nothing is ever
posted there; a Devvit app just has to be installed somewhere to run.

## Endpoint

`POST /external/read` (an external endpoint with a managed app token, `"scopes": ["global"]`).

Request, either part optional:

```json
{
  "listings": [{"sub": "ProgrammerHumor", "kind": "week", "limit": 100}],
  "threads": [{"sub": "wow", "id": "t3_abc123", "limit": 60}]
}
```

- `kind` is `day`, `week` or `month` (top of that period) or `hot`. `limit` is at most 100.
- A thread is its post plus up to `limit` top-level comments, in top order.

Answer:

```json
{
  "listings": [{"sub": "...", "kind": "...", "posts": [Post]}],
  "threads": [{"sub": "...", "id": "t3_...", "post": Post | null, "comments": [{"body", "created", "score"}]}],
  "failed": ["<item>: <error>"]
}
```

Each `Post` is `{id, title, link, url, body, created, score, comments, removed, author, nsfw, images}`.
`body` is cut to 4000 characters and each comment to 600. Each item is fetched on its own, so one
subreddit failing doesn't sink the rest.

The app only reads, with `reddit.getTopPosts`, `getHotPosts`, `getPostById` and `getComments`. It never
posts, comments or votes, and it stores nothing.

## Commands

- `npm run build`: builds the server bundle.
- `npx devvit upload`, then `npx devvit install trio_relay_dev`: ships a new version.
- `npx devvit logs trio_relay_dev`: the app's logs.
