import { lock } from 'proper-lockfile';
import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

export interface DaemonInfo {
  pid: number;
  socket: string;
  command: string;
  args: string[];
  started: string;
  lastAccess: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface DaemonLock {
  info: DaemonInfo;
  release: () => Promise<void>;
}

const MCPLI_DIR = '.mcpli';
const LEGACY_LOCK_FILE = 'daemon.lock';
const LEGACY_SOCK_FILE = 'daemon.sock';

const DAEMON_ID_REGEX = /^[a-z0-9_-]{1,64}$/i;

export function isValidDaemonId(id: string): boolean {
  return typeof id === 'string' && DAEMON_ID_REGEX.test(id);
}

function assertValidDaemonId(id: string): void {
  if (!isValidDaemonId(id)) {
    throw new Error(
      `Invalid daemon ID: "${id}". Allowed characters: letters, numbers, underscore (_), hyphen (-); max length 64.`,
    );
  }
}

function ensureValidDaemonId(id: string): string {
  assertValidDaemonId(id);
  return id;
}

function getMcpliDir(cwd = process.cwd()): string {
  return path.join(cwd, MCPLI_DIR);
}

/**
 * Returns the lock file path for a given daemon ID, or the legacy single-daemon path if no ID is provided.
 */
export function getLockFilePath(cwd: string, daemonId?: string): string {
  const dir = getMcpliDir(cwd);
  if (daemonId && daemonId.length > 0) {
    const safeId = ensureValidDaemonId(daemonId);
    return path.join(dir, `daemon-${safeId}.lock`);
  }
  return path.join(dir, LEGACY_LOCK_FILE);
}

/**
 * Returns the socket path for a given daemon ID, or the legacy single-daemon path if no ID is provided.
 */
export function getSocketPath(cwd: string, daemonId?: string): string {
  const dir = getMcpliDir(cwd);
  if (daemonId && daemonId.length > 0) {
    const safeId = ensureValidDaemonId(daemonId);
    return path.join(dir, `daemon-${safeId}.sock`);
  }
  return path.join(dir, LEGACY_SOCK_FILE);
}

async function ensureMcpliDir(cwd = process.cwd()): Promise<void> {
  const mcpliDir = getMcpliDir(cwd);
  if (!existsSync(mcpliDir)) {
    await fs.mkdir(mcpliDir, { recursive: true });
  }
}

/**
 * Normalize command and args across platforms (absolute path, normalized separators)
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

function normalizeEnv(env: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const key = process.platform === 'win32' ? k.toUpperCase() : k;
    out[key] = String(v ?? '');
  }
  // Sort keys for determinism
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Derive the effective environment that should be used for daemon identity.
 * Includes process.env but excludes MCPLI_* runtime variables.
 */
export function deriveIdentityEnv(
  explicitEnv: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('MCPLI_')) continue;
    base[k] = String(v);
  }
  // explicit overrides base
  const merged = { ...base, ...explicitEnv };
  return normalizeEnv(merged);
}

/**
 * Env-aware daemon ID generation. Includes normalized env into the hash.
 */
