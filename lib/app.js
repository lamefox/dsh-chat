/**
 * dsh-chat browser client.
 *
 * The page keeps the conversation locally (localStorage) and sends the whole
 * request to the host proxy, which owns the API key and injects the chat-demo
 * request fields. Rendering mirrors chat-demo's block model: thinking, text
 * with citations, server tool calls and their results.
 */

const boot = JSON.parse(document.getElementById('boot').textContent)
const TOKEN = document.querySelector('meta[name="dsh-chat-token"]').content
const API = `${boot.path}/api`
const STORE_KEY = 'dsh-chat:v1'

const LAYOUT_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])
const IMAGE_MIME = /^image\//i

// ── store ──────────────────────────────────────────────────────────────────

const loadStore = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')
    if (raw && Array.isArray(raw.sessions)) {
      return { sessions: raw.sessions, activeId: raw.activeId ?? null, theme: raw.theme ?? 'auto' }
    }
  } catch {
    /* fall through to a fresh store */
  }
  return { sessions: [], activeId: null, theme: 'auto' }
}

const PREFS_KEY = 'dsh-chat:prefs:v2'

/**
 * Per-window capability switches exposed as composer pills.
 * Thinking starts off (one more reasoning pass is opt-in); search starts on.
 */
const loadPrefs = () => {
  const fallback = { thinking: false, search: boot.search !== false }
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')
    if (raw !== null && typeof raw === 'object') {
      return {
        thinking: typeof raw.thinking === 'boolean' ? raw.thinking : fallback.thinking,
        search: typeof raw.search === 'boolean' ? raw.search : fallback.search,
      }
    }
  } catch {
    /* fall through to the config defaults */
  }
  return fallback
}

const prefs = loadPrefs()

const savePrefs = () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* a full quota only costs persistence of the toggles */
  }
}

const store = loadStore()
if (!Array.isArray(store.workspaces)) store.workspaces = []

/** Sidebar filter: 'all', 'none', or a workspace id. */
const WORKSPACE_FILTER_KEY = 'dsh-chat:workspace-filter'
let workspaceFilter = 'all'
try {
  const savedFilter = localStorage.getItem(WORKSPACE_FILTER_KEY)
  if (typeof savedFilter === 'string' && savedFilter !== '') workspaceFilter = savedFilter
} catch {
  /* ignore a disabled storage */
}

const THEME_KEY = 'dsh-chat:theme'
try {
  const savedTheme = localStorage.getItem(THEME_KEY)
  if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'auto') store.theme = savedTheme
} catch {
  /* a disabled storage keeps the default theme */
}

/**
 * Persistence mode. `server` means the host owns a SQLite database and the
 * browser is a cache; `local` is the fallback for a host whose plugin predates
 * the storage routes (the page must never break because the host was not
 * restarted). Mode is decided once at boot by probing `GET /api/sessions`.
 */
const remote = { enabled: false }

const saveStore = () => {
  if (remote.enabled) return // the database is the source of truth
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
  } catch {
    toast('本地存储已满，请删除部分会话')
  }
}

