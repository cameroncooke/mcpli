import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { acquireDaemonLock, DaemonLock } from './lock.js';
import { createIPCServer, IPCRequest } from './ipc.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DaemonOptions {
  logs?: boolean;
  debug?: boolean;
  cwd?: string;
  timeout?: number;
}

export interface DaemonProcess {
  lock: DaemonLock;
  close: () => Promise<void>;
}

export async function startDaemon(
  command: string,
  args: string[],
  options: DaemonOptions = {}
): Promise<DaemonProcess> {
  // Use InProcessDaemon for more reliable operation
  const daemon = new InProcessDaemon(command, args, options);
  await daemon.start();
  
  return {
    lock: daemon.lock!,
    close: () => daemon.close()
  };
}

async function waitForDaemonReady(socketPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    try {
      const { sendIPCRequest, generateRequestId } = await import('./ipc.js');
      await sendIPCRequest(socketPath, {
        id: generateRequestId(),
        method: 'ping'
      }, 1000);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  throw new Error(`Daemon failed to start within ${timeoutMs}ms`);
}

// In-process daemon for development/testing
export class InProcessDaemon {
  private mcpClient?: Client;
  private ipcServer?: any;
  public lock?: DaemonLock;
  private inactivityTimeout?: NodeJS.Timeout;
  
  constructor(
    private command: string,
    private args: string[],
    private options: DaemonOptions = {}
  ) {}
  
  async start(): Promise<void> {
    const cwd = this.options.cwd || process.cwd();
    
    // Acquire lock
    this.lock = await acquireDaemonLock(this.command, this.args, cwd);
    
    // Start MCP client
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      stderr: this.options.logs ? 'inherit' : 'ignore'
    });
    
    this.mcpClient = new Client({
      name: 'mcpli-daemon',
      version: '1.0.0'
    }, {
      capabilities: {}
    });
    
    await this.mcpClient.connect(transport);
    
    // Start IPC server
    this.ipcServer = await createIPCServer(
      this.lock.info.socket,
      this.handleIPCRequest.bind(this)
    );
    
    // Set up inactivity timeout
    this.resetInactivityTimer();
    
    // Set up cleanup handlers
    process.on('SIGTERM', this.gracefulShutdown.bind(this));
    process.on('SIGINT', this.gracefulShutdown.bind(this));
  }
  
  private async handleIPCRequest(request: IPCRequest): Promise<any> {
    this.resetInactivityTimer();
    
    switch (request.method) {
      case 'ping':
        return 'pong';
        
      case 'listTools':
        if (!this.mcpClient) throw new Error('MCP client not connected');
        const result = await this.mcpClient.listTools();
        return result;
        
      case 'callTool':
        if (!this.mcpClient) throw new Error('MCP client not connected');
        return await this.mcpClient.callTool(request.params);
        
      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }
  
  private resetInactivityTimer(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }
    
    const timeoutMs = this.options.timeout || 30 * 60 * 1000; // 30 minutes
    this.inactivityTimeout = setTimeout(() => {
      this.gracefulShutdown();
    }, timeoutMs);
  }
  
  private async gracefulShutdown(): Promise<void> {
    if (this.options.debug) {
      console.error('[DEBUG] Daemon shutting down gracefully');
    }
    
    // Clear timeout
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }
    
    // Close IPC server
    if (this.ipcServer) {
      await this.ipcServer.close();
    }
    
    // Close MCP client
    if (this.mcpClient) {
      await this.mcpClient.close();
    }
    
    // Release lock
    if (this.lock) {
      await this.lock.release();
    }
    
    process.exit(0);
  }
  
  async close(): Promise<void> {
    await this.gracefulShutdown();
  }
}