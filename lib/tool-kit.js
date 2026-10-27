/**
 * Shared primitives for tool schemas and handlers.
 *
 * Schema fragments live here so a new tool describes its parameters without
 * copy-pasting JSON-schema boilerplate, and every tool renders as a single
 * text block in the same way.
 */

/** One text block, the only content shape TokenForge tools return. */
export function blockText(value) {
  return [{ type: 'text', text: String(value) }]
}

export const stringParam = (description) => ({ type: 'string', description })
export const integerParam = (description) => ({ type: 'integer', description })
export const booleanParam = (description) => ({ type: 'boolean', description })

/**
 * Standard output descriptor: the handler returns a string, the host renders
 * it as one text block. Spread it into `schema.output`.
 */
export function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => blockText(value),
  }
}

/** Render a failed sub-request inline instead of failing the whole batch. */
export function errorBlock(label, error) {
  const message = error instanceof Error ? error.message : String(error)
  return `<error ${label}>${message}</error>`
}

/** Clip text at a line boundary when possible. */
export function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text
  const cut = text.lastIndexOf('\n', maxChars)
  const body = cut > 200 ? text.slice(0, cut) : text.slice(0, maxChars)
  return `${body}\n[... truncated by TokenForge ...]`
}

/** Footer that tells the model how to page a full result from the spill cache. */
export function cacheNotice(id, label) {
  return id
    ? `\n\n[tf:${id} ${label}; use tf_result to page]`
    : `\n\n[${label}; full result exceeds the cache entry cap]`
}