let persistFailed = false
/** Fire-and-forget write with one visible failure per session. */
const persist = (label, run) => {
  if (!remote.enabled) return
  run().catch((error) => {
    console.warn(`dsh-chat persist ${label} failed`, error)
    if (!persistFailed) {
      persistFailed = true
      toast(`保存到本机数据库失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

const persistSession = (session) =>
  persist('session', async () => {
    const response = await apiFetch('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: session.id, title: session.title, createdAt: session.createdAt }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  })

const persistTitle = (session) =>
  persist('title', async () => {
    const response = await apiFetch(`/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: session.title }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  })

const persistMessage = (session, message) =>
  persist('message', async () => {
    const response = await apiFetch(`/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  })

const forgetMessages = (session, ids) => {
  if (!remote.enabled || ids.length === 0) return
  persist('delete-messages', async () => {
    const response = await apiFetch(`/sessions/${encodeURIComponent(session.id)}/messages/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  })
}

const persistWorkspace = (workspace) =>
  persist('workspace', async () => {
    const response = await apiFetch('/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: workspace.id, name: workspace.name }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  })

const renameWorkspaceRemote = (id, name) =>
  persist('rename-workspace', async () => {
    const response = await apiFetch(`/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  })

const forgetWorkspace = (id) =>
  persist('delete-workspace', async () => {
    const response = await apiFetch(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`)
  })

const moveSessionRemote = (session) =>
  persist('move-session', async () => {
    const response = await apiFetch(`/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: session.workspaceId ?? null }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  })

const clearAllRemote = () =>
  persist('clear-all', async () => {
    const response = await apiFetch('/sessions', { method: 'DELETE' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  })

const forgetSession = (id) => {
  if (!remote.enabled) return
  persist('delete-session', async () => {
    const response = await apiFetch(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`)
  })
}

/** Load one session's transcript on demand; the list only carries metadata. */
const ensureLoaded = async (session) => {
  if (!remote.enabled || session === undefined || session === null) return
  if (Array.isArray(session.messages) || session.loading === true) return
  session.loading = true
  try {
    const response = await apiFetch(`/sessions/${encodeURIComponent(session.id)}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    session.messages = (data.messages ?? []).map((message) => ({ ...message, id: message.id ?? uid() }))
    if (typeof data.session?.title === 'string' && data.session.title !== '') session.title = data.session.title
  } catch (error) {
    session.messages = []
    toast(`加载对话失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    session.loading = false
    render()
  }
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const activeSession = () => store.sessions.find((s) => s.id === store.activeId) ?? null

const newSession = () => {
  const session = {
    id: uid(),
    title: '新对话',
    createdAt: Date.now(),
    messages: [],
    workspaceId: workspaceFilter === 'all' || workspaceFilter === 'none' ? null : workspaceFilter,
  }
  store.sessions.unshift(session)
  store.activeId = session.id
  saveStore()
  persistSession(session)
  return session
}

// ── dom helpers ────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Minimal stroke icons for message actions, matching the muted action bar. */
const ICONS = {
  copy: 'M9 9h9v10a1 1 0 01-1 1H9a1 1 0 01-1-1V9zM15 9V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3',
  speak: 'M11 5L6 9H3v6h3l5 4V5zM15.5 9a4 4 0 010 6',
  refresh: 'M20 12a8 8 0 11-2.3-5.6M20 4v4h-4',
  share: 'M9 13l6-4M9 11l6 4M6 15a3 3 0 110-6 3 3 0 010 6zM18 9a3 3 0 110-6 3 3 0 010 6zM18 21a3 3 0 110-6 3 3 0 010 6z',
  edit: 'M4 20h4l10-10a2.8 2.8 0 10-4-4L4 16v4z',
  more: 'M12 5v14M6 11l6 6 6-6',
}

const iconSvg = (kind, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[kind]}"/></svg>`

const iconButton = (kind, title, onClick) => {
  const button = el('button')
  button.title = title
  button.setAttribute('aria-label', title)
  button.innerHTML = iconSvg(kind)
  button.onclick = onClick
  return button
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

let toastTimer
const toast = (message) => {
  let node = document.querySelector('.toast')
  if (!node) {
    node = el('div', 'toast')
    document.body.append(node)
  }
  node.textContent = message
  node.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600)
}

// ── text helpers ───────────────────────────────────────────────────────────
// Canonical source: lib/text.js (unit-tested there). This inline copy keeps the
// page self-contained, so a running host never needs a plugin reload to render.

/** Escape the five characters that can break out of text or an attribute. */
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * Inline markdown over already-escaped text. Order matters: bold before
 * italic, and links before bare URLs so a labelled link keeps its label.
 */
const renderInline = (text) => {
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>')
  return out
}

/**
 * Line-oriented markdown-lite: headings, lists, quotes, rules, fenced code and
 * paragraphs. Every text fragment is escaped before any tag is produced, so raw
 * HTML in an answer can never render as markup.
 */
const renderMarkdown = (text) => {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const html = []
  let inCode = false
  let codeLang = ''
  let codeLines = []
  let listType = null

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }

  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line)
    if (inCode) {
      if (fence) {
        html.push(
          `<pre data-lang="${escapeHtml(codeLang)}"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`
        )
        inCode = false
        codeLines = []
        codeLang = ''
      } else {
        codeLines.push(line)
      }
      continue
    }
    if (fence) {
      closeList()
      inCode = true
      codeLang = fence[1]
      continue
    }
    if (line.trim() === '') {
      closeList()
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`)
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList()
      html.push('<hr />')
      continue
    }
    if (/^>\s?/.test(line)) {
      closeList()
      html.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ordered) {
      if (listType !== 'ol') {
        closeList()
        html.push('<ol>')
        listType = 'ol'
      }
      html.push(`<li>${renderInline(ordered[1])}</li>`)
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      if (listType !== 'ul') {
        closeList()
        html.push('<ul>')
        listType = 'ul'
      }
      html.push(`<li>${renderInline(bullet[1])}</li>`)
      continue
    }
    closeList()
    html.push(`<p>${renderInline(line)}</p>`)
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  closeList()
  return html.join('')
}

/** The answer text without citations, used for copy, speech and share. */
const plainText = (message) =>
  (message.blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

/**
 * Merge consecutive text blocks into markdown runs. The stream splits assistant
 * text whenever a citation arrives, so one paragraph often spans several blocks
 * and the tail may start with "。"; joining them keeps citations inline and stops
 * stray punctuation from becoming its own paragraph. Any non-text block ends the
 * current run.
 * @param blocks - durable assistant blocks in stream order.
 * @param numberOf - citation URL to its conversation-wide source number.
 * @returns runs as `{ start, markdown }`, where `start` is the first block index.
 */
const mergeAnswerRuns = (blocks, numberOf) => {
  const runs = []
  let current = ''
  let start = -1
  const flush = () => {
    if (current.trim() !== '') runs.push({ start, markdown: current })
    current = ''
    start = -1
  }
  ;(blocks ?? []).forEach((block, index) => {
    if (block.type === 'text') {
      if (start === -1) start = index
      current += block.text ?? ''
      for (const citation of block.citations ?? []) {
        const number = numberOf(citation.url)
        if (number !== undefined) current += '«cite:' + number + '»'
      }
      return
    }
    flush()
  })
  flush()
  return runs
}

// ── messages → request ─────────────────────────────────────────────────────

/**
 * `latest_reminder` wire contract (api-docs.deepseek.com/zh-cn/guides/latest_reminder):
 * `<date>,<weekday>,<location>,<platform>,<language>` — date is YYYY-MM-DD, the
 * weekday is written in `language`, the location may be empty or contain commas,
 * the platform is `App` or `Web`, and the language is a supported native name.
 *
 * The conversation title is not configurable here: cost is one extra model turn
 * when the format drifts, so language names are taken from the documented list.
 */
const LANGUAGE_NAMES = {
  af: 'Afrikaans',
  am: 'አማርኛ',
  ar: 'العربية',
  az: 'Azərbaycanca',
  be: 'беларуская',
  bg: 'български',
  bn: 'বাংলা',
  ca: 'català',
  cs: 'čeština',
  da: 'dansk',
  de: 'Deutsch',
  el: 'Ελληνικά',
  en: 'English',
  es: 'español',
  et: 'eesti',
  eu: 'euskara',
  fa: 'فارسی',
  fi: 'suomi',
  fil: 'Filipino',
  fr: 'français',
  gl: 'galego',
  gu: 'ગુજરાતી',
  he: 'עברית',
  hi: 'हिन्दी',
  hr: 'hrvatski',
  hu: 'magyar',
  hy: 'հայերեն',
  id: 'Indonesia',
  is: 'íslenska',
  it: 'italiano',
  ja: '日本語',
  ka: 'ქართული',
  kk: 'қазақтілі',
  km: 'ខ្មែរ',
  kn: 'ಕನ್ನಡ',
  ko: '한국어',
  ky: 'кыргызча',
  lo: 'ລາວ',
  lt: 'lietuvių',
  lv: 'latviešu',
  mk: 'македонски',
  ml: 'മലയാളം',
  mn: 'монгол',
  mr: 'मराठी',
  ms: 'Melayu',
  my: 'မြန်မာ',
  ne: 'नेपाली',
  nl: 'Nederlands',
  pa: 'ਪੰਜਾਬੀ',
  pl: 'polski',
  pt: 'português',
  ro: 'română',
  ru: 'русский',
  si: 'සිංහල',
  sk: 'slovenčina',
  sl: 'slovenščina',
  sq: 'shqip',
  sr: 'српски',
  sv: 'svenska',
  sw: 'Kiswahili',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  th: 'ไทย',
  tr: 'Türkçe',
  uk: 'українська',
  ur: 'اردو',
  vi: 'TiếngViệt',
  zu: 'isiZulu',
}

const SUPPORTED_LANGUAGES = new Set([...Object.values(LANGUAGE_NAMES), '中文', '中文繁體', '中文香港'])

/** Native language name for the current UI language, falling back to English. */
const languageName = () => {
  const tag = String(navigator.language || 'en').toLowerCase()
  if (tag.startsWith('zh')) {
    if (tag.includes('tw')) return '中文繁體'
    if (tag.includes('hk') || tag.includes('mo')) return '中文香港'
    return '中文'
  }
  return LANGUAGE_NAMES[tag.split('-')[0]] ?? 'English'
}

/** `YYYY-MM-DD` in the viewer's own time zone. */
const isoDate = (date) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Build one reminder. The weekday is written in the reminder language, and a
 * mobile browser is still `Web`: `App` means the DeepSeek app, not a phone.
 */
const reminder = () => {
  const now = new Date()
  const language = languageName()
  let weekday
  try {
    weekday = new Intl.DateTimeFormat(navigator.language || 'en', { weekday: 'long' }).format(now)
  } catch {
    weekday = new Intl.DateTimeFormat('en', { weekday: 'long' }).format(now)
  }
  const location = (localStorage.getItem('dsh-chat:location') ?? '').trim()
  return [isoDate(now), weekday, location, 'Web', language].join(',')
}

/**
 * Accept only a reminder this API accepts. Older sessions stored a prose
 * sentence; dropping it is safe (history reminders are optional) while sending
 * it would fail the whole request with 400.
 */
const isReminder = (value) => {
  if (typeof value !== 'string') return false
  const parts = value.split(',')
  if (parts.length < 4) return false
  const [date, weekday] = parts
  const platform = parts[parts.length - 2]
  const language = parts[parts.length - 1]
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    weekday.trim() !== '' &&
    (platform === 'App' || platform === 'Web') &&
    SUPPORTED_LANGUAGES.has(language)
  )
}

const usableReply = (message) =>
  message &&
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  plainText(message) !== ''

const toFileBlocks = (files) =>
  (files ?? []).flatMap((file) =>
    file.fileId
      ? [{ type: file.isImage ? 'image' : 'document', source: { type: 'file', file_id: file.fileId } }]
      : []
  )

const toUserParam = (message) => {
  const blocks = toFileBlocks(message.files)
  if (blocks.length === 0) return { role: 'user', content: message.text ?? '' }
  return {
    role: 'user',
    content: [...blocks, ...(message.text ? [{ type: 'text', text: message.text }] : [])],
  }
}

const toAssistantParam = (message, prefix, thinking) => {
  const content = []
  let text = null
  const unsignedReadLinks = new Set(
    (message.blocks ?? []).flatMap((block) =>
      block.type === 'fetchResult' && block.kind === 'read_link' && block.hasSignature === false
        ? [block.toolUseId]
        : []
    )
  )
  for (const block of message.blocks ?? []) {
    if (prefix && block.type === 'thinking' && !String(block.text ?? '').trim()) continue
    if (block.type === 'text') {
      if (text) {
        text.text += block.text
      } else {
        const previous = content[content.length - 1]
        text = { type: 'text', text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}` }
        content.push(text)
      }
      continue
    }
    text = null
    if (prefix && thinking && block.type === 'thinking') {
      content.push({ type: 'thinking', thinking: block.text, signature: block.signature ?? '' })
    } else if (block.type === 'search' && block.kind === 'read_link' && !unsignedReadLinks.has(block.id)) {
      content.push({
        type: 'server_tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
        kind: block.kind,
      })
    } else if (block.type === 'fetchResult' && block.kind === 'read_link' && !unsignedReadLinks.has(block.toolUseId)) {
      content.push(block.raw)
    }
  }
  return {
    role: 'assistant',
    content: content.filter((block) => block.type !== 'text' || block.text !== ''),
  }
}

const buildMessages = (history, question, prefix) => {
  const messages = []
  let previousReminder
  const appendReminder = (value) => {
    if (!isReminder(value)) return
    if (value !== previousReminder) {
      messages.push({ role: 'latest_reminder', content: value })
      previousReminder = value
    }
  }
  for (let i = 0; i + 1 < history.length; i++) {
    const user = history[i]
    const reply = history[i + 1]
    if (user.role !== 'user' || !usableReply(reply)) continue
    if (!user.text && toFileBlocks(user.files).length === 0) continue
    appendReminder(reply.latestReminder)
    messages.push(toUserParam(user), toAssistantParam(reply))
    i++
  }
  appendReminder(reminder())
  messages.push(toUserParam(question))
  if (prefix && prefix.prefix) {
    const assistant = toAssistantParam(prefix, true, true)
    if (
      assistant.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'thinking' && String(block.thinking ?? '').trim())
      )
    ) {
      messages.push(assistant)
    }
  }
  return messages
}

