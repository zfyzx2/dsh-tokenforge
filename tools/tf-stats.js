/**
 * `tf_stats` — best-effort receipt for this session only. Never a billing record.
 */

import { formatBytes, estimateTokens } from '../lib/compact.js'
import { textOutput } from '../lib/tool-kit.js'

export const schema = {
  name: 'tf_stats',
  description: 'Report the current session token usage and TokenForge-attributed savings. Estimates only.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  output: textOutput(),
}

/**
 * @param {import('../lib/runtime.js').TokenForgeRuntime} runtime
 */
export function createHandler(runtime) {
  const { ctx, cache, stats } = runtime

  return async function execute(_args, exec) {
    const sessionId = runtime.sessionId(exec)
    const snapshot = stats.snapshot(sessionId)
    const lines = ['TokenForge stats (estimates, this session only)']
    const meter = ctx.get('tokenMeter')
    if (meter && exec.agent?.session) {
      try {
        const measured = meter.measure(exec.agent.session)
        lines.push(`session tokens: ${measured.totalTokens.toLocaleString('en-US')} (surface ${measured.surfaceTokens.toLocaleString('en-US')})`)
      } catch {
        lines.push('session tokens: unavailable')
      }
    } else {
      lines.push('session tokens: unavailable')
    }
    lines.push(`tf_read: ${snapshot.readCalls} calls | returned ${formatBytes(snapshot.readReturnedChars)} | full files ${formatBytes(snapshot.readFullChars)}`)
    lines.push(`tf_grep: ${snapshot.grepCalls} calls | returned ${formatBytes(snapshot.grepReturnedChars)}`)
    lines.push(`tf_glob: ${snapshot.globCalls} calls | returned ${formatBytes(snapshot.globReturnedChars)}`)
    lines.push(`tf_result: ${snapshot.resultCalls} calls`)
    lines.push(`governor: ${snapshot.governorHits} outputs compressed | saved ${formatBytes(snapshot.governorSavedChars)}`)
    lines.push(`attributed savings: ${formatBytes(snapshot.attributedSavedChars)} ~= ${estimateTokens(snapshot.attributedSavedChars).toLocaleString('en-US')} tokens`)
    const cacheStats = cache.stats(sessionId)
    lines.push(`spill cache: ${cacheStats.entries} entries, ${formatBytes(cacheStats.bytes)}`)
    return lines.join('\n')
  }
}
