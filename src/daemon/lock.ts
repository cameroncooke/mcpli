import path from 'path';

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

const DAEMON_ID_REGEX = /^[a-z0-9_-]{1,64}$/i;

export function isValidDaemonId(id: string): boolean {
  return typeof id === 'string' && DAEMON_ID_REGEX.test(id);
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

export function normalizeEnv(env: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const key = process.platform === 'win32' ? k.toUpperCase() : k;
    out[key] = String(v ?? '');
  }
  // Sort keys for determinism
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
