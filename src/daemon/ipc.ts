import net from 'net';
import path from 'path';

/**
 * Parameters for invoking a single MCP tool via the daemon.
 */
export interface ToolCallParams {
  /** The tool name to invoke (as reported by the server). */
  name: string;
  /** Structured arguments for the tool call. */
  arguments?: Record<string, unknown>;
  /** Future-proof: additional fields may be passed through. */
  [key: string]: unknown;
}

/**
 * Minimal tool descriptor as returned by MCP listTools.
 */
export interface Tool {
  /** Canonical tool name. */
  name: string;
  /** Human-friendly description, when available. */
  description?: string;
  /** JSON Schema for input arguments, when provided by the server. */
  inputSchema?: Record<string, unknown>;
}

/**
 * Result payload for a listTools call.
 */
export interface ToolListResult {
  /** Array of tools discovered from the server. */
  tools: Tool[];
  /** Optional metadata field for implementation details. */
  _meta?: Record<string, unknown>;
}

/**
 * Result payload for a callTool call.
 */
export interface ToolCallResult {
  /**
   * Content items, typically including a text blob from the tool run.
   */
  content?: Array<{
    /** Content type (commonly 'text'). */
    type: string;
    /** Text content if present. */
    text?: string;
    /** Additional fields as provided by the server. */
    [key: string]: unknown;
  }>;
  /** True if the server signaled an error at the tool-call level. */
  isError?: boolean;
  /** Optional metadata for debugging or transport.
   */
  _meta?: Record<string, unknown>;
}

/**
 * JSON request frame used over the local IPC socket.
 */
export interface IPCRequest {
  /** Unique request id for correlation. */
  id: string;
  /** Method name indicating operation. */
  method: 'listTools' | 'callTool' | 'ping';
  /** Optional method params. */
  params?: ToolCallParams | undefined;
}

/**
 * JSON response frame used over the local IPC socket.
 */
export interface IPCResponse {
  /** Echoed request id. */
  id: string;
  /** Result payload on success. */
  result?: unknown;
  /** Error message if the request failed. */
  error?: string;
}

/**
 * Handle returned when creating an IPC server. Ensures proper cleanup.
 */
export interface IPCServer {
  /** The underlying Node net.Server instance. */
  server: net.Server;
  /** Asynchronous close that also handles cleanup responsibilities. */
  close: () => Promise<void>;
}

/**
 * F-014: IPC frame safety limits
 * - Soft limit (default): 100MB — reject request/response but keep processes alive.
 * - Hard limit: 500MB — daemon terminates to prevent runaway memory (server-side only).
 * - Configurable via MCPLI_IPC_MAX_FRAME_BYTES for the soft limit; clamped below hard limit.
 */
const DEFAULT_MAX_FRAME_BYTES = 100 * 1024 * 1024; // 100MB
const HARD_KILL_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500MB (daemon kill threshold)
let oversizeKillInitiated = false;

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let b = Math.max(0, bytes);
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  const v = i === 0 ? b.toString() : b.toFixed(2);
  return `${v} ${units[i]}`;
}

function getIpcLimits(): { maxFrameBytes: number; killThresholdBytes: number } {
  const envVal = process.env.MCPLI_IPC_MAX_FRAME_BYTES;
  let maxFrame = DEFAULT_MAX_FRAME_BYTES;
  if (typeof envVal === 'string' && envVal.trim() !== '') {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxFrame = Math.floor(parsed);
    } else {
      console.warn(
        `[F-014] Ignoring invalid MCPLI_IPC_MAX_FRAME_BYTES='${envVal}'. Using default ${formatBytes(
          DEFAULT_MAX_FRAME_BYTES,
        )}.`,
      );
    }
  }
  if (maxFrame >= HARD_KILL_THRESHOLD_BYTES) {
    const clamped = HARD_KILL_THRESHOLD_BYTES - 1;
    console.warn(
      `[F-014] MCPLI_IPC_MAX_FRAME_BYTES (${formatBytes(
        maxFrame,
      )}) exceeds or equals hard kill threshold (${formatBytes(
        HARD_KILL_THRESHOLD_BYTES,
      )}). Clamping to ${formatBytes(clamped)}.`,
    );
  }
  return {
    maxFrameBytes: Math.min(maxFrame, HARD_KILL_THRESHOLD_BYTES - 1),
    killThresholdBytes: HARD_KILL_THRESHOLD_BYTES,
  };
}