// ── api ────────────────────────────────────────────────────────────────────

const apiFetch = (path, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { 'x-dsh-chat-token': TOKEN, ...(init.headers ?? {}) },
  })

const upload = async (file) => {
  const isImage = IMAGE_MIME.test(file.type) || /\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?)$/i.test(file.name)
  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : ''
  const purpose = isImage ? null : LAYOUT_EXTS.has(ext) ? 'rich_layout_recognition' : 'user_data'
  const form = new FormData()
  if (purpose) form.append('purpose', purpose)
  form.append('file', file)
  const response = await apiFetch('/files', { method: 'POST', body: form })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error?.message ?? `上传失败（${response.status}）`)
  return { fileId: body.id, name: file.name, isImage, size: file.size, preview: isImage ? URL.createObjectURL(file) : undefined }
}

// ── SSE ────────────────────────────────────────────────────────────────────

/** Parse one SSE frame: `event:` name plus joined `data:` lines. */
const parseFrame = (text) => {
  let name = 'message'
  const data = []
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    else if (line.startsWith(':')) continue // keep-alive comment
  }
  return data.length > 0 ? { name, data: data.join('\n') } : null
}

/**
 * Read SSE frames from a fetch body. Both `\n\n` and `\r\n\r\n` delimit frames,
 * and a stream that ends without a trailing blank line still yields its last
 * frame (otherwise the `message_stop` or final `message_delta` would be lost).
 */
const readSSE = async function* (body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const nextFrame = () => {
    const boundary = /\r?\n\r?\n/.exec(buffer)
    if (boundary === null) return null
    const raw = buffer.slice(0, boundary.index)
    buffer = buffer.slice(boundary.index + boundary[0].length)
    return raw
  }
  while (true) {
    if (signal.aborted) {
      reader.cancel().catch(() => {})
      return
    }
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (let raw = nextFrame(); raw !== null; raw = nextFrame()) {
      const frame = parseFrame(raw)
      if (frame) yield frame
    }
  }
  const tail = parseFrame(buffer)
  if (tail) yield tail
}

// ── streaming state ────────────────────────────────────────────────────────

let stream = null

