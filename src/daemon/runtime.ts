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
export type OrchestratorName = 'launchd';

export interface EnsureOptions {
  cwd?: string;
  env?: Record<string, string>;
  debug?: boolean;
  logs?: boolean;
  timeout?: number; // seconds
  timeoutMs?: number; // milliseconds (derived from timeout if not provided)
  /**
   * Hint to start the service immediately rather than lazily on first connection (if supported).
   */
  preferImmediateStart?: boolean;
}

export interface EnsureResult {
  /**
   * Stable identity derived from normalized (command, args, env).
   */
  id: string;
  /**
   * Absolute path to the Unix domain socket this daemon listens on.
   */
  socketPath: string;
  /**
   * launchd job label (launchd-specific).
   */
  label?: string;
  /**
   * If determinable, the PID of a currently running process (may be undefined for on-demand services).
   */
  pid?: number;
}

export interface RuntimeStatus {
  id: string;
  /**
   * launchd label if available.
   */
  label?: string;
  /**
   * Whether the orchestrator has a loaded job in the domain.
   */
  loaded: boolean;
  /**
   * Whether a process is currently running/attached to the job (best-effort).
   */
  running: boolean;
  /**
   * Current PID if discoverable.
   */
  pid?: number;
  /**
   * Socket path if known.
   */
  socketPath?: string;
  /**
   * Optional additional metadata fields (e.g., timestamps) may be included by implementations.
   */
  [key: string]: unknown;
}

/**
 * Core orchestration interface.
 * Implementations should be idempotent and safe to call concurrently.
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
export function normalizeCommand(
  command: string,
  args: string[] = [],
): { command: string; args: string[] } {
  const trimmed = String(command || '').trim();
  const normCommand = path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.normalize(path.resolve(trimmed));

  const normArgs = (Array.isArray(args) ? args : [])
    .map((a) => String(a ?? '').trim())
    .filter((a) => a.length > 0);

  const normalizedCommand =
    process.platform === 'win32' ? normCommand.replace(/\\/g, '/').toLowerCase() : normCommand;
  const normalizedArgs =
    process.platform === 'win32' ? normArgs.map((a) => a.replace(/\\/g, '/')) : normArgs;

  return { command: normalizedCommand, args: normalizedArgs };
}

/**
 * Normalize environment for identity hashing.
 * - On Windows, keys are treated case-insensitively (uppercased).
 * - Keys are sorted to ensure deterministic hashing.
 * - Values are coerced to strings.
 */
export function normalizeEnv(env: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const key = process.platform === 'win32' ? k.toUpperCase() : k;
    out[key] = String(v ?? '');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Derive the effective environment to be used for identity.
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
