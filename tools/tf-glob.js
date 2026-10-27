/**
 * `tf_glob` — path discovery without reading contents.
 */

import { formatBytes } from '../lib/compact.js'
import { collectFiles, isSymlink, lstatNoFollow } from '../lib/fs-walk.js'
import {
  booleanParam,
  cacheNotice,
  integerParam,
  stringParam,
  textOutput,
  truncateText,
} from '../lib/tool-kit.js'

export const schema = {
  name: 'tf_glob',
  description: 'List matching workspace paths without reading contents. Supports **, *, ? and {a,b}.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'One glob or an array of globs.',
      },
      path: stringParam('Root directory; defaults to the session cwd.'),
      maxResults: integerParam('Maximum paths (default 200).'),
      details: booleanParam('Include byte size for each path.'),
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
    const requested = Array.isArray(args?.pattern) ? args.pattern : [args?.pattern]
    const positives = requested.filter((item) => typeof item === 'string' && item.length > 0 && !item.startsWith('!'))
    const negatives = requested.filter((item) => typeof item === 'string' && item.startsWith('!')).map((item) => item.slice(1))
    if (positives.length === 0) throw new Error('pattern must include at least one positive glob')
    const maxResults = clamp(intOr(args?.maxResults, settings.globMaxResults), 1, 2000)
    const rootPath = args?.path ?? '.'
    const link = await lstatNoFollow(ctx.fs, rootPath, cwd, exec.signal)
    if (isSymlink(link)) throw new Error('symbolic links are not traversed; use the real path inside the workspace')
    const files = await collectFiles({
      fs: ctx.fs,
      cwd,
      root: rootPath,
      signal: exec.signal,
      include: positives,
      exclude: negatives,
      maxFiles: Math.max(maxResults * 8, 1000),
      maxFileBytes: 8 * 1024 * 1024,
      excludedDirs: settings.exclude,
      sensitive: settings.sensitive,
    })
    const selected = files.slice(0, maxResults)
    let output = selected.map((file) => (args?.details ? `${file.rel}\t${formatBytes(file.size ?? 0)}` : file.rel)).join('\n')
    if (selected.length === 0) output = '(no files)'
    else if (files.length > selected.length) output += `\n[... ${files.length - selected.length} more files; showing first ${selected.length}; narrow the glob]`
    if (output.length > settings.globMaxChars) {
      const id = cache.put(sessionId, output)
      output = `${truncateText(output, settings.globMaxChars)}${cacheNotice(id, 'full glob result')}`
    }
    stats.bump(sessionId, 'toolCalls', 1)
    stats.bump(sessionId, 'globCalls', 1)
    stats.bump(sessionId, 'globReturnedChars', output.length)
    return output
  }
}

function intOr(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
