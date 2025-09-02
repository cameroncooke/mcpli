#!/usr/bin/env node

/**
 * MCPLI Daemon Wrapper - Long-lived MCP server process
 *
 * This script runs as a detached daemon process and manages
 * a connection to an MCP server while providing IPC interface
 * for MCPLI commands.
 */

import { createIPCServer, createIPCServerFromLaunchdSocket, IPCRequest, IPCServer } from './ipc.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { computeDaemonId, deriveIdentityEnv } from './runtime.ts';
import { spawn } from 'child_process';

function osLog(message: string): void {
  try {
    const logger = spawn('/usr/bin/logger', ['-t', 'mcpli'], { stdio: 'pipe' });
    logger.stdin.write(message + '\n');
    logger.stdin.end();
  } catch {
    // ignore logger errors
  }
}

function validateSocketName(name: string): string {
  const key = (name ?? '').trim() || 'MCPLI_SOCKET';
  if (!/^[A-Za-z0-9_]+$/.test(key)) {
    throw new Error(`Invalid socket name key '${key}'. Expected [A-Za-z0-9_]+`);
  }
  return key;
}

/**
 * Long-lived daemon process that hosts an MCP client and exposes a local
 * IPC interface for mcpli commands. Designed to be launched by launchd
 * with socket activation.
 */
class MCPLIDaemon {
  private mcpClient: Client | null = null;
  private ipcServer: IPCServer | null = null;
  private inactivityTimeout: NodeJS.Timeout | null = null;

  private isShuttingDown = false;
  private allowShutdown = false;

  private mcpCommand: string;
  private mcpArgs: string[];
  private cwd: string;
  private debug: boolean;
  private verbose: boolean;
  private quiet: boolean;
  private timeoutMs: number;

  private daemonId?: string;
  private expectedId?: string;
  private processId: string;
  private serverEnv: Record<string, string>;
  private orchestrator: string;
  private socketEnvKey: string;
  private socketPath?: string;

  constructor() {
    // Generate unique process ID for tracking
    this.processId = Math.random().toString(36).substring(7);

    // Launchd-provided environment
    this.socketEnvKey = validateSocketName(process.env.MCPLI_SOCKET_ENV_KEY ?? 'MCPLI_SOCKET');
    this.cwd = process.env.MCPLI_CWD ?? process.cwd();
    this.debug = process.env.MCPLI_DEBUG === '1';
    this.verbose = process.env.MCPLI_VERBOSE === '1';
    this.quiet = process.env.MCPLI_QUIET === '1';
    const timeoutRaw = process.env.MCPLI_TIMEOUT;
    const timeoutNum = Number(timeoutRaw);
    this.timeoutMs = Number.isFinite(timeoutNum) && timeoutNum > 0 ? timeoutNum : 30 * 60 * 1000;
    this.mcpCommand = process.env.MCPLI_COMMAND ?? '';
    this.mcpArgs = JSON.parse(process.env.MCPLI_ARGS ?? '[]') as string[];
    this.serverEnv = JSON.parse(process.env.MCPLI_SERVER_ENV ?? '{}') as Record<string, string>;
    this.expectedId = process.env.MCPLI_ID_EXPECTED ?? undefined;
    this.orchestrator = process.env.MCPLI_ORCHESTRATOR ?? 'standalone';
    this.socketPath = process.env.MCPLI_SOCKET_PATH ?? undefined; // diagnostic only

    // Socket FD discovery removed: wrapper now relies solely on launchd socket activation via ipc.ts

    if (!this.mcpCommand) {
      console.error('[DAEMON] Missing MCPLI_COMMAND in environment');
      process.exit(1);
    }
  }

