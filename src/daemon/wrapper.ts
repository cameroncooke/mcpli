#!/usr/bin/env node

/**
 * MCPLI Daemon Wrapper - Long-lived MCP server process
 *
 * This script runs as a detached daemon process and manages
 * a connection to an MCP server while providing IPC interface
 * for MCPLI commands.
 */

import { createIPCServer, createIPCServerFromFD, IPCRequest, IPCServer } from './ipc.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { computeDaemonId, deriveIdentityEnv } from './runtime.ts';

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
  private socketFd?: number;
  private socketFdSource?: string;
  private socketPath?: string;

  constructor() {
    // Generate unique process ID for tracking
    this.processId = Math.random().toString(36).substring(7);

    // Launchd-provided environment
    this.socketEnvKey = process.env.MCPLI_SOCKET_ENV_KEY ?? 'MCPLI_SOCKET';
    this.cwd = process.env.MCPLI_CWD ?? process.cwd();
    this.debug = process.env.MCPLI_DEBUG === '1';
    this.verbose = process.env.MCPLI_VERBOSE === '1';
    this.quiet = process.env.MCPLI_QUIET === '1';
    this.timeoutMs = parseInt(process.env.MCPLI_TIMEOUT ?? '1800000', 10);
    this.mcpCommand = process.env.MCPLI_COMMAND ?? '';
    this.mcpArgs = JSON.parse(process.env.MCPLI_ARGS ?? '[]') as string[];
    this.serverEnv = JSON.parse(process.env.MCPLI_SERVER_ENV ?? '{}') as Record<string, string>;
    this.expectedId = process.env.MCPLI_ID_EXPECTED ?? undefined;
    this.orchestrator = process.env.MCPLI_ORCHESTRATOR ?? 'standalone';
    this.socketPath = process.env.MCPLI_SOCKET_PATH ?? undefined; // diagnostic only

    // Socket FD discovery for launchd fallback (if socket-activation fails)
    const socketKey = this.socketEnvKey;
    const launchdFdEnv = `LAUNCH_JOB_SOCKET_FD_${socketKey}`;
    const candidates = [launchdFdEnv, socketKey];

    let fdNum: number | undefined;
    let source: string = 'unknown';

    // Try environment variables first
    for (const envVar of candidates) {
      const val = process.env[envVar];
      if (val != null && val !== '') {
        const parsed = parseInt(val, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          fdNum = parsed;
          source = `env var ${envVar}`;
          break;
        }
      }
    }

    // Fallback to discovered FD from testing
    if (fdNum === undefined) {
      fdNum = 4; // First socket FD discovered by testing
      source = 'discovered launchd socket FD (4)';
    }

    this.socketFd = fdNum;
    this.socketFdSource = source;

    if (!this.mcpCommand) {
      console.error('[DAEMON] Missing MCPLI_COMMAND in environment');
      process.exit(1);
    }
  }

  async start(): Promise<void> {
    try {
      // Compute canonical identity and validate if provided
      const identityEnv = deriveIdentityEnv(this.serverEnv);
      const computedId = computeDaemonId(this.mcpCommand, this.mcpArgs, identityEnv);
      this.daemonId = computedId;

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
        console.log(
          `[DAEMON:${this.processId}] Socket FD: ${this.socketFd} (${this.socketEnvKey})`,
        );
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

    // launchd automatically redirects MCP server stderr to OSLog via inheritance
    // No need for explicit stderr capture - it goes directly to OSLog
    const transport = new StdioClientTransport({
      command: resolvedCommand,
      args: this.mcpArgs,
      env: { ...baseEnv, ...this.serverEnv },
    });

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

    if (this.debug) {
      console.log('[DAEMON] MCP client connected');
    }
  }

  async startIPCServer(): Promise<void> {
    // Launchd mode: use socket activation to get inherited socket FDs
    if (this.orchestrator === 'launchd') {
      const socketName = this.socketEnvKey || 'MCPLI_SOCKET';
      try {
        if (this.debug) {
          console.log(`[DAEMON] Using launchd socket activation with name: ${socketName}`);
        }

        // Get socket FDs from launchd via socket-activation package
        const sockets = await import('socket-activation');
        const fds = sockets.collect(socketName);

        if (this.debug) {
          console.log(
            `[DAEMON] Collected ${fds.length} socket FDs from launchd: [${fds.join(', ')}]`,
          );
        }

        if (fds.length === 0) {
          throw new Error(`No socket FDs found for launchd socket '${socketName}'`);
        }

        // Use the first FD to create our IPC server
        const fd = fds[0];
        this.ipcServer = await createIPCServerFromFD(fd, this.handleIPCRequest.bind(this));

        if (this.debug) {
          console.log(`[DAEMON] IPC server listening via launchd socket FD ${fd}`);
        }
        return;
      } catch (err) {
        console.error(`[DAEMON] Failed to use launchd socket activation:`, err);
        throw err; // Don't fall back - if launchd socket activation fails, we should fail
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
    }

    // Set up inactivity timeout - allow shutdown after idle period
    this.inactivityTimeout = setTimeout(() => {
      if (this.debug) {
        console.log('[DAEMON] Shutting down due to inactivity');
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

    process.exit(0);
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
