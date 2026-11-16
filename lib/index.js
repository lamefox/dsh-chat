/**
 * dsh-chat — an independent chat window over the DeepSeek Messages API.
 *
 * The plugin owns no session model: it mounts three static assets and four
 * proxy routes on the already-running DSH web server, then opens its own page
 * in a separate browser window. The proxy is the only place that sees the API
 * key, and it is the only place that injects the chat-demo request fields
 * (`tools`, `safety_check`, `title`) that the DSH agent adapter cannot carry.
 *
 * @module dsh-chat
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openStore, resolveDbPath } from './store.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Plugin name used by loader diagnostics. */
export const name = 'dsh-chat'

/** The web server is the only hard dependency; credentials are optional. */
export const inject = ['webServer']

const DEFAULTS = {
  path: '/chat',
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com/anthropic/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  apiKey: undefined,
  safetyCheck: 'high',
  search: true,
  readUrl: true,
  title: true,
  thinking: true,
  openBrowser: 'once',
  openDelayMs: 400,
  allowRemote: false,
  storage: 'sqlite',
  dbPath: undefined,
  auth: 'auto',
  maxBodyBytes: 16 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/** Normalize a configured mount path to an absolute pathname without trailing slash. */
function normalizePath(value) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULTS.path
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return withSlash.length > 1 ? withSlash.replace(/\/+$/u, '') : withSlash
}

/** Coerce the raw cordis entry config into the effective options object. */
function readConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const pick = (key) => (input[key] === undefined ? DEFAULTS[key] : input[key])
  const openBrowser = ['once', 'always', 'never'].includes(pick('openBrowser'))
    ? pick('openBrowser')
    : 'once'
  return {
    path: normalizePath(pick('path')),
    model: String(pick('model') ?? DEFAULTS.model),
    baseUrl: String(pick('baseUrl') ?? DEFAULTS.baseUrl).replace(/\/+$/u, ''),
    apiKeyEnv: String(pick('apiKeyEnv') ?? DEFAULTS.apiKeyEnv),
    apiKey: typeof pick('apiKey') === 'string' && pick('apiKey') !== '' ? pick('apiKey') : undefined,
    safetyCheck: pick('safetyCheck') === 'high' ? 'high' : 'off',
    search: pick('search') !== false,
    readUrl: pick('readUrl') !== false,
    title: pick('title') !== false,
    thinking: pick('thinking') !== false,
    openBrowser,
    openDelayMs: Number.isFinite(pick('openDelayMs')) ? Number(pick('openDelayMs')) : DEFAULTS.openDelayMs,
    allowRemote: pick('allowRemote') === true,
    storage: pick('storage') === 'none' ? 'none' : 'sqlite',
    dbPath: typeof pick('dbPath') === 'string' && pick('dbPath').trim() !== '' ? pick('dbPath').trim() : undefined,
    auth: ['auto', 'apiKey', 'account'].includes(pick('auth')) ? pick('auth') : 'auto',
    maxBodyBytes: Number.isFinite(pick('maxBodyBytes')) ? Number(pick('maxBodyBytes')) : DEFAULTS.maxBodyBytes,
    maxFileBytes: Number.isFinite(pick('maxFileBytes')) ? Number(pick('maxFileBytes')) : DEFAULTS.maxFileBytes,
  }
}

/** Read a request body into one Buffer, refusing oversized payloads. */
async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) {
      const error = new Error(`request body exceeds ${limit} bytes`)
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Read and parse a JSON request body. */
async function readJsonBody(req, limit) {
  const text = (await readBody(req, limit)).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    throw error
  }
}

/** Write a JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Write a plain-text error response. */
function sendText(res, status, message) {
  const body = String(message ?? '')
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Wrap a route handler so a thrown error becomes a JSON 500 instead of a dropped request. */
function guard(label, handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const message = `${label}: ${error instanceof Error ? error.message : String(error)}`
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, 500, { error: { message } })
    }
  }
}

/** Random session id for a client that lets the host allocate one. */
const randomId = () => randomBytes(9).toString('base64url')

/** Read one static asset from this package. */
async function readAsset(file) {
  return readFile(join(HERE, file))
}

/** Open a URL in a detached platform browser window. */
function openWindow(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Whether a socket address is loopback, so the page is only reachable from this machine. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  return (
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    /^127\./u.test(address) ||
    /^::ffff:127\./u.test(address)
  )
}

