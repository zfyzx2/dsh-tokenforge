/**
 * Global read guard.
 *
 * Intercepts the *result* of the host `read` tool (not the disk read) and
 * compresses oversized text before it reaches the model. The disk read, the
 * sandbox and the host tool contract are untouched.
 *
 * Failure policy is fail-open: the `next()` result is returned unchanged if
 * anything inside the guard throws. Errors from `next()` itself are the host's
 * own read failure and are propagated, never masked.
 */

import { formatBytes, safeCompressText } from './compact.js'
import { blockText } from './tool-kit.js'
import { classifyPath } from './file-kind.js'

/** Tools governed by the global guard. Kept as config so a fork can extend it. */
export const DEFAULT_READ_TOOLS = Object.freeze(['read'])

/** 100 KiB of characters: large enough to matter, small enough to be safe. */
export const DEFAULT_READ_THRESHOLD = 100 * 1024

/**
 * @param {Record<string, any>} [config]
 */
export function resolveGuardConfig(config = {}) {
  const value = config ?? {}
  return {
    enabled: value.enabled !== false,
    aggressiveCompression: value.aggressiveCompression !== false,
    thresholdChars: positive(value.thresholdChars, DEFAULT_READ_THRESHOLD),
    headLines: positive(value.headLines, 120),
    tailLines: positive(value.tailLines, 40),
    maxOutputChars: positive(value.maxOutputChars, 12000),
    maxInputChars: positive(value.maxInputChars, 32 * 1024 * 1024),
    codeThresholdChars: positive(value.codeThresholdChars, 512 * 1024),
    codeHeadLines: positive(value.codeHeadLines, 200),
    codeTailLines: positive(value.codeTailLines, 80),
    codeMaxOutputChars: positive(value.codeMaxOutputChars, 32000),
    tools: Array.isArray(value.tools) && value.tools.length > 0
      ? value.tools.map(String)
      : [...DEFAULT_READ_TOOLS],
  }
}

/**
 * Build the `tools/post-execute` handler.
 * @param {ReturnType<typeof resolveGuardConfig>} settings
 */
export function createReadGuard(settings) {
  return async function tokenforgeReadGuard(exec, result, next) {
    const decision = await next()
    try {
      return govern(decision, result, exec, settings)
    } catch {
      // Never let our own bug change or block the host's read result.
      return decision
    }
  }
}

function govern(decision, result, exec, settings) {
  if (decision?.kind !== 'accept' || decision.value !== undefined) return decision
  if (!settings.tools.includes(exec?.name)) return decision

  const content = decision.content ?? result?.content
  if (!Array.isArray(content) || content.length === 0) return decision
  if (!content.every((part) => part?.type === 'text' && typeof part.text === 'string')) return decision

  const kind = classifyPath(requestPathOf(exec))
  const code = kind === 'code'
  // Safe mode: leave code files completely untouched, keep compressing logs.
  if (code && !settings.aggressiveCompression) return decision

  const original = content.map((part) => part.text).join('\n')
  const thresholdChars = code ? settings.codeThresholdChars : settings.thresholdChars
  if (original.length < thresholdChars) return decision

  let input = original
  let inputCapped = false
  if (original.length > settings.maxInputChars) {
    const half = Math.floor(settings.maxInputChars / 2)
    input = `${original.slice(0, half)}\n[... read-guard input capped ...]\n${original.slice(-half)}`
    inputCapped = true
  }

  const compressed = safeCompressText(input, {
    thresholdChars,
    headLines: code ? settings.codeHeadLines : settings.headLines,
    tailLines: code ? settings.codeTailLines : settings.tailLines,
    maxOutputChars: code ? settings.codeMaxOutputChars : settings.maxOutputChars,
    omissionNote: code
      ? 'code-aware preview: re-read a narrower range with offset/limit for exact lines'
      : 're-read a narrower range with offset/limit',
    preserveStructure: code,
    isError: result?.isError === true,
  })
  if (!compressed.changed) return decision

  const savedPercent = original.length > 0
    ? ((original.length - compressed.text.length) / original.length) * 100
    : 0
  const capNote = inputCapped ? ' input capped at maxInputChars;' : ''
  const modeNote = code ? ' code-aware preview;' : ''
  const footer = `\n\n[TokenForge read-guard] ${formatBytes(original.length)} -> ${formatBytes(compressed.text.length)} (${savedPercent.toFixed(1)}% smaller).${modeNote}${capNote} Re-read a narrower range with offset/limit to see omitted lines.`
  return { ...decision, content: blockText(`${compressed.text}${footer}`) }
}

/** Best-effort path extraction; the host read tool uses `path`. */
function requestPathOf(exec) {
  const args = exec?.args ?? exec?.input ?? {}
  const value = args?.path ?? args?.file_path ?? args?.filePath
  return typeof value === 'string' ? value : ''
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