  /**
   * Entry point: start MCP client, then start IPC server, attach signal/error
   * handlers, and manage lifecycle including inactivity shutdown.
   *
   * @returns A promise that resolves once startup completes, or rejects on failure.
   */
  async start(): Promise<void> {
    try {
      // Compute canonical identity and validate if provided
      const identityEnv = deriveIdentityEnv(this.serverEnv);
      const computedId = computeDaemonId(this.mcpCommand, this.mcpArgs, identityEnv);
      this.daemonId = computedId;

      // Load diagnostic flags from file if present (avoids plist reloads on flag changes)
      try {
        const fs = await import('fs/promises');
        const diagPath = `${this.cwd}/.mcpli/diagnostic-${this.daemonId}.json`;
        const raw = await fs.readFile(diagPath, 'utf8');
        const diag = JSON.parse(raw) as {
          debug?: boolean;
          logs?: boolean;
          verbose?: boolean;
          quiet?: boolean;
        };
        if (typeof diag.debug === 'boolean') this.debug = diag.debug;
        if (typeof diag.verbose === 'boolean') this.verbose = diag.verbose;
        if (typeof diag.quiet === 'boolean') this.quiet = diag.quiet;
      } catch {
        // best-effort only
      }

      if (this.expectedId && this.expectedId !== computedId) {
        throw new Error(
          `Daemon ID mismatch: expected ${this.expectedId}, computed ${computedId}. Aborting.`,
        );
      }

      if (this.debug) {
        console.log(
          `[DAEMON:${this.processId}] Launching MCP server: ${this.mcpCommand} ${this.mcpArgs.join(' ')}`,
        );
        console.log(`[DAEMON:${this.processId}] CWD: ${this.cwd}`);
        console.log(`[DAEMON:${this.processId}] Daemon ID: ${this.daemonId}`);
        if (this.socketPath) {
          console.log(`[DAEMON] Socket path (diagnostic): ${this.socketPath}`);
        }
      }

      // Start MCP client (stdio transport)
      await this.startMCPClient();

      // Start IPC on inherited FD from launchd
      await this.startIPCServer();

      // Signal handlers for proper shutdown
      process.on('SIGTERM', () => {
        this.allowShutdown = true;
        this.gracefulShutdown('SIGTERM');
      });
      process.on('SIGINT', () => {
        this.allowShutdown = true;
        this.gracefulShutdown('SIGINT');
      });

      // Error handlers
      process.on('uncaughtException', this.handleError.bind(this));
      process.on('unhandledRejection', this.handleError.bind(this));

      // Inactivity timer
      this.resetInactivityTimer();

      if (this.debug) {
        console.log('[DAEMON] Started successfully');
      }
    } catch (error) {
      console.error('[DAEMON] Failed to start:', error);
      process.exit(1);
    }
  }