/**
 * Environment-driven server tunables (F-009)
 * - MCPLI_IPC_MAX_CONNECTIONS (default 64, clamp [1..1000])
 * - MCPLI_IPC_CONNECTION_IDLE_TIMEOUT_MS (default 15000, clamp [1000..600000])
 * - MCPLI_IPC_LISTEN_BACKLOG (default 128, clamp [1..2048])
 */
function getIpcServerTunables(): {
  maxConnections: number;
  connectionIdleTimeoutMs: number;
  listenBacklog: number;
} {
  const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

  const parseEnvInt = (name: string, defValue: number, min: number, max: number): number => {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim() === '') return defValue;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      console.warn(`[IPC] Ignoring invalid ${name}='${raw}'. Using default ${defValue}.`);
      return defValue;
    }
    const v = Math.floor(n);
    if (v < min || v > max) {
      console.warn(`[IPC] Clamping ${name}=${v} to range [${min}..${max}].`);
    }
    return clamp(v, min, max);
  };

  const maxConnections = parseEnvInt('MCPLI_IPC_MAX_CONNECTIONS', 64, 1, 1000);
  const connectionIdleTimeoutMs = parseEnvInt(
    'MCPLI_IPC_CONNECTION_IDLE_TIMEOUT_MS',
    15000,
    1000,
    600000,
  );
  const listenBacklog = parseEnvInt('MCPLI_IPC_LISTEN_BACKLOG', 128, 1, 2048);

  return { maxConnections, connectionIdleTimeoutMs, listenBacklog };
}

function makeOversizeRequestError(current: number, limit: number): string {
  return [
    `IPC request too large: ${formatBytes(current)} exceeds limit ${formatBytes(limit)}.`,
    `Set MCPLI_IPC_MAX_FRAME_BYTES to a higher value if this is expected data.`,
    `Request rejected; daemon remains running.`,
  ].join(' ');
}

function makeOversizeResponseError(current: number, limit: number): string {
  return [
    `IPC response too large: ${formatBytes(current)} exceeds limit ${formatBytes(limit)}.`,
    `Set MCPLI_IPC_MAX_FRAME_BYTES to a higher value if this is expected data.`,
  ].join(' ');
}

function terminateProcessWithServerClose(server: net.Server, reason: string): void {
  if (oversizeKillInitiated) return;
  oversizeKillInitiated = true;
  console.error(
    `[F-014] ${reason} — Terminating daemon to prevent runaway memory. Hard threshold: ${formatBytes(
      HARD_KILL_THRESHOLD_BYTES,
    )}.`,
  );
  try {
    server.close(() => {
      try {
        process.exit(1);
      } catch {
        // ignore
      }
    });
  } catch {
    try {
      process.exit(1);
    } catch {
      // ignore
    }
  }
  // Failsafe in case server.close never calls back
  setTimeout(() => {
    try {
      process.exit(1);
    } catch {
      // ignore
    }
  }, 1500);
}

/**
 * Ensure that the parent directory for a Unix domain socket is securely owned and permissioned.
 * - Creates the directory recursively with mode 0700 by default
 * - Verifies it's not a symlink and owned by the current user
 * - Tightens permissions if too permissive
 * - Throws on any security issue
 * - No-ops on Windows / named pipe paths
 */