const applyEvent = (reply, event, now, indexes) => {
  switch (event.type) {
    case 'message_start':
      reply.usage = event.message?.usage ?? reply.usage
      return
    case 'content_block_start': {
      const block = event.content_block
      indexes.delete(event.index)
      if (block?.type === 'tool_use') {
        reply.prefix = false
        return
      }
      const mapped = mapBlock(block, now)
      if (!mapped) return
      indexes.set(event.index, reply.blocks.length)
      reply.blocks.push(mapped)
      return
    }
    case 'content_block_delta': {
      const index = indexes.get(event.index)
      if (index === undefined) return
      const block = reply.blocks[index]
      const delta = event.delta
      if (block.type === 'text' && delta.type === 'text_delta') block.text += delta.text
      else if (block.type === 'text' && delta.type === 'citations_delta') block.citations.push(delta.citation)
      else if (block.type === 'thinking' && delta.type === 'thinking_delta') block.text += delta.thinking
      else if (block.type === 'thinking' && delta.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature
      return
    }
    case 'content_block_stop': {
      const index = indexes.get(event.index)
      if (index === undefined) return
      indexes.delete(event.index)
      const block = reply.blocks[index]
      if (block.type === 'thinking' && block.endedAt === undefined) block.endedAt = now
      return
    }
    case 'message_delta':
      reply.stopReason = event.delta?.stop_reason ?? reply.stopReason
      if (event.delta?.title) reply.title = event.delta.title
      reply.usage = event.usage ?? reply.usage
      return
    default:
  }
}

const mapBlock = (block, now) => {
  switch (block?.type) {
    case 'text':
      return { type: 'text', text: block.text ?? '', citations: block.citations ?? [] }
    case 'thinking':
      return { type: 'thinking', text: block.thinking ?? '', signature: block.signature, startedAt: now }
    case 'server_tool_use':
      return { type: 'search', id: block.id, name: block.name, kind: block.kind, input: block.input }
    case 'web_search_tool_result':
      return {
        type: 'searchResult',
        toolUseId: block.tool_use_id,
        kind: block.kind,
        items: (block.content ?? []).filter((item) => item?.type === 'web_search_result'),
        error: (block.content ?? []).find((item) => item?.type === 'web_search_tool_result_error')?.error_code,
      }
    case 'web_fetch_tool_result': {
      // Only a signed read_link is ever replayed, so only that shape is kept;
      // storing the whole wire block would copy page payloads into localStorage.
      const replayable =
        block.kind === 'read_link' &&
        typeof block.signature === 'string' &&
        block.signature.trim() !== '' &&
        block.content?.type === 'web_fetch_result'
      return {
        type: 'fetchResult',
        toolUseId: block.tool_use_id,
        kind: block.kind,
        url: block.content?.url,
        title: block.content?.content?.title,
        error: block.content?.type === 'web_fetch_tool_result_error' ? block.content.error_code : undefined,
        hasSignature: replayable,
        raw: replayable ? block : undefined,
      }
    }
    default:
      return null
  }
}

const send = async ({ prefix = null, question = null } = {}) => {
  if (stream) return
  let session = activeSession() ?? newSession()
  if (!Array.isArray(session.messages)) {
    await ensureLoaded(session)
    session = activeSession() ?? newSession()
    if (!Array.isArray(session.messages)) return
  }

  let history
  let userMessage = null
  let reply
  if (prefix !== null) {
    // Continue generation: reuse the trailing assistant and resend it as prefill.
    reply = prefix
    reply.status = 'streaming'
    reply.error = undefined
    history = session.messages.slice(0, -1)
    userMessage = history[history.length - 1] ?? { role: 'user', text: '', files: [] }
  } else {
    const text = question ? (question.text ?? '') : $('input').value.trim()
    const files = question ? (question.files ?? []) : pendingFiles.filter((file) => !file.uploading && !file.error)
    if (!text && files.length === 0) return
    if (!question && pendingFiles.some((file) => file.uploading)) {
      toast('文件还在上传，请稍候')
      return
    }
    userMessage = { id: uid(), role: 'user', text, files, at: Date.now(), latestReminder: reminder() }
    reply = {
      id: uid(),
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      stopReason: null,
      prefix: true,
      latestReminder: userMessage.latestReminder,
      at: Date.now(),
    }
    history = session.messages.slice()
    session.messages.push(userMessage, reply)
    persistSession(session)
    persistMessage(session, userMessage)
    if (!question) {
      // The bubble only lists names, so the preview blobs can be released now.
      for (const file of pendingFiles) {
        if (file.preview) {
          URL.revokeObjectURL(file.preview)
          delete file.preview
        }
      }
      pendingFiles = []
      $('input').value = ''
      autosize()
      renderAttachments()
    }
  }

  streamingMessage = reply
  render()

  const controller = new AbortController()
  stream = controller
  setComposerBusy(true)

  const pairs = prefix !== null ? history.slice(0, -1) : history
  // The proxy treats the entry config as a ceiling and honours this subset.
  const tools = []
  if (prefs.search && boot.search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
    if (boot.readUrl) tools.push({ type: 'deepseek_read_url', name: 'deepseek_read_url' })
  }

  const request = {
    model: boot.model,
    system: '你是一个乐于助人的助手。回答使用 Markdown。',
    messages: buildMessages(pairs, userMessage, prefix),
    thinking: { type: prefs.thinking ? 'enabled' : 'disabled' },
    tools,
  }

  const indexes = new Map()
  try {
    const response = await apiFetch('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body?.error?.message ?? `请求失败（${response.status}）`)
    }
    for await (const frame of readSSE(response.body, controller.signal)) {
      let payload
      try {
        payload = JSON.parse(frame.data)
      } catch {
        continue
      }
      if (payload?.error) throw new Error(payload.error.message ?? '上游返回错误')
      applyEvent(reply, payload, Date.now(), indexes)
      scheduleRender()
      if (payload.type === 'message_stop') break
    }
    reply.status = controller.signal.aborted ? 'stopped' : 'done'
  } catch (error) {
    if (controller.signal.aborted) {
      reply.status = 'stopped'
    } else {
      reply.status = 'error'
      reply.error = error instanceof Error ? error.message : String(error)
    }
  } finally {
    for (const block of reply.blocks) if (block.type === 'thinking' && block.endedAt === undefined) block.endedAt = Date.now()
    if (reply.title) session.title = reply.title
    saveStore()
    persistMessage(session, reply)
    if (reply.title) persistTitle(session)
    stream = null
    streamingMessage = null
    renderFailed = false
    setComposerBusy(false)
    render()
  }
}

// ── rendering ──────────────────────────────────────────────────────────────

/** Message object → its rendered node, so a stream can repaint one message. */
const messageNodes = new WeakMap()

/** The message currently being streamed, when one is. */
let streamingMessage = null

let renderQueued = false

/**
 * Repaint only the streaming answer. A full render on every token rewrote the
 * whole transcript, the sidebar and the source panel for each frame.
 */
const patchStreaming = () => {
  const session = activeSession()
  const message = streamingMessage
  if (!session || !message) return false
  const node = messageNodes.get(message)
  if (!node || !node.isConnected) return false
  const registry = collectSources(session)
  const messages = $('messages')
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160
  const next = renderAssistant(message, registry)
  node.replaceWith(next)
  messageNodes.set(message, next)
  if (panelState.open) renderPanel(registry)
  if (atBottom) messages.scrollTop = messages.scrollHeight
  updateScrollButton()
  return true
}

const scheduleRender = () => {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    if (!patchStreaming()) render()
  })
}

/** Blocks the reader opened by hand, so a streaming re-render keeps them open. */
const openedThinking = new WeakSet()

const renderThinking = (block) => {
  const box = el('details', 'thinking')
  const seconds = block.startedAt ? Math.max(1, Math.round(((block.endedAt ?? Date.now()) - block.startedAt) / 1000)) : null
  const summary = el('summary', null, `深度思考${seconds ? `（${seconds}s）` : '中…'}`)
  box.append(summary, el('div', 'body', block.text))
  box.open = block.endedAt === undefined || openedThinking.has(block)
  // Registered after the initial state is applied: only a real click records it.
  box.addEventListener('toggle', () => {
    if (box.open) openedThinking.add(block)
    else openedThinking.delete(block)
  })
  return box
}

const formatDate = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

