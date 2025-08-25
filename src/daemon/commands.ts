import {
  isDaemonRunning,
  getDaemonInfo,
  listAllDaemons,
  cleanupAllStaleDaemons,
  normalizeCommand,
  generateDaemonIdWithEnv,
  deriveIdentityEnv,
} from './lock.ts';
import { startDaemon, DaemonOptions } from './spawn.ts';
import { testIPCConnection } from './ipc.ts';
import fs from 'fs/promises';
import path from 'path';

export interface DaemonCommandOptions extends DaemonOptions {
  force?: boolean;
  env?: Record<string, string>;
}

interface DaemonEntry {
  id?: string;
  [key: string]: unknown;
}

// Utility: compute daemonId from a command + args using the same normalization as the lock layer
function computeDaemonIdFromCommandWithEnv(
  command?: string,
  args: string[] = [],
  env: Record<string, string> = {},
): string | undefined {
  if (!command?.trim()) return undefined;
  const norm = normalizeCommand(command, args);
  return generateDaemonIdWithEnv(norm.command, norm.args, env);
}

// Utility: friendlier string for command+args
function formatCommand(command?: string, args: string[] = []): string {
  if (!command) return '(no command)';
  return [command, ...args].join(' ');
}

// Utility: normalize entries from listAllDaemons() into ids
function extractDaemonIds(entries: unknown[]): string[] {
  if (!Array.isArray(entries)) return [];
  const ids = entries
    .map((d: unknown) => {
      if (typeof d === 'string') return d;
      if (
        d &&
        typeof d === 'object' &&
        (d as DaemonEntry).id &&
        typeof (d as DaemonEntry).id === 'string'
      )
        return (d as DaemonEntry).id;
      return undefined;
    })
    .filter((v: unknown): v is string => typeof v === 'string');
  return Array.from(new Set(ids));
}

