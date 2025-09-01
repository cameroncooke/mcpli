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

export interface DaemonClientOptions {
  cwd?: string;
  env?: Record<string, string>;
  debug?: boolean;
  logs?: boolean;
  verbose?: boolean;
  timeout?: number;
  autoStart?: boolean;
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
    const result = await this.callDaemon('listTools');
    return result as ToolListResult;
  }

  async callTool(params: ToolCallParams): Promise<ToolCallResult> {
    const result = await this.callDaemon('callTool', params);
    return result as ToolCallResult;
  }

  private async callDaemon(method: string, params?: ToolCallParams): Promise<unknown> {
    const cwd = this.options.cwd ?? process.cwd();
    const orchestrator = await this.orchestratorPromise;

    if (!this.command && !this.daemonId) {
      throw new Error('No daemon identity available and no server command provided');
    }

    // Ensure launchd job/socket exist. Acts as auto-start for on-demand jobs.
    if (this.options.debug) {
      console.time('[DEBUG] orchestrator.ensure');
    }
    const ensureRes = await orchestrator.ensure(this.command, this.args, {
      cwd,
      env: this.options.env ?? {},
      debug: this.options.debug,
      logs: Boolean(this.options.logs ?? this.options.verbose),
      verbose: this.options.verbose,
      timeout: this.options.timeout, // Pass seconds, commands.ts will convert to ms
      preferImmediateStart: Boolean(
        this.options.logs ?? this.options.verbose ?? this.options.debug,
      ),
    });
    if (this.options.debug) {
      console.timeEnd('[DEBUG] orchestrator.ensure');
      console.debug(
        `[DEBUG] ensure result: action=${ensureRes.updateAction ?? 'unchanged'}, started=${ensureRes.started ? '1' : '0'}, pid=${typeof ensureRes.pid === 'number' ? ensureRes.pid : 'n/a'}`,
      );
    }

    const request = {
      id: generateRequestId(),
      method: method as 'listTools' | 'callTool' | 'ping',
      params,
    };

    // Single IPC request; no preflight ping
    if (this.options.debug) {
      console.time('[DEBUG] IPC request');
    }
    const result = await sendIPCRequest(ensureRes.socketPath, request);
    if (this.options.debug) {
      console.timeEnd('[DEBUG] IPC request');
    }
    return result;
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
