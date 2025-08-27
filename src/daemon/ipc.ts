import net from 'net';

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
  opts: { unlinkOnClose?: boolean; chmod?: number } = {},
): Promise<IPCServer> {
  // Pre-bind cleanup: remove existing socket file if present
  try {
    await import('fs/promises').then((fs) => fs.unlink(socketPath));
  } catch {
    // Socket file doesn't exist, which is fine
  }

  const server = net.createServer((client) => {
    let buffer = '';

    client.on('data', async (data) => {
      buffer += data.toString();

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
          client.write(JSON.stringify(response) + '\n');
        }
      }
    });

    client.on('error', (error) => {
      console.error('IPC client error:', error);
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(socketPath, async () => {
      const chmodMode = typeof opts.chmod === 'number' ? opts.chmod : 0o600;
      if (chmodMode && chmodMode > 0) {
        try {
          await import('fs/promises').then((fs) => fs.chmod(socketPath, chmodMode));
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
              if (shouldUnlink) {
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

    server.on('error', reject);
  });
}

export async function createIPCServerFromFD(
  fd: number,
  handler: (request: IPCRequest) => Promise<unknown>,
): Promise<IPCServer> {
  const server = net.createServer((client) => {
    let buffer = '';

    client.on('data', async (data) => {
      buffer += data.toString();

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
          client.write(JSON.stringify(response) + '\n');
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
      `[DEBUG] Socket-activation: Collected ${fds.length} socket FDs from launchd for '${socketName}': [${fds.join(', ')}]`,
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
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath, () => {
      client.write(JSON.stringify(request) + '\n');
    });

    let buffer = '';
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error(`IPC request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.on('data', (data) => {
      buffer += data.toString();

      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const message = buffer.slice(0, newlineIndex);
        clearTimeout(timeout);
        client.end();

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
      client.destroy();
      reject(new Error('IPC connection timeout'));
    });
  });
}

export function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
