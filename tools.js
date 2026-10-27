/**
 * TokenForge plugin entry.
 *
 * Wiring only: normalize config, create the per-plugin runtime, publish the
 * policy section, install the governor, and register the tool surface. Tool
 * schemas and handlers live in `tools/`, shared primitives in `lib/`, and
 * platform differences in `platform/`.
 *
 * This module is mounted by the `tokenforge` agent preset. It registers no
 * global service and changes no other Session's behavior. All filesystem work
 * goes through ctx.fs so the host keeps path/sandbox authority.
 *
 * OS branching is deliberately centralised in platform/index.js: this entry
 * never calls process.platform directly, and the only platform-dependent value
 * it consumes (the shell tool allowlist) comes from resolveConfig().
 *
 * The tool definitions are raw ToolDefinition objects on purpose: a plugin that
 * lives in the profile must not assume it can import Harness runtime packages
 * from its own node_modules. The host registry owns validation and execution.
 */

import { resolveConfig } from './lib/config.js'
import { installGovernor } from './lib/governor.js'
import { POLICY } from './lib/policy.js'
import { createRuntime } from './lib/runtime.js'
import { registerTools } from './tools/index.js'

export const name = 'tokenforge-tools'
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory']

export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  const runtime = createRuntime(ctx, settings)

  ctx.effect(() => () => runtime.dispose(), 'tokenforge: state teardown')

  ctx.on('agent/disposed', (payload) => runtime.forget(payload?.agent?.session?.id))

  ctx.systemPrompt.section({
    name: 'tokenforge:policy',
    order: 3200,
    interpolate: false,
    text: POLICY,
  })

  installGovernor(ctx, runtime)
  registerTools(ctx, runtime)
}