/** Site mark for one source: the API icon when present, otherwise an initial. */
const faviconOf = (source) => {
  if (source.siteIcon) {
    const image = el('img', 'favicon')
    image.src = source.siteIcon
    image.alt = ''
    image.loading = 'lazy'
    image.onerror = () => image.replaceWith(faviconOf({ ...source, siteIcon: null }))
    return image
  }
  const letter = el('span', 'favicon')
  const name = String(source.siteName ?? hostOf(source.url) ?? '?').replace(/^www\./u, '')
  letter.textContent = name.slice(0, 1).toUpperCase()
  return letter
}

const faviconStack = (sources, max = 4) => {
  const stack = el('span', 'favicon-stack')
  for (const source of sources.slice(0, max)) stack.append(faviconOf(source))
  return stack
}

/** Conversation-wide source registry: first appearance order, deduped by URL. */
const collectSources = (session) => {
  const list = []
  const index = new Map()
  const push = (item) => {
    if (!item.url || index.has(item.url)) return
    index.set(item.url, list.length + 1)
    list.push({ ...item, index: list.length + 1 })
  }
  for (const message of session?.messages ?? []) {
    if (message.role !== 'assistant') continue
    for (const block of message.blocks ?? []) {
      if (block.type === 'searchResult') {
        for (const item of block.items ?? []) {
          push({
            url: item.url,
            title: item.title ?? item.url,
            snippet: item.snippet ?? '',
            siteName: item.site_name ?? hostOf(item.url),
            siteIcon: item.site_icon ?? null,
            pageAge: item.page_age ?? null,
          })
        }
      } else if (block.type === 'fetchResult' && !block.error && block.url) {
        push({
          url: block.url,
          title: block.title ?? block.url,
          snippet: '',
          siteName: hostOf(block.url),
          siteIcon: null,
          pageAge: null,
        })
      } else if (block.type === 'text') {
        for (const citation of block.citations ?? []) {
          push({
            url: citation.url,
            title: citation.title ?? citation.url,
            snippet: citation.cited_text ?? '',
            siteName: hostOf(citation.url),
            siteIcon: null,
            pageAge: null,
          })
        }
      }
    }
  }
  return { list, index }
}

/** Sources this answer actually used, in registry order. */
const messageSources = (message, registry) => {
  const urls = new Set()
  for (const block of message.blocks ?? []) {
    if (block.type === 'searchResult') for (const item of block.items ?? []) urls.add(item.url)
    else if (block.type === 'fetchResult' && block.url) urls.add(block.url)
    else if (block.type === 'text') for (const citation of block.citations ?? []) urls.add(citation.url)
  }
  return registry.list.filter((source) => urls.has(source.url))
}

const renderSearchSummary = (count, sources, label = '搜索到') => {
  const chip = el('button', 'search-summary')
  chip.type = 'button'
  chip.title = '查看搜索结果'
  const icon = el('span')
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16.5 16.5L21 21"/></svg>'
  chip.append(icon, el('span', null, count > 0 ? `${label} ${count} 个网页` : '正在搜索网页…'))
  if (sources.length > 0) chip.append(faviconStack(sources))
  chip.onclick = () => openPanel()
  return chip
}

/** Render one merged markdown run, swapping inline citation markers for anchors. */
const proseNode = (markdown, registry) => {
  const wrap = el('div', 'prose')
  wrap.innerHTML = renderMarkdown(markdown).replace(/«cite:(\d+)»/gu, (_, raw) => {
    const source = registry.list[Number(raw) - 1]
    if (!source) return ''
    const title = escapeHtml(source.title ?? source.url)
    return `<a class="cite" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer noopener" title="${title}">${raw}</a>`
  })
  return wrap
}

/**
 * Build the answer body in block order. Assistant text arrives as several
 * blocks that the citation deltas split apart — the tail often begins with
 * "。" and the citation belongs *inside* the paragraph, not after it. So
 * consecutive text blocks merge into one markdown run with inline `«cite:N»`
 * markers, and any non-text block (thinking, tool) closes the run.
 */
const answerBlocks = (message, registry) => {
  const entries = []
  for (const run of mergeAnswerRuns(message.blocks, (url) => registry.index.get(url))) {
    entries.push({ at: run.start, node: proseNode(run.markdown, registry) })
  }
  ;(message.blocks ?? []).forEach((block, index) => {
    if (block.type === 'thinking') entries.push({ at: index, node: renderThinking(block) })
  })
  entries.sort((left, right) => left.at - right.at)
  return entries.map((entry) => entry.node)
}

const regenerate = (message) => {
  const session = activeSession()
  if (!session) return
  const index = session.messages.indexOf(message)
  const question = index > 0 ? session.messages[index - 1] : null
  if (!question || question.role !== 'user') {
    toast('找不到对应的提问')
    return
  }
  const removed = [question, message].map((entry) => entry?.id).filter(Boolean)
  session.messages.splice(index - 1, 2)
  saveStore()
  forgetMessages(session, removed)
  render()
  send({ question })
}

const shareAnswer = (message, sources) => {
  const body = plainText(message)
  const links = sources.map((source) => `[${source.index}] ${source.title} - ${source.url}`).join('\n')
  const text = links ? `${body}\n\n来源：\n${links}` : body
  navigator.clipboard.writeText(text).then(
    () => toast('已复制，含来源链接'),
    () => toast('复制失败')
  )
}

const renderAssistant = (message, registry) => {
  const root = el('div', 'msg assistant')
  const blocks = el('div', 'blocks')

  const searchCount = (message.blocks ?? [])
    .filter((block) => block.type === 'searchResult')
    .reduce((total, block) => total + (block.items?.length ?? 0), 0)
  const used = messageSources(message, registry)
  const readCount = (message.blocks ?? []).filter((block) => block.type === 'fetchResult' && !block.error).length

  if (message.status === 'streaming' && (message.blocks ?? []).some((block) => block.type === 'search')) {
    blocks.append(renderSearchSummary(searchCount || used.length, used, '正在搜索'))
  } else if (searchCount > 0 || used.length > 0) {
    blocks.append(renderSearchSummary(Math.max(searchCount, used.length), used, searchCount > 0 ? '搜索到' : '阅读了'))
  }

  for (const node of answerBlocks(message, registry)) blocks.append(node)
  if (readCount > 0 && searchCount === 0 && used.length === 0) {
    blocks.append(el('div', 'answer-note', `已阅读 ${readCount} 个网页`))
  }
  root.append(blocks)

  if (message.status === 'error') {
    const failure = el('div', 'error-box')
    failure.append(el('div', null, `出错：${message.error ?? '未知错误'}`))
    const retry = el('button')
    retry.innerHTML = `${iconSvg('refresh', 14)}<span>重试</span>`
    retry.onclick = () => regenerate(message)
    failure.append(retry)
    root.append(failure)
  }

  if (message.status !== 'streaming' && message.status !== 'error') {
    const foot = el('div', 'answer-foot')
    foot.append(el('div', 'answer-note', '本回答由 AI 生成，内容仅供参考，请仔细甄别'))

    if (used.length > 0) {
      const pill = el('button', 'sources-pill')
      pill.type = 'button'
      pill.append(faviconStack(used), el('span', null, `${used.length} 个网页`))
      pill.title = '查看搜索结果'
      pill.onclick = () => openPanel()
      foot.append(pill)
    }

    const actions = el('div', 'msg-actions')
    if (plainText(message)) {
      actions.append(
        iconButton('copy', '复制', () =>
          navigator.clipboard.writeText(plainText(message)).then(() => toast('已复制'))
        )
      )
      actions.append(iconButton('refresh', '重新生成', () => regenerate(message)))
      if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
        actions.append(
          iconButton('speak', '朗读', () => {
            speechSynthesis.cancel()
            const utterance = new SpeechSynthesisUtterance(plainText(message))
            utterance.lang = 'zh-CN'
            speechSynthesis.speak(utterance)
          })
        )
      }
      actions.append(iconButton('share', '分享（复制含来源）', () => shareAnswer(message, used)))
    }
    if (canContinue(message)) {
      actions.append(
        // The prefix path replays this message as prefill; popping it first
        // would drop the question from the request.
        iconButton('more', '继续生成', () => send({ prefix: message }))
      )
    }
    if (message.usage) {
      actions.append(
        el('span', 'meta', `输入 ${message.usage.input_tokens ?? 0} · 输出 ${message.usage.output_tokens ?? 0}`)
      )
    }
    if (actions.childElementCount > 0) foot.append(actions)
    root.append(foot)
  }
  return root
}

