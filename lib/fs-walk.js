/**
 * Filesystem traversal and glob matching built exclusively on ctx.fs.
 * The host filesystem provider owns sandbox/path authorization; this module
 * never calls Node's fs and never follows symlinks.
 */

import path from 'node:path'

export const DEFAULT_EXCLUDED_DIRS = [
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.next', '.nuxt',
  '.venv', 'venv', 'target', 'coverage', '.dsh', '.tokenforge', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.turbo',
  '.ssh', '.aws', '.gnupg', '.kube', '.docker',
]

export const DEFAULT_SENSITIVE = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*',
  'id_ed25519*', 'id_ecdsa*', 'known_hosts', 'authorized_keys',
  '.credentials*', 'credentials.json', '.netrc', '.npmrc', '.pgpass',
  '.htpasswd', '*.kdbx', 'secrets.json', 'secrets.yaml', 'secrets.yml',
  '.secrets', '.secret', 'token.json',
]

/** Directories whose contents are treated as credential material. */
export const SENSITIVE_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker']

const globCache = new Map()

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** Convert one glob (supports **, *, ?, {a,b}) to an anchored regular expression. */
export function globToRegExp(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '')
  const cached = globCache.get(normalized)
  if (cached) return cached

  let body = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        i += 1
        if (normalized[i + 1] === '/') {
          i += 1
          body += '(?:.*/)?'
        } else {
          body += '.*'
        }
      } else {
        body += '[^/]*'
      }
    } else if (ch === '?') {
      body += '[^/]'
    } else if (ch === '{') {
      const end = normalized.indexOf('}', i)
      if (end > i) {
        const options = normalized.slice(i + 1, end).split(',').map((part) => escapeRegex(part.trim()))
        body += `(?:${options.join('|')})`
        i = end
      } else {
        body += '\\{'
      }
    } else {
      body += escapeRegex(ch)
    }
  }

  const anchored = normalized.includes('/')
    ? new RegExp(`^${body}$`)
    : new RegExp(`(?:^|/)${body}$`)
  globCache.set(normalized, anchored)
  return anchored
}

/** True when any name pattern matches the basename (supports * and ?). */
export function matchesName(name, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(name))
}

/**
 * Reject credential-like paths before any read. This is broader than a
 * basename check: a credential directory anywhere in the path is enough, so
 * `.ssh/id_rsa`, `~/.aws/credentials`, and a copied `backup/.ssh/id_rsa` are
 * all denied. Callers may opt out explicitly.
 */
export function isSensitivePath(value, patterns = DEFAULT_SENSITIVE) {
  const parts = normalizePath(value).split('/').filter(Boolean)
  if (parts.some((part) => SENSITIVE_DIRS.includes(part))) return true
  return parts.some((part) => matchesName(part, patterns))
}

/** Normalize a model path to forward slashes without resolving it. */
export function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** Display path relative to the session cwd when possible. */
export function displayPath(fs, target, cwd) {
  let absolute = ''
  try {
    absolute = fs.processPath(target)
  } catch {
    absolute = target.displayPath
  }
  const normalized = normalizePath(absolute)
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/, '')
  if (normalizedCwd && (normalized === normalizedCwd || normalized.startsWith(`${normalizedCwd}/`))) {
    const rel = normalized.slice(normalizedCwd.length + 1)
    return rel.length > 0 ? rel : '.'
  }
  return normalized
}

/** Resolve the session cwd, falling back to process.cwd() for direct calls. */
export function sessionCwd(ctx, agent) {
  try {
    if (agent?.session) return ctx.workingDirectory.get(agent.session)
  } catch {
    // fall through
  }
  return process.cwd()
}

/**
 * Recursively collect regular files under a root.
 * @returns {Promise<Array<{target: any, rel: string, name: string, size?: number}>>}
 */
export async function collectFiles(options) {
  const {
    fs, cwd, root = '.', signal, include = [], exclude = [],
    maxFiles = 2000, maxFileBytes = 2 * 1024 * 1024,
    excludedDirs = DEFAULT_EXCLUDED_DIRS, sensitive = DEFAULT_SENSITIVE,
    maxDepth = 24,
  } = options

  const rootTarget = await fs.resolve(root, { cwd, signal })
  const rootStat = await fs.stat(rootTarget, signal)
  if (!rootStat) throw new Error(`path not found: ${normalizePath(root)}`)

  const files = []
  const push = (target, rel, name, size) => {
    if (files.length >= maxFiles) return false
    if (typeof size === 'number' && size > maxFileBytes) return true
    const accepts = include.length === 0
      ? !exclude.some((pattern) => globToRegExp(pattern).test(rel))
      : include.some((pattern) => globToRegExp(pattern).test(rel))
        && !exclude.some((pattern) => globToRegExp(pattern).test(rel))
    if (accepts) files.push({ target, rel, name, size })
    return true
  }

  if (rootStat.type === 'file') {
    const name = normalizePath(path.posix.basename(normalizePath(rootTarget.displayPath)))
    if (!isSensitivePath(rootTarget.displayPath, sensitive) && (typeof rootStat.size !== 'number' || rootStat.size <= maxFileBytes)) {
      // An explicit file root is already the caller's selection; include filters
      // apply to directory walks, not to a single named file.
      files.push({ target: rootTarget, rel: displayPath(fs, rootTarget, cwd), name, size: rootStat.size })
    }
    return files
  }
  if (rootStat.type !== 'directory') return files

  const queue = [{ target: rootTarget, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current.depth > maxDepth || files.length >= maxFiles) break
    let entries
    try {
      entries = await fs.listDir(current.target, signal)
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      if (entry.type === 'directory') {
        if (excludedDirs.includes(entry.name) || SENSITIVE_DIRS.includes(entry.name)) continue
        queue.push({ target: entry.target, depth: current.depth + 1 })
        continue
      }
      if (entry.type !== 'file') continue
      const rel = displayPath(fs, entry.target, cwd)
      if (isSensitivePath(rel, sensitive)) continue
      push(entry.target, rel, entry.name, entry.size)
    }
  }
  return files
}

