/**
 * Per-plugin runtime.
 *
 * Owns the state shared by all tools (spill cache + stats) and binds it to the
 * host context, so a handler never has to know how a session id or the session
 * cwd is derived. One runtime exists per mounted plugin instance.
 */

import { SpillCache } from './spill-cache.js'
import { StatsBook } from './stats.js'
import { sessionCwd } from './fs-walk.js'

/**
 * @param {any} ctx DSH plugin context
 * @param {ReturnType<import('./config.js').resolveConfig>} settings
 */
export function createRuntime(ctx, settings) {
  const cache = new SpillCache()
  const stats = new StatsBook()
  const reads = new Map()

  return {
    ctx,
    settings,
    cache,
    stats,

    /** Stable id for cache/stats buckets; `anonymous` keeps direct calls working. */
    sessionId(exec) {
      return exec?.agent?.session?.id ?? 'anonymous'
    },

    /** Session working directory, falling back to the process cwd. */
    cwd(exec) {
      return sessionCwd(ctx, exec?.agent)
    },

    /**
     * Collapse concurrent reads of the same file+version into one host read.
     * Only in-flight work is shared; nothing is cached after the promise
     * settles, so there is no stale-content window.
     */
    shareRead(key, factory) {
      const existing = reads.get(key)
      if (existing) return existing
      const pending = Promise.resolve().then(factory).finally(() => {
        if (reads.get(key) === pending) reads.delete(key)
      })
      reads.set(key, pending)
      return pending
    },

    /** Drop one session's cache and counters when its agent is disposed. */
    forget(sessionId) {
      if (!sessionId) return
      cache.clear(sessionId)
      stats.drop(sessionId)
    },

    /** Release every session (plugin disposal). */
    dispose() {
      reads.clear()
      cache.clearAll()
      stats.clearAll()
    },
  }
}

/** @typedef {ReturnType<typeof createRuntime>} TokenForgeRuntime */
