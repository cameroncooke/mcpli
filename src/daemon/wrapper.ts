#!/usr/bin/env node

/**
 * MCPLI Daemon Wrapper - Long-lived MCP server process
 *
 * This script runs as a detached daemon process and manages
 * a connection to an MCP server while providing IPC interface
 * for MCPLI commands.
 */

import { createIPCServerFromFD, IPCRequest, IPCServer } from './ipc.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { computeDaemonId, deriveIdentityEnv } from './runtime.ts';

class MCPLIDaemon {
  private mcpClient: Client | null = null;
  private ipcServer: IPCServer | null = null;
  private inactivityTimeout: NodeJS.Timeout | null = null;

  private isShuttingDown = false;

  private mcpCommand: string;
  private mcpArgs: string[];
  private cwd: string;
  private debug: boolean;
  private logs: boolean;
  private timeoutMs: number;

  private daemonId?: string;
  private expectedId?: string;
  private serverEnv: Record<string, string>;
  private socketEnvKey: string;
  private socketFd?: number;
  private socketPath?: string;

  constructor() {
    // Launchd-provided environment
    this.socketEnvKey = process.env.MCPLI_SOCKET_ENV_KEY ?? 'MCPLI_SOCKET';
    this.cwd = process.env.MCPLI_CWD ?? process.cwd();
    this.debug = process.env.MCPLI_DEBUG === '1';
    this.logs = process.env.MCPLI_LOGS === '1';
    this.timeoutMs = parseInt(process.env.MCPLI_TIMEOUT ?? '1800000', 10);
    this.mcpCommand = process.env.MCPLI_COMMAND ?? '';
    this.mcpArgs = JSON.parse(process.env.MCPLI_ARGS ?? '[]') as string[];
    this.serverEnv = JSON.parse(process.env.MCPLI_SERVER_ENV ?? '{}') as Record<string, string>;
    this.expectedId = process.env.MCPLI_ID_EXPECTED ?? undefined;
    this.socketPath = process.env.MCPLI_SOCKET_PATH ?? undefined; // diagnostic only

    const fdStr = process.env[this.socketEnvKey];
    if (!fdStr) {
      console.error(
        `[DAEMON] Missing socket FD env var "${this.socketEnvKey}". Ensure launchd Sockets are configured.`,
      );
      process.exit(1);
    }
    const fdNum = parseInt(fdStr, 10);
    if (!Number.isFinite(fdNum) || fdNum <= 0) {
      console.error(`[DAEMON] Invalid socket FD value for ${this.socketEnvKey}: "${fdStr}"`);
      process.exit(1);
    }
    this.socketFd = fdNum;

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
        console.log(`[DAEMON] Launching MCP server: ${this.mcpCommand} ${this.mcpArgs.join(' ')}`);
        console.log(`[DAEMON] CWD: ${this.cwd}`);
        console.log(`[DAEMON] Daemon ID: ${this.daemonId}`);
        console.log(`[DAEMON] Socket FD: ${this.socketFd} (${this.socketEnvKey})`);
        if (this.socketPath) {
          console.log(`[DAEMON] Socket path (diagnostic): ${this.socketPath}`);
        }
      }

      // Start MCP client (stdio transport)
      await this.startMCPClient();

      // Start IPC on inherited FD from launchd
      await this.startIPCServer();

      // Handlers
      process.on('SIGTERM', this.gracefulShutdown.bind(this));
      process.on('SIGINT', this.gracefulShutdown.bind(this));
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

    const transport = new StdioClientTransport({
      command: this.mcpCommand,
      args: this.mcpArgs,
      env: { ...baseEnv, ...this.serverEnv },
      stderr: this.debug || this.logs ? 'inherit' : 'ignore',
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

    await this.mcpClient.connect(transport);

    if (this.debug) {
      console.log('[DAEMON] MCP client connected');
    }
  }

  async startIPCServer(): Promise<void> {
    if (this.socketFd == null) {
      throw new Error('Socket FD not available (launchd socket activation required)');
    }
    this.ipcServer = await createIPCServerFromFD(this.socketFd, this.handleIPCRequest.bind(this));

    if (this.debug) {
      console.log('[DAEMON] IPC server listening (launchd FD)');
    }
  }

  async handleIPCRequest(request: IPCRequest): Promise<unknown> {
    this.resetInactivityTimer();

    if (this.debug) {
      console.log(`[DAEMON] Handling IPC request: ${request.method}`);
    }

    switch (request.method) {
      case 'ping':
        return 'pong';

      case 'listTools':
        if (!this.mcpClient) throw new Error('MCP client not connected');
        return await this.mcpClient.listTools();

      case 'callTool':
        if (!this.mcpClient) throw new Error('MCP client not connected');
        return await this.mcpClient.callTool(request.params!);

      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }

  resetInactivityTimer(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }

    this.inactivityTimeout = setTimeout(() => {
      if (this.debug) {
        console.log('[DAEMON] Shutting down due to inactivity');
      }
      this.gracefulShutdown();
    }, this.timeoutMs);
  }

  async gracefulShutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    if (this.debug) {
      console.log('[DAEMON] Starting graceful shutdown');
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
    console.error('[DAEMON] Unhandled error:', error);
    this.gracefulShutdown();
  }
}

const daemon = new MCPLIDaemon();
daemon.start().catch((error) => {
  console.error('[DAEMON] Fatal error:', error);
  process.exit(1);
});
