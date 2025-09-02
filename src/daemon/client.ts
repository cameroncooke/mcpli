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

/**
 * Options for interacting with the MCPLI daemon through the orchestrator.
 * - `cwd`: Working directory used to scope daemon identities and artifacts.
 * - `env`: Environment variables to pass to the MCP server (identity-affecting).
 * - `debug`: Emit detailed timing and diagnostics to stderr.
 * - `logs`/`verbose`: Request immediate start and stream OSLog in certain flows.
 * - `timeout`: Inactivity timeout (seconds) for the daemon wrapper.
 */
export interface DaemonClientOptions {
  /** Working directory used to scope daemon identity and artifacts. */
  cwd?: string;
  /** Environment variables passed to the MCP server (affects identity). */
  env?: Record<string, string>;
  /** Enable detailed timing and diagnostics. */
  debug?: boolean;
  /** Suggest immediate start and OSLog streaming in certain flows. */
  logs?: boolean;
  /** Increase verbosity (may imply logs). */
  verbose?: boolean;
  /** Inactivity timeout (seconds) for the daemon. */
  timeout?: number;
}

/**
 * Lightweight client that ensures the appropriate daemon exists and
 * proxies a single request over IPC. Automatically computes a stable
 * daemon id from command/args/env and uses the platform orchestrator
 * (launchd on macOS) for lifecycle management.
 */
export class DaemonClient {
  private daemonId?: string;
  private orchestratorPromise: Promise<Orchestrator>;

  /**
   * Construct a client for a given MCP server command.
   *
   * @param command MCP server executable.
   * @param args Arguments to the MCP server executable.
   * @param options Client options controlling env, cwd, and verbosity.
   */
  constructor(
    private command: string,
    private args: string[],
    private options: DaemonClientOptions = {},
  ) {
    this.options = {
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

  /**
   * Query the MCP server (via daemon) for available tools.
   *
   * @returns Tool list result from the daemon.
   */
  async listTools(): Promise<ToolListResult> {
    const result = await this.callDaemon('listTools');
    return result as ToolListResult;
  }

  /**
   * Execute a specific tool over IPC, returning the raw MCP tool result.
   *
   * @param params Tool call parameters including name and arguments.
   * @returns Raw MCP tool call result.
   */
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

  /**
   * Lightweight liveness check.
   *
   * @returns True if the daemon responds to a ping.
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.callDaemon('ping');
      return result === 'pong';
    } catch {
      return false;
    }
  }
}

/**
 * Helper to create a `DaemonClient`, run an async operation, and return the
 * result.
 *
 * @param command MCP server executable.
 * @param args Arguments for the MCP server.
 * @param options Client options (cwd, env, debug, etc.).
 * @param operation Async function that receives the client and returns a value.
 * @returns Result of the operation.
 */
export async function withDaemonClient<T>(
  command: string,
  args: string[],
  options: DaemonClientOptions,
  operation: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = new DaemonClient(command, args, options);
  return await operation(client);
}
