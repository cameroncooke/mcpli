import {
  isDaemonRunning,
  getDaemonInfo,
  updateLastAccess,
  generateDaemonIdWithEnv,
  deriveIdentityEnv,
} from './lock.ts';
import {
  sendIPCRequest,
  generateRequestId,
  testIPCConnection,
  ToolListResult,
  ToolCallResult,
  ToolCallParams,
} from './ipc.ts';
import { startDaemon, DaemonOptions } from './spawn.ts';

export interface DaemonClientOptions extends DaemonOptions {
  autoStart?: boolean;
  fallbackToStateless?: boolean;
}

export class DaemonClient {
  private daemonId?: string;

  constructor(
    private command: string,
    private args: string[],
    private options: DaemonClientOptions = {},
  ) {
    this.options = {
      autoStart: true,
      fallbackToStateless: true,
      ...options,
    };

    // Compute daemonId only when we have a command (daemon discovery mode may not provide one)
    if (this.command?.trim()) {
      const identityEnv = deriveIdentityEnv(this.options.env);
      this.daemonId = generateDaemonIdWithEnv(this.command, this.args, identityEnv);
    }
  }

  async listTools(): Promise<ToolListResult> {
    try {
      const result = await this.callDaemon('listTools');
      return result as ToolListResult;
    } catch (error) {
      if (this.options.fallbackToStateless) {
        if (this.options.debug) {
          console.log('[DEBUG] Daemon listTools failed, falling back to stateless:', error);
        }
        return this.fallbackListTools();
      }
      throw error;
    }
  }

  async callTool(params: ToolCallParams): Promise<ToolCallResult> {
    try {
      const result = await this.callDaemon('callTool', params);
      return result as ToolCallResult;
    } catch (error) {
      if (this.options.fallbackToStateless) {
        if (this.options.debug) {
          console.log('[DEBUG] Daemon callTool failed, falling back to stateless:', error);
        }
        return this.fallbackCallTool(params);
      }
      throw error;
    }
  }

  private async callDaemon(method: string, params?: ToolCallParams): Promise<unknown> {
    const cwd = this.options.cwd ?? process.cwd();

    // Check if daemon is running (for this specific daemonId, if any)
    const isRunning = await isDaemonRunning(cwd, this.daemonId);

    if (!isRunning) {
      if (this.options.autoStart && this.command) {
        if (this.options.debug) {
          console.log('[DEBUG] Starting daemon automatically');
        }
        await this.startDaemon();
      } else {
        throw new Error(
          this.command
            ? 'Daemon not running and auto-start disabled'
            : 'No daemon running and no server command provided',
        );
      }
    }

    // Get daemon info
    const daemonInfo = await getDaemonInfo(cwd, this.daemonId);
    if (!daemonInfo) {
      throw new Error('Daemon info not available');
    }

    // Test connection
    if (!(await testIPCConnection(daemonInfo))) {
      throw new Error('Cannot connect to daemon IPC socket');
    }

    // Send request
    const request = {
      id: generateRequestId(),
      method: method as 'listTools' | 'callTool' | 'ping',
      params,
    };

    const result = await sendIPCRequest(daemonInfo.socket, request);

    // Update last access time
    await updateLastAccess(cwd, this.daemonId);

    return result;
  }

  private async startDaemon(): Promise<void> {
    try {
      await startDaemon(this.command, this.args, { ...this.options });

      // Wait a moment for daemon to be fully ready
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (this.options.debug) {
        console.log('[DEBUG] Daemon started successfully');
      }
    } catch (error) {
      if (this.options.debug) {
        console.error('[DEBUG] Failed to start daemon:', error);
      }
      throw new Error(`Failed to start daemon: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async fallbackListTools(): Promise<ToolListResult> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.options.env ? { ...safeEnv, ...this.options.env } : undefined,
      stderr: this.options.logs ? 'inherit' : 'ignore',
    });

    const client = new Client(
      {
        name: 'mcpli',
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport);
      const result = await client.listTools();
      await client.close();
      return result;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private async fallbackCallTool(params: ToolCallParams): Promise<ToolCallResult> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.options.env ? { ...safeEnv, ...this.options.env } : undefined,
      stderr: this.options.logs ? 'inherit' : 'ignore',
    });

    const client = new Client(
      {
        name: 'mcpli',
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport);
      const result = await client.callTool(params);
      await client.close();
      return result;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.callDaemon('ping');
      return result === 'pong';
    } catch {
      return false;
    }
  }
}

// Convenience function for one-off operations
export async function withDaemonClient<T>(
  command: string,
  args: string[],
  options: DaemonClientOptions,
  operation: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = new DaemonClient(command, args, options);
  return await operation(client);
}
