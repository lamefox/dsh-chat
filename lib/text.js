/**
 * Pure text helpers for dsh-chat: HTML escaping, the markdown-lite renderer and
 * the answer-run merger. No DOM access, so `node --test` covers them and the
 * browser loads the same file.
 */

/** Escape the five characters that can break out of text or an attribute. */
export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * Inline markdown over already-escaped text. Order matters: bold before
 * italic, and links before bare URLs so a labelled link keeps its label.
 */
export const renderInline = (text) => {
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
export const renderMarkdown = (text) => {
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
export const mergeAnswerRuns = (blocks, numberOf) => {
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

/** The answer text without citations, used for copy, speech and share. */
export const plainText = (message) =>
  (message.blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