async function ensureSecureUnixSocketDir(
  socketPath: string,
  opts: { mode?: number; failOnInsecure?: boolean } = {},
): Promise<void> {
  const isWindows = process.platform === 'win32';
  // On Windows, Node uses named pipes (\\\\.\\pipe\\...) and directory semantics don't apply.
  if (isWindows || socketPath.startsWith('\\\\.\\')) {
    return;
  }

  const dir = path.dirname(socketPath);
  const mode = typeof opts.mode === 'number' ? opts.mode : 0o700;
  const failOnInsecure = opts.failOnInsecure !== false;

  const fs = await import('fs/promises');

  // Create directory recursively with the requested mode
  try {
    await fs.mkdir(dir, { recursive: true, mode });
    console.log(
      `[DEBUG] Ensured IPC socket directory exists: ${dir} (requested mode ${mode.toString(8)})`,
    );
  } catch (err) {
    const msg = `Failed to create IPC socket directory '${dir}': ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    throw new Error(msg);
  }

  // lstat to inspect the path without following symlinks
  let st: import('fs').Stats;
  try {
    st = await fs.lstat(dir);
  } catch (err) {
    const msg = `Failed to stat IPC socket directory '${dir}': ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    throw new Error(msg);
  }

  // Must be a real directory (not a symlink)
  if (st.isSymbolicLink?.() === true) {
    const msg = `Security error: IPC socket directory must not be a symlink: ${dir}`;
    console.error(msg);
    if (failOnInsecure) throw new Error(msg);
    return;
  }
  if (typeof st.isDirectory === 'function' && !st.isDirectory()) {
    const msg = `Security error: IPC socket parent is not a directory: ${dir}`;
    console.error(msg);
    throw new Error(msg);
  }

  // Ownership check (POSIX only)
  try {
    const getUid = (process as { getuid?: () => number }).getuid;
    if (typeof getUid === 'function') {
      const uid = getUid();
      const statUid = (st as { uid?: number }).uid;
      if (typeof statUid === 'number' && statUid !== uid) {
        const msg = `Security error: IPC socket directory '${dir}' is owned by uid ${statUid}, expected ${uid}`;
        console.error(msg);
        if (failOnInsecure) throw new Error(msg);
        return;
      }
    }
  } catch {
    // If ownership checks are unavailable, continue; permissions checks still apply.
  }

  // Permission tightening: enforce requested mode (default 0700)
  const currentMode = st.mode & 0o777;
  if ((currentMode & 0o077) !== 0 || currentMode !== mode) {
    try {
      await fs.chmod(dir, mode);
      console.log(
        `[DEBUG] Tightened IPC socket directory permissions: ${dir} (${currentMode.toString(8)} -> ${mode.toString(8)})`,
      );
    } catch (err) {
      const msg = `Failed to set permissions ${mode.toString(8)} on IPC socket directory '${dir}': ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.error(msg);
      if (failOnInsecure) throw new Error(msg);
    }
  }
}

/**
 * Safe unlink that only removes Unix domain sockets or symlinks (F-010).
 * No-op on Windows or named pipe paths.
 */
async function safeUnlinkSocketIfExists(socketPath: string): Promise<void> {
  const isWindows = process.platform === 'win32' || socketPath.startsWith('\\\\.\\');
  if (isWindows) return;

  const fs = await import('fs/promises');
  try {
    const st = await fs.lstat(socketPath);
    const stWithSocket = st as typeof st & { isSocket?: () => boolean };
    const isSocket = typeof stWithSocket.isSocket === 'function' && stWithSocket.isSocket();
    const isSymlink = typeof st.isSymbolicLink === 'function' && st.isSymbolicLink();

    if (isSocket || isSymlink) {
      await fs.unlink(socketPath);
      console.log(`[DEBUG] Removed stale IPC socket path: ${socketPath}`);
    } else {
      throw new Error(`Refusing to remove non-socket file at: ${socketPath}`);
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      return; // Not present; nothing to do
    }
    if (err instanceof Error) {
      // Propagate to caller; startup should fail rather than remove arbitrary files
      throw err;
    }
    throw new Error(String(err));
  }
}

/**
 * Post-bind verification for defense-in-depth (F-010).
 * Verifies that the bound path is a socket and owned by current user. Logs warnings only.
 * POSIX only; no-op on Windows/named pipe paths.
 */
async function verifySocketPostBind(socketPath: string): Promise<void> {
  const isWindows = process.platform === 'win32' || socketPath.startsWith('\\\\.\\');
  if (isWindows) return;

  const fs = await import('fs/promises');
  try {
    const st = await fs.lstat(socketPath);
    const stWithSocket = st as typeof st & { isSocket?: () => boolean };
    const isSocket = typeof stWithSocket.isSocket === 'function' && stWithSocket.isSocket();
    if (!isSocket) {
      console.warn(`[F-010] Post-bind check: ${socketPath} is not a socket`);
    }
    try {
      const getUid = (process as { getuid?: () => number }).getuid;
      if (typeof getUid === 'function') {
        const uid = getUid();
        const statUid = (st as { uid?: number }).uid;
        if (typeof statUid === 'number' && statUid !== uid) {
          console.warn(
            `[F-010] Post-bind ownership mismatch: ${socketPath} owned by uid ${statUid}, expected ${uid}`,
          );
        }
      }
    } catch {
      // ignore unavailable ownership checks
    }
  } catch (err) {
    console.warn(
      `[F-010] Post-bind verification failed for ${socketPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Attach server handlers that implement connection flood protection (F-009),
 * handshake idle timeout, and frame-size safety limits (F-014).
 */
function attachIpcServerHandlers(
  server: net.Server,
  handler: (request: IPCRequest) => Promise<unknown>,
  tunables: ReturnType<typeof getIpcServerTunables> = getIpcServerTunables(),
): void {
  const { maxFrameBytes, killThresholdBytes } = getIpcLimits();
  let activeConnections = 0;
  // Advisory limit; we still enforce manually
  (server as { maxConnections?: number }).maxConnections = tunables.maxConnections;

  server.on('connection', (client) => {
    if (activeConnections >= tunables.maxConnections) {
      const response: IPCResponse = {
        id: 'unknown',
        error: `Server busy: max connections ${tunables.maxConnections} reached`,
      };
      try {
        client.write(JSON.stringify(response) + '\n');
      } catch {
        // ignore
      }
      try {
        client.end();
      } catch {
        // ignore
      }
      return;
    }

    activeConnections++;
    let buffer = '';
    let handshakeCompleted = false;
    let idleTimer: NodeJS.Timeout | undefined;

    const armIdleTimer = (): void => {
      if (handshakeCompleted) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          client.end();
        } catch {
          // ignore
        }
      }, tunables.connectionIdleTimeoutMs);
    };

    // Start handshake timer immediately on connection
    armIdleTimer();

    client.on('data', async (data) => {
      // Reset handshake timer on any inbound data until first full message
      armIdleTimer();

      // Append new data and enforce frame size limits before parsing
      buffer += data.toString();
      const currentBytes = Buffer.byteLength(buffer, 'utf8');

      if (currentBytes > killThresholdBytes) {
        // Hard kill: terminate daemon to prevent runaway memory usage
        try {
          client.destroy();
        } catch {
          // ignore
        }
        terminateProcessWithServerClose(
          server,
          `IPC request buffer exceeded hard kill threshold (${formatBytes(
            currentBytes,
          )} > ${formatBytes(killThresholdBytes)})`,
        );
        return;
      }

      if (currentBytes > maxFrameBytes) {
        // Soft limit: reject request, clear buffer, keep daemon alive
        const response: IPCResponse = {
          id: 'unknown',
          error: makeOversizeRequestError(currentBytes, maxFrameBytes),
        };
        try {
          client.write(JSON.stringify(response) + '\n');
        } catch {
          // ignore write failure
        }
        buffer = '';
        try {
          client.end();
        } catch {
          // ignore
        }
        return;
      }

      // Handle multiple JSON messages in buffer
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;

        const message = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (!message.trim()) continue;

        // Mark handshake as completed upon first full message
        if (!handshakeCompleted) {
          handshakeCompleted = true;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
          }
        }

        try {
          const request: IPCRequest = JSON.parse(message) as IPCRequest;
          const result = await handler(request);
          const response: IPCResponse = { id: request.id, result };
          client.write(JSON.stringify(response) + '\n');
        } catch (error) {
          const response: IPCResponse = {
            id: 'unknown',
            error: error instanceof Error ? error.message : String(error),
          };
          try {
            client.write(JSON.stringify(response) + '\n');
          } catch {
            // ignore
          }
        }
      }
    });

    client.on('error', (error: NodeJS.ErrnoException) => {
      // Reduce log spam for expected disconnects
      if (error && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
        return;
      }
      console.error('IPC client error:', error);
    });

    client.on('close', () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      activeConnections = Math.max(0, activeConnections - 1);
    });
  });
}