/** Wait until the web server reports its listening origin. */
async function waitForOrigin(ctx, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      if (Date.now() > deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

/**
 * Mount the chat window: static assets, proxy routes, and the startup window.
 * @param ctx - cordis context with the web server service.
 * @param rawConfig - entry config from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const cfg = readConfig(rawConfig)
  const token = randomBytes(18).toString('base64url')
  const base = cfg.path
  const apiBase = `${base}/api`
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-chat') : undefined

  /** Resolve the upstream API key without ever logging it. */
  const resolveApiKey = async () => {
    if (cfg.apiKey !== undefined) return cfg.apiKey
    const fromEnv = process.env[cfg.apiKeyEnv]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
    // `ctx.<service>` throws for services outside `inject`; `ctx.get()` is the safe read.
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(cfg.apiKeyEnv)
        const value = resolved?.value ?? resolved?.secret
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      } catch {
        /* a missing reference is reported to the page as "no key" */
      }
    }
    return undefined
  }

  /**
   * Header carrying the DeepSeek account grant. The official account adapter
   * sends the same header, and `resolveToken` refuses any origin that is not the
   * configured inference origin, so a custom baseUrl simply falls through.
   */
  const ACCOUNT_HEADER = 'x-dsh-auth-token'

  /**
   * Resolve how to authenticate one upstream call.
   * @param targetUrl - upstream base URL; the account grant is origin-scoped.
   * @returns `{ header, value, kind }`, or undefined when nothing is configured.
   */
  const resolveAuth = async (targetUrl) => {
    if (cfg.auth !== 'apiKey') {
      // `ctx.<service>` throws outside `inject`; `ctx.get()` is the safe read.
      const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
      if (account !== undefined && typeof account.resolveToken === 'function') {
        try {
          const token = await account.resolveToken(targetUrl)
          if (typeof token === 'string' && token !== '') {
            return { header: ACCOUNT_HEADER, value: token, kind: 'account' }
          }
        } catch {
          /* a storage or protocol failure just falls back to the API key */
        }
      }
    }
    if (cfg.auth === 'account') return undefined
    const key = await resolveApiKey()
    return key === undefined ? undefined : { header: 'x-api-key', value: key, kind: 'apiKey' }
  }

  /** Reject a proxied call that does not carry this process's page token. */
  const authorized = (req) => {
    const header = req.headers['x-dsh-chat-token']
    return typeof header === 'string' && header === token
  }

  /**
   * Gate a request: the page token cannot protect a page that hands the token
   * out, so a non-loopback peer is refused unless the entry opts in.
   */
  const admit = (req, res) => {
    if (cfg.allowRemote) return true
    if (isLoopbackAddress(req.socket?.remoteAddress)) return true
    sendText(res, 403, 'dsh-chat only serves loopback clients; set allowRemote: true to change that')
    return false
  }

  const upstreamHeaders = (acceptSse) => ({
    'content-type': 'application/json',
    ...(acceptSse ? { accept: 'text/event-stream' } : {}),
  })

  let store
  if (cfg.storage !== 'none') {
    try {
      store = openStore({ file: resolveDbPath(cfg.dbPath) })
      logger?.info?.(`dsh-chat store: ${store.file}`)
    } catch (error) {
      logger?.warn?.(`dsh-chat storage disabled: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Every storage route answers 501 when the host cannot open SQLite. */
  const requireStore = (res) => {
    if (store !== undefined && store !== null) return true
    sendJson(res, 501, { error: { message: 'dsh-chat storage is unavailable on this host' } })
    return false
  }

  const disposers = []
  const route = (kind, path, handler) =>
    disposers.push(ctx.webServer.register({ kind, path, handler: guard(`${kind} ${path}`, handler) }))

  // ── static assets ───────────────────────────────────────────────────────
  route('exact', base, async (req, res) => {
    if (!admit(req, res)) return
    try {
      const template = (await readAsset('page.html')).toString('utf8')
      const page = template
        .replaceAll('__DSH_CHAT_TOKEN__', token)
        .replaceAll('__DSH_CHAT_PATH__', base)
        .replaceAll('__DSH_CHAT_STATE__', JSON.stringify(publicState(cfg)).replaceAll('<', '\\u003c'))
      res.writeHead(200, {
        'content-type': MIME['.html'],
        'content-length': Buffer.byteLength(page),
        'cache-control': 'no-store',
        'x-frame-options': 'SAMEORIGIN',
      })
      res.end(page)
    } catch (error) {
      sendText(res, 500, `dsh-chat: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  for (const file of ['app.js', 'style.css']) {
    const ext = file.slice(file.lastIndexOf('.'))
    route('exact', `${base}/${file}`, async (req, res) => {
      if (!admit(req, res)) return
      try {
        const asset = await readAsset(file)
        res.writeHead(200, {
          'content-type': MIME[ext],
          'content-length': asset.length,
          'cache-control': 'no-store',
        })
        res.end(asset)
      } catch (error) {
        sendText(res, 404, `dsh-chat: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  // ── state ───────────────────────────────────────────────────────────────
  route('exact', `${apiBase}/state`, async (req, res) => {
    if (!admit(req, res)) return
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })
    const auth = await resolveAuth(cfg.baseUrl)
    sendJson(res, 200, {
      ...publicState(cfg),
      storage: store === undefined ? 'none' : 'sqlite',
      auth: cfg.auth,
      hasAuth: auth !== undefined,
      authKind: auth?.kind ?? 'none',
      hasKey: auth?.kind === 'apiKey',
      keyRef: auth?.kind === 'account' ? 'DeepSeek account' : cfg.apiKey === undefined ? cfg.apiKeyEnv : 'entry config',
    })
  })

  // ── messages (SSE proxy) ────────────────────────────────────────────────
  route('exact', `${apiBase}/messages`, async (req, res) => {
    if (!admit(req, res)) return
    if (req.method !== 'POST') return sendText(res, 405, 'POST required')
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })

    let body
    try {
      body = await readJsonBody(req, cfg.maxBodyBytes)
    } catch (error) {
      return sendText(res, error.status ?? 400, error.message)
    }

    const auth = await resolveAuth(cfg.baseUrl)
    if (auth === undefined) {
      return sendJson(res, 503, {
        error: {
          message:
            cfg.auth === 'account'
              ? 'dsh-chat is set to account auth but no DeepSeek account grant is available: sign in under Settings → Models, or switch auth to auto/apiKey'
              : `dsh-chat has no API key: set ${cfg.apiKeyEnv}, write it into the entry config, or store it through the DSH credentials service (or sign in to DeepSeek to use account auth)`,
          type: 'no_api_key',
        },
      })
    }

    const payload = {
      ...body,
      model: body.model ?? cfg.model,
      stream: true,
    }
    // chat-demo request fields the DSH agent adapter cannot carry. The entry
    // config is the ceiling; a request may narrow it (the composer pills do),
    // but can never enable a tool the deployment disabled.
    const allowed = []
    if (cfg.search) allowed.push('deepseek_web_search')
    if (cfg.readUrl) allowed.push('deepseek_read_url')
    const requested = Array.isArray(body.tools)
      ? body.tools
          .map((tool) => (typeof tool?.name === 'string' ? tool.name : ''))
          .filter((tool) => allowed.includes(tool))
      : allowed
    const tools = requested.map((tool) => ({ type: tool, name: tool }))
    if (tools.length > 0) payload.tools = tools
    else delete payload.tools
    if (cfg.safetyCheck === 'high') payload.safety_check = { level: 'high' }
    if (cfg.title) payload.title = { enabled: true }

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    let upstream
    try {
      upstream = await fetch(`${cfg.baseUrl}/messages`, {
        method: 'POST',
        headers: { ...upstreamHeaders(true), [auth.header]: auth.value },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      return sendJson(res, 502, {
        error: { message: `upstream request failed: ${error instanceof Error ? error.message : String(error)}` },
      })
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(text === '' ? JSON.stringify({ error: { message: upstream.statusText } }) : text)
      return
    }

    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    try {
      for await (const chunk of upstream.body) res.write(chunk)
    } catch {
      /* a client disconnect surfaces here; nothing to report */
    } finally {
      res.end()
    }
  })

  // ── sessions (durable store) ────────────────────────────────────────────
  route('exact', `${apiBase}/sessions`, async (req, res) => {
    if (!admit(req, res)) return
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })
    if (!requireStore(res)) return

    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET') {
      return sendJson(res, 200, { sessions: store.listSessions({ workspaceId: url.searchParams.get('workspaceId') ?? undefined }) })
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, { removed: store.deleteAllSessions() })
    }
    if (req.method !== 'POST') return sendText(res, 405, 'GET, POST or DELETE required')

    let body
    try {
      body = await readJsonBody(req, cfg.maxBodyBytes)
    } catch (error) {
      return sendText(res, error.status ?? 400, error.message)
    }
    const id = typeof body.id === 'string' && body.id !== '' ? body.id : randomId()
    const session = store.createSession({
      id,
      title: body.title,
      createdAt: body.createdAt,
      workspaceId: body.workspaceId,
    })
    sendJson(res, 200, { session })
  })

  route('prefix', `${apiBase}/sessions`, async (req, res) => {
    if (!admit(req, res)) return
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })
    if (!requireStore(res)) return

    const url = new URL(req.url ?? '/', 'http://localhost')
    const rest = url.pathname.slice(`${apiBase}/sessions`.length).replace(/^\/+/, '')
    const segments = rest.split('/').filter(Boolean)
    if (segments.length === 0) return sendText(res, 404, 'session id required')
    const id = decodeURIComponent(segments[0])

    let body
    const readBodyOnce = async () => {
      if (body !== undefined) return body
      try {
        body = await readJsonBody(req, cfg.maxBodyBytes)
      } catch (error) {
        throw Object.assign(error, { handled: true })
      }
      return body
    }

    try {
      if (segments.length === 1) {
        if (req.method === 'GET') {
          const found = store.getSession(id)
          if (found === undefined) return sendJson(res, 404, { error: { message: 'session not found' } })
          return sendJson(res, 200, found)
        }
        if (req.method === 'PATCH') {
          const payload = await readBodyOnce()
          let touched = false
          if (payload.title !== undefined) touched = store.renameSession(id, payload.title) || touched
          if (payload.workspaceId !== undefined) touched = store.moveSession(id, payload.workspaceId) || touched
          return sendJson(res, touched ? 200 : 404, { ok: touched })
        }
        if (req.method === 'DELETE') {
          return sendJson(res, store.deleteSession(id) ? 200 : 404, { ok: true })
        }
        return sendText(res, 405, 'GET, PATCH or DELETE required')
      }

      if (segments[1] === 'messages' && segments.length === 2 && req.method === 'POST') {
        const payload = await readBodyOnce()
        if (typeof payload.message?.id !== 'string' || payload.message.id === '') {
          return sendJson(res, 400, { error: { message: 'message.id is required' } })
        }
        return sendJson(res, 200, { seq: store.upsertMessage(id, payload.message) })
      }

      if (segments[1] === 'messages' && segments[2] === 'delete' && req.method === 'POST') {
        const payload = await readBodyOnce()
        return sendJson(res, 200, { removed: store.deleteMessages(id, payload.ids) })
      }

      return sendText(res, 404, 'unknown session route')
    } catch (error) {
      if (error?.handled === true) return sendText(res, error.status ?? 400, error.message)
      throw error
    }
  })

  route('exact', `${apiBase}/workspaces`, async (req, res) => {
    if (!admit(req, res)) return
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })
    if (!requireStore(res)) return

    if (req.method === 'GET') return sendJson(res, 200, { workspaces: store.listWorkspaces() })
    if (req.method !== 'POST') return sendText(res, 405, 'GET or POST required')

    let body
    try {
      body = await readJsonBody(req, cfg.maxBodyBytes)
    } catch (error) {
      return sendText(res, error.status ?? 400, error.message)
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return sendJson(res, 400, { error: { message: 'workspace name is required' } })
    }
    const id = typeof body.id === 'string' && body.id !== '' ? body.id : randomId()
    sendJson(res, 200, { workspace: store.createWorkspace({ id, name: body.name, sort: body.sort }) })
  })

  route('prefix', `${apiBase}/workspaces`, async (req, res) => {
    if (!admit(req, res)) return
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })
    if (!requireStore(res)) return

    const url = new URL(req.url ?? '/', 'http://localhost')
    const rest = url.pathname.slice(`${apiBase}/workspaces`.length).replace(/^\/+/, '')
    const segments = rest.split('/').filter(Boolean)
    if (segments.length === 0) return sendText(res, 404, 'workspace id required')
    const id = decodeURIComponent(segments[0])

    if (req.method === 'DELETE') {
      return sendJson(res, store.deleteWorkspace(id) ? 200 : 404, { ok: true })
    }
    if (req.method === 'PATCH') {
      let body
      try {
        body = await readJsonBody(req, cfg.maxBodyBytes)
      } catch (error) {
        return sendText(res, error.status ?? 400, error.message)
      }
      const renamed = store.renameWorkspace(id, body.name)
      return sendJson(res, renamed ? 200 : 404, { ok: renamed })
    }
    return sendText(res, 405, 'PATCH or DELETE required')
  })

  route('exact', `${apiBase}/search`, async (req, res) => {
    if (!admit(req, res)) return
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })
    if (!requireStore(res)) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    const query = url.searchParams.get('q') ?? ''
    sendJson(res, 200, { hits: store.search(query, Number(url.searchParams.get('limit') ?? 20)) })
  })

  route('exact', `${apiBase}/import`, async (req, res) => {
    if (!admit(req, res)) return
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })
    if (!requireStore(res)) return
    if (req.method !== 'POST') return sendText(res, 405, 'POST required')
    let body
    try {
      body = await readJsonBody(req, cfg.maxBodyBytes)
    } catch (error) {
      return sendText(res, error.status ?? 400, error.message)
    }
    const workspaces = store.importWorkspaces(body.workspaces)
    const imported = store.importSessions(body.sessions)
    sendJson(res, 200, { imported, workspaces })
  })

  // ── files (multipart passthrough) ───────────────────────────────────────
  route('exact', `${apiBase}/files`, async (req, res) => {
    if (!admit(req, res)) return
    if (req.method !== 'POST') return sendText(res, 405, 'POST required')
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })

    const auth = await resolveAuth(cfg.baseUrl)
    if (auth === undefined) {
      return sendJson(res, 503, { error: { message: `dsh-chat has no credentials (${cfg.apiKeyEnv} or a DeepSeek account sign-in)` } })
    }

    let raw
    try {
      raw = await readBody(req, cfg.maxFileBytes)
    } catch (error) {
      return sendText(res, error.status ?? 400, error.message)
    }

    const upstream = await fetch(`${cfg.baseUrl}/files`, {
      method: 'POST',
      headers: {
        [auth.header]: auth.value,
        'content-type': req.headers['content-type'] ?? 'application/octet-stream',
        'anthropic-beta': 'files-api-2025-04-14',
      },
      body: raw,
    }).catch((error) => error)

    if (upstream instanceof Error) {
      return sendJson(res, 502, { error: { message: `upstream upload failed: ${upstream.message}` } })
    }
    const text = await upstream.text().catch(() => '')
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text === '' ? JSON.stringify({ error: { message: upstream.statusText } }) : text)
  })

  route('prefix', `${apiBase}/files`, async (req, res) => {
    if (!admit(req, res)) return
    if (req.method !== 'DELETE') return sendText(res, 405, 'DELETE required')
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or stale page token' })

    const auth = await resolveAuth(cfg.baseUrl)
    if (auth === undefined) return sendJson(res, 503, { error: { message: 'no credentials' } })

    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = url.pathname.slice(`${apiBase}/files`.length).replace(/^\/+/, '')
    if (id === '') return sendJson(res, 400, { error: { message: 'file id required' } })

    const upstream = await fetch(`${cfg.baseUrl}/files/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { [auth.header]: auth.value, 'anthropic-beta': 'files-api-2025-04-14' },
    }).catch((error) => error)

    if (upstream instanceof Error) {
      return sendJson(res, 502, { error: { message: upstream.message } })
    }
    res.writeHead(upstream.status)
    res.end(await upstream.text().catch(() => ''))
  })

  // ── startup window ──────────────────────────────────────────────────────
  let opened = false
  const openOnce = async () => {
    if (cfg.openBrowser === 'never') return
    if (opened && cfg.openBrowser !== 'always') return
    const origin = await waitForOrigin(ctx, 30_000)
    if (origin === undefined) {
      logger?.warn?.(`dsh-chat could not resolve the web origin; open ${base} manually`)
      return
    }
    opened = true
    const url = `${origin}${base}`
    logger?.info?.(`dsh-chat window: ${url}`)
    process.stdout.write(`[dsh-chat] window: ${url}\n`)
    setTimeout(() => openWindow(url), cfg.openDelayMs)
  }

  // The entry is mounted before the listener binds, so poll once per boot.
  const timer = setTimeout(() => {
    openOnce().catch(() => {})
  }, 0)
  timer.unref?.()

  const dispose = () => {
    clearTimeout(timer)
    try {
      store?.close()
    } catch {
      /* already closed */
    }
    for (const d of disposers.splice(0)) {
      try {
        d()
      } catch {
        /* already disposed */
      }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
}

/** The subset of the config the page may see. */
function publicState(cfg) {
  return {
    path: cfg.path,
    model: cfg.model,
    search: cfg.search,
    readUrl: cfg.readUrl,
    safetyCheck: cfg.safetyCheck,
    title: cfg.title,
    thinking: cfg.thinking,
  }
}

