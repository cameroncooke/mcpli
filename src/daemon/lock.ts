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
