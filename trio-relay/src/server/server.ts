// The trio's Discord bot reads Reddit through this app: Reddit closed its public feeds to
// logged-out readers (Nov 2026). Our bot calls POST /external/read with a managed app token and
// gets the listings and comment threads it asked for back as JSON. Read-only: the app never posts,
// comments or votes, and keeps nothing.
import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {reddit} from '@devvit/web/server'
import type {Post, Comment} from '@devvit/web/server'

const BODY = 4000
const COMMENT = 600

type Kind = 'day' | 'hot' | 'week' | 'month'
type WantListing = {sub: string; kind: Kind; limit: number}
type WantThread = {sub: string; id: string; limit: number}

/** A post as the bot reads it. */
type Out = {
  id: string
  title: string
  link: string
  url: string
  body: string
  created: number
  score: number
  comments: number
  removed: boolean
  author: string
  nsfw: boolean
  images: string[]
}

const out = (p: Post): Out => ({
  id: p.id,
  title: p.title,
  link: `https://www.reddit.com${p.permalink}`,
  url: p.url,
  body: (p.body ?? '').slice(0, BODY),
  created: Math.floor(p.createdAt.getTime() / 1000),
  score: p.score,
  comments: p.numberOfComments,
  removed: p.removed || p.spam || p.body === '[removed]' || p.body === '[deleted]',
  author: p.authorName,
  nsfw: p.nsfw,
  images: (p.gallery ?? []).map(g => g.url).filter(Boolean),
})

const listing = async (w: WantListing) => {
  const limit = Math.min(Math.max(w.limit, 1), 100)
  const l =
    w.kind === 'hot'
      ? reddit.getHotPosts({subredditName: w.sub, limit, pageSize: limit})
      : reddit.getTopPosts({subredditName: w.sub, timeframe: w.kind, limit, pageSize: limit})
  return {sub: w.sub, kind: w.kind, posts: (await l.all()).map(out)}
}

const thread = async (w: WantThread) => {
  const id = (w.id.startsWith('t3_') ? w.id : `t3_${w.id}`) as `t3_${string}`
  const post = await reddit.getPostById(id).catch(() => null)
  const limit = Math.min(Math.max(w.limit, 1), 100)
  const cs: Comment[] = post ? await reddit.getComments({postId: id, sort: 'top', depth: 1, limit, pageSize: limit}).all() : []
  return {
    sub: w.sub,
    id,
    post: post ? out(post) : null,
    comments: cs
      .filter(c => c.body && c.body !== '[removed]' && c.body !== '[deleted]')
      .map(c => ({body: c.body.slice(0, COMMENT), created: Math.floor(c.createdAt.getTime() / 1000), score: c.score})),
  }
}

/** Every item on its own: one failing subreddit or thread doesn't sink the rest. */
const each = async <A, B>(xs: A[], f: (x: A) => Promise<B>) => {
  const done: B[] = []
  const failed: string[] = []
  for (const x of xs) {
    try {
      done.push(await f(x))
    } catch (e) {
      failed.push(`${JSON.stringify(x)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return {done, failed}
}

/** POST /external/read: { listings?, threads? } in, the same fetched out (each item on its own). */
type ReadReq = {listings?: WantListing[]; threads?: WantThread[]}
async function read(req: ReadReq) {
  const ls = await each(req.listings ?? [], listing)
  const ts = await each(req.threads ?? [], thread)
  return {listings: ls.done, threads: ts.done, failed: [...ls.failed, ...ts.failed]}
}

export async function onReq(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  try {
    if (req.method === 'POST' && req.url?.split('?')[0] === '/external/read') {
      const body = await readJson<ReadReq>(req)
      return writeJson(200, await read(body), rsp)
    }
    writeJson(404, {error: 'not found'}, rsp)
  } catch (err) {
    console.error(`failed: ${err instanceof Error ? err.stack : err}`)
    writeJson(500, {error: String(err)}, rsp)
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  req.on('data', c => chunks.push(c))
  await once(req, 'end')
  const text = `${Buffer.concat(chunks)}`
  return (text ? JSON.parse(text) : {}) as T
}

function writeJson(status: number, json: object, rsp: ServerResponse): void {
  const body = JSON.stringify(json)
  rsp.writeHead(status, {'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/json'})
  rsp.end(body)
}
