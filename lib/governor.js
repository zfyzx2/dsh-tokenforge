/**
 * Tool-output governor for the TokenForge preset.
 *
 * Compresses oversized shell/web output before it reaches the model, keeps the
 * full text in the session spill cache, and appends a `tf_result` paging hint.
 * The hook is installed once per plugin instance and is a no-op when disabled.
 *
 * The hook is fail-open: any error in our own processing returns the host
 * decision unchanged. Errors from `next()` are the host's own tool failure and
 * are propagated, never masked.
 */

import { formatBytes, safeCompressText } from './compact.js'
import { blockText } from './tool-kit.js'

/**
 * @param {any} ctx DSH plugin context
 * @param {import('./runtime.js').TokenForgeRuntime} runtime
 */
export function installGovernor(ctx, runtime) {
  const governor = runtime.settings.governor
  if (!governor.enabled) return

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      return govern(exec, result, decision, runtime, governor)
    } catch {
      // A governor bug must never change or block the host's tool result.
      return decision
    }
  })
}

function govern(exec, result, decision, runtime, governor) {
 if (decision?.kind !== 'accept') return decision;
if (governor?.tools && !governor.tools.includes(exec.name)) return decision;
  if (!governor.tools.includes(exec.name)) return decision
  const content = decision.content ?? result?.content
  if (!Array.isArray(content) || content.length === 0) return decision
  if (!content.every((part) => part?.type === 'text')) return decision
  const original = content.map((part) => part.text).join('\n')
  if (original.length < governor.thresholdChars) return decision
  let governanceInput = original
  let inputTruncated = false
  if (original.length > governor.maxInputChars) {
    const half = Math.floor(governor.maxInputChars / 2)
    governanceInput = `${original.slice(0, half)}\n[... governance input truncated ...]\n${original.slice(-half)}`
    inputTruncated = true
  }
  const compressed = safeCompressText(governanceInput, {
    thresholdChars: governor.thresholdChars,
    headLines: governor.headLines,
    tailLines: governor.tailLines,
    maxOutputChars: governor.maxOutputChars,
    isError: result?.isError === true,
  })
  if (!compressed.changed) return decision
  let text = governorPreview(runtime.cache, runtime.stats, runtime.sessionId(exec), governanceInput, compressed)
  if (inputTruncated) {
    text += `\n[governance input capped: ${original.length} chars -> ${governanceInput.length} chars]`
  }
  return { ...decision, content: blockText(text) }
}

function governorPreview(cache, stats, sessionId, original, compressed) {
  const id = cache.put(sessionId, original)
  const ref = id
    ? `\n\n[tf:${id} full output ${formatBytes(original.length)}; call tf_result({"id":"${id}"}) to page]`
    : `\n\n[full output ${formatBytes(original.length)} exceeds the cache entry cap; preview retained]`
  stats.bump(sessionId, 'governorHits', 1)
  stats.bump(sessionId, 'governorSavedChars', Math.max(0, original.length - compressed.text.length))
  return `${compressed.text}${ref}`
}
