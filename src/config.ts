/**
 * Centralized configuration for MCPLI
 *
 * Priority order:
 * 1. CLI arguments (highest priority)
 * 2. Environment variables
 * 3. Default values (lowest priority)
 */

function parsePositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw === undefined ? Number.NaN : Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export interface MCPLIConfig {
  /** Default daemon inactivity timeout in seconds */
  defaultTimeoutSeconds: number;
  /** Default CLI operation timeout in seconds */
  defaultCliTimeoutSeconds: number;
  /** Default IPC connection timeout in milliseconds */
  defaultIpcTimeoutMs: number;
  /** Default MCP client tool timeout in milliseconds */
  defaultToolTimeoutMs: number;
}

/**
 * Environment variable names for configuration
 */
export const ENV_VARS = {
  /** Daemon inactivity timeout in seconds */
  MCPLI_DEFAULT_TIMEOUT: 'MCPLI_DEFAULT_TIMEOUT',
  /** CLI operation timeout in seconds */
  MCPLI_CLI_TIMEOUT: 'MCPLI_CLI_TIMEOUT',
  /** IPC connection timeout in milliseconds */
  MCPLI_IPC_TIMEOUT: 'MCPLI_IPC_TIMEOUT',
  /** Preferred user-facing tool timeout in milliseconds */
  MCPLI_TOOL_TIMEOUT_MS: 'MCPLI_TOOL_TIMEOUT_MS',
} as const;

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: MCPLIConfig = {
  defaultTimeoutSeconds: 1800, // 30 minutes
  defaultCliTimeoutSeconds: 30, // 30 seconds
  // IPC timeout must exceed tool timeout; set to tool (10m) + 1m buffer
  defaultIpcTimeoutMs: 660000, // 11 minutes
  defaultToolTimeoutMs: 600000, // 10 minutes
};

/**
 * Get the current MCPLI configuration, considering environment variables
 */
export function getConfig(): MCPLIConfig {
  return {
    defaultTimeoutSeconds: parsePositiveIntEnv(
      ENV_VARS.MCPLI_DEFAULT_TIMEOUT,
      DEFAULT_CONFIG.defaultTimeoutSeconds,
    ),
    defaultCliTimeoutSeconds: parsePositiveIntEnv(
      ENV_VARS.MCPLI_CLI_TIMEOUT,
      DEFAULT_CONFIG.defaultCliTimeoutSeconds,
    ),
    defaultIpcTimeoutMs: parsePositiveIntEnv(
      ENV_VARS.MCPLI_IPC_TIMEOUT,
      DEFAULT_CONFIG.defaultIpcTimeoutMs,
    ),
    // Front-facing tool timeout only
    defaultToolTimeoutMs: parsePositiveIntEnv(
      ENV_VARS.MCPLI_TOOL_TIMEOUT_MS,
      DEFAULT_CONFIG.defaultToolTimeoutMs,
    ),
  };
}

/**
 * Resolve the daemon timeout to use, with priority:
 * 1. CLI argument (if provided)
 * 2. Environment variable
 * 3. Default value
 */
export function resolveDaemonTimeout(cliTimeout?: number): number {
  if (cliTimeout != null) {
    return Math.max(1, Math.trunc(cliTimeout));
  }

  const config = getConfig();
  return config.defaultTimeoutSeconds;
}

/**
 * Get daemon timeout in milliseconds (for internal use)
 */
export function getDaemonTimeoutMs(cliTimeout?: number): number {
  return resolveDaemonTimeout(cliTimeout) * 1000;
}
