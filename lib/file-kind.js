/**
 * File-kind classification for compression policy.
 *
 * Code files get structure-preserving compression: no blank/repeat folding and
 * a larger output budget. Logs and data dumps keep the aggressive path. This
 * is a heuristic on the extension only; it never reads the file.
 */

export const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.fs',
  '.rb', '.php', '.swift', '.m', '.mm', '.lua', '.pl', '.r',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.vue', '.svelte', '.astro', '.dart', '.ex', '.exs', '.erl',
])

export const LOG_EXTENSIONS = new Set([
  '.log', '.out', '.err', '.trace', '.ndjson', '.jsonl', '.txt', '.text',
])

export const DATA_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.csv', '.tsv', '.xml', '.toml', '.ini', '.conf',
])

/** Lower-case extension including the dot, or '' when there is none. */
export function extensionOf(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  const clean = value.split(/[?#]/, 1)[0].replace(/\\/g, '/')
  const name = clean.slice(clean.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot).toLowerCase()
}

/**
 * @param {string|undefined} value path or file name
 * @returns {'code'|'log'|'data'|'generic'}
 */
export function classifyPath(value) {
  const ext = extensionOf(value)
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (LOG_EXTENSIONS.has(ext)) return 'log'
  if (DATA_EXTENSIONS.has(ext)) return 'data'
  return 'generic'
}
