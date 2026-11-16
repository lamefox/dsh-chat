/**
 * End-to-end smoke test without the DSH boot: mounts the plugin's routes on a
 * plain http server and points the proxy at a fake upstream.
 *
 *   node test/smoke.mjs
 */
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const storeHome = mkdtempSync(join(tmpdir(), 'dsh-chat-smoke-'))
process.env.DSH_HOME = storeHome
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const sse = (frames) =>
  frames
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')

const upstreamFrames = [
  {
    event: 'message_start',
    data: { type: 'message_start', message: { id: 'm1', model: 'deepseek-flash', usage: { input_tokens: 12, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先搜索一下。' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'server_tool_use',
        id: 'srvtoolu_s_1_abc',
        name: 'deepseek_web_search',
        input: { action: 'search', queries: ['DeepSeek V4.1'] },
        caller: { type: 'direct' },
        kind: 'search',
      },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_s_1_abc',
        kind: 'search',
        content: [
          { type: 'web_search_result', title: '更新说明', url: 'https://api-docs.deepseek.com/news/news261017/', snippet: '新版本要点', site_name: 'DeepSeek', site_icon: null, page_age: null, encrypted_content: 'x' },
        ],
      },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'V4.1 ' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '新增了工具能力。' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://api-docs.deepseek.com/news/news261017/', title: '更新说明', encrypted_index: '', cited_text: 'V4.1 新增了工具能力。' } } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 3 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, title: 'DeepSeek V4.1 更新' }, usage: { input_tokens: 9078, output_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
]

let received = null
const upstream = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  received = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(sse(upstreamFrames))
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/anthropic/v1`

const routes = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    getOrigin() {
      return `http://127.0.0.1:${server.address().port}`
    },
  },
  logger: () => ({ info() {}, warn() {} }),
  effect: (factory) => factory(),
}

apply(ctx, { apiKey: 'test-key', baseUrl: upstreamUrl, openBrowser: 'never' })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const exact = routes.find((route) => route.kind === 'exact' && route.path === url.pathname)
  // Mirror the host contract: a prefix matches itself or `p/<anything>`, and a
  // registered path never carries a trailing slash (a trailing slash never matches).
  const prefix = routes.find(
    (route) =>
      route.kind === 'prefix' &&
      (url.pathname === route.path || url.pathname.startsWith(`${route.path}/`))
  )
  const route = exact ?? prefix
  if (!route) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  await route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

// 0. route contract: no trailing slashes, unique (kind, path)
const seen = new Set()
for (const route of routes) {
  assert.equal(route.path.endsWith('/'), false, `prefix/exact path must not end with "/": ${route.path}`)
  const key = `${route.kind} ${route.path}`
  assert.equal(seen.has(key), false, `duplicate route ${key}`)
  seen.add(key)
}

// 1. the page boots with an injected token and no template placeholders left
const page = await (await fetch(`${origin}/chat`)).text()
assert.match(page, /dsh-chat/, 'page renders the app shell')
assert.match(page, /name="dsh-chat-token" content="[^"]{10,}"/, 'page carries a page token')
assert.doesNotMatch(page, /__DSH_CHAT_TOKEN__/, 'token placeholder replaced')
assert.doesNotMatch(page, /__DSH_CHAT_STATE__/, 'state placeholder replaced')
const token = /name="dsh-chat-token" content="([^"]+)"/.exec(page)[1]

// 2. assets are served
for (const [file, type] of [['app.js', 'javascript'], ['style.css', 'text/css']]) {
  const response = await fetch(`${origin}/chat/${file}`)
  assert.equal(response.status, 200, `${file} served`)
  assert.match(response.headers.get('content-type') ?? '', new RegExp(type), `${file} content type`)
}

