/**
 * Per-session counters used by tf_stats and the benchmark. Counters are
 * best-effort attribution for this plugin only; they are never presented as a
 * billing record or as the session's total token usage.
 */

import { estimateTokens } from './compact.js'

const EMPTY = () => ({
  toolCalls: 0,
  readCalls: 0,
  readReturnedChars: 0,
  readFullChars: 0,
  grepCalls: 0,
  grepReturnedChars: 0,
  globCalls: 0,
  globReturnedChars: 0,
  governorHits: 0,
  governorSavedChars: 0,
  resultCalls: 0,
})

export class StatsBook {
  constructor() {
    this.sessions = new Map()
  }

  #stats(sessionId) {
    let value = this.sessions.get(sessionId)
    if (!value) {
      value = EMPTY()
      this.sessions.set(sessionId, value)
    }
    return value
  }

  bump(sessionId, key, amount = 1) {
    if (!sessionId) return
    const stats = this.#stats(sessionId)
    stats[key] = (stats[key] ?? 0) + amount
  }

  snapshot(sessionId) {
    const stats = sessionId ? this.sessions.get(sessionId) : undefined
    const value = stats ? { ...stats } : EMPTY()
    const savedChars = Math.max(0, value.readFullChars - value.readReturnedChars) + value.governorSavedChars
    return {
      ...value,
      attributedSavedChars: savedChars,
      attributedSavedTokens: estimateTokens(savedChars),
    }
  }

  drop(sessionId) {
    this.sessions.delete(sessionId)
  }

  clearAll() {
    this.sessions.clear()
  }
}
