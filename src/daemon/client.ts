import {
  sendIPCRequest,
  generateRequestId,
  ToolListResult,
  ToolCallResult,
  ToolCallParams,
} from './ipc.ts';
import {
  resolveOrchestrator,
  computeDaemonId,
  deriveIdentityEnv,
  Orchestrator,
} from './runtime.ts';
import { getDaemonTimeoutMs } from '../config.ts';

export interface DaemonClientOptions {
  cwd?: string;
  env?: Record<string, string>;
  debug?: boolean;
  logs?: boolean;
  timeout?: number;
  autoStart?: boolean;
  fallbackToStateless?: boolean;
}

export class DaemonClient {
  private daemonId?: string;
  private orchestratorPromise: Promise<Orchestrator>;

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

    // Resolve orchestrator (launchd-only architecture)
    this.orchestratorPromise = resolveOrchestrator();

    // Compute daemonId only when we have a command
    if (this.command?.trim()) {
      const identityEnv = deriveIdentityEnv(this.options.env ?? {});
      this.daemonId = computeDaemonId(this.command, this.args, identityEnv);
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
    const orchestrator = await this.orchestratorPromise;

    if (!this.command && !this.daemonId) {
      throw new Error('No daemon identity available and no server command provided');
    }

    // Ensure launchd job/socket exist. Acts as auto-start for on-demand jobs.
    const ensureRes = await orchestrator.ensure(this.command, this.args, {
      cwd,
      env: this.options.env ?? {},
      debug: this.options.debug,
      logs: this.options.logs,
      timeoutMs: getDaemonTimeoutMs(this.options.timeout),
      preferImmediateStart: true,
    });

    const request = {
      id: generateRequestId(),
      method: method as 'listTools' | 'callTool' | 'ping',
      params,
    };

    // Single IPC request; no preflight ping
    const result = await sendIPCRequest(ensureRes.socketPath, request);
    return result;
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

export async function withDaemonClient<T>(
  command: string,
  args: string[],
  options: DaemonClientOptions,
  operation: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = new DaemonClient(command, args, options);
  return await operation(client);
}
