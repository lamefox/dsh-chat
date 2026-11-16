/**
 * Unit tests for the pure text helpers. No DOM, no network.
 *
 *   node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { escapeHtml, mergeAnswerRuns, plainText, renderMarkdown } from '../lib/text.js'

const here = dirname(fileURLToPath(import.meta.url))

test('escapeHtml covers the five dangerous characters', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
})

test('renderMarkdown escapes raw HTML but keeps generated tags', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>')
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img/)
})

test('renderMarkdown handles headings, lists, code fences and links', () => {
  const html = renderMarkdown(
    [
      '## 标题',
      '',
      '- 一',
      '- 二',
      '',
      '```js',
      'const a = 1 < 2',
      '```',
      '',
      '见 [文档](https://example.com/a)',
    ].join('\n')
  )
  assert.match(html, /<h2>标题<\/h2>/)
  assert.match(html, /<ul><li>一<\/li><li>二<\/li><\/ul>/)
  assert.match(html, /<pre data-lang="js"><code>const a = 1 &lt; 2<\/code><\/pre>/)
  assert.match(html, /<a href="https:\/\/example.com\/a"/)
})

test('mergeAnswerRuns joins blocks split by citations into one run', () => {
  const blocks = [
    { type: 'text', text: '有的卖“品牌资产”', citations: [{ url: 'https://a/1' }, { url: 'https://b/2' }] },
    { type: 'text', text: '。如果不先厘清自己要买什么。' },
  ]
  const runs = mergeAnswerRuns(blocks, (url) => ({ 'https://a/1': 1, 'https://b/2': 2 })[url])
  assert.equal(runs.length, 1, 'the tail stays in the same paragraph')
  assert.equal(runs[0].start, 0)
  assert.equal(runs[0].markdown, '有的卖“品牌资产”«cite:1»«cite:2»。如果不先厘清自己要买什么。')
})

test('mergeAnswerRuns breaks a run at every non-text block', () => {
  const blocks = [
    { type: 'thinking', text: '先想一下' },
    { type: 'text', text: '第一段' },
    { type: 'search', id: 's1' },
    { type: 'text', text: '第二段' },
  ]
  const runs = mergeAnswerRuns(blocks, () => undefined)
  assert.deepEqual(
    runs.map((run) => [run.start, run.markdown]),
    [
      [1, '第一段'],
      [3, '第二段'],
    ]
  )
})

test('mergeAnswerRuns drops unknown citations and never emits an empty run', () => {
  const blocks = [
    { type: 'text', text: '  \n  ' },
    { type: 'text', text: '正文', citations: [{ url: 'https://unknown/9' }] },
  ]
  const runs = mergeAnswerRuns(blocks, () => undefined)
  assert.equal(runs.length, 1, 'whitespace-only blocks join the next paragraph instead of standing alone')
  assert.equal(runs[0].markdown.trim(), '正文')
  assert.equal(runs[0].markdown.includes('cite'), false, 'an unknown URL adds no marker')
})

test('plainText concatenates only text blocks', () => {
  const message = {
    blocks: [
      { type: 'thinking', text: '思考' },
      { type: 'text', text: 'A' },
      { type: 'searchResult', items: [] },
      { type: 'text', text: 'B' },
    ],
  }
  assert.equal(plainText(message), 'AB')
})

/** The browser bundle inlines these helpers; keep the two copies byte-equal. */
const bodyOf = (source, name) => {
  const patterns = [`export const ${name} = `, `const ${name} = `]
  const pattern = patterns.find((candidate) => source.includes(candidate))
  if (!pattern) return null
  const from = source.indexOf(pattern) + pattern.length
  const rest = source.slice(from)
  const stop = rest.search(/\n(?=\/\/|\/\*\*|(?:export )?const )/)
  return (stop === -1 ? rest : rest.slice(0, stop)).replace(/\s+/g, ' ').trim()
}

test('app.js keeps a byte-identical copy of every text helper', () => {
  const app = readFileSync(join(here, '../lib/app.js'), 'utf8')
  const text = readFileSync(join(here, '../lib/text.js'), 'utf8')
  for (const name of ['escapeHtml', 'renderInline', 'renderMarkdown', 'mergeAnswerRuns', 'plainText']) {
    const browserCopy = bodyOf(app, name)
    assert.ok(browserCopy, `${name} missing from lib/app.js`)
    assert.equal(browserCopy, bodyOf(text, name), `${name} drifted between lib/app.js and lib/text.js`)
  }
})