// Utility: attempt to kill daemon by id, with graceful then forceful fallback
async function killDaemonById(
  cwd: string,
  daemonId: string,
): Promise<{ killed: boolean; reason?: string }> {
  try {
    const info = await getDaemonInfo(cwd, daemonId);
    if (!info || typeof info.pid !== 'number') {
      return { killed: false, reason: 'no pid in daemon info' };
    }

    const runningBefore = await isDaemonRunning(cwd, daemonId);
    if (!runningBefore) {
      return { killed: false, reason: 'not running' };
    }

    try {
      process.kill(info.pid, 'SIGTERM');
    } catch (err: unknown) {
      if (!err || (err as { code?: string }).code !== 'ESRCH') {
        return {
          killed: false,
          reason: `SIGTERM failed: ${(err as Error)?.message ?? String(err)}`,
        };
      }
      // If ESRCH, process already gone; proceed to cleanup
    }

    // Give it a moment to exit gracefully
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stillRunning = await isDaemonRunning(cwd, daemonId).catch(() => false);
    if (!stillRunning) {
      return { killed: true };
    }

    // Force kill
    try {
      process.kill(info.pid, 'SIGKILL');
    } catch (err: unknown) {
      if (!err || (err as { code?: string }).code !== 'ESRCH') {
        return {
          killed: false,
          reason: `SIGKILL failed: ${(err as Error)?.message ?? String(err)}`,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    return { killed: true };
  } finally {
    await cleanupAllStaleDaemons(cwd).catch(() => {});
  }
}

export async function handleDaemonStart(
  command: string,
  args: string[],
  options: DaemonCommandOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const identityEnv = deriveIdentityEnv(options.env);
  const daemonId = computeDaemonIdFromCommandWithEnv(command, args, identityEnv);

  // Check if daemon is already running for this specific command
  if (daemonId && (await isDaemonRunning(cwd, daemonId))) {
    const info = await getDaemonInfo(cwd, daemonId);
    console.log(`Daemon is already running for this command (PID ${info?.pid})`);
    return;
  }

  try {
    console.log(`Starting daemon: ${command} ${args.join(' ')}`);

    const daemon = await startDaemon(command, args, { ...options, env: identityEnv });

    console.log(`Daemon started successfully (PID ${daemon.lock.info.pid})`);
    console.log(`Socket: ${daemon.lock.info.socket}`);

    if (options.debug) {
      console.log('Debug mode enabled - daemon will log to console');
    }
  } catch (error) {
    console.error(`Failed to start daemon: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

export async function handleDaemonStop(
  command?: string,
  args: string[] = [],
  options: DaemonCommandOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  try {
    let targetIds: string[] = [];
    const identityEnv = deriveIdentityEnv(options.env);
    const daemonId = computeDaemonIdFromCommandWithEnv(command, args, identityEnv);

    if (daemonId) {
      targetIds = [daemonId];
    } else {
      // Stop all daemons if no specific command provided
      const entries = await listAllDaemons(cwd);
      targetIds = extractDaemonIds(entries);
    }

    if (targetIds.length === 0) {
      console.log('No daemons found');
      return;
    }

    let stopped = 0;
    for (const id of targetIds) {
      const result = await killDaemonById(cwd, id);
      if (result.killed) {
        stopped++;
        console.log(`Stopped daemon ${id}`);
      } else {
        console.log(`Skipped daemon ${id}${result.reason ? ` (${result.reason})` : ''}`);
      }
    }

    console.log(`Done. ${stopped} daemon(s) stopped.`);
  } catch (error) {
    console.error(`Failed to stop daemon: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

export async function handleDaemonStatus(options: DaemonCommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  try {
    const entries = await listAllDaemons(cwd);
    const ids = extractDaemonIds(entries);

    if (ids.length === 0) {
      console.log('No daemons found in this directory');
      return;
    }

    let anyRunning = false;
    for (const id of ids) {
      const running = await isDaemonRunning(cwd, id);

      if (running) {
        anyRunning = true;
        const info = await getDaemonInfo(cwd, id).catch(() => null);
        const cmd = info?.command;
        const args = Array.isArray(info?.args) ? info.args : [];
        const pid = info?.pid;
        const started = info?.started ? new Date(info.started).toLocaleString() : 'unknown';
        const lastAccess = info?.lastAccess
          ? new Date(info.lastAccess).toLocaleString()
          : 'unknown';
        const canConnect = info ? await testIPCConnection(info) : false;

        console.log(`Daemon ${id}:`);
        console.log(`  Status: Running`);
        console.log(`  PID: ${pid ?? 'unknown'}`);
        console.log(`  Command: ${formatCommand(cmd, args)}`);
        console.log(`  Started: ${started}`);
        console.log(`  Last access: ${lastAccess}`);
        console.log(`  Socket: ${info?.socket ?? 'unknown'}`);
        console.log(`  IPC connection: ${canConnect ? 'OK' : 'FAILED'}`);

        if (info?.started) {
          const uptimeMs = Date.now() - new Date(info.started).getTime();
          const uptimeMinutes = Math.floor(uptimeMs / 60000);
          const uptimeHours = Math.floor(uptimeMinutes / 60);
          const uptimeDays = Math.floor(uptimeHours / 24);

          let uptimeStr = '';
          if (uptimeDays > 0) uptimeStr += `${uptimeDays}d `;
          if (uptimeHours > 0) uptimeStr += `${uptimeHours % 24}h `;
          uptimeStr += `${uptimeMinutes % 60}m`;

          console.log(`  Uptime: ${uptimeStr}`);
        }

        console.log('');
      }
    }

    if (!anyRunning) {
      console.log('No running daemons found');
    }
  } catch (error) {
    console.error(`Error reading daemon status: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

export async function handleDaemonRestart(
  command?: string,
  args: string[] = [],
  options: DaemonCommandOptions = {},
): Promise<void> {
  console.log('Restarting daemon...');

  // Stop existing daemon(s) - if command provided, stop specific daemon; otherwise stop all
  await handleDaemonStop(command, args, options);

  // Wait a moment for cleanup
  await new Promise((resolve) => setTimeout(resolve, 500));

  // For restart with a specific command, start that daemon
  if (command) {
    await handleDaemonStart(command, args, options);
  } else {
    console.log('No specific command provided. Daemons will auto-start when commands are run.');
  }
}

export async function handleDaemonLogs(options: DaemonCommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const logPath = path.join(cwd, '.mcpli', 'daemon.log');

  try {
    const logContent = await fs.readFile(logPath, 'utf8');
    console.log(logContent);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      console.log('No log file found. Daemon may not have been started with --logs flag.');
    } else {
      console.error(`Failed to read log file: ${error instanceof Error ? error.message : error}`);
    }
  }
}

export async function handleDaemonClean(options: DaemonCommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const mcpliDir = path.join(cwd, '.mcpli');

  try {
    // Stop all running daemons first
    const entries = await listAllDaemons(cwd);
    const ids = extractDaemonIds(entries);

    let stopped = 0;
    for (const id of ids) {
      const result = await killDaemonById(cwd, id);
      if (result.killed) {
        stopped++;
        console.log(`Stopped daemon ${id}`);
      }
    }

    if (stopped > 0) {
      console.log(`Stopped ${stopped} daemon(s)`);
    }

    // Remove stale lock files and metadata
    await cleanupAllStaleDaemons(cwd).catch(() => {});

    // Remove orphaned sockets
    let dirEntries: string[] = [];
    try {
      dirEntries = await fs.readdir(mcpliDir);
    } catch {
      // Missing directory is fine
      console.log('Daemon cleanup complete');
      return;
    }

    const socketFiles = dirEntries.filter((f) => /^daemon-.+\.sock$/.test(f));
    for (const sockName of socketFiles) {
      const idMatch = /^daemon-(.+)\.sock$/.exec(sockName);
      const daemonId = idMatch?.[1];
      if (!daemonId) continue;

      const running = await isDaemonRunning(cwd, daemonId).catch(() => false);
      if (!running) {
        const sockPath = path.join(mcpliDir, sockName);
        try {
          await fs.unlink(sockPath);
          console.log(`Removed stale socket ${sockName}`);
        } catch {
          // ignore unlink errors
        }
      }
    }

    // Remove .mcpli directory if empty
    try {
      await fs.rmdir(mcpliDir);
      console.log('Removed empty .mcpli directory');
    } catch {
      // Directory not empty or doesn't exist
    }

    console.log('Daemon cleanup complete');
  } catch (error) {
    console.error(
      `Failed to clean daemon files: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

export function printDaemonHelp(): void {
  console.log('MCPLI Daemon Management');
  console.log('');
  console.log('Usage:');
  console.log('  mcpli daemon <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  start [-- command args...]       Start daemon with MCP server command');
  console.log('  stop [-- command args...]        Stop specific daemon or all daemons');
  console.log('  restart [-- command args...]     Restart specific daemon or all daemons');
  console.log('  status                           Show all running daemons');
  console.log('  logs                             Show daemon log output');
  console.log('  clean                            Clean up all daemon files');
  console.log('');
  console.log('Options:');
  console.log('  --force                          Force stop daemon');
  console.log('  --logs                           Enable daemon logging');
  console.log('  --debug                          Enable debug output');
  console.log('  --timeout <ms>                   Set daemon inactivity timeout');
  console.log('');
  console.log('Notes:');
  console.log('  - Daemons are command-specific per directory using stable daemon IDs');
  console.log('  - Commands auto-start daemons transparently (no manual start needed)');
  console.log('  - stop/restart without command acts on all daemons in directory');
  console.log('');
  console.log('Examples:');
  console.log('  mcpli daemon start -- node server.js');
  console.log('  mcpli daemon status');
  console.log('  mcpli daemon stop');
  console.log('  mcpli daemon clean');
}