const canContinue = (message) => {
  if (!message.prefix) return false
  if (message.stopReason === 'refusal' || message.stopReason === 'tool_use') return false
  if ((message.blocks ?? []).some((block) => block.type === 'search' || block.type === 'searchResult' || block.type === 'fetchResult')) return false
  return message.status === 'stopped' || (message.status === 'done' && message.stopReason === 'max_tokens')
}

const renderUser = (message) => {
  const root = el('div', 'msg user')
  const bubble = el('div', 'bubble')
  if (message.text) bubble.append(document.createTextNode(message.text))
  if ((message.files ?? []).length > 0) {
    const files = el('div', 'files')
    for (const file of message.files) files.append(el('span', null, file.name))
    bubble.append(files)
  }
  const actions = el('div', 'user-actions')
  actions.append(
    iconButton('copy', '复制', () =>
      navigator.clipboard.writeText(message.text ?? '').then(() => toast('已复制'))
    )
  )
  actions.append(
    iconButton('edit', '编辑', () => {
      $('input').value = message.text ?? ''
      autosize()
      $('input').focus()
      toast('已填入输入框')
    })
  )
  root.append(bubble, actions)
  return root
}

// ── search results panel ───────────────────────────────────────────────────

const panelState = { open: false }

const openPanel = () => {
  panelState.open = true
  render()
}

const closePanel = () => {
  panelState.open = false
  render()
}

const renderPanel = (registry) => {
  const panel = $('search-panel')
  panel.hidden = !panelState.open
  if (!panelState.open) return
  const list = $('search-list')
  list.textContent = ''
  if (registry.list.length === 0) {
    list.append(el('div', 'answer-note', '这一轮还没有搜索来源。'))
    return
  }
  for (const source of registry.list) {
    const item = el('a', 'source-item')
    item.href = source.url
    item.target = '_blank'
    item.rel = 'noreferrer noopener'

    const meta = el('div', 'source-meta')
    meta.append(faviconOf(source), el('span', 'name', source.siteName ?? hostOf(source.url)))
    const date = formatDate(source.pageAge)
    if (date) meta.append(el('span', null, `| ${date}`))
    meta.append(el('span', 'source-index', String(source.index)))
    item.append(meta)
    item.append(el('div', 'source-title', source.title))
    if (source.snippet) item.append(el('div', 'source-snippet', source.snippet))
    list.append(item)
  }
}

let renderFailed = false

