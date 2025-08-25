import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { DaemonLock, getDaemonInfo, getSocketPath, deriveIdentityEnv } from './lock.ts';
import { createIPCServer, IPCRequest } from './ipc.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDaemonTimeoutMs } from '../config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DaemonOptions {
  logs?: boolean;
  debug?: boolean;
  cwd?: string;
  timeout?: number;
  daemonId?: string;
  env?: Record<string, string>;
}

export interface DaemonProcess {
  lock: DaemonLock;
  close: () => Promise<void>;
}

export async function startDaemon(
  command: string,
  args: string[],
  options: DaemonOptions = {},
): Promise<DaemonProcess> {
  const cwd = options.cwd ?? process.cwd();

  // Resolve daemon ID (prefer provided, otherwise derive from command+args+env)
  const { generateDaemonIdWithEnv } = await import('./lock.ts');
  const identityEnv = options.env ?? deriveIdentityEnv();
  const id = options.daemonId ?? generateDaemonIdWithEnv(command, args, identityEnv);

  // Compute socket path for this daemonId
  const socketPath = getSocketPath(cwd, id);

  // Ensure .mcpli directory exists
  const fs = await import('fs/promises');
  const { existsSync } = await import('fs');
  const mcpliDir = path.join(cwd, '.mcpli');
  if (!existsSync(mcpliDir)) {
    await fs.mkdir(mcpliDir, { recursive: true });
  }

  // Wrapper script path
  const wrapperPath = path.join(__dirname, 'daemon', 'wrapper.js');

  // Spawn detached wrapper process with merged environment
  const daemon = spawn('node', [wrapperPath], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      MCPLI_SOCKET_PATH: socketPath,
      MCPLI_CWD: cwd,
      MCPLI_DEBUG: options.debug ? '1' : '0',
      MCPLI_TIMEOUT: getDaemonTimeoutMs(options.timeout).toString(),
      MCPLI_LOGS: options.logs ? '1' : '0',
      MCPLI_COMMAND: command,
      MCPLI_ARGS: JSON.stringify(args),
      MCPLI_DAEMON_ID: id,
      MCPLI_SERVER_ENV: JSON.stringify(options.env ?? {}),
    },
  });

  daemon.unref();

  // Wait for IPC server ready
  await waitForDaemonReady(socketPath, 10000);

  // Read daemon info back from lock file
  const info = await getDaemonInfo(cwd, id);
  if (!info) {
    throw new Error('Failed to get daemon lock info after startup');
  }

  return {
    lock: {
      info,
      release: async (): Promise<void> => {
        // Lock is owned by daemon; do nothing here
      },
    },
    close: async (): Promise<void> => {
      try {
        if (daemon.pid) {
          process.kill(daemon.pid, 'SIGTERM');
          await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 5000);
            daemon.on('exit', () => {
              clearTimeout(timeout);
              resolve(undefined);
            });
          });
          try {
            if (daemon.pid) {
              process.kill(daemon.pid, 'SIGKILL');
            }
          } catch {
            // Already dead
          }
        }
      } catch {
        // Process may already be dead
      }
    },
  };
}

async function waitForDaemonReady(socketPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { sendIPCRequest, generateRequestId } = await import('./ipc.ts');
      await sendIPCRequest(
        socketPath,
        {
          id: generateRequestId(),
          method: 'ping',
        },
        1000,
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Daemon failed to start within ${timeoutMs}ms`);
}

// In-process daemon for development/testing
export class InProcessDaemon {
  private mcpClient?: Client;
  private ipcServer?: { close: () => Promise<void> };
  public lock?: DaemonLock;
  private inactivityTimeout?: NodeJS.Timeout;

  constructor(
    private command: string,
    private args: string[],
    private options: DaemonOptions = {},
  ) {}

  async start(): Promise<void> {
    const cwd = this.options.cwd ?? process.cwd();
    const { acquireDaemonLockWithEnv, generateDaemonIdWithEnv } = await import('./lock.ts');
    const identityEnv = this.options.env ?? deriveIdentityEnv();
    const id =
      this.options.daemonId ?? generateDaemonIdWithEnv(this.command, this.args, identityEnv);

    // Acquire lock for this daemonId
    this.lock = await acquireDaemonLockWithEnv(
      this.command,
      this.args,
      this.options.env ?? {},
      cwd,
      id,
    );

    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.options.env ? { ...safeEnv, ...this.options.env } : undefined,
      stderr: this.options.logs ? 'inherit' : 'ignore',
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

    // Start IPC server for this daemonId's socket
    this.ipcServer = await createIPCServer(
      this.lock!.info.socket,
      this.handleIPCRequest.bind(this),
    );

    this.resetInactivityTimer();

    process.on('SIGTERM', this.gracefulShutdown.bind(this));
    process.on('SIGINT', this.gracefulShutdown.bind(this));
  }

  private async handleIPCRequest(request: IPCRequest): Promise<unknown> {
    this.resetInactivityTimer();

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

  private resetInactivityTimer(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }

    const timeoutMs = getDaemonTimeoutMs(this.options.timeout);
    this.inactivityTimeout = setTimeout(() => {
      this.gracefulShutdown();
    }, timeoutMs);
  }

  private async gracefulShutdown(): Promise<void> {
    if (this.options.debug) {
      console.log('[DEBUG] Daemon shutting down gracefully');
    }

    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }

    if (this.ipcServer) {
      await this.ipcServer.close();
    }

    if (this.mcpClient) {
      await this.mcpClient.close();
    }

    if (this.lock) {
      await this.lock.release();
    }

    process.exit(0);
  }

  async close(): Promise<void> {
    await this.gracefulShutdown();
  }
}
