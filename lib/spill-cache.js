/**
 * Session-scoped LRU cache for full tool outputs that were replaced by a
 * bounded preview. The cache is deliberately in-memory: it is a retrieval aid
 * for the current process, not durable session state.
 */

const DEFAULT_MAX_ENTRIES = 32

/**
 * Session-scoped LRU cache. Every method is synchronous and runs to completion
 * on the Node event loop; two async callers can interleave only between method
 * calls, never inside one. That makes the Map operations atomic without a
 * mutex and removes any lock-ordering deadlock risk. A future worker-thread
 * implementation would need its own synchronization.
 */
export class SpillCache {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024
    this.maxEntryBytes = options.maxEntryBytes ?? 4 * 1024 * 1024
    this.sessions = new Map()
  }

  #bucket(sessionId) {
    let bucket = this.sessions.get(sessionId)
    if (!bucket) {
      bucket = { nextId: 1, totalBytes: 0, items: new Map() }
      this.sessions.set(sessionId, bucket)
    }
    return bucket
  }

  #evict(bucket) {
    while (bucket.items.size > this.maxEntries || bucket.totalBytes > this.maxBytes) {
      const oldestKey = bucket.items.keys().next().value
      if (oldestKey === undefined) break
      const oldest = bucket.items.get(oldestKey)
      bucket.items.delete(oldestKey)
      bucket.totalBytes -= oldest.bytes
    }
  }

  /**
   * Store full text; returns a short retrieval id, or null when this single
   * entry would exceed the per-entry cap. Callers must keep the source result
   * inline (or a bounded preview) when null is returned.
   */
  put(sessionId, text) {
    const value = String(text)
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > this.maxEntryBytes) return null
    const bucket = this.#bucket(sessionId)
    const id = `r${bucket.nextId}`
    bucket.nextId += 1
    bucket.items.set(id, { text: value, bytes })
    bucket.totalBytes += bytes
    this.#evict(bucket)
    return id
  }

  /** Retrieve full text, or undefined when the id was evicted/unknown. */
  get(sessionId, id) {
    const bucket = this.sessions.get(sessionId)
    if (!bucket) return undefined
    const item = bucket.items.get(id)
    if (!item) return undefined
    // Refresh LRU position without changing the id.
    bucket.items.delete(id)
    bucket.items.set(id, item)
    return item.text
  }

  /** Drop all cached text for one session. */
  clear(sessionId) {
    this.sessions.delete(sessionId)
  }

  /** Drop every session (plugin disposal). */
  clearAll() {
    this.sessions.clear()
  }

  stats(sessionId) {
    const bucket = this.sessions.get(sessionId)
    if (!bucket) return { entries: 0, bytes: 0 }
    return { entries: bucket.items.size, bytes: bucket.totalBytes }
  }
}
