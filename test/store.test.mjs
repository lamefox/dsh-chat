/**
 * Unit tests for the durable store. Each test gets its own database file.
 *
 *   node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messageText, openStore, resolveDbPath, SCHEMA_VERSION, sqliteAvailable } from '../lib/store.js'

const withStore = (run) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-store-'))
  const store = openStore({ file: join(dir, 'chat.db') })
  try {
    await run(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const user = (id, text, at = 1) => ({ id, role: 'user', text, at })
const answer = (id, text, at = 2) => ({
  id,
  role: 'assistant',
  status: 'done',
  stopReason: 'end_turn',
  blocks: [{ type: 'text', text }],
  at,
})

test('sqlite binding is available in this runtime', () => {
  assert.equal(sqliteAvailable(), true)
})

test('resolveDbPath honours an explicit path and $DSH_HOME', () => {
  assert.equal(resolveDbPath('/tmp/x.db'), '/tmp/x.db')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/fake-home'
  try {
    assert.equal(resolveDbPath(), '/tmp/fake-home/dsh-chat/chat.db')
    assert.equal(resolveDbPath('  '), '/tmp/fake-home/dsh-chat/chat.db')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('messageText keeps visible text and drops thinking', () => {
  assert.equal(messageText(user('m', '你好')), '你好')
  const reply = {
    role: 'assistant',
    blocks: [
      { type: 'thinking', text: '推理过程' },
      { type: 'text', text: '答案 A' },
      { type: 'text', text: '答案 B' },
    ],
  }
  assert.equal(messageText(reply), '答案 A\n答案 B')
})

test(
  'sessions are created, listed and renamed',
  withStore(async (store) => {
    store.createSession({ id: 's1', title: '第一段对话', createdAt: 100 })
    const listed = store.listSessions()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, 's1')
    assert.equal(listed[0].messageCount, 0)
    assert.equal(store.renameSession('s1', '改名后'), true)
    assert.equal(store.listSessions()[0].title, '改名后')
    assert.equal(store.renameSession('s1', '   '), false, 'blank titles are rejected')
    assert.equal(store.renameSession('missing', 'x'), false)
    assert.equal(store.version, SCHEMA_VERSION)
  })
)

test(
  'messages keep stream order and upsert in place',
  withStore(async (store) => {
    store.createSession({ id: 's1', title: 'T' })
    store.upsertMessage('s1', user('m1', '问题一'))
    store.upsertMessage('s1', answer('m2', '回答一'))
    store.upsertMessage('s1', user('m3', '问题二'))
    assert.deepEqual(store.getSession('s1').messages.map((m) => m.id), ['m1', 'm2', 'm3'])

    // a streaming answer is written again when it finishes
    store.upsertMessage('s1', answer('m2', '回答一（更新）'))
    const messages = store.getSession('s1').messages
    assert.equal(messages.length, 3, 'the same id never duplicates')
    assert.equal(messages[1].blocks[0].text, '回答一（更新）')
  })
)

test(
  'two sessions never see each other messages',
  withStore(async (store) => {
    store.createSession({ id: 'a', title: 'A' })
    store.createSession({ id: 'b', title: 'B' })
    store.upsertMessage('a', user('a1', '只属于 A 的问题'))
    store.upsertMessage('b', user('b1', '只属于 B 的问题'))
    assert.deepEqual(store.getSession('a').messages.map((m) => m.text), ['只属于 A 的问题'])
    assert.deepEqual(store.getSession('b').messages.map((m) => m.text), ['只属于 B 的问题'])
  })
)

test(
  'deleting a session removes its messages and search rows',
  withStore(async (store) => {
    store.createSession({ id: 's1', title: 'T' })
    store.upsertMessage('s1', user('m1', 'GEO 优化公司怎么选'))
    assert.equal(store.search('优化公司').length, 1)
    assert.equal(store.deleteSession('s1'), true)
    assert.equal(store.getSession('s1'), undefined)
    assert.equal(store.search('优化公司').length, 0, 'search index is cleaned with the session')
  })
)

test(
  'deleting specific messages rewinds the tail',
  withStore(async (store) => {
    store.createSession({ id: 's1', title: 'T' })
    store.upsertMessage('s1', user('m1', '第一问'))
    store.upsertMessage('s1', answer('m2', '第一答'))
    assert.equal(store.deleteMessages('s1', ['m1', 'm2']), 2)
    assert.deepEqual(store.getSession('s1').messages, [])
    store.upsertMessage('s1', user('m3', '重问'))
    assert.deepEqual(store.getSession('s1').messages.map((m) => m.id), ['m3'], 'seq restarts after a full rewind')
  })
)

test(
  'import preserves order, assigns ids and is idempotent',
  withStore(async (store) => {
    const sessions = [
      { id: 'x', title: '导入的会话', createdAt: 10, messages: [user(undefined, '老问题'), { role: 'assistant', blocks: [{ type: 'text', text: '老回答' }] }] },
    ]
    const first = store.importSessions(sessions)
    assert.equal(first, 2)
    assert.equal(store.getSession('x').messages.length, 2)
    store.importSessions(sessions)
    assert.equal(store.getSession('x').messages.length, 2, 're-import updates instead of duplicating')
  })
)

test(
  'search supports three-or-more characters (FTS) and shorter queries (LIKE)',
  withStore(async (store) => {
    store.createSession({ id: 's1', title: 'GEO' })
    store.upsertMessage('s1', user('m1', '南京的GEO服务商有哪些'))
    store.upsertMessage('s1', answer('m2', '推荐关注服务商盘点与案例'))
    const long = store.search('服务商')
    assert.ok(long.length >= 1, 'trigram match works for CJK')
    assert.equal(long[0].sessionId, 's1')
    const short = store.search('南京')
    assert.equal(short.length, 1, 'two characters fall back to LIKE')
    assert.equal(store.search('   ').length, 0)
  })
)

test(
  'workspaces group sessions and deleting one keeps the conversations',
  withStore(async (store) => {
    const workspace = store.createWorkspace({ id: 'w1', name: '工作区 A' })
    assert.equal(workspace.name, '工作区 A')
    store.createSession({ id: 's1', title: '分组内', workspaceId: 'w1' })
    store.createSession({ id: 's2', title: '未分组' })

    assert.equal(store.listWorkspaces()[0].sessionCount, 1)
    assert.deepEqual(store.listSessions({ workspaceId: 'w1' }).map((session) => session.id), ['s1'])
    assert.deepEqual(store.listSessions({ workspaceId: 'none' }).map((session) => session.id), ['s2'])
    assert.equal(store.listSessions().length, 2)

    assert.equal(store.moveSession('s2', 'w1'), true)
    assert.deepEqual(store.listSessions({ workspaceId: 'w1' }).map((session) => session.id).sort(), ['s1', 's2'])
    assert.equal(store.moveSession('s2', 'nope'), false, 'unknown workspaces are rejected')
    assert.equal(store.moveSession('s2', 'none'), true)
    assert.equal(store.listSessions({ workspaceId: 'none' }).length, 1)

    assert.equal(store.updateWorkspaceName?.('w1', 'x'), undefined, 'no accidental extra API')
    assert.equal(store.renameWorkspace('w1', '改名'), true)
    assert.equal(store.listWorkspaces()[0].name, '改名')

    assert.equal(store.deleteWorkspace('w1'), true)
    assert.equal(store.listWorkspaces().length, 0)
    const orphan = store.getSession('s1')
    assert.equal(orphan.session.workspaceId, null, 'sessions survive their workspace')
    assert.equal(orphan.messages.length, 0)
  })
)

test(
  'deleteAllSessions clears conversations but keeps workspaces',
  withStore(async (store) => {
    store.createWorkspace({ id: 'w1', name: '保留' })
    store.createSession({ id: 's1', title: 'A', workspaceId: 'w1' })
    store.upsertMessage('s1', user('m1', '要被清空的消息'))
    assert.equal(store.search('清空').length, 1)

    assert.equal(store.deleteAllSessions(), 1)
    assert.equal(store.listSessions().length, 0)
    assert.equal(store.listWorkspaces().length, 1, 'workspaces are configuration, not conversation data')
    assert.equal(store.search('清空').length, 0, 'the search index is cleared too')
  })
)

test('a v1 database upgrades in place without losing conversations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-migrate-'))
  const file = join(dir, 'chat.db')
  try {
    // Build the exact v1 shape, then reopen through the store.
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, status TEXT, stop_reason TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(session_id, seq));
      INSERT INTO sessions VALUES ('old', '升级前的会话', 1, 2);
      INSERT INTO messages VALUES ('old-m1', 'old', 1, 'user', NULL, NULL, '{"id":"old-m1","role":"user","text":"历史消息"}', 1);
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const store = openStore({ file })
    assert.equal(store.version, SCHEMA_VERSION)
    assert.equal(store.listSessions().length, 1, 'existing conversations survive the upgrade')
    assert.equal(store.getSession('old').messages.length, 1)
    assert.equal(store.listSessions()[0].workspaceId, null, 'old rows join the ungrouped bucket')
    assert.deepEqual(store.listWorkspaces(), [], 'the workspaces table exists after migration')
    store.createWorkspace({ id: 'w', name: '升级后新建' })
    assert.equal(store.moveSession('old', 'w'), true, 'migrated sessions can be grouped')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