// 3. the proxy refuses a request without the page token
const denied = await fetch(`${origin}/chat/api/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [] }),
})
assert.equal(denied.status, 401, 'missing token rejected')

// 4. the proxy injects chat-demo fields and streams SSE verbatim
const streamed = await fetch(`${origin}/chat/api/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-chat-token': token },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'DeepSeek V4.1 有哪些更新？' }], model: 'from-client' }),
})
assert.equal(streamed.status, 200)
assert.match(streamed.headers.get('content-type') ?? '', /text\/event-stream/)
const text = await streamed.text()
assert.match(text, /event: message_stop/, 'SSE reaches the client untouched')
assert.match(text, /web_search_tool_result/, 'search result block forwarded')
assert.match(text, /citations_delta/, 'citation delta forwarded')

assert.equal(received.url, '/anthropic/v1/messages')
assert.equal(received.headers['x-api-key'], 'test-key', 'key injected server side')
assert.equal(received.body.stream, true, 'stream forced on')
assert.equal(received.body.model, 'from-client', 'client model wins over the default')
assert.deepEqual(received.body.tools, [
  { type: 'deepseek_web_search', name: 'deepseek_web_search' },
  { type: 'deepseek_read_url', name: 'deepseek_read_url' },
])
assert.deepEqual(received.body.safety_check, { level: 'high' })
assert.deepEqual(received.body.title, { enabled: true })

// 4b. a client may narrow the tool set, never widen it
const narrow = await fetch(`${origin}/chat/api/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-chat-token': token },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'deepseek_web_search' }, { name: 'some_client_tool' }],
  }),
})
assert.equal(narrow.status, 200)
await narrow.text()
assert.deepEqual(received.body.tools, [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }], 'subset honoured, unknown tool dropped')

const none = await fetch(`${origin}/chat/api/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-chat-token': token },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
})
assert.equal(none.status, 200)
await none.text()
assert.equal('tools' in received.body, false, 'empty pill state sends no tools at all')
assert.deepEqual(received.body.safety_check, { level: 'high' }, 'safety check is not affected by the pills')

// 5. state reports the key without leaking it
const state = await (await fetch(`${origin}/chat/api/state`, { headers: { 'x-dsh-chat-token': token } })).json()
assert.equal(state.hasKey, true)
assert.equal(state.keyRef, 'entry config')
assert.equal(JSON.stringify(state).includes('test-key'), false, 'state never leaks the key')

// 6. an upstream failure keeps its status and message
received = null
const failing = http.createServer(async (req, res) => {
  res.writeHead(429, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }))
})
await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve))
const failingRoutes = []
apply(
  { ...ctx, webServer: { ...ctx.webServer, register: (route) => (failingRoutes.push(route), () => {}) } },
  { apiKey: 'k', baseUrl: `http://127.0.0.1:${failing.address().port}/anthropic/v1`, openBrowser: 'never' }
)
const failingServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = failingRoutes.find((entry) => entry.path === url.pathname)
  await route.handler(req, res)
})
await new Promise((resolve) => failingServer.listen(0, '127.0.0.1', resolve))
const failingPage = await (await fetch(`http://127.0.0.1:${failingServer.address().port}/chat`)).text()
const failingToken = /name="dsh-chat-token" content="([^"]+)"/.exec(failingPage)[1]
const limited = await fetch(`http://127.0.0.1:${failingServer.address().port}/chat/api/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-chat-token': failingToken },
  body: JSON.stringify({ messages: [] }),
})
assert.equal(limited.status, 429, 'upstream status preserved')
assert.match(await limited.text(), /rate limited/, 'upstream error body preserved')

// 7. durable store: sessions, messages, search, delete
const json = (res) => res.json()
const auth = { 'x-dsh-chat-token': token, 'content-type': 'application/json' }

const created = await json(
  await fetch(`${origin}/chat/api/sessions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ id: 'smoke-s1', title: '冒烟会话' }),
  })
)
assert.equal(created.session.id, 'smoke-s1')

const first = await json(
  await fetch(`${origin}/chat/api/sessions/smoke-s1/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ message: { id: 'sm1', role: 'user', text: '南京 GEO 服务商有哪些', at: 1 } }),
  })
)
assert.equal(first.seq, 1)

const second = await json(
  await fetch(`${origin}/chat/api/sessions/smoke-s1/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      message: { id: 'sm2', role: 'assistant', status: 'done', blocks: [{ type: 'text', text: '服务商盘点推荐' }], at: 2 },
    }),
  })
)
assert.equal(second.seq, 2)

