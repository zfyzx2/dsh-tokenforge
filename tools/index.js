/**
 * Tool registry.
 *
 * Each tool module exports exactly two things:
 *   - `schema`: name, description, parameters and output presentation;
 *   - `createHandler(runtime)`: a factory returning `execute(args, exec)`.
 *
 * The registry is the only place that knows how a schema becomes a host
 * `ToolDefinition`. Adding a tool therefore never touches the plugin entry:
 * create `tools/tf-<name>.js`, append it to `TOOL_MODULES`, and (optionally)
 * add governance by listing the tool name in the preset config.
 */

import * as read from './tf-read.js'
import * as grep from './tf-grep.js'
import * as glob from './tf-glob.js'
import * as result from './tf-result.js'
import * as stats from './tf-stats.js'

/**
 * Ordered tool surface. Order is preserved from the 1.0.0-beta.1 release so the
 * model-facing contract does not shift during the refactor.
 */
export const TOOL_MODULES = [read, grep, glob, result, stats]

const REQUIRED_SCHEMA_KEYS = ['name', 'description', 'parameters', 'output']

// Fail at import time with a precise message: a malformed module is a plugin
// packaging bug, not a runtime condition the model should ever see.
const seen = new Set()
for (const [index, module] of TOOL_MODULES.entries()) {
  const label = module?.schema?.name ?? `TOOL_MODULES[${index}]`
  for (const key of REQUIRED_SCHEMA_KEYS) {
    if (module?.schema?.[key] === undefined) {
      throw new TypeError(`${label}: missing schema.${key}`)
    }
  }
  if (typeof module.createHandler !== 'function') {
    throw new TypeError(`${label}: missing createHandler(runtime)`)
  }
  if (seen.has(module.schema.name)) {
    throw new TypeError(`${label}: duplicate tool name`)
  }
  seen.add(module.schema.name)
}

/**
 * Compose schema + handler into the object the host registry expects.
 * @param {(typeof TOOL_MODULES)[number]} module
 * @param {import('../lib/runtime.js').TokenForgeRuntime} runtime
 */
export function defineTool(module, runtime) {
  return { ...module.schema, execute: module.createHandler(runtime) }
}

/**
 * Register every tool in the current plugin scope.
 * @param {any} ctx DSH plugin context
 * @param {import('../lib/runtime.js').TokenForgeRuntime} runtime
 */
export function registerTools(ctx, runtime) {
  for (const module of TOOL_MODULES) {
    const tool = defineTool(module, runtime)
    ctx.effect(() => ctx.tools.register(tool), `tokenforge: ${tool.name}`)
  }
}
