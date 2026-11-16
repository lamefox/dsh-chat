/**
 * dsh-chat durable store: one SQLite database for conversation transcripts.
 *
 * The browser keeps a working set in memory; this module is the only writer of
 * record. It is deliberately independent from the DSH agent session log — a
 * dsh-chat conversation is not an agent session, so mixing the two would pollute
 * the session list and its search index.
 *
 * @module dsh-chat/store
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Bumped when a migration step is added; `PRAGMA user_version` tracks it. */
export const SCHEMA_VERSION = 2

/**
 * Resolve the database file: an explicit path, else `$DSH_HOME/dsh-chat/chat.db`
 * (the same home the host resolves), else `~/.dsh/dsh-chat/chat.db`.
 * @param explicit - configured absolute path, if any.
 */
export const resolveDbPath = (explicit) => {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'dsh-chat', 'chat.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  status TEXT,
  stop_reason TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_session_seq ON messages(session_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, message_id UNINDEXED, session_id UNINDEXED, tokenize = 'trigram');
`

/** Every visible character of one message, used for the search index. */
export const messageText = (message) => {
  if (typeof message?.text === 'string' && message.role === 'user') return message.text
  const blocks = Array.isArray(message?.blocks) ? message.blocks : []
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

const nowOf = () => Date.now()

/**
 * v1 → v2. Runs against both a brand-new file (version 0) and an existing v1
 * database, so an upgrade never loses conversations. `SET NULL` on the foreign
 * key is what makes deleting a workspace return its sessions to "ungrouped"
 * instead of deleting them.
 */
const migrateToV2 = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0
    );
  `)
  const columns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name)
  if (!columns.includes('workspace_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL')
  }
  db.exec('CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace_id, updated_at DESC)')
  db.exec('PRAGMA user_version = 2')
}

/** Load the SQLite binding once, tolerating Node builds that lack it. */
let sqliteBinding
const loadSqlite = () => {
  if (sqliteBinding !== undefined) return sqliteBinding
  try {
    sqliteBinding = createRequire(import.meta.url)('node:sqlite')
  } catch (error) {
    throw new Error(`node:sqlite is unavailable (${error instanceof Error ? error.message : String(error)})`)
  }
  if (typeof sqliteBinding.DatabaseSync !== 'function') {
    throw new Error('node:sqlite has no DatabaseSync; Node 22.5 or newer is required')
  }
  return sqliteBinding
}

/** Whether this host can open a store at all; the plugin falls back to no storage. */
export const sqliteAvailable = () => {
  try {
    loadSqlite()
    return true
  } catch {
    return false
  }
}

/**
 * Open (and migrate) the database. Throws when the SQLite module is unavailable,
 * which the caller turns into "storage off" instead of a failed plugin.
 * @param options - database file path.
 */