/**
 * Rebuild a UTF-16 file from the UTF-8-decoded string that ctx.fs handed us.
 *
 * ctx.fs exposes only readText, so a UTF-16LE/BE file arrives already decoded
 * as UTF-8: ASCII content shows a NUL in every other code unit, non-ASCII
 * content shows replacement characters. We may only rebuild the byte stream
 * when every code unit is < 0x80, because an ASCII character can only come
 * from an ASCII byte; in that case the original bytes are recoverable exactly.
 * Anything else would be a guess, and guessing silently corrupts content, so
 * this returns null and the caller fails closed with an actionable message.
 *
 * @returns {string|null} decoded text, or null when this is not recoverable UTF-16
 */
export function decodeUtf16Text(text) {
  if (typeof text !== 'string') return null
  // A UTF-16 BOM is two bytes that are invalid UTF-8, so each arrives as U+FFFD.
  let start = 0
  while (start < 2 && start < text.length && text.charCodeAt(start) === 0xfffd) start += 1
  const body = text.slice(start)
  if (body.length < 2) return null
  for (let i = 0; i < body.length; i += 1) {
    if (body.charCodeAt(i) > 0x7f) return null
  }
  const pairs = Math.floor(body.length / 2)
  if (pairs === 0) return null
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i < body.length; i += 1) {
    if (body.charCodeAt(i) === 0) {
      if (i % 2 === 0) evenNul += 1
      else oddNul += 1
    }
  }
  const slack = Math.ceil(pairs * 0.05)
  const isLe = oddNul >= pairs && evenNul <= slack
  const isBe = evenNul >= pairs && oddNul <= slack
  if (isLe === isBe) return null
  const evenLength = body.length % 2 === 0 ? body.length : body.length - 1
  const bytes = Buffer.allocUnsafe(evenLength)
  for (let i = 0; i < evenLength; i += 1) bytes[i] = body.charCodeAt(i) & 0xff
  const decoded = (isBe ? Buffer.from(bytes).swap16() : bytes).toString('utf16le')
  const stripped = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded
  return stripped.replace(/\u0000+$/, '')
}

/** True when text still looks like raw bytes rather than readable content. */
export function isProbablyBinary(text) {
  if (typeof text !== 'string') return true
  if (text.includes('\u0000')) return true
  let controls = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) controls += 1
  }
  return text.length > 0 && controls / text.length > 0.05
}

/**
 * Read a text file through ctx.fs, bounded by `maxBytes`, and decode it with
 * explicit encoding detection. Binary and low-confidence content is rejected
 * instead of being returned as mojibake.
 *
 * When the host exposes `readBytes` (DSH does), we read raw bytes so GBK and
 * UTF-16 are decoded from the original stream, not from an already-lossy UTF-8
 * string. Otherwise we fall back to `readText` for older hosts and tests.
 *
 * @param {any} fs host filesystem service
 * @param {any} target resolved target
 * @param {AbortSignal|undefined} signal
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<string>}
 */
export async function readTextFile(fs, target, signal, options = {}) {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  if (typeof fs.readBytes === 'function') {
    const bytes = await fs.readBytes(target, signal, maxBytes)
    return decodeTextBytes(bytes).text
  }

  const text = await fs.readText(target, signal)
  if (typeof text !== 'string') throw new Error('not a UTF-8 text file')
  const decoded = decodeUtf16Text(text)
  if (decoded !== null && !isProbablyBinary(decoded)) return decoded
  if (text.includes('\u0000')) {
    throw new Error('binary file detected: NUL bytes found (or UTF-16 without a decodable BOM); convert it to UTF-8 to read it')
  }
  if (text.includes('\ufffd')) {
    throw new Error('not valid UTF-8 text: replacement characters found (file may be GBK/GB18030 or UTF-16); convert it to UTF-8 to read it')
  }
  let body = text
  while (body.charCodeAt(0) === 0xfeff) body = body.slice(1)
  return body
}