const loaded = await json(await fetch(`${origin}/chat/api/sessions/smoke-s1`, { headers: auth }))
assert.equal(loaded.messages.length, 2, 'both messages load in order')

const list = await json(await fetch(`${origin}/chat/api/sessions`, { headers: auth }))
assert.equal(list.sessions[0].messageCount, 2)

const hits = await json(await fetch(`${origin}/chat/api/search?q=${encodeURIComponent('服务商')}`, { headers: auth }))
assert.ok(hits.hits.length >= 1, 'full-text search finds the answer')

const imported = await json(
  await fetch(`${origin}/chat/api/import`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ sessions: [{ id: 'legacy', title: '旧会话', createdAt: 1, messages: [{ role: 'user', text: '旧问题' }] }] }),
  })
)
assert.equal(imported.imported, 1, 'browser data can be imported')

const rewound = await json(
  await fetch(`${origin}/chat/api/sessions/smoke-s1/messages/delete`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ids: ['sm2'] }),
  })
)
assert.equal(rewound.removed, 1, 'regenerate can rewind a single answer')
assert.equal((await json(await fetch(`${origin}/chat/api/sessions/smoke-s1`, { headers: auth }))).messages.length, 1)

const removed = await json(
  await fetch(`${origin}/chat/api/sessions/smoke-s1`, { method: 'DELETE', headers: auth })
)
assert.equal(removed.ok, true)
assert.equal((await fetch(`${origin}/chat/api/sessions/smoke-s1`, { headers: auth })).status, 404, 'deleted session is gone')

// 8. workspaces group conversations without owning them
const workspace = await json(
  await fetch(`${origin}/chat/api/workspaces`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ id: 'ws-1', name: '工作区 A' }),
  })
)
assert.equal(workspace.workspace.name, '工作区 A')

const moved = await json(
  await fetch(`${origin}/chat/api/sessions/legacy`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ workspaceId: 'ws-1' }),
  })
)
assert.equal(moved.ok, true)

const grouped = await json(await fetch(`${origin}/chat/api/sessions?workspaceId=ws-1`, { headers: auth }))
assert.deepEqual(grouped.sessions.map((session) => session.id), ['legacy'], 'the filter returns only grouped sessions')
const ungrouped = await json(await fetch(`${origin}/chat/api/sessions?workspaceId=none`, { headers: auth }))
assert.equal(ungrouped.sessions.length, 0)

const renamed = await json(
  await fetch(`${origin}/chat/api/workspaces/ws-1`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ name: '改名后的工作区' }),
  })
)
assert.equal(renamed.ok, true)
assert.equal((await json(await fetch(`${origin}/chat/api/workspaces`, { headers: auth }))).workspaces[0].name, '改名后的工作区')

const clearedWorkspace = await json(
  await fetch(`${origin}/chat/api/workspaces/ws-1`, { method: 'DELETE', headers: auth })
)
assert.equal(clearedWorkspace.ok, true)
const afterWorkspaceDelete = await json(await fetch(`${origin}/chat/api/sessions/legacy`, { headers: auth }))
assert.equal(afterWorkspaceDelete.session.workspaceId, null, 'a deleted workspace returns its sessions to ungrouped')
assert.equal((await json(await fetch(`${origin}/chat/api/sessions/legacy`, { headers: auth }))).messages.length, 1)

const cleared = await json(await fetch(`${origin}/chat/api/sessions`, { method: 'DELETE', headers: auth }))
assert.equal(cleared.removed, 1, 'clear-all removes every conversation')
assert.equal((await json(await fetch(`${origin}/chat/api/sessions`, { headers: auth }))).sessions.length, 0)

for (const closeable of [server, upstream, failingServer, failing]) closeable.close()
rmSync(storeHome, { recursive: true, force: true })
console.log('dsh-chat smoke: 20 checks passed')
