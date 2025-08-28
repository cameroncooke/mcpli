import net from 'net';
import path from 'path';

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolListResult {
  tools: Tool[];
  _meta?: Record<string, unknown>;
}

export interface ToolCallResult {
  content?: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface IPCRequest {
  id: string;
  method: 'listTools' | 'callTool' | 'ping';
  params?: ToolCallParams | undefined;
}

export interface IPCResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface IPCServer {
  server: net.Server;
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
    maxFrame = clamped;
  }
  return { maxFrameBytes: maxFrame, killThresholdBytes: HARD_KILL_THRESHOLD_BYTES };
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

export async function createIPCServer(
  socketPath: string,
  handler: (request: IPCRequest) => Promise<unknown>,
): Promise<IPCServer> {
  // Remove existing socket file if it exists
  return createIPCServerPath(socketPath, handler, { unlinkOnClose: true, chmod: 0o600 });
}

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
  // Pre-bind cleanup: remove existing socket file if present
  try {
    await import('fs/promises').then((fs) => fs.unlink(socketPath));
  } catch {
    // Socket file doesn't exist, which is fine
  }

  const { maxFrameBytes, killThresholdBytes } = getIpcLimits();

  const server = net.createServer((client) => {
    let buffer = '';

    client.on('data', async (data) => {
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

    client.on('error', (error) => {
      console.error('IPC client error:', error);
    });
  });

  // Ensure secure parent directory (POSIX only)
  const dirMode = typeof opts.secureDirMode === 'number' ? opts.secureDirMode : 0o700;
  await ensureSecureUnixSocketDir(socketPath, { mode: dirMode, failOnInsecure: true });

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

      server.listen(socketPath, async () => {
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

        resolve({
          server,
          close: () =>
            new Promise((resolveClose) => {
              server.close(() => {
                // Conditionally clean up socket file
                const shouldUnlink = opts.unlinkOnClose !== false;
                if (shouldUnlink && !isWindows) {
                  import('fs/promises')
                    .then((fs) => fs.unlink(socketPath).catch(() => {}))
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

export async function createIPCServerFromFD(
  fd: number,
  handler: (request: IPCRequest) => Promise<unknown>,
): Promise<IPCServer> {
  const { maxFrameBytes, killThresholdBytes } = getIpcLimits();

  const server = net.createServer((client) => {
    let buffer = '';

    client.on('data', async (data) => {
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

    client.on('error', (error) => {
      console.error('IPC client error:', error);
    });
  });

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

export async function createIPCServerFromLaunchdSocket(
  socketName: string,
  handler: (request: IPCRequest) => Promise<unknown>,
): Promise<IPCServer> {
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

    // Fallback: Use discovered FDs from testing (FD 4 and 5 were found)
    console.log(`[DEBUG] Using fallback FDs: [4, 5]`);
    fds = [4, 5];
  }

  if (fds.length === 0) {
    throw new Error(`No socket FDs found for launchd socket '${socketName}'`);
  }

  // Use the first socket FD
  const fd = fds[0];
  console.log(`[DEBUG] Using socket FD: ${fd}`);

  return createIPCServerFromFD(fd, handler);
}

export async function sendIPCRequest(
  socketPath: string,
  request: IPCRequest,
  timeoutMs = 10000,
): Promise<unknown> {
  const { maxFrameBytes, killThresholdBytes } = getIpcLimits();

  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath, () => {
      client.write(JSON.stringify(request) + '\n');
    });

    let buffer = '';
    const timeout = setTimeout(() => {
      try {
        client.destroy();
      } catch {
        // ignore
      }
      reject(new Error(`IPC request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.on('data', (data) => {
      buffer += data.toString();

      const currentBytes = Buffer.byteLength(buffer, 'utf8');

      if (currentBytes > killThresholdBytes) {
        clearTimeout(timeout);
        try {
          client.destroy();
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
          client.destroy();
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
          client.end();
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

    client.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    client.on('timeout', () => {
      clearTimeout(timeout);
      try {
        client.destroy();
      } catch {
        // ignore
      }
      reject(new Error('IPC connection timeout'));
    });
  });
}

export function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