/**
 * Decode raw file bytes with explicit, fail-closed detection.
 *
 * Order: repeated UTF-8 BOM, UTF-16 BOM, BOM-less UTF-16 (ASCII pattern),
 * strict UTF-8, then GBK with a CJK-ratio confidence check. Anything else
 * throws `UNSUPPORTED_ENCODING`; we never guess a legacy code page and return
 * mojibake to the model.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{text: string, encoding: string}}
 */
export function decodeTextBytes(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? [])
  if (bytes.length === 0) return { text: '', encoding: 'utf-8' }

  let offset = 0
  while (offset < 9 && offset + 3 <= bytes.length
    && bytes[offset] === 0xef && bytes[offset + 1] === 0xbb && bytes[offset + 2] === 0xbf) {
    offset += 3
  }
  if (offset > 0) {
    return { text: decodeStrict('utf-8', bytes.subarray(offset)), encoding: 'utf-8' }
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeStrict('utf-16le', bytes.subarray(2)), encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeStrict('utf-16be', bytes.subarray(2)), encoding: 'utf-16be' }
  }

  const bomlessUtf16 = sniffBomlessUtf16(bytes)
  if (bomlessUtf16) {
    return { text: decodeStrict(bomlessUtf16, bytes), encoding: bomlessUtf16 }
  }

  if (bytes.subarray(0, 512).includes(0)) {
    throw codedError('BINARY_FILE', 'binary file detected: NUL bytes in the first 512 bytes; refusing to decode')
  }

  let utf8Error
  try {
    const text = decodeStrict('utf-8', bytes)
    if (!isProbablyBinary(text)) return { text, encoding: 'utf-8' }
  } catch (error) {
    utf8Error = error
  }

  try {
    const text = decodeStrict('gbk', bytes)
    if (looksLikeGbk(bytes, text) && !isProbablyBinary(text)) return { text, encoding: 'gbk' }
  } catch {
    // fall through to the explicit error below
  }

  throw codedError(
    'UNSUPPORTED_ENCODING',
    'unsupported encoding: not valid UTF-8, UTF-16 or high-confidence GBK text; convert the file to UTF-8 and retry',
  )
}

function decodeStrict(encoding, bytes) {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}

/** UTF-16 without BOM is only claimed for the ASCII pattern; CJK needs a BOM. */
function sniffBomlessUtf16(bytes) {
  const sample = bytes.subarray(0, Math.min(512, bytes.length))
  if (sample.length < 8) return null
  const pairs = Math.floor(sample.length / 2)
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i < pairs * 2; i += 1) {
    if (sample[i] === 0) {
      if (i % 2 === 0) evenNul += 1
      else oddNul += 1
    }
  }
  if (oddNul >= pairs * 0.8 && evenNul <= pairs * 0.1) return 'utf-16le'
  if (evenNul >= pairs * 0.8 && oddNul <= pairs * 0.1) return 'utf-16be'
  return null
}

/** GBK is only accepted when enough high bytes clearly form CJK characters. */
function looksLikeGbk(bytes, text) {
  if (text.includes('\ufffd')) return false
  let highBytes = 0
  for (const byte of bytes) {
    if (byte >= 0x80) highBytes += 1
  }
  if (highBytes < 4) return false
  let cjk = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
  }
  return cjk >= 2 && cjk * 2 >= highBytes * 0.5
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Map host/Node filesystem failures to a human-readable, non-throwing message. */
export function describeFsError(error) {
  const code = String(error?.code ?? '')
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'EBUSY':
    case 'EPERM':
    case 'EACCES':
      return `file is locked or access is denied (${code}); close the program holding it, or copy the file and retry`
    case 'ENOENT':
    case 'FS_NOT_FOUND':
      return 'file not found'
    case 'EISDIR':
      return 'path is a directory, not a file'
    case 'EMFILE':
    case 'ENFILE':
      return 'too many open files; retry after closing other reads'
    case 'FS_TOO_LARGE':
      return message
    case 'FS_NOT_TEXT':
      return 'binary or non-text file; refusing to decode'
    case 'FS_ABORTED':
      return 'read aborted'
    case 'BINARY_FILE':
    case 'UNSUPPORTED_ENCODING':
      return message
    default:
      return message || code || 'unknown filesystem error'
  }
}

/**
 * Follow no symlinks: ask the host for an lstat-style record before resolving.
 * Returns undefined when the host has no lstat or the check itself fails; the
 * normal resolve/stat path still enforces the sandbox.
 */
export async function lstatNoFollow(fs, requestPath, cwd, signal) {
  if (typeof fs?.lstat !== 'function') return undefined
  try {
    return await fs.lstat(requestPath, { cwd }, signal)
  } catch {
    return undefined
  }
}

/** Host records use `type: 'symlink'`; accept a boolean shape too. */
export function isSymlink(info) {
  return info?.type === 'symlink' || info?.isSymbolicLink === true
}

/** Count occurrences of one compiled regular expression in text. */
export function countMatches(text, regex) {
  let count = 0
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
  const scan = new RegExp(regex.source, flags)
  while (scan.exec(text) !== null) {
    count += 1
    if (scan.lastIndex === 0) scan.lastIndex += 1
  }
  return count
}
