/**
 * `tf_grep` — locate text cheaply, then let the model decide what to read.
 */

import { collectFiles, isSymlink, lstatNoFollow, readTextFile } from '../lib/fs-walk.js'
import {
  cacheNotice,
  integerParam,
  stringParam,
  textOutput,
  truncateText,
} from '../lib/tool-kit.js'

export const schema = {
  name: 'tf_grep',
  description: 'Search text files and return compact counts or matching lines. Start with mode "summary" to decide what to read.',
  parameters: {
    type: 'object',
    properties: {
      pattern: stringParam('JavaScript regular expression.'),
      path: stringParam('Root file or directory; defaults to the session cwd.'),
      include: stringParam('Optional glob filter, e.g. "src/**/*.ts".'),
      mode: { type: 'string', enum: ['summary', 'count', 'content'], description: 'summary (default), count, or matching lines.' },
      maxFiles: integerParam('Maximum files to scan (default 5000).'),
      maxMatches: integerParam('Maximum matches to collect (default 100).'),
      caseSensitive: { type: 'boolean', description: 'Case-sensitive search; default false.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  output: textOutput(),
}

/**
 * @param {import('../lib/runtime.js').TokenForgeRuntime} runtime
 */
export function createHandler(runtime) {
  const { ctx, settings, cache, stats } = runtime

  return async function execute(args, exec) {
    const cwd = runtime.cwd(exec)
    const sessionId = runtime.sessionId(exec)
    let regex
    try {
      regex = new RegExp(String(args?.pattern ?? ''), args?.caseSensitive ? '' : 'i')
    } catch (error) {
      throw new Error(`invalid pattern: ${error.message}`)
    }
    const mode = args?.mode ?? 'summary'
    const maxMatches = clamp(intOr(args?.maxMatches, settings.grepMaxMatches), 1, 1000)
    const maxFiles = clamp(intOr(args?.maxFiles, settings.grepMaxFiles), 1, 20000)
    const include = typeof args?.include === 'string' && args.include.length > 0 ? [args.include] : []
    const rootPath = args?.path ?? '.'
    const link = await lstatNoFollow(ctx.fs, rootPath, cwd, exec.signal)
    if (isSymlink(link)) throw new Error('symbolic links are not traversed; use the real path inside the workspace')
    const files = await collectFiles({
      fs: ctx.fs,
      cwd,
      root: rootPath,
      signal: exec.signal,
      include,
      maxFiles,
      maxFileBytes: 2 * 1024 * 1024,
      excludedDirs: settings.exclude,
      sensitive: settings.sensitive,
    })
    const perFile = []
    let totalMatches = 0
    let scanned = 0
    for (const file of files) {
      if (totalMatches >= maxMatches) break
      let text
      try {
        const info = await ctx.fs.stat(file.target, exec.signal)
        if (!info || info.type !== 'file' || (typeof info.size === 'number' && info.size > 2 * 1024 * 1024)) continue
        text = await readTextFile(ctx.fs, file.target, exec.signal, { maxBytes: 2 * 1024 * 1024 })
      } catch {
        continue
      }
      scanned += 1
      const lines = text.split('\n')
      let count = 0
      const matches = []
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) {
          count += 1
          if (matches.length < maxMatches - totalMatches) {
            matches.push({ line: i + 1, text: lines[i].slice(0, 300) })
          }
        }
      }
      if (count === 0) continue
      totalMatches += count
      perFile.push({ path: file.rel, count, matches })
    }
    let output
    if (totalMatches === 0) {
      output = '(no matches)'
    } else if (mode === 'count') {
      output = perFile.map((entry) => `${entry.path}: ${entry.count}`).join('\n')
    } else if (mode === 'content') {
      const rows = []
      for (const entry of perFile) {
        rows.push(entry.path)
        for (const match of entry.matches) rows.push(`  ${match.line}: ${match.text}`)
      }
      output = rows.join('\n')
    } else {
      output = [`files=${perFile.length} matches=${totalMatches} scanned=${scanned}`, ...perFile.map((entry) => `${entry.path}: ${entry.count}`)].join('\n')
    }
    if (output.length > settings.grepMaxChars) {
      const id = cache.put(sessionId, output)
      output = `${truncateText(output, settings.grepMaxChars)}${cacheNotice(id, 'full grep result')}`
    }
    stats.bump(sessionId, 'toolCalls', 1)
    stats.bump(sessionId, 'grepCalls', 1)
    stats.bump(sessionId, 'grepReturnedChars', output.length)
    return output
  }
}

function intOr(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
