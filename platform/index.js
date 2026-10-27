/**
 * Platform seam and the only place that may branch on the operating system.
 *
 * Policy:
 *   - Only `win32`, `darwin` and `linux` are supported platforms.
 *   - On an unknown platform the plugin still runs (all governance is pure
 *     JavaScript), but no shell tool is placed in the governor allowlist:
 *     guessing a shell name is worse than doing nothing.
 *   - TokenForge never changes file permissions, ACLs, ownership or processes.
 *     There is no Windows ACL repair code path; nothing to disable elsewhere.
 */

/** Platforms the package is tested and supported on. */
export const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux'])

/** True only on an explicitly supported platform. */
export function isSupportedPlatform(platform = process.platform) {
  return SUPPORTED_PLATFORMS.includes(platform)
}

/** @param {string} [platform] Node's `process.platform` value. */
export function isWindows(platform = process.platform) {
  return platform === 'win32'
}

/**
 * Name of the shell tool registered by the host for this platform.
 * Returns `null` for an unsupported platform instead of guessing.
 * @param {string} [platform]
 * @returns {'pwsh' | 'bash' | null}
 */
export function shellTool(platform = process.platform) {
  if (!isSupportedPlatform(platform)) return null
  return isWindows(platform) ? 'pwsh' : 'bash'
}

/**
 * Tools whose output the governor compresses by default. The shell entry is
 * omitted entirely when the platform is unknown.
 * @param {string} [platform]
 * @returns {string[]}
 */
export function defaultGovernedTools(platform = process.platform) {
  const shell = shellTool(platform)
  return [...(shell ? [shell] : []), 'web_fetch', 'web_search']
}

/**
 * Snapshot used by diagnostics and tests. No side effects.
 * @param {string} [platform]
 * @param {string} [arch]
 */
export function platformInfo(platform = process.platform, arch = process.arch) {
  return {
    platform,
    arch,
    supported: isSupportedPlatform(platform),
    windows: isWindows(platform),
    shellTool: shellTool(platform),
  }
}