/**
 * Create a Unix socket IPC server at the given path with secure defaults
 * (safe unlink on bind, permission tightening, unlink-on-close).
 *
 * @param socketPath Absolute path to the Unix socket.
 * @param handler Async request handler for IPC requests.
 * @returns An `IPCServer` with a `close()` method for cleanup.
 */
export async function createIPCServer(
  socketPath: string,
  handler: (request: IPCRequest) => Promise<unknown>,
): Promise<IPCServer> {
  // Default behavior with unlinkOnClose and chmod
  return createIPCServerPath(socketPath, handler, { unlinkOnClose: true, chmod: 0o600 });
}

/**
 * Advanced variant of `createIPCServer` with tunable unlink/chmod/umask.
 *
 * @param socketPath Absolute path to the Unix socket.
 * @param handler Async request handler for IPC requests.
 * @param opts Optional behaviors: unlinkOnClose, chmod mode, secure dir mode, umask during bind.
 * @returns An `IPCServer` with a `close()` method for cleanup.
 */
export async function createIPCServerPath(
  socketPath: string,
  handler: (request: IPCRequest) => Promise<unknown>,
  opts: {
    unlinkOnClose?: boolean;
    chmod?: number;
    secureDirMode?: number;
    umaskDuringListen?: number;
  } = {},
): Promise<IPCServer> {
  // Ensure secure parent directory (POSIX only) BEFORE any unlink (F-010)
  const dirMode = typeof opts.secureDirMode === 'number' ? opts.secureDirMode : 0o700;
  await ensureSecureUnixSocketDir(socketPath, { mode: dirMode, failOnInsecure: true });

  // Safe pre-bind cleanup: remove only stale sockets/symlinks (F-010)
  await safeUnlinkSocketIfExists(socketPath);

  const tunables = getIpcServerTunables();

  const server = net.createServer();
  attachIpcServerHandlers(server, handler, tunables);

  // Prepare umask handling parameters
  const umaskDuringListen =
    typeof opts.umaskDuringListen === 'number' ? opts.umaskDuringListen : 0o177;
  const isWindows = process.platform === 'win32' || socketPath.startsWith('\\\\.\\');

  return new Promise((resolve, reject) => {
    let previousUmask: number | undefined;

    const setTempUmask = (): void => {
      if (!isWindows) {
        previousUmask = process.umask(umaskDuringListen);
        console.log(
          `[DEBUG] Set temporary umask ${umaskDuringListen.toString(8)} before binding IPC socket`,
        );
      }
    };

    const restoreUmask = (): void => {
      if (typeof previousUmask === 'number') {
        process.umask(previousUmask);
        console.log(`[DEBUG] Restored original umask ${previousUmask.toString(8)} after binding`);
        previousUmask = undefined;
      }
    };

    try {
      setTempUmask();

      server.listen(socketPath, tunables.listenBacklog, async () => {
        // Restore umask immediately upon successful bind
        restoreUmask();

        // Post-listen chmod as verification/enforcement step
        const chmodMode = typeof opts.chmod === 'number' ? opts.chmod : 0o600;
        if (!isWindows && chmodMode && chmodMode > 0) {
          try {
            await import('fs/promises').then((fs) => fs.chmod(socketPath, chmodMode));
            console.log(
              `[DEBUG] Verified IPC socket permissions at ${socketPath} to ${chmodMode.toString(8)}`,
            );
          } catch {
            // Non-fatal, but log for debugging
            console.warn('Could not set socket permissions:', socketPath);
          }
        }

        // Post-bind verification for defense-in-depth (F-010)
        await verifySocketPostBind(socketPath);

        resolve({
          server,
          close: () =>
            new Promise((resolveClose) => {
              server.close(() => {
                // Conditionally clean up socket file
                const shouldUnlink = opts.unlinkOnClose !== false;
                if (shouldUnlink) {
                  safeUnlinkSocketIfExists(socketPath)
                    .catch(() => {})
                    .finally(resolveClose);
                } else {
                  resolveClose();
                }
              });
            }),
        });
      });

      server.on('error', (err) => {
        // Ensure umask is restored on error as well
        restoreUmask();
        reject(err);
      });
    } catch (err) {
      // Synchronous error path: restore umask and reject
      restoreUmask();
      reject(err);
    }
  });
}

