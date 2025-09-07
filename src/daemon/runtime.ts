/**
 * Orchestrator abstraction for managing MCPLI daemons.
 *
 * This interface intentionally removes any dependency on legacy file-lock logic.
 * The initial concrete implementation targets macOS launchd with socket activation.
 */

import path from 'path';
import { createHash } from 'crypto';

/**
 * The only orchestrator in this architecture is launchd (macOS).
 * Additional implementations can be added in the future if needed.
 */
/**
 * Known orchestrator types. Currently only macOS launchd is supported.
 */
export type OrchestratorName = 'launchd';

/**
 * Options that control how a daemon is ensured/started by the orchestrator.
 * - `cwd`: Scope job artifacts and identity to this directory.
 * - `env`: Environment passed through to the MCP server (affects identity).
 * - `timeout`: Daemon inactivity timeout (seconds). Mutually exclusive with `timeoutMs`.
 * - `preferImmediateStart`: Start immediately vs rely on socket activation.
 */
export interface EnsureOptions {
  /** Working directory that scopes daemon identity and artifacts. */
  cwd?: string;
  /** Environment passed to the MCP server process (affects identity). */
  env?: Record<string, string>;
  /** Enable debug diagnostics and timing. */
  debug?: boolean;
  /** Request that logs be made available (implementation dependent). */
  logs?: boolean;
  /** Increase verbosity (may imply logs). */
  verbose?: boolean;
  /** Suppress routine output where applicable. */
  quiet?: boolean;
  /** Daemon inactivity timeout in seconds. */
  timeout?: number;
  /** Daemon inactivity timeout in milliseconds (overrides `timeout` if set). */
  timeoutMs?: number;
  /** Default MCP tool timeout (ms) to pass to wrapper; does not affect identity. */
  toolTimeoutMs?: number;
  /**
   * Hint to start the service immediately rather than lazily on first connection (if supported).
   */
  preferImmediateStart?: boolean;
}

/**
 * Result of an ensure call, including the daemon id, socket path, current
 * process state, and what action (if any) was taken to update the job.
 */
export interface EnsureResult {
  /** Stable identity derived from normalized (command, args, env). */
  id: string;
  /** Absolute path to the Unix domain socket this daemon listens on. */
  socketPath: string;
  /** launchd job label (launchd-specific). */
  label?: string;
  /** PID of a currently running process, if determinable. */
  pid?: number;
  /**
   * Orchestrator action taken when ensuring the job:
   * - 'loaded' when a previously-unloaded job was loaded,
   * - 'reloaded' when an existing job was updated (bootout + bootstrap),
   * - 'unchanged' when no plist content change required and loaded state preserved.
   */
  updateAction?: 'loaded' | 'reloaded' | 'unchanged';
  /** True if ensure actively attempted to start the job via kickstart. */
  started?: boolean;
}

/**
 * Status entry for a daemon managed under the current working directory.
 */
export interface RuntimeStatus {
  /** Stable daemon id. */
  id: string;
  /** launchd label if available. */
  label?: string;
  /** Whether the orchestrator has a loaded job in the domain. */
  loaded: boolean;
  /** Whether a process is currently running/attached to the job (best-effort). */
  running: boolean;
  /** Current PID if discoverable. */
  pid?: number;
  /** Socket path if known. */
  socketPath?: string;
  /** Optional additional metadata fields (e.g., timestamps). */
  [key: string]: unknown;
}

/**
 * Core orchestration interface.
 * Implementations should be idempotent and safe to call concurrently.
 */
/**
 * Abstraction for platform-specific daemon orchestration.
 */
export interface Orchestrator {
  readonly type: OrchestratorName;

  /**
   * Compute a stable daemon id using the same normalization rules as the orchestrator.
   * Implementations should generally delegate to computeDaemonId().
   */
  computeId(command: string, args: string[], env?: Record<string, string>, cwd?: string): string;

  /**
   * Ensure that a daemon exists for the provided command/args/env.
   * Implementations may create or bootstrap the job on-demand.
   */
  ensure(command: string, args: string[], opts: EnsureOptions): Promise<EnsureResult>;

  /**
   * Stop a specific daemon by id, or all daemons under a given cwd if id is omitted.
   */
  stop(id?: string): Promise<void>;

  /**
   * List orchestrator-managed daemons scoped to a working directory.
   */
  status(): Promise<RuntimeStatus[]>;

  /**
   * Clean up any orchestrator artifacts (plists, sockets, metadata) scoped to the working directory.
   */
  clean(): Promise<void>;
}

/**
 * Normalize command and args across platforms (absolute path, normalized separators).
 * This mirrors the semantics used by identity hashing to ensure cross-process stability.
 */
/**
 * Normalize a command and arguments into absolute, platform-stable strings.
 *
 * @param command The executable to run.
 * @param args Arguments to pass to the executable.
 * @returns Normalized command and args with absolute command path.
 */
export function normalizeCommand(
  command: string,
  args: string[] = [],
): { command: string; args: string[] } {
  const trimmed = String(command || '').trim();

  const looksPathLike = (s: string): boolean => {
    if (!s) return false;
    if (path.isAbsolute(s)) return true;
    if (s.startsWith('./') || s.startsWith('../')) return true;
    if (s.includes('/')) return true;
    return false;
  };

  const normCommand = looksPathLike(trimmed) ? path.normalize(path.resolve(trimmed)) : trimmed;

  const normArgs = (Array.isArray(args) ? args : [])
    .map((a) => String(a ?? '').trim())
    .filter((a) => a.length > 0);

  return { command: normCommand, args: normArgs };
}