export const openStore = ({ file }) => {
  mkdirSync(dirname(file), { recursive: true })
  // Resolved through require so a host without `node:sqlite` fails here with a
  // clear message instead of failing the whole plugin at import time.
  const { DatabaseSync } = loadSqlite()

  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 3000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  const version = db.prepare('PRAGMA user_version').get()?.user_version ?? 0
  if (version < 2) migrateToV2(db)

  const sessionRow = (row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id ?? null,
  })

  const workspaceRow = (row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    sort: row.sort,
    sessionCount: row.session_count ?? 0,
  })

  const reindex = (messageId, sessionId, text) => {
    db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(messageId)
    if (text) db.prepare('INSERT INTO messages_fts (text, message_id, session_id) VALUES (?, ?, ?)').run(text, messageId, sessionId)
  }

  const upsertMessage = (sessionId, message) => {
    const id = typeof message?.id === 'string' && message.id !== '' ? message.id : undefined
    if (id === undefined) throw new Error('message.id is required')
    const existing = db.prepare('SELECT seq FROM messages WHERE id = ?').get(id)
    const seq = existing?.seq ?? (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session_id = ?').get(sessionId)?.next ?? 1)
    const payload = JSON.stringify(message)
    const createdAt = Number.isFinite(message.at) ? message.at : nowOf()
    db.prepare(
      `INSERT INTO messages (id, session_id, seq, role, status, stop_reason, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload = excluded.payload,
         status = excluded.status,
         stop_reason = excluded.stop_reason,
         role = excluded.role`
    ).run(id, sessionId, seq, message.role ?? 'assistant', message.status ?? null, message.stopReason ?? null, payload, createdAt)
    reindex(id, sessionId, messageText(message))
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nowOf(), sessionId)
    return seq
  }

  /**
   * Session summaries, newest activity first.
   * @param options - `{ workspaceId }`: omitted lists everything, `'none'` lists
   *   only ungrouped sessions, any other value filters to that workspace.
   */
  const listSessions = (options = {}) => {
    const filter = options.workspaceId
    const where =
      filter === undefined || filter === null || filter === 'all'
        ? ''
        : filter === 'none'
          ? 'WHERE s.workspace_id IS NULL'
          : 'WHERE s.workspace_id = ?'
    const params = where === 'WHERE s.workspace_id = ?' ? [filter] : []
    return db
      .prepare(
        `SELECT s.id, s.title, s.created_at, s.updated_at, s.workspace_id,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
           FROM sessions s ${where}
          ORDER BY s.updated_at DESC`
      )
      .all(...params)
      .map((row) => ({ ...sessionRow(row), messageCount: row.message_count }))
  }

  const listWorkspaces = () =>
    db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.id) AS session_count
           FROM workspaces w ORDER BY w.sort, w.created_at`
      )
      .all()
      .map(workspaceRow)

  const createWorkspace = ({ id, name, sort }) => {
    const label = String(name ?? '').trim()
    if (label === '') throw new Error('workspace name is required')
    const stamp = nowOf()
    db.prepare(
      `INSERT INTO workspaces (id, name, created_at, sort) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    ).run(id, label, stamp, Number.isFinite(sort) ? sort : stamp)
    return workspaceRow(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id))
  }

  const renameWorkspace = (id, name) => {
    const label = String(name ?? '').trim()
    if (label === '') return false
    return Number(db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(label, id).changes) > 0
  }

  /** Deleting a workspace keeps its conversations; they become ungrouped. */
  const deleteWorkspace = (id) => {
    db.prepare('UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ?').run(id)
    const result = db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  const moveSession = (id, workspaceId) => {
    const target =
      workspaceId === undefined || workspaceId === null || workspaceId === 'none' ? null : workspaceId
    if (target !== null) {
      const exists = db.prepare('SELECT 1 AS ok FROM workspaces WHERE id = ?').get(target)
      if (exists === undefined) return false
    }
    return (
      Number(
        db.prepare('UPDATE sessions SET workspace_id = ?, updated_at = ? WHERE id = ?').run(target, nowOf(), id).changes
      ) > 0
    )
  }

  /** Delete every conversation (and its index rows); workspaces are kept. */
  const deleteAllSessions = () => {
    const result = db.prepare('DELETE FROM sessions').run()
    db.prepare('DELETE FROM messages_fts').run()
    return Number(result.changes)
  }

  /** Load one session with its messages in stream order. */
  const getSession = (id) => {
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
      if (row === undefined) return undefined
      const messages = db
        .prepare('SELECT payload FROM messages WHERE session_id = ? ORDER BY seq')
        .all(id)
        .map((entry) => JSON.parse(entry.payload))
    return { session: sessionRow(row), messages }
  }

  const createSession = ({ id, title, createdAt, workspaceId }) => {
    const stamp = Number.isFinite(createdAt) ? createdAt : nowOf()
    db.prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
    ).run(id, title ?? '新对话', stamp, stamp, workspaceId ?? null)
    return sessionRow(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id))
  }

  const renameSession = (id, title) => {
      const next = String(title ?? '').trim()
      if (next === '') return false
      const result = db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(next, nowOf(), id)
    return Number(result.changes) > 0
  }

  const deleteSession = (id) => {
      const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      if (Number(result.changes) > 0) db.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(id)
    return Number(result.changes) > 0
  }

  /** Drop specific messages (regenerate / retry rewinds the tail). */
  const deleteMessages = (sessionId, ids) => {
      let removed = 0
      for (const id of ids ?? []) {
        removed += Number(db.prepare('DELETE FROM messages WHERE id = ? AND session_id = ?').run(id, sessionId).changes)
        db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id)
      }
      if (removed > 0) db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nowOf(), sessionId)
    return removed
  }

  /** Import browser-side workspaces; existing ids keep their name. */
  const importWorkspaces = (workspaces) => {
    let imported = 0
    for (const workspace of workspaces ?? []) {
      if (typeof workspace?.id !== 'string' || workspace.id === '') continue
      createWorkspace({ id: workspace.id, name: workspace.name ?? '工作区', sort: workspace.createdAt })
      imported += 1
    }
    return imported
  }

  /** Bulk import of browser-side sessions; ids and seq are preserved/assigned. */
  const importSessions = (sessions) => {
      let imported = 0
      db.exec('BEGIN')
      try {
        for (const session of sessions ?? []) {
          if (typeof session?.id !== 'string' || session.id === '') continue
          createSession({
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            workspaceId: session.workspaceId ?? null,
          })
          for (const [index, message] of (session.messages ?? []).entries()) {
            upsertMessage(session.id, { ...message, id: message.id ?? `m_${session.id}_${index}` })
            imported += 1
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    return imported
  }

  /**
   * Full-text search over message text. FTS5 trigram needs at least three
   * characters, so shorter queries fall back to LIKE.
   */
  const search = (query, limit = 20) => {
      const text = String(query ?? '').trim()
      if (text === '') return []
      const size = Math.min(Math.max(Number(limit) || 20, 1), 100)
      if ([...text].length >= 3) {
        return db
          .prepare(
            `SELECT m.session_id AS sessionId, m.id AS messageId, m.role, s.title,
                    snippet(messages_fts, 0, '', '', '…', 12) AS snippet
               FROM messages_fts f
               JOIN messages m ON m.id = f.message_id
               JOIN sessions s ON s.id = m.session_id
              WHERE messages_fts MATCH ?
              ORDER BY rank LIMIT ?`
          )
          .all(text, size)
      }
      return db
        .prepare(
          `SELECT m.session_id AS sessionId, m.id AS messageId, m.role, s.title,
                  substr(m.payload, 1, 120) AS snippet
             FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.payload LIKE ?
            ORDER BY m.created_at DESC LIMIT ?`
        )
      .all(`%${text}%`, size)
  }

  return {
    file,
    version: SCHEMA_VERSION,
    listSessions,
    getSession,
    createSession,
    renameSession,
    deleteSession,
    upsertMessage,
    deleteMessages,
    importSessions,
    importWorkspaces,
    listWorkspaces,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    moveSession,
    deleteAllSessions,
    search,
    close: () => db.close(),
  }
}
