/**
 * `tf_result` — page a spill-cached result that was replaced by a preview.
 */

import { renderNumberedLines } from '../lib/compact.js'
import { integerParam, stringParam, textOutput } from '../lib/tool-kit.js'

export const schema = {
  name: 'tf_result',
  description: 'Page a full output that TokenForge replaced with a preview. Use the id printed in the preview.',
  parameters: {
    type: 'object',
    properties: {
      id: stringParam('Retrieval id such as r3.'),
      offset: integerParam('0-based first line (default 0).'),
      limit: integerParam('Lines to return (default 120, max 400).'),
    },
    required: ['id'],
    additionalProperties: false,
  },
  output: textOutput(),
}

/**
 * @param {import('../lib/runtime.js').TokenForgeRuntime} runtime
 */
export function createHandler(runtime) {
  const { cache, stats } = runtime

  return async function execute(args, exec) {
    const sessionId = runtime.sessionId(exec)
    const full = cache.get(sessionId, String(args?.id ?? ''))
    if (full === undefined) throw new Error(`unknown or evicted id: ${args?.id}`)
    const lines = full.split('\n')
    const offset = clamp(intOr(args?.offset, 0), 0, Math.max(0, lines.length - 1))
    const limit = clamp(intOr(args?.limit, 120), 1, 400)
    const end = Math.min(lines.length, offset + limit)
    const window = lines.slice(offset, end).join('\n')
    const rendered = renderNumberedLines(window, offset + 1, 16000)
    stats.bump(sessionId, 'toolCalls', 1)
    stats.bump(sessionId, 'resultCalls', 1)
    return `[tf:${args?.id} lines ${offset + 1}-${end}/${lines.length}]\n${rendered}`
  }
}

function intOr(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
