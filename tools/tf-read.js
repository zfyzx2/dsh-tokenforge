/**
 * `tf_read` — schema (model-facing contract) and handler (execution) live in
 * the same module but are separate exports. The registry composes them.
 *
 * Defenses in this handler: empty-file short circuit, symlink refusal,
 * bounded raw-byte reads, encoding detection, concurrent-read dedupe, and
 * human-readable filesystem errors. File content is wrapped as untrusted data.
 */

import { formatBytes, renderNumberedLines } from '../lib/compact.js'
import {
  describeFsError,
  displayPath,
  isSensitivePath,
  isSymlink,
  lstatNoFollow,
  readTextFile,
} from '../lib/fs-walk.js'
import {
  cacheNotice,
  integerParam,
  stringParam,
  textOutput,
  truncateText,
} from '../lib/tool-kit.js'

export const schema = {
  name: 'tf_read',
  description: 'Read up to 8 exact file ranges with line numbers. Prefer this over dumping a whole file; combine independent reads in one call.',
  parameters: {
    type: 'object',
    properties: {
      requests: {
        type: 'array',
        description: 'Read requests (1-8): {path, offset?, limit?}. offset is 1-based.',
        items: {
          type: 'object',
          properties: {
            path: stringParam('Workspace-relative or absolute path.'),
            offset: integerParam('First line, 1-based.'),
            limit: integerParam('Maximum lines (<=2000).'),
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    required: ['requests'],
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
    const requests = Array.isArray(args?.requests) ? args.requests.slice(0, 8) : []
    if (requests.length === 0) throw new Error('requests must contain 1-8 items')
    const cwd = runtime.cwd(exec)
    const sessionId = runtime.sessionId(exec)
    const blocks = []

    for (const request of requests) {
      const requestPath = typeof request?.path === 'string' ? request.path : ''
      if (!requestPath) {
        blocks.push('<error path="">path must be a non-empty string</error>')
        continue
      }
      if (!settings.allowSensitivePaths && isSensitivePath(requestPath, settings.sensitive)) {
        blocks.push(`<error path="${escapeAttribute(requestPath)}">sensitive credential path denied by TokenForge</error>`)
        continue
      }
      try {
        const link = await lstatNoFollow(ctx.fs, requestPath, cwd, exec.signal)
        if (isSymlink(link)) {
          throw new Error('symbolic links are not read directly; resolve the real path inside the workspace')
        }
        const target = await ctx.fs.resolve(requestPath, { cwd, signal: exec.signal })
        const info = await ctx.fs.stat(target, exec.signal)
        if (!info) throw new Error('not found')
        if (info.type !== 'file') throw new Error('not a regular file')
        if (typeof info.size === 'number' && info.size > settings.readMaxFileBytes) {
          throw new Error(`file too large (${formatBytes(info.size)}); read a narrower range`)
        }

        const rel = displayPath(ctx.fs, target, cwd)
        try {
          ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, { agent: exec.agent })
        } catch {
          // Observation is an optimization for write/edit policy; never fail the read over it.
        }

        if (info.size === 0) {
          blocks.push(emptyFileBlock(rel, 0))
          stats.bump(sessionId, 'readCalls', 1)
          stats.bump(sessionId, 'readReturnedChars', 13)
          continue
        }

        const key = `${safeProcessPath(ctx.fs, target) ?? requestPath}|${info.version ?? ''}|${info.size ?? ''}`
        const text = await runtime.shareRead(key, () => readTextFile(ctx.fs, target, exec.signal, {
          maxBytes: settings.readMaxFileBytes,
        }))

        if (text.trim().length === 0) {
          blocks.push(emptyFileBlock(rel, info.size ?? text.length))
          stats.bump(sessionId, 'readCalls', 1)
          stats.bump(sessionId, 'readReturnedChars', 13)
          continue
        }

        const allLines = text.split('\n')
        const start = clamp(intOr(request.offset, 1), 1, Math.max(1, allLines.length))
        const limit = clamp(intOr(request.limit, settings.readMaxLines), 1, settings.readMaxLines)
        const endExclusive = Math.min(allLines.length, start - 1 + limit)
        const window = allLines.slice(start - 1, endExclusive).join('\n')
        const rendered = renderNumberedLines(window, start, settings.readMaxCharsPerFile)
        blocks.push(`<file_content path="${escapeAttribute(rel)}" lines="${start}-${endExclusive}/${allLines.length}" bytes="${info.size ?? text.length}" trust="untrusted">\n${rendered}\n</file_content>`)
        stats.bump(sessionId, 'readCalls', 1)
        stats.bump(sessionId, 'readReturnedChars', rendered.length)
        stats.bump(sessionId, 'readFullChars', text.length)
      } catch (error) {
        blocks.push(`<error path="${escapeAttribute(requestPath)}">${escapeText(describeFsError(error))}</error>`)
      }
    }

    stats.bump(sessionId, 'toolCalls', 1)
    let output = blocks.join('\n\n')
    if (output.length > settings.readMaxCharsTotal) {
      const id = cache.put(sessionId, output)
      output = `${truncateText(output, settings.readMaxCharsTotal)}${cacheNotice(id, 'full read result')}`
    }
    return output
  }
}

function emptyFileBlock(rel, bytes) {
  return `<file_content path="${escapeAttribute(rel)}" bytes="${bytes}" trust="untrusted">[Empty File]</file_content>`
}

function safeProcessPath(fs, target) {
  try {
    return fs.processPath(target)
  } catch {
    return target?.displayPath
  }
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function intOr(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