/**
 * Create an IPC server from an already-open socket FD (e.g., launchd).
 *
 * @param fd A valid, listening socket file descriptor.
 * @param handler Async request handler for IPC requests.
 * @returns An `IPCServer` with a `close()` method for cleanup.
 */
export async function createIPCServerFromFD(
  fd: number,
  handler: (request: IPCRequest) => Promise<unknown>,
): Promise<IPCServer> {
  const tunables = getIpcServerTunables();
  const server = net.createServer();
  attachIpcServerHandlers(server, handler, tunables);

  return new Promise((resolve, reject) => {
    server.listen({ fd, exclusive: false }, () => {
      resolve({
        server,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => {
              // No unlink behavior for FD-based servers; launchd owns the socket
              resolveClose();
            });
          }),
      });
    });

    server.on('error', reject);
  });
}

function assertValidSocketName(name: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Invalid launchd socket name '${name}'. Expected [A-Za-z0-9_]+`);
  }
}
/**
 * Create an IPC server using launchd socket activation.
 * Expects a valid `socketName` key present in the launchd plist.
 *
 * @param socketName The launchd Sockets dict key to collect.
 * @param handler Async request handler for IPC requests.
 * @returns An `IPCServer` with a `close()` method for cleanup.
 */
export async function createIPCServerFromLaunchdSocket(
  socketName: string,
  handler: (request: IPCRequest) => Promise<unknown>,
): Promise<IPCServer> {
  assertValidSocketName(socketName);
  let fds: number[] = [];

  try {
    // Try using socket-activation package first
    const sockets = await import('socket-activation');
    fds = sockets.collect(socketName);
    console.log(
      `[DEBUG] Socket-activation: Collected ${fds.length} socket FDs from launchd for '${socketName}': [${fds.join(
        ', ',
      )}]`,
    );
  } catch (error) {
    console.log(
      `[DEBUG] Socket-activation failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    // Optional fallback only when explicitly allowed (testing)
    if (process.env.MCPLI_ALLOW_FD_FALLBACK === '1') {
      console.warn(
        `[DEBUG] MCPLI_ALLOW_FD_FALLBACK=1 set. Using test-only FDs: [4, 5]. Do NOT use in production.`,
      );
      fds = [4, 5];
    }
  }

  if (fds.length === 0) {
    throw new Error(`No socket FDs found for launchd socket '${socketName}'`);
  }

  // Use the first socket FD
  const fd = fds[0];
  console.log(`[DEBUG] Using socket FD: ${fd}`);

  return createIPCServerFromFD(fd, handler);
}