/**
 * Normalize environment for identity hashing.
 * - On Windows, keys are treated case-insensitively (uppercased).
 * - Keys are sorted to ensure deterministic hashing.
 * - Values are coerced to strings.
 */
/**
 * Normalize an environment object for identity hashing: coerces values to
 * strings and sorts keys (case-insensitive on Windows).
 *
 * @param env Environment key/value pairs to normalize.
 * @returns A new object with normalized and sorted keys.
 */
export function normalizeEnv(env: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const key = process.platform === 'win32' ? k.toUpperCase() : k;
    out[key] = String(v ?? '');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Derive the effective environment to be used for identity.
 */
/**
 * Derive the effective environment to use for identity hashing from the
 * explicit CommandSpec-only values provided after `--`.
 *
 * @param explicitEnv The explicit env from CommandSpec (after --).
 * @returns Normalized identity env.
 */
export function deriveIdentityEnv(
  explicitEnv: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {};
  // New behavior:
  // Identity hashing must only consider environment variables explicitly provided
  // in the server CommandSpec (after the --). The ambient shell environment
  // (process.env) must be ignored to ensure stable identity across different
  // shells and sessions.
  //
  // Note: We purposefully do not merge process.env here. We also do not filter
  // out MCPLI_* because the CommandSpec is fully controlled by the user; if they
  // include MCPLI_* intentionally after --, it will be part of identity.
  // Normalize keys/values and sort for deterministic hashing.
  void base; // keep anchor's first body line variable referenced
  // Only include explicit environment from CommandSpec
  return normalizeEnv(explicitEnv);
}

/**
 * Compute a deterministic 8-char id from normalized command, args, and env.
 * This is the canonical identity for MCPLI daemons and should remain stable across orchestrators.
 */
/**
 * Compute a deterministic 8-character id from normalized command, args, and env.
 *
 * @param command Executable path or name.
 * @param args Arguments for the executable.
 * @param env Identity-affecting environment.
 * @returns An 8-character hexadecimal id.
 */
export function computeDaemonId(
  command: string,
  args: string[] = [],
  env: Record<string, string> = {},
): string {
  const norm = normalizeCommand(command, args);
  const normEnv = normalizeEnv(env);
  const input = JSON.stringify([norm.command, ...norm.args, { env: normEnv }]);
  const digest = createHash('sha256').update(input).digest('hex');
  return digest.slice(0, 8);
}

const DAEMON_ID_REGEX = /^[a-z0-9_-]{1,64}$/i;

/**
 * Validate daemon id format (1..64 chars of /[a-z0-9_-]/i).
 *
 * @param id Candidate id string.
 * @returns True when the id is valid.
 */
export function isValidDaemonId(id: string): boolean {
  return typeof id === 'string' && DAEMON_ID_REGEX.test(id);
}

/**
 * Resolve the orchestrator implementation.
 * - On macOS (darwin), selects the launchd-based orchestrator.
 * - On other platforms, this phase intentionally throws (launchd-only architecture).
 *
 * Note: Uses a runtime dynamic import to avoid compile-time coupling before the
 * concrete implementation (runtime-launchd.ts) is added.
 */
/**
 * Resolve the orchestrator implementation for the current platform.
 * macOS only in this phase (launchd).
 *
 * @returns A resolved orchestrator instance.
 */
export async function resolveOrchestrator(): Promise<Orchestrator> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'MCPLI launchd orchestrator is only supported on macOS (darwin) in this architecture phase.',
    );
  }

  // Allow env override for future extensibility; for now, we only support launchd.
  const forced = process.env.MCPLI_RUNTIME?.toLowerCase();
  if (forced && forced !== 'launchd') {
    throw new Error(
      `Unsupported MCPLI_RUNTIME="${forced}". Only "launchd" is supported currently.`,
    );
  }

  // Dynamic import to LaunchdRuntime
  let mod: unknown;
  try {
    mod = await import('./runtime-launchd.js');
  } catch (err) {
    throw new Error(
      `Launchd orchestrator module not found. Expected runtime-launchd module. Error: ${err}`,
    );
  }

  const LaunchdCtor =
    (mod as { LaunchdRuntime?: new () => Orchestrator }).LaunchdRuntime ??
    (mod as { default?: new () => Orchestrator }).default;

  if (typeof LaunchdCtor !== 'function') {
    throw new Error(
      'Invalid launchd orchestrator module shape. Export class LaunchdRuntime implementing Orchestrator.',
    );
  }

  const instance: Orchestrator = new LaunchdCtor();
  return instance;
}

/**
 * A lightweight base class that orchestrator implementations may extend to inherit
 * common identity behavior. Optional to use.
 */
/**
 * Convenience base class that implements common identity semantics for
 * orchestrator implementations.
 */
export abstract class BaseOrchestrator implements Orchestrator {
  abstract readonly type: OrchestratorName;

  computeId(command: string, args: string[], env: Record<string, string> = {}): string {
    return computeDaemonId(command, args, deriveIdentityEnv(env));
  }

  abstract ensure(command: string, args: string[], opts: EnsureOptions): Promise<EnsureResult>;
  abstract stop(id?: string): Promise<void>;
  abstract status(): Promise<RuntimeStatus[]>;
  abstract clean(): Promise<void>;
}
