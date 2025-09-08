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
import { getConfig } from '../config.ts';
import { parsePositiveIntMs, getDefaultToolTimeoutMs } from './mcp-client-utils.ts';

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
  /** IPC request timeout in milliseconds (overrides config default). */
  ipcTimeoutMs?: number;
  /** Default tool timeout in milliseconds (front-facing). */
  toolTimeoutMs?: number;
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
  private ipcTimeoutMs: number;

  /**
   * Resolve the effective front-facing tool timeout (milliseconds).
   * Priority: explicit client option > global/config default.
   */
  private resolveEffectiveToolTimeoutMs(): number {
    const fromFlag = parsePositiveIntMs(this.options.toolTimeoutMs);
    if (typeof fromFlag === 'number') {
      return Math.max(1000, fromFlag);
    }
    const env = this.options.env ?? {};
    const fromFrontEnv = parsePositiveIntMs(
      (env as unknown as Record<string, unknown>)['MCPLI_TOOL_TIMEOUT_MS'],
    );
    if (typeof fromFrontEnv === 'number') {
      return Math.max(1000, fromFrontEnv);
    }
    return Math.max(1000, getDefaultToolTimeoutMs());
  }

  /**
   * Whether the tool timeout was explicitly provided (vs coming from defaults).
   */
  private isToolTimeoutExplicit(): boolean {
    const fromFlag = parsePositiveIntMs(this.options.toolTimeoutMs);
    if (typeof fromFlag === 'number') return true;
    const env = this.options.env ?? {};
    const fromFrontEnv = parsePositiveIntMs(
      (env as unknown as Record<string, unknown>)['MCPLI_TOOL_TIMEOUT_MS'],
    );
    return typeof fromFrontEnv === 'number';
  }

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

    // Configure IPC timeout from options or global config
    const cfg = getConfig();
    this.ipcTimeoutMs = Math.max(
      1000,
      Math.trunc(this.options.ipcTimeoutMs ?? cfg.defaultIpcTimeoutMs),
    );

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
    // Determine effective tool timeout (ms) from flag/defaults
    const effectiveToolTimeoutMs: number = this.resolveEffectiveToolTimeoutMs();
    const toolTimeoutExplicit: boolean = this.isToolTimeoutExplicit();

    const ensureRes = await orchestrator.ensure(this.command, this.args, {
      cwd,
      env: this.options.env ?? {},
      debug: this.options.debug,
      logs: Boolean(this.options.logs ?? this.options.verbose),
      verbose: this.options.verbose,
      timeout: this.options.timeout, // Pass seconds, commands.ts will convert to ms
      // Propagate computed tool timeout to wrapper without affecting identity
      toolTimeoutMs: effectiveToolTimeoutMs,
      preferImmediateStart: Boolean(
        this.options.logs ?? this.options.verbose ?? this.options.debug,
      ),
    });
    if (this.options.debug) {
      console.timeEnd('[DEBUG] orchestrator.ensure');
      console.debug(
        `[DEBUG] ensure result: action=${ensureRes.updateAction ?? 'unchanged'}, started=${ensureRes.started ? '1' : '0'}, pid=${typeof ensureRes.pid === 'number' ? ensureRes.pid : 'n/a'}`,
      );
      console.debug(
        `[DEBUG] effective tool timeout: ${effectiveToolTimeoutMs}ms (${this.isToolTimeoutExplicit() ? 'explicit' : 'default'}); IPC base timeout: ${this.ipcTimeoutMs}ms`,
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
    // Ensure IPC timeout never undercuts tool timeout: add 60s buffer for tool calls
    const toolTimeoutMs = effectiveToolTimeoutMs;
    // Ensure IPC timeout never undercuts tool timeout. For callTool we always buffer.
    // For listTools, if a tool timeout is provided (via flag/env), also raise IPC to avoid
    // discovery timing out before long-running servers become ready.
    const timeoutForRequest = ((): number => {
      if (method === 'callTool') {
        return Math.max(this.ipcTimeoutMs, toolTimeoutMs + 60_000);
      }
      if (method === 'listTools' && toolTimeoutExplicit) {
        return Math.max(this.ipcTimeoutMs, effectiveToolTimeoutMs + 60_000);
      }
      return this.ipcTimeoutMs;
    })();

    // Heuristic: if the job was just (re)loaded or explicitly started, allow a
    // larger connect retry budget to ride out launchd socket rebind races.
    const needsExtraConnectBudget =
      ensureRes.updateAction === 'loaded' ||
      ensureRes.updateAction === 'reloaded' ||
      !!ensureRes.started;
    const connectRetryBudgetMs = needsExtraConnectBudget ? 8000 : undefined;

    const result = await sendIPCRequest(
      ensureRes.socketPath,
      request,
      timeoutForRequest,
      connectRetryBudgetMs,
    );
    if (this.options.debug) {
      console.timeEnd('[DEBUG] IPC request');
      console.debug(
        `[DEBUG] IPC timeout used: ${timeoutForRequest}ms; connect retry budget: ${connectRetryBudgetMs ?? 'default'}`,
      );
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