/**
 * Send a single request over the Unix socket with frame-size safety and timeout.
 *
 * @param socketPath Absolute path to the Unix socket to connect to.
 * @param request Request to send.
 * @param timeoutMs Request timeout in milliseconds (default 10000ms).
 * @returns The `result` field from the IPC response, or throws on error.
 */
export async function sendIPCRequest(
  socketPath: string,
  request: IPCRequest,
  timeoutMs = 10000,
): Promise<unknown> {
  const { maxFrameBytes, killThresholdBytes } = getIpcLimits();

  // Connection retry budget to smooth over launchd activation races (ms)
  const retryBudgetDefault = 1000;
  const retryBudgetEnv = Number(process.env.MCPLI_IPC_CONNECT_RETRY_BUDGET_MS ?? '');
  const connectRetryBudget =
    Number.isFinite(retryBudgetEnv) && retryBudgetEnv > 0
      ? Math.min(retryBudgetEnv, Math.max(250, retryBudgetEnv))
      : retryBudgetDefault;

  function connectWithRetry(path: string, budgetMs: number): Promise<net.Socket> {
    const deadline = Date.now() + budgetMs;
    const attempt = (delayMs: number): Promise<net.Socket> =>
      new Promise((resolveAttempt, rejectAttempt) => {
        const socket = net.connect(path);
        let settled = false;

        const onConnect = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolveAttempt(socket);
        };
        const onError = (err: NodeJS.ErrnoException): void => {
          if (settled) return;
          // Retry only for transient launchd/socket activation cases
          if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT')) {
            cleanup();
            const now = Date.now();
            if (now >= deadline) {
              rejectAttempt(err);
              return;
            }
            const nextDelay = Math.min(100, Math.max(20, delayMs));
            setTimeout(() => {
              attempt(nextDelay).then(resolveAttempt, rejectAttempt);
            }, nextDelay);
            return;
          }
          cleanup();
          rejectAttempt(err);
        };
        const cleanup = (): void => {
          socket.removeListener('connect', onConnect);
          socket.removeListener('error', onError);
        };

        socket.once('connect', onConnect);
        socket.once('error', onError);
      });

    return attempt(20);
  }

  return new Promise((resolve, reject) => {
    let client: net.Socket;
    // Establish connection (with short retry budget)
    connectWithRetry(
      socketPath,
      Math.min(connectRetryBudget, Math.max(100, Math.floor(timeoutMs / 4))),
    )
      .then((sock) => {
        client = sock;
        client.write(JSON.stringify(request) + '\n');
        attachHandlers(client);
      })
      .catch((err) => reject(err));

    function attachHandlers(clientSock: net.Socket): void {
      let buffer = '';
      const timeout = setTimeout(() => {
        try {
          clientSock.destroy();
        } catch {
          // ignore
        }
        reject(new Error(`IPC request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      clientSock.on('data', (data) => {
        buffer += data.toString();

        const currentBytes = Buffer.byteLength(buffer, 'utf8');

        if (currentBytes > killThresholdBytes) {
          clearTimeout(timeout);
          try {
            clientSock.destroy();
          } catch {
            // ignore
          }
          buffer = '';
          reject(
            new Error(
              `[F-014] IPC response exceeded hard threshold ${formatBytes(
                killThresholdBytes,
              )}. Aborting to prevent runaway memory.`,
            ),
          );
          return;
        }

        if (currentBytes > maxFrameBytes) {
          clearTimeout(timeout);
          try {
            clientSock.destroy();
          } catch {
            // ignore
          }
          buffer = '';
          reject(new Error(makeOversizeResponseError(currentBytes, maxFrameBytes)));
          return;
        }

        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex !== -1) {
          const message = buffer.slice(0, newlineIndex);
          clearTimeout(timeout);
          try {
            clientSock.end();
          } catch {
            // ignore
          }
          try {
            const response: IPCResponse = JSON.parse(message) as IPCResponse;
            if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response.result!);
            }
          } catch (error) {
            reject(new Error(`Invalid IPC response: ${error}`));
          }
        }
      });
    }
  });
}

/**
 * Generate a best-effort unique request identifier (time + random suffix).
 *
 * @returns A string identifier.
 */
export function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Internal exports for testing IPC limit tuning without exposing as public API.
 * @internal
 */
export { getIpcLimits as __testGetIpcLimits, getIpcServerTunables as __testGetIpcServerTunables };
