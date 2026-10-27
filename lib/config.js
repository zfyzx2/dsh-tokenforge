/**
 * Config normalization for TokenForge.
 *
 * One place owns defaults and bounds, so every tool handler, the governor and
 * `tf_stats` read the same settings object. Unknown keys are ignored on
 * purpose: a preset may carry forward config from an older version.
 */

import { DEFAULT_EXCLUDED_DIRS, DEFAULT_SENSITIVE } from './fs-walk.js'
import { defaultGovernedTools } from '../platform/index.js'

/**
 * @param {Record<string, any>} [config]
 * @returns {ReturnType<typeof resolveConfig>}
 */
export function resolveConfig(config = {}) {
  const governor = config.governor ?? {}
  return {
    readMaxLines: positive(config.readMaxLines, 2000),
    readMaxCharsPerFile: positive(config.readMaxCharsPerFile, 32768),
    readMaxCharsTotal: positive(config.readMaxCharsTotal, 49152),
    readMaxFileBytes: positive(config.readMaxFileBytes, 8 * 1024 * 1024),
    grepMaxMatches: positive(config.grepMaxMatches, 100),
    grepMaxChars: positive(config.grepMaxChars, 12288),
    grepMaxFiles: positive(config.grepMaxFiles, 5000),
    globMaxResults: positive(config.globMaxResults, 100),
    globMaxChars: positive(config.globMaxChars, 8192),
    exclude: Array.isArray(config.exclude) ? config.exclude : DEFAULT_EXCLUDED_DIRS,
    sensitive: Array.isArray(config.sensitive) ? config.sensitive : DEFAULT_SENSITIVE,
    allowSensitivePaths: config.allowSensitivePaths === true,
    governor: {
      enabled: governor.enabled !== false,
      thresholdChars: positive(governor.thresholdChars, 8000),
      headLines: positive(governor.headLines, 120),
      tailLines: positive(governor.tailLines, 40),
      maxOutputChars: positive(governor.maxOutputChars, 12000),
      maxInputChars: positive(governor.maxInputChars, 32 * 1024 * 1024),
      tools: Array.isArray(governor.tools) && governor.tools.length > 0
        ? governor.tools
        : defaultGovernedTools(),
    },
  }
}

/** Coerce to a positive integer, falling back when the value is not a finite number. */
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
