#!/usr/bin/env node

/**
 * MCPLI Daemon Wrapper - Long-lived MCP server process
 *
 * This script runs as a detached daemon process and manages
 * a connection to an MCP server while providing IPC interface
 * for MCPLI commands.
 */

import path from 'path';
import { createIPCServer, IPCRequest, IPCServer } from './ipc.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  acquireDaemonLockWithEnv,
  DaemonLock,
  updateLastAccess,
  generateDaemonIdWithEnv,
  deriveIdentityEnv,
  getSocketPath,
} from './lock.ts';

class MCPLIDaemon {
  private mcpClient: Client | null = null;
  private ipcServer: IPCServer | null = null;
  private inactivityTimeout: NodeJS.Timeout | null = null;
  private daemonLock: DaemonLock | null = null;
  private mcpCommand: string;
  private mcpArgs: string[];
  private cwd: string;
  private debug: boolean;
  private daemonId: string | undefined;
  private socketPath: string;
  private timeoutMs: number;
  private isShuttingDown = false;
  private logs: boolean;
  private serverEnv: Record<string, string>;

  constructor() {
    // Read environment variables
    this.socketPath = process.env.MCPLI_SOCKET_PATH!;
    this.cwd = process.env.MCPLI_CWD ?? process.cwd();
    this.debug = process.env.MCPLI_DEBUG === '1';
    this.logs = process.env.MCPLI_LOGS === '1';
    this.timeoutMs = parseInt(process.env.MCPLI_TIMEOUT ?? '1800000', 10);
    this.mcpCommand = process.env.MCPLI_COMMAND!;
    this.mcpArgs = JSON.parse(process.env.MCPLI_ARGS ?? '[]') as string[];
    this.serverEnv = JSON.parse(process.env.MCPLI_SERVER_ENV ?? '{}') as Record<string, string>;

    if (!this.socketPath || !this.mcpCommand) {
      console.error('Missing required environment variables or arguments');
      process.exit(1);
    }
  }

  async start(): Promise<void> {
    try {
      if (this.debug) {
        console.log(`[DAEMON] Starting with command: ${this.mcpCommand} ${this.mcpArgs.join(' ')}`);
        console.log(`[DAEMON] Socket path: ${this.socketPath}`);
        if (this.daemonId) {
          console.log(`[DAEMON] Daemon ID: ${this.daemonId}`);
        }
      }

      const identityEnv = deriveIdentityEnv(this.serverEnv);
      const computedId = generateDaemonIdWithEnv(this.mcpCommand, this.mcpArgs, identityEnv);
      const expectedSocket = getSocketPath(this.cwd, computedId);

      if (this.debug) {
        console.log(`[DAEMON] Resolved Daemon ID: ${computedId}`);
        console.log(`[DAEMON] Expected socket path: ${expectedSocket}`);
      }

      if (this.socketPath && path.normalize(this.socketPath) !== path.normalize(expectedSocket)) {
        throw new Error(
          `[DAEMON] Socket path mismatch: expected ${expectedSocket}, got ${this.socketPath}`,
        );
      }

      // Adopt canonical identity and socket path
      this.daemonId = computedId;
      this.socketPath = expectedSocket;

      // Acquire env-aware daemon lock for this ID - writes correct PID and socket with env metadata
      this.daemonLock = await acquireDaemonLockWithEnv(
        this.mcpCommand,
        this.mcpArgs,
        identityEnv,
        this.cwd,
        computedId,
      );

      if (this.debug) {
        console.log(`[DAEMON] Lock acquired for PID ${this.daemonLock.info.pid}`);
      }

      // Start MCP client
      await this.startMCPClient();

      // Start IPC server
      await this.startIPCServer();

      // Set up cleanup handlers
      process.on('SIGTERM', this.gracefulShutdown.bind(this));
      process.on('SIGINT', this.gracefulShutdown.bind(this));
      process.on('uncaughtException', this.handleError.bind(this));
      process.on('unhandledRejection', this.handleError.bind(this));

      // Start inactivity timer
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
    this.ipcServer = await createIPCServer(this.socketPath, this.handleIPCRequest.bind(this));

    if (this.debug) {
      console.log('[DAEMON] IPC server listening on:', this.socketPath);
    }
  }

  async handleIPCRequest(request: IPCRequest): Promise<unknown> {
    this.resetInactivityTimer();

    // Daemon (lock owner) updates lastAccess here
    try {
      await updateLastAccess(this.cwd, this.daemonId);
    } catch {
      // Non-fatal, ignore
    }

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

    // Release the daemon lock
    if (this.daemonLock) {
      await this.daemonLock.release();
      if (this.debug) {
        console.log('[DAEMON] Lock released');
      }
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

// Start the daemon
const daemon = new MCPLIDaemon();
daemon.start().catch((error) => {
  console.error('[DAEMON] Fatal error:', error);
  process.exit(1);
});
