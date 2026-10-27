/**
 * Deterministic text compaction helpers. No I/O and no model calls.
 * Used by the tool-output governor and by the compact renderers.
 */

const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g
const ANSI_SINGLE = /\u001B[@-_]/g
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** Remove ANSI escape sequences and non-printing control characters. */
export function stripAnsi(value) {
  return String(value)
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_SINGLE, '')
    .replace(CONTROL, '')
}

/** Normalize line endings and fold carriage-return progress updates to their last frame. */
export function normalizeLines(value) {
  const text = stripAnsi(value).replace(/\r\n/g, '\n')
  const lines = text.split('\n').map((line) => {
    if (!line.includes('\r')) return line
    const frames = line.split('\r').filter((frame) => frame.length > 0)
    return frames.length > 0 ? frames[frames.length - 1] : ''
  })
  return lines.join('\n')
}

/**
 * Compress one oversized text result.
 * @param {string} raw
 * @param {{thresholdChars?: number, headLines?: number, tailLines?: number, isError?: boolean, maxOutputChars?: number, omissionNote?: string, preserveStructure?: boolean}} [opts]
 */
export function compressText(raw, opts = {}) {
  const thresholdChars = opts.thresholdChars ?? 8000
  const headLines = opts.headLines ?? 120
  const tailLines = opts.tailLines ?? 40
  const maxOutputChars = opts.maxOutputChars ?? 12000
  const omissionNote = opts.omissionNote ?? 'full output available via tf_result'
  const preserveStructure = opts.preserveStructure === true
  const original = String(raw)
  if (original.length <= thresholdChars) {
    return { text: original, changed: false, originalChars: original.length, compressedChars: original.length, removedChars: 0 }
  }

  const normalized = normalizeLines(original)
  const sourceLines = normalized.split('\n')
  const folded = []

  if (preserveStructure) {
    // Code path: keep blank lines, indentation and repeated lines intact.
    // Only trailing whitespace is dropped; the head/tail budget still applies.
    for (const line of sourceLines) folded.push(line.replace(/[ \t]+$/g, ''))
  } else {
    let blankRun = 0
    let lastLine = null
    let repeatRun = 0

    for (const line of sourceLines) {
      const trimmedEnd = line.replace(/[ \t]+$/g, '')
      if (trimmedEnd.trim() === '') {
        blankRun += 1
        if (blankRun <= 2) folded.push('')
        continue
      }
      blankRun = 0
      if (trimmedEnd === lastLine) {
        repeatRun += 1
        continue
      }
      if (repeatRun > 1) folded.push(`[... previous line repeated ${repeatRun} more times]`)
      repeatRun = 0
      lastLine = trimmedEnd
      folded.push(trimmedEnd)
    }
    if (repeatRun > 1) folded.push(`[... previous line repeated ${repeatRun} more times]`)
  }

  if (folded.length <= headLines + tailLines + 4) {
    let joined = folded.join('\n')
    if (joined.length > maxOutputChars) joined = clipToBudget(joined, maxOutputChars)
    if (joined.length >= original.length) {
      return { text: original, changed: false, originalChars: original.length, compressedChars: original.length, removedChars: 0 }
    }
    return { text: joined, changed: true, originalChars: original.length, compressedChars: joined.length, removedChars: original.length - joined.length }
  }

  let text = fitPreview(folded, headLines, tailLines, maxOutputChars, omissionNote)

  if (text.length >= original.length || text.length >= normalized.length) {
    return { text: original, changed: false, originalChars: original.length, compressedChars: original.length, removedChars: 0 }
  }
  return { text, changed: true, originalChars: original.length, compressedChars: text.length, removedChars: original.length - text.length }
}

/**
 * Build a head/tail preview that fits the character budget while always
 * keeping the omission marker. Long lines previously pushed the marker and the
 * whole tail past the budget, leaving the model with a silent mid-line cut.
 */
function fitPreview(lines, headLines, tailLines, maxOutputChars, omissionNote) {
  let head = Math.min(headLines, lines.length)
  let tail = Math.min(tailLines, Math.max(0, lines.length - head))
  while (head + tail > 0) {
    const headPart = head > 0 ? lines.slice(0, head) : []
    const tailPart = tail > 0 ? lines.slice(-tail) : []
    const omitted = lines.length - head - tail
    const text = [...headPart, `[... ${omitted} lines omitted by TokenForge; ${omissionNote} ...]`, ...tailPart].join('\n')
    if (text.length <= maxOutputChars) return text
    if (head >= tail && head > 0) head = Math.floor(head * 0.75)
    else if (tail > 0) tail = Math.floor(tail * 0.75)
    else break
  }
  return clipToBudget(lines.join('\n'), maxOutputChars)
}

/** Clip to a character budget without splitting a UTF-16 surrogate pair. */
function clipToBudget(text, maxOutputChars) {
  const suffix = '\n[... output clipped by TokenForge ...]'
  let budget = Math.max(1, maxOutputChars - suffix.length)
  if (budget < text.length) {
    const code = text.charCodeAt(budget - 1)
    if (code >= 0xD800 && code <= 0xDBFF) budget -= 1
  }
  const head = text.slice(0, budget)
  const cut = head.lastIndexOf('\n')
  const body = cut > 0 ? head.slice(0, cut) : head
  return `${body}${suffix}`
}

/**
 * Never-throwing wrapper for the governor. A malformed or adversarial string
 * must degrade to the original text, never turn a successful tool call into a
 * plugin error.
 */
export function safeCompressText(raw, opts = {}) {
  let original = ''
  try {
    original = typeof raw === 'string' ? raw : String(raw ?? '')
  } catch {
    original = '[unprintable input]'
  }
  try {
    return compressText(original, opts)
  } catch (error) {
    return {
      text: original,
      changed: false,
      originalChars: original.length,
      compressedChars: original.length,
      removedChars: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Render a line-numbered window, preserving the requested 1-based start line. */
export function renderNumberedLines(text, startLine = 1, maxChars = 32768) {
  const lines = String(text).split('\n')
  const visible = []
  let used = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const cost = line.length + 8
    if (used + cost > maxChars && visible.length > 0) {
      visible.push(`[... ${lines.length - i} more lines truncated; narrow the range ...]`)
      break
    }
    visible.push(line)
    used += cost
  }
  const width = String(startLine + visible.length).length
  return visible.map((line, i) => `${String(startLine + i).padStart(width, ' ')}|${line}`).join('\n')
}

/** Human-readable byte size for tool output. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

/** Approximate token count used only for local reporting. */
export function estimateTokens(chars) {
  return Math.ceil((Number(chars) || 0) / 4)
}
