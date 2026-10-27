/**
 * Global read guard plugin entry.
 *
 * Mounted by `cordis.patch.yml` as a top-level row, so it applies to every
 * Session in the profile after install — no preset selection required.
 *
 * Scope: compress the *result* of the host `read` tool when it exceeds the
 * threshold. No filesystem access, no permission changes, no process calls.
 * The whole entry is fail-open: if anything goes wrong the host keeps working.
 */

import { createReadGuard, resolveGuardConfig } from './lib/read-guard.js'

export const name = 'tokenforge-read-guard'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  try {
    const settings = resolveGuardConfig(config)
    if (!settings.enabled) return
    ctx.on('tools/post-execute', createReadGuard(settings))
  } catch {
    // Fail open: a broken guard must never prevent the host from starting or
    // reading files. The guard simply does nothing in this process.
  }
}
