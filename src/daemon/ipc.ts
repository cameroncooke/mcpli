import net from 'net';
import { DaemonInfo } from './lock.ts';

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
      // Restrict socket permissions to current user only (0600)
      try {
        await import('fs/promises').then((fs) => fs.chmod(socketPath, 0o600));
      } catch {
        // Non-fatal, but log for debugging
        console.warn('Could not set socket permissions:', socketPath);
      }

      resolve({
        server,
        close: () =>
          new Promise((resolve) => {
            server.close(() => {
              // Clean up socket file
              import('fs/promises')
                .then((fs) => fs.unlink(socketPath).catch(() => {}))
                .finally(resolve);
            });
          }),
      });
    });

    server.on('error', reject);
  });
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

export async function testIPCConnection(daemonInfo: DaemonInfo): Promise<boolean> {
  try {
    const request: IPCRequest = {
      id: Date.now().toString(),
      method: 'ping',
    };

    await sendIPCRequest(daemonInfo.socket, request, 2000);
    return true;
  } catch {
    return false;
  }
}

export function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