const render = () => {
  try {
    renderUnsafe()
  } catch (error) {
    console.error('dsh-chat render failed', error)
    if (!renderFailed) {
      renderFailed = true
      toast(`渲染失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const renderUnsafe = () => {
  const session = activeSession()
  $('chat-title').textContent = session?.title ?? '新对话'
  renderSessions()
  const registry = collectSources(session)
  renderPanel(registry)

  const messages = $('messages')
  const scrollBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160
  messages.textContent = ''

  if (session !== null && !Array.isArray(session.messages)) {
    // Server mode loads one transcript at a time; ask once and re-render after.
    ensureLoaded(session)
    messages.append(el('div', 'answer-note', '正在加载对话…'))
  } else if (!session || session.messages.length === 0) {
    const empty = el('div', 'empty')
    empty.append(el('h2', null, '我是 dsh-chat，很高兴见到你！'))
    empty.append(el('p', null, '独立窗口 · 联网搜索 · 深度思考 · 附件解析，均由 DSH 宿主代理。'))
    const cards = el('div', 'cards')
    for (const [label, prompt] of [
      ['查一下 DeepSeek V4.1 有哪些更新', 'DeepSeek V4.1 有哪些更新？请联网搜索并给出引用。'],
      ['阅读一个链接并总结', '请阅读 https://api-docs.deepseek.com/zh-cn/guides/build_a_chatbot/ 并总结要点。'],
      ['解释这段代码', '请解释下面的代码做了什么：\n\n```js\nconst f = (x) => x * 2\n```'],
    ]) {
      const button = el('button', null, label)
      button.onclick = () => {
        $('input').value = prompt
        autosize()
        $('input').focus()
      }
      cards.append(button)
    }
    empty.append(cards)
    messages.append(empty)
  } else {
    for (const message of session.messages) {
      const node = message.role === 'user' ? renderUser(message) : renderAssistant(message, registry)
      messageNodes.set(message, node)
      messages.append(node)
    }
  }

  if (scrollBottom) messages.scrollTop = messages.scrollHeight
  updateScrollButton()
}

const updateScrollButton = () => {
  const messages = $('messages')
  const button = $('scroll-down')
  if (!button || !messages) return
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120
  button.hidden = atBottom || messages.scrollHeight <= messages.clientHeight
}

const filteredSessions = () => {
  if (workspaceFilter === 'all') return store.sessions
  if (workspaceFilter === 'none') return store.sessions.filter((session) => !session.workspaceId)
  return store.sessions.filter((session) => session.workspaceId === workspaceFilter)
}

const currentWorkspace = () =>
  workspaceFilter === 'all' || workspaceFilter === 'none'
    ? null
    : store.workspaces.find((workspace) => workspace.id === workspaceFilter) ?? null

const renderWorkspaceSelect = () => {
  const select = $('workspace-filter')
  select.textContent = ''
  const add = (value, label) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.append(option)
  }
  add('all', `全部对话（${store.sessions.length}）`)
  add('none', `未分组（${store.sessions.filter((session) => !session.workspaceId).length}）`)
  for (const workspace of store.workspaces) {
    const count = store.sessions.filter((session) => session.workspaceId === workspace.id).length
    add(workspace.id, `${workspace.name}（${count}）`)
  }
  if (![...select.options].some((option) => option.value === workspaceFilter)) workspaceFilter = 'all'
  select.value = workspaceFilter

  const active = currentWorkspace()
  $('workspace-rename').disabled = active === null
  $('workspace-delete').disabled = active === null
}

const closeMoveMenu = () => {
  $('move-menu').hidden = true
}

const moveSessionTo = (session, workspaceId) => {
  session.workspaceId = workspaceId === 'none' ? null : workspaceId
  saveStore()
  moveSessionRemote(session)
  render()
}

const openMoveMenu = (session, anchor) => {
  const menu = $('move-menu')
  menu.textContent = ''
  const add = (label, value, active) => {
    const item = el('button', null, label)
    if (active) item.classList.add('active')
    item.onclick = (event) => {
      event.stopPropagation()
      closeMoveMenu()
      moveSessionTo(session, value)
    }
    menu.append(item)
  }
  add('未分组', 'none', !session.workspaceId)
  for (const workspace of store.workspaces) {
    add(workspace.name, workspace.id, session.workspaceId === workspace.id)
  }
  menu.hidden = false
  const rect = anchor.getBoundingClientRect()
  menu.style.left = `${Math.max(8, Math.min(rect.left - 120, window.innerWidth - 180))}px`
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`
}

const renderSessions = () => {
  const list = $('session-list')
  list.textContent = ''
  const sessions = filteredSessions()
  if (sessions.length === 0) {
    list.append(el('div', 'side-empty', store.sessions.length === 0 ? '还没有对话' : '这个工作区还没有对话'))
  }
  for (const session of sessions) {
    const item = el('div', 'session-item' + (session.id === store.activeId ? ' active' : ''))
    item.append(el('span', 'title', session.title || '新对话'))

    const move = el('button', 'move')
    move.title = '移动到工作区'
    move.setAttribute('aria-label', '移动到工作区')
    move.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 7l5 5-5 5"/></svg>'
    move.onclick = (event) => {
      event.stopPropagation()
      openMoveMenu(session, move)
    }
    item.append(move)

    const del = el('button', 'del', '×')
    del.onclick = (event) => {
      event.stopPropagation()
      if (!confirm('删除这个对话？')) return
      store.sessions = store.sessions.filter((entry) => entry.id !== session.id)
      if (store.activeId === session.id) {
        store.activeId = filteredSessions()[0]?.id ?? store.sessions[0]?.id ?? null
        ensureLoaded(activeSession())
      }
      saveStore()
      forgetSession(session.id)
      render()
    }
    item.append(del)
    item.onclick = () => {
      store.activeId = session.id
      saveStore()
      render()
      ensureLoaded(session)
    }
    list.append(item)
  }
  renderWorkspaceSelect()
}

// ── attachments ────────────────────────────────────────────────────────────

let pendingFiles = []

const renderAttachments = () => {
  const box = $('attachments')
  box.textContent = ''
  for (const [index, file] of pendingFiles.entries()) {
    const chip = el('div', 'chip-file')
    if (file.preview) {
      const image = el('img')
      image.src = file.preview
      chip.append(image)
    }
    chip.append(el('span', null, `${file.name}${file.uploading ? ' · 上传中…' : file.error ? ' · 失败' : ''}`))
    const remove = el('button', null, '×')
    remove.onclick = () => {
      if (file.preview) URL.revokeObjectURL(file.preview)
      pendingFiles.splice(index, 1)
      renderAttachments()
    }
    chip.append(remove)
    box.append(chip)
  }
}

const addFiles = async (files) => {
  for (const file of files) {
    const entry = { name: file.name, size: file.size, uploading: true }
    pendingFiles.push(entry)
    renderAttachments()
    try {
      const uploaded = await upload(file)
      Object.assign(entry, uploaded, { uploading: false })
    } catch (error) {
      entry.error = true
      entry.uploading = false
      toast(error instanceof Error ? error.message : '上传失败')
    }
    renderAttachments()
  }
}

// ── capability pills ───────────────────────────────────────────────────────

const renderPills = () => {
  const thinking = $('toggle-thinking')
  const search = $('toggle-search')
  thinking.classList.toggle('active', prefs.thinking)
  thinking.setAttribute('aria-pressed', String(prefs.thinking))
  search.classList.toggle('active', prefs.search && boot.search)
  search.setAttribute('aria-pressed', String(prefs.search && boot.search))
  // A pill the deployment switched off stays visible but cannot be turned back on.
  search.disabled = boot.search !== true
  search.title =
    boot.search === true
      ? '智能搜索：需要时自动联网搜索并阅读链接，回答附带引用'
      : '智能搜索已被插件配置关闭（search: false）'
  thinking.disabled = boot.thinking === false
  thinking.title =
    boot.thinking === false
      ? '深度思考已被插件配置关闭（thinking: false）'
      : '深度思考：开启后模型先推理再回答，搜索会变成边想边搜（默认关闭）'
}

$('toggle-thinking').onclick = () => {
  prefs.thinking = !prefs.thinking
  savePrefs()
  renderPills()
}

$('toggle-search').onclick = () => {
  prefs.search = !prefs.search
  savePrefs()
  renderPills()
}

// ── composer ───────────────────────────────────────────────────────────────

const autosize = () => {
  const input = $('input')
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`
}

const setComposerBusy = (busy) => {
  $('send').hidden = busy
  $('stop').hidden = !busy
}

$('input').addEventListener('input', autosize)
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send()
  }
})
$('send').onclick = () => send()
$('stop').onclick = () => {
  stream?.abort()
}
$('new-chat').onclick = () => {
  newSession()
  render()
}
$('toggle-side').onclick = () => {
  const sidebar = $('sidebar')
  sidebar.hidden = !sidebar.hidden
}
$('collapse-side').onclick = () => {
  $('sidebar').hidden = true
}
$('attach').onclick = () => $('file-input').click()
$('file-input').onchange = (event) => {
  addFiles(Array.from(event.target.files ?? []))
  event.target.value = ''
}
$('input').addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length > 0) {
    event.preventDefault()
    addFiles(files)
  }
})
document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  if (event.dataTransfer?.files?.length) {
    event.preventDefault()
    addFiles(Array.from(event.dataTransfer.files))
  }
})

document.addEventListener('click', (event) => {
  if (event.target.closest('#move-menu') === null) closeMoveMenu()
})

$('close-panel').onclick = () => closePanel()
$('messages').addEventListener('scroll', updateScrollButton, { passive: true })
$('scroll-down').onclick = () => {
  const messages = $('messages')
  messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' })
}

$('workspace-filter').onchange = (event) => {
  workspaceFilter = event.target.value
  try {
    localStorage.setItem(WORKSPACE_FILTER_KEY, workspaceFilter)
  } catch {
    /* the filter simply is not remembered */
  }
  render()
}

$('workspace-add').onclick = async () => {
  const name = prompt('工作区名称')
  if (name === null) return
  const label = name.trim()
  if (label === '') return
  const workspace = { id: uid(), name: label, createdAt: Date.now() }
  store.workspaces.push(workspace)
  workspaceFilter = workspace.id
  saveStore()
  persistWorkspace(workspace)
  try {
    localStorage.setItem(WORKSPACE_FILTER_KEY, workspaceFilter)
  } catch {}
  render()
}

$('workspace-rename').onclick = () => {
  const workspace = currentWorkspace()
  if (workspace === null) return
  const name = prompt('重命名工作区', workspace.name)
  if (name === null || name.trim() === '') return
  workspace.name = name.trim()
  saveStore()
  renameWorkspaceRemote(workspace.id, workspace.name)
  render()
}

$('workspace-delete').onclick = () => {
  const workspace = currentWorkspace()
  if (workspace === null) return
  const count = store.sessions.filter((session) => session.workspaceId === workspace.id).length
  if (!confirm(`删除工作区「${workspace.name}」？其中 ${count} 个对话会回到未分组，不会被删除。`)) return
  store.workspaces = store.workspaces.filter((entry) => entry.id !== workspace.id)
  for (const session of store.sessions) {
    if (session.workspaceId === workspace.id) session.workspaceId = null
  }
  workspaceFilter = 'all'
  saveStore()
  forgetWorkspace(workspace.id)
  try {
    localStorage.setItem(WORKSPACE_FILTER_KEY, workspaceFilter)
  } catch {}
  render()
}

$('clear-all').onclick = () => {
  if (store.sessions.length === 0) {
    toast('还没有对话可清空')
    return
  }
  if (!confirm(`将删除全部 ${store.sessions.length} 个对话，不可恢复。继续？`)) return
  store.sessions = []
  store.activeId = null
  saveStore()
  clearAllRemote()
  render()
  toast('已清空全部对话')
}

$('theme').onclick = () => {
  const order = ['auto', 'light', 'dark']
  store.theme = order[(order.indexOf(store.theme) + 1) % order.length]
  applyTheme()
  try {
    localStorage.setItem(THEME_KEY, store.theme)
  } catch {
    /* ignoring a quota failure only loses the preference */
  }
  saveStore()
}

const applyTheme = () => {
  document.documentElement.dataset.theme = store.theme === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : store.theme
}

/** Every transcript, fetching the ones the sidebar has not loaded yet. */
const exportSessions = async () => {
  if (!remote.enabled) return store.sessions
  const sessions = []
  for (const summary of store.sessions) {
    if (Array.isArray(summary.messages)) {
      sessions.push({ id: summary.id, title: summary.title, createdAt: summary.createdAt, messages: summary.messages })
      continue
    }
    try {
      const data = await (await apiFetch(`/sessions/${encodeURIComponent(summary.id)}`)).json()
      sessions.push({ id: summary.id, title: data.session?.title ?? summary.title, createdAt: summary.createdAt, messages: data.messages ?? [] })
    } catch {
      /* a session deleted in another window is simply skipped */
    }
  }
  return sessions
}

$('export').onclick = async () => {
  const sessions = await exportSessions()
  const blob = new Blob(
    [JSON.stringify({ version: 2, sessions, workspaces: store.workspaces }, null, 2)],
    { type: 'application/json' }
  )
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `dsh-chat-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}

$('import').onclick = () => $('import-file').click()
$('import-file').onchange = async (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    if (!Array.isArray(parsed?.sessions)) throw new Error('文件里没有 sessions 数组')
    const question = remote.enabled
      ? `把 ${parsed.sessions.length} 个对话导入本机数据库？同 id 的会话会被覆盖其中的消息。`
      : '导入会覆盖当前全部对话，继续？'
    if (!confirm(question)) return

    if (remote.enabled) {
      const result = await apiFetch('/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: parsed.sessions, workspaces: parsed.workspaces }),
      })
      if (!result.ok) throw new Error(`导入失败（${result.status}）`)
      const body = await result.json()
      await initPersistence()
      render()
      toast(`导入 ${body.imported ?? 0} 条消息`)
      return
    }

    store.sessions = parsed.sessions
    store.workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : []
    store.activeId = parsed.sessions[0]?.id ?? null
    saveStore()
    render()
    toast('导入完成')
  } catch (error) {
    toast(`导入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── boot ───────────────────────────────────────────────────────────────────

/** Probe the host store; import any browser-only conversations once. */
const initPersistence = async () => {
  let response
  try {
    response = await apiFetch('/sessions')
  } catch {
    return // no route yet: stay local
  }
  if (!response.ok) return
  remote.enabled = true

  const local = loadStore()
  let sessions = (await response.json()).sessions ?? []
  if (sessions.length === 0 && local.sessions.length > 0) {
    if (confirm(`检测到浏览器里有 ${local.sessions.length} 个对话，导入本机数据库？（导入后浏览器副本会清除）`)) {
      const imported = await apiFetch('/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: local.sessions }),
      }).then((result) => result.json())
      try {
        localStorage.removeItem(STORE_KEY)
      } catch {
        /* quota errors are irrelevant for a removal */
      }
      toast(`已导入 ${imported.imported ?? 0} 条消息`)
      sessions = (await (await apiFetch('/sessions')).json()).sessions ?? []
    }
  }

  store.sessions = sessions.map((summary) => ({
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    workspaceId: summary.workspaceId ?? null,
    messageCount: summary.messageCount,
    messages: undefined,
  }))
  store.activeId = store.sessions[0]?.id ?? null

  try {
    const workspaceResponse = await apiFetch('/workspaces')
    if (workspaceResponse.ok) {
      store.workspaces = (await workspaceResponse.json()).workspaces ?? []
    }
  } catch {
    /* workspaces stay browser-local if the host cannot serve them */
  }
}

const bootstrap = async () => {
  applyTheme()
  // Embed mode (DSH right-sidebar iframe): the sidebar is a drawer there, closed by default
  // so it does not squeeze a 400–600px panel. The top-left button still opens it.
  if (document.documentElement.classList.contains('embed')) $('sidebar').hidden = true
  $('badge-model').textContent = boot.model
  renderPills()
  await initPersistence()
  if (remote.enabled) {
    if (store.sessions.length === 0) newSession()
    else ensureLoaded(activeSession())
  } else if (store.sessions.length === 0) newSession()
  else if (!store.activeId) store.activeId = store.sessions[0].id
  render()
  try {
    const response = await apiFetch('/state')
    const state = await response.json()
    const connected = state.hasAuth ?? state.hasKey
    if (connected === false) {
      $('badge-key').hidden = false
      $('badge-key').title =
        state.auth === 'account'
          ? '账号模式：请在设置 → 模型 里登录 DeepSeek'
          : `设置 ${state.keyRef}、写入插件 config，或在设置 → 模型 里登录 DeepSeek`
    } else if (state.authKind === 'account') {
      $('badge-key').hidden = false
      $('badge-key').textContent = '账号登录'
      $('badge-key').classList.remove('warn')
      $('badge-key').title = '使用 DeepSeek 账号登录态（x-dsh-auth-token）'
    }
  } catch {
    /* the badge is advisory only */
  }
}

bootstrap()

// Diagnostics handle for the DOM checks in test/ and for support: read-only use.
globalThis.__dshChat = { render, patchStreaming, renderAssistant, collectSources, store, prefs }