  async startMCPClient(): Promise<void> {
    // Filter out MCPLI_* environment variables and merge with server-specific env
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => !k.startsWith('MCPLI_') && v !== undefined),
    ) as Record<string, string>;

    // Resolve command path - if it's just "node", use the same node executable as this daemon
    const resolvedCommand = this.mcpCommand === 'node' ? process.execPath : this.mcpCommand;

    // Capture MCP server stderr and prefix with daemon ID before forwarding to OSLog
    const transport = new StdioClientTransport({
      command: resolvedCommand,
      args: this.mcpArgs,
      env: { ...baseEnv, ...this.serverEnv },
      cwd: this.cwd,
      stderr: 'pipe',
    });

    // CRITICAL: Access transport.stderr BEFORE connect() to avoid losing early output
    const errStream = transport.stderr;
    if (errStream) {
      errStream.on('data', (data: Buffer) => {
        const text = data.toString();
        // Prefix each line with daemon ID for OSLog filtering
        const prefixedLines = text
          .split('\n')
          .map((line) => (line.trim() ? `[MCPLI:${this.daemonId}] ${line}` : ''))
          .filter((line) => line)
          .join('\n');

        if (prefixedLines) {
          // Write to system log for OSLog integration
          try {
            const logger = spawn('/usr/bin/logger', ['-t', 'mcpli'], { stdio: 'pipe' });
            logger.stdin.write(prefixedLines + '\n');
            logger.stdin.end();
          } catch {
            // Ignore logger errors
          }
        }
      });

      errStream.on('error', (err: Error) => {
        try {
          const logger = spawn('/usr/bin/logger', ['-t', 'mcpli'], { stdio: 'pipe' });
          logger.stdin.write(`[MCPLI:${this.daemonId}] stderr error: ${err.message}\n`);
          logger.stdin.end();
        } catch {
          // Ignore logger errors
        }
      });
    }

    this.mcpClient = new Client(
      {
        name: 'mcpli-daemon',
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    // Connect to the MCP server (this spawns the process)
    await this.mcpClient.connect(transport);

    // Log daemon startup to OSLog for monitoring
    try {
      const logger = spawn('/usr/bin/logger', ['-t', 'mcpli'], { stdio: 'pipe' });
      logger.stdin.write(`[MCPLI:${this.daemonId}] Daemon started and MCP client connected\n`);
      logger.stdin.end();
    } catch {
      // Ignore logger errors - not critical
    }

    if (this.debug) {
      console.log('[DAEMON] MCP client connected');
    }
  }

  async startIPCServer(): Promise<void> {
    // Launchd mode: use socket activation to get inherited socket FDs
    if (this.orchestrator === 'launchd') {
      const socketName = this.socketEnvKey;
      try {
        if (this.debug) {
          console.log(`[DAEMON] Using launchd socket activation with name: ${socketName}`);
        }

        this.ipcServer = await createIPCServerFromLaunchdSocket(
          socketName,
          this.handleIPCRequest.bind(this),
        );

        if (this.debug) {
          console.log(`[DAEMON] IPC server listening via launchd socket '${socketName}'`);
        }
        return;
      } catch (err) {
        osLog(
          `[MCPLI:${this.daemonId}] Launchd socket activation failed for '${socketName}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw new Error(
          `Launchd socket activation failed for '${socketName}'. Ensure the plist defines the Sockets->${socketName} entry and that the daemon runs under launchd. Original error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Non-launchd mode: create our own socket
    if (this.socketPath) {
      if (this.debug) {
        console.log(`[DAEMON] Non-launchd mode: creating IPC server at: ${this.socketPath}`);
      }
      this.ipcServer = await createIPCServer(this.socketPath, this.handleIPCRequest.bind(this));
      if (this.debug) {
        console.log(`[DAEMON] IPC server listening on Unix socket: ${this.socketPath}`);
      }
      return;
    }

    throw new Error('No socket activation context or socket path available for IPC server');
  }

  async handleIPCRequest(request: IPCRequest): Promise<unknown> {
    this.resetInactivityTimer();

    if (this.debug) {
      console.log(`[DAEMON] Handling IPC request: ${request.method}`);
    }

    try {
      let result;
      switch (request.method) {
        case 'ping':
          result = 'pong';
          break;

        case 'listTools':
          if (!this.mcpClient) throw new Error('MCP client not connected');
          result = await this.mcpClient.listTools();
          break;

        case 'callTool':
          if (!this.mcpClient) throw new Error('MCP client not connected');
          result = await this.mcpClient.callTool(request.params!);
          break;

        default:
          throw new Error(`Unknown method: ${request.method}`);
      }

      if (this.debug) {
        console.log(`[DAEMON] Successfully handled ${request.method}`);
      }

      return result;
    } catch (error) {
      if (this.debug) {
        console.error(`[DAEMON] Error in handleIPCRequest:`, error);
      }
      throw error;
    }
  }

  resetInactivityTimer(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }

    if (this.debug) {
      console.log('[DAEMON] Inactivity timer reset');
      try {
        osLog(`[MCPLI:${this.daemonId}] Inactivity timer reset to ${this.timeoutMs}ms`);
      } catch {
        // ignore osLog errors
      }
    }

    // Set up inactivity timeout - allow shutdown after idle period
    this.inactivityTimeout = setTimeout(() => {
      if (this.debug) {
        console.log('[DAEMON] Shutting down due to inactivity');
        try {
          osLog(`[MCPLI:${this.daemonId}] Shutting down due to inactivity`);
        } catch {
          // ignore osLog errors
        }
      }
      this.shutdownForInactivity();
    }, this.timeoutMs);
  }

  private shutdownForInactivity(): void {
    this.allowShutdown = true;
    this.gracefulShutdown('inactivity timeout');
  }

  private shutdownForError(error: unknown): void {
    this.allowShutdown = true;
    this.gracefulShutdown(`unhandled error: ${error}`);
  }

  async gracefulShutdown(reason?: string): Promise<void> {
    if (this.isShuttingDown) return;

    // Block shutdown during normal operation - only allow for valid reasons
    if (!this.allowShutdown) {
      if (this.debug) {
        console.log(
          `[DAEMON:${this.processId}] SHUTDOWN BLOCKED - NOT ALLOWED (reason: ${reason ?? 'unknown'})`,
        );
      }
      return;
    }

    this.isShuttingDown = true;

    if (this.debug) {
      console.log(
        `[DAEMON:${this.processId}] GRACEFUL SHUTDOWN INITIATED (reason: ${reason ?? 'unknown'})`,
      );
    }

    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }

    try {
      if (this.ipcServer) {
        await this.ipcServer.close();
        if (this.debug) {
          console.log('[DAEMON] IPC server closed');
        }
      }

      if (this.mcpClient) {
        await this.mcpClient.close();
        if (this.debug) {
          console.log('[DAEMON] MCP client closed');
        }
      }
    } catch (error) {
      console.error('[DAEMON] Error during shutdown:', error);
    }

    if (this.debug) {
      console.log('[DAEMON] Shutdown complete');
    }
    // Attempt clean exit; add a failsafe timer in case event loop has stray handles
    try {
      process.exit(0);
    } finally {
      const t: NodeJS.Timeout = setTimeout(() => {
        try {
          process.exit(0);
        } catch {
          // ignore
        }
      }, 1000);
      // Unref if available so this timer doesn't hold the loop
      if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
        (t as unknown as { unref: () => void }).unref();
      }
    }
  }

  handleError(error: unknown): void {
    console.log('[DAEMON] Unhandled error:', error);
    console.log('[DAEMON] Stack trace:', error instanceof Error ? error.stack : 'No stack trace');
    this.shutdownForError(error);
  }
}

const daemon = new MCPLIDaemon();
daemon.start().catch((error) => {
  console.error('[DAEMON] Fatal error:', error);
  process.exit(1);
});
