import {
  resolveOrchestrator,
  deriveIdentityEnv,
  computeDaemonId,
  Orchestrator,
} from './runtime.ts';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

/**
 * Common CLI options for daemon management commands.
 */
export interface DaemonCommandOptions {
  /** Working directory that scopes daemon identity and artifacts. */
  cwd?: string;
  /** Environment variables to pass to the MCP server. */
  env?: Record<string, string>;
  /** Enable debug diagnostics. */
  debug?: boolean;
  /** Request immediate start and OSLog streaming for logs-related commands. */
  logs?: boolean;
  /** Daemon inactivity timeout in seconds. */
  timeout?: number;
  /** Suppress non-essential output. */
  quiet?: boolean;
}

/**
 * Ensure (and optionally start) a daemon for the provided server command.
 *
 * @param command MCP server executable.
 * @param args Arguments for the MCP server.
 * @param options Daemon command options (cwd, env, debug, etc.).
 * @returns A promise that resolves when ensuring is complete.
 */
export async function handleDaemonStart(
  command: string,
  args: string[],
  options: DaemonCommandOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  if (!command?.trim()) {
    console.error('Error: Command required to start daemon');
    process.exit(1);
  }

  try {
    const orchestrator: Orchestrator = await resolveOrchestrator();
    const identityEnv = deriveIdentityEnv(options.env ?? {});
    const id = computeDaemonId(command, args, identityEnv);

    if (!options.quiet) {
      console.log(`Ensuring daemon (id ${id}) for: ${command} ${args.join(' ')}`);
    }

    const ensureRes = await orchestrator.ensure(command, args, {
      cwd,
      env: options.env ?? {},
      debug: options.debug,
      logs: options.logs,
      timeout: options.timeout, // Pass seconds, runtime will convert to ms
      preferImmediateStart: true,
    });

    if (!options.quiet) {
      console.log(`Launchd job ensured.`);
      if (ensureRes.label) console.log(`  Label: ${ensureRes.label}`);
      console.log(`  ID: ${ensureRes.id}`);
      console.log(`  Socket: ${ensureRes.socketPath}`);
      if (ensureRes.pid) console.log(`  PID: ${ensureRes.pid}`);
    }
  } catch (error) {
    console.error(`Failed to ensure daemon: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * Stop a specific daemon (if command/args provided) or all daemons in cwd.
 *
 * @param command Optional MCP server executable to compute a specific id.
 * @param args Arguments for the MCP server.
 * @param options Daemon command options.
 * @returns A promise that resolves when stop actions complete.
 */
export async function handleDaemonStop(
  command?: string,
  args: string[] = [],
  options: DaemonCommandOptions = {},
): Promise<void> {
  try {
    const orchestrator: Orchestrator = await resolveOrchestrator();

    let id: string | undefined;
    if (command?.trim()) {
      const identityEnv = deriveIdentityEnv(options.env ?? {});
      id = computeDaemonId(command, args, identityEnv);
    }

    await orchestrator.stop(id);
    if (!options.quiet) {
      console.log(id ? `Stopped daemon ${id}` : 'Stopped all daemons for this project');
    }
  } catch (error) {
    console.error(`Failed to stop daemon: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * Print status for all daemons managed under the current directory.
 *
 * @returns A promise that resolves when output is complete.
 */
export async function handleDaemonStatus(): Promise<void> {
  try {
    const orchestrator: Orchestrator = await resolveOrchestrator();
    const entries = await orchestrator.status();

    if (entries.length === 0) {
      console.log('No daemons found in this directory');
      return;
    }

    for (const s of entries) {
      console.log(`Daemon ${s.id}:`);
      console.log(`  Label: ${s.label ?? '(unknown)'}`);
      console.log(`  Loaded: ${s.loaded ? 'yes' : 'no'}`);
      console.log(`  Running: ${s.running ? 'yes' : 'no'}`);
      if (s.pid) console.log(`  PID: ${s.pid}`);
      if (s.socketPath) console.log(`  Socket: ${s.socketPath}`);
      console.log('');
    }
  } catch (error) {
    console.error(`Error reading daemon status: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * Restart a specific daemon or all daemons for the current directory.
 *
 * @param command Optional MCP server executable for specific daemon.
 * @param args Arguments for the MCP server.
 * @param options Daemon command options.
 * @returns A promise that resolves when restart actions complete.
 */
export async function handleDaemonRestart(
  command?: string,
  args: string[] = [],
  options: DaemonCommandOptions = {},
): Promise<void> {
  if (!options.quiet) {
    console.log('Restarting daemon...');
  }

  await handleDaemonStop(command, args, options);
  await new Promise((resolve) => setTimeout(resolve, 300));

  if (command?.trim()) {
    await handleDaemonStart(command, args, options);
  } else {
    if (!options.quiet) {
      console.log('No specific command provided. Daemons will start on next usage.');
    }
  }
}

/**
 * Remove orchestrator artifacts (plists, sockets) and attempt to clean `.mcpli`.
 *
 * @param options Daemon command options with cwd and quiet controls.
 * @returns A promise that resolves when cleanup completes.
 */
export async function handleDaemonClean(options: DaemonCommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  try {
    const orchestrator: Orchestrator = await resolveOrchestrator();
    await orchestrator.clean();

    // Attempt to remove .mcpli directory if empty
    const mcpliDir = path.join(cwd, '.mcpli');
    try {
      await fs.rmdir(mcpliDir);
      if (!options.quiet) {
        console.log('Removed empty .mcpli directory');
      }
    } catch {
      // ignore
    }

    if (!options.quiet) {
      console.log('Daemon cleanup complete');
    }
  } catch (error) {
    console.error(
      `Failed to clean daemon files: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

/**
 * Stream daemon logs using OSLog filtering for specific daemon or all MCPLI daemons.
 */
/**
 * Stream daemon logs from macOS unified logging (OSLog) filtered to MCPLI.
 *
 * @param command Optional MCP server executable to filter logs for a specific daemon.
 * @param args Arguments for the MCP server.
 * @param options Daemon command options.
 * @returns A promise that resolves when the streaming ends.
 */
export async function handleDaemonLogs(
  command?: string,
  args: string[] = [],
  options: DaemonCommandOptions = {},
): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('Daemon logs are only available on macOS.');
    process.exit(1);
  }

  let description: string;

  if (command?.trim()) {
    // Show logs for specific daemon
    const identityEnv = deriveIdentityEnv(options.env ?? {});
    const id = computeDaemonId(command, args, identityEnv);
    description = `Streaming OSLog for daemon ${id} (${command} ${args.join(' ')}):`;
  } else {
    // Show logs for all MCPLI daemons
    description = 'Streaming OSLog for all MCPLI daemons:';
  }

  console.log(description);
  console.log('Press Ctrl+C to exit\n');

  // Use the correct predicate for streaming
  const predicate = command
    ? `eventMessage CONTAINS "[MCPLI:${computeDaemonId(command, args, deriveIdentityEnv(options.env ?? {}))}"`
    : `eventMessage CONTAINS "[MCPLI:"`;

  const proc = spawn('/usr/bin/log', ['stream', '--style', 'compact', '--predicate', predicate], {
    stdio: ['ignore', 'inherit', 'ignore'],
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    proc.kill('SIGTERM');
    process.exit(0);
  });

  await new Promise<void>((resolve, reject) => {
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`log stream exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Print help text for daemon subcommands.
 *
 * @returns Nothing; prints to stdout.
 */
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
  console.log('  --debug                          Enable debug output');
  console.log('  --quiet, -q                      Suppress informational output');
  console.log('  --timeout=<seconds>              Set daemon inactivity timeout (seconds)');
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