export function generateDaemonIdWithEnv(
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

/**
 * Env-aware lock acquisition. Writes env metadata to the lock file.
 */
export async function acquireDaemonLockWithEnv(
  command: string,
  args: string[],
  env: Record<string, string> = {},
  cwd = process.cwd(),
  daemonId?: string,
): Promise<DaemonLock> {
  await ensureMcpliDir(cwd);

  const id = daemonId ?? generateDaemonIdWithEnv(command, args, env);
  const lockPath = getLockFilePath(cwd, id);

  // Create empty lock file if it doesn't exist
  try {
    await fs.access(lockPath);
  } catch {
    await fs.writeFile(lockPath, '{}');
  }

  try {
    const releaseFileLock = await lock(lockPath, {
      retries: 0,
      stale: 60000, // 1 minute
    });

    const daemonInfo: DaemonInfo = {
      pid: process.pid,
      socket: getSocketPath(cwd, id),
      command,
      args,
      started: new Date().toISOString(),
      lastAccess: new Date().toISOString(),
      cwd,
      env: normalizeEnv(env),
    };

    await fs.writeFile(lockPath, JSON.stringify(daemonInfo, null, 2));

    return {
      info: daemonInfo,
      release: async (): Promise<void> => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // File might already be deleted
        }
        await releaseFileLock();
      },
    };
  } catch (error) {
    throw new Error(
      `Cannot acquire daemon lock: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Deterministic 8-char hash for identifying daemons by their command+args
 */
export function generateDaemonId(command: string, args: string[] = []): string {
  const norm = normalizeCommand(command, args);
  const input = JSON.stringify([norm.command, ...norm.args]);
  const digest = createHash('sha256').update(input).digest('hex');
  return digest.slice(0, 8);
}

/**
 * Acquire an exclusive lock for a daemon (per daemonId).
 * If daemonId is not provided, it is derived from command+args.
 */
export async function acquireDaemonLock(
  command: string,
  args: string[],
  cwd = process.cwd(),
  daemonId?: string,
): Promise<DaemonLock> {
  await ensureMcpliDir(cwd);

  const id = daemonId ?? generateDaemonId(command, args);
  const lockPath = getLockFilePath(cwd, id);

  // Create empty lock file if it doesn't exist
  try {
    await fs.access(lockPath);
  } catch {
    await fs.writeFile(lockPath, '{}');
  }

  try {
    const releaseFileLock = await lock(lockPath, {
      retries: 0,
      stale: 60000, // 1 minute
    });

    const daemonInfo: DaemonInfo = {
      pid: process.pid,
      socket: getSocketPath(cwd, id),
      command,
      args,
      started: new Date().toISOString(),
      lastAccess: new Date().toISOString(),
      cwd,
    };

    await fs.writeFile(lockPath, JSON.stringify(daemonInfo, null, 2));

    return {
      info: daemonInfo,
      release: async (): Promise<void> => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // File might already be deleted
        }
        await releaseFileLock();
      },
    };
  } catch (error) {
    throw new Error(
      `Cannot acquire daemon lock: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Get daemon info for a specific daemonId. If daemonId is omitted,
 * falls back to legacy single-daemon file (daemon.lock).
 */
export async function getDaemonInfo(
  cwd = process.cwd(),
  daemonId?: string,
): Promise<DaemonInfo | null> {
  try {
    const lockPath = getLockFilePath(cwd, daemonId);
    const data = await fs.readFile(lockPath, 'utf8');
    return JSON.parse(data) as DaemonInfo;
  } catch {
    return null;
  }
}

/**
 * Update lastAccess in daemon info. No-op if not found.
 */
export async function updateLastAccess(cwd = process.cwd(), daemonId?: string): Promise<void> {
  const info = await getDaemonInfo(cwd, daemonId);
  if (!info) return;

  info.lastAccess = new Date().toISOString();
  const lockPath = getLockFilePath(cwd, daemonId);

  try {
    await fs.writeFile(lockPath, JSON.stringify(info, null, 2));
  } catch {
    // Ignore write errors - daemon might be shutting down
  }
}

/**
 * Check if a daemon is running by reading its PID and sending signal 0.
 * If not running, cleans up stale lock file.
 */
export async function isDaemonRunning(cwd = process.cwd(), daemonId?: string): Promise<boolean> {
  const info = await getDaemonInfo(cwd, daemonId);
  if (!info || typeof info.pid !== 'number') return false;

  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    await cleanupStaleLock(cwd, daemonId);
    return false;
  }
}

/**
 * Remove a specific lock file (by daemonId) or legacy lock if no ID.
 */
export async function cleanupStaleLock(cwd = process.cwd(), daemonId?: string): Promise<void> {
  try {
    const lockPath = getLockFilePath(cwd, daemonId);
    await fs.unlink(lockPath);
  } catch {
    // Lock file might not exist or already cleaned up
  }
}

/**
 * Stop a specific daemon by ID (or legacy if none provided).
 */
export async function stopDaemon(
  cwd = process.cwd(),
  force = false,
  daemonId?: string,
): Promise<boolean> {
  const info = await getDaemonInfo(cwd, daemonId);
  if (!info) return false;

  try {
    process.kill(info.pid, force ? 'SIGKILL' : 'SIGTERM');

    if (!force) {
      // Wait up to 5 seconds for graceful shutdown
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(info.pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {
          // Process has exited
          break;
        }
      }

      // Force kill if still running
      try {
        process.kill(info.pid, 0);
        process.kill(info.pid, 'SIGKILL');
      } catch {
        // Already exited
      }
    }

    await cleanupStaleLock(cwd, daemonId);
    return true;
  } catch {
    await cleanupStaleLock(cwd, daemonId);
    return false;
  }
}

/**
 * Enumerate all daemon IDs by scanning daemon-*.lock files.
 */
export async function listAllDaemons(cwd: string): Promise<string[]> {
  const mcpliDir = getMcpliDir(cwd);
  try {
    const entries = await fs.readdir(mcpliDir);
    const daemonIds = entries
      .filter((f) => f.startsWith('daemon-') && f.endsWith('.lock'))
      .map((f) => f.slice(7, -5))
      .filter((id) => isValidDaemonId(id));
    return Array.from(new Set(daemonIds));
  } catch {
    return [];
  }
}

/**
 * Remove stale per-daemon lock/socket files across all daemon IDs.
 */
export async function cleanupAllStaleDaemons(cwd: string): Promise<void> {
  const mcpliDir = getMcpliDir(cwd);

  try {
    const entries = await fs.readdir(mcpliDir);
    const lockFiles = entries.filter((f) => f.startsWith('daemon-') && f.endsWith('.lock'));

    for (const lockFile of lockFiles) {
      const lockPath = path.join(mcpliDir, lockFile);
      const daemonId = lockFile.slice(7, -5);

      try {
        const info = JSON.parse(await fs.readFile(lockPath, 'utf8')) as DaemonInfo;
        if (!info.pid || !isPidRunning(info.pid)) {
          await fs.unlink(lockPath).catch(() => {});
          const sockPath = path.join(mcpliDir, `daemon-${daemonId}.sock`);
          await fs.unlink(sockPath).catch(() => {});
        }
      } catch {
        await fs.unlink(lockPath).catch(() => {});
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
