import { isDaemonRunning, getDaemonInfo, updateLastAccess } from './lock.js';
import { sendIPCRequest, generateRequestId, testIPCConnection } from './ipc.js';
import { startDaemon, DaemonOptions } from './spawn.js';

export interface DaemonClientOptions extends DaemonOptions {
  autoStart?: boolean;
  fallbackToStateless?: boolean;
}

export class DaemonClient {
  constructor(
    private command: string,
    private args: string[],
    private options: DaemonClientOptions = {}
  ) {
    this.options = {
      autoStart: true,
      fallbackToStateless: true,
      ...options
    };
  }
  
  async listTools(): Promise<any> {
    try {
      const result = await this.callDaemon('listTools');
      return result;
    } catch (error) {
      if (this.options.fallbackToStateless) {
        if (this.options.debug) {
          console.error('[DEBUG] Daemon listTools failed, falling back to stateless:', error);
        }
        return this.fallbackListTools();
      }
      throw error;
    }
  }
  
  async callTool(params: { name: string; arguments: any }): Promise<any> {
    try {
      const result = await this.callDaemon('callTool', params);
      return result;
    } catch (error) {
      if (this.options.fallbackToStateless) {
        if (this.options.debug) {
          console.error('[DEBUG] Daemon callTool failed, falling back to stateless:', error);
        }
        return this.fallbackCallTool(params);
      }
      throw error;
    }
  }
  
  private async callDaemon(method: string, params?: any): Promise<any> {
    const cwd = this.options.cwd || process.cwd();
    
    // Check if daemon is running
    const isRunning = await isDaemonRunning(cwd);
    
    if (!isRunning) {
      if (this.options.autoStart) {
        if (this.options.debug) {
          console.error('[DEBUG] Starting daemon automatically');
        }
        await this.startDaemon();
      } else {
        throw new Error('Daemon not running and auto-start disabled');
      }
    }
    
    // Get daemon info
    const daemonInfo = await getDaemonInfo(cwd);
    if (!daemonInfo) {
      throw new Error('Daemon info not available');
    }
    
    // Test connection
    if (!(await testIPCConnection(daemonInfo))) {
      throw new Error('Cannot connect to daemon IPC socket');
    }
    
    // Send request
    const request = {
      id: generateRequestId(),
      method: method as 'listTools' | 'callTool' | 'ping',
      params
    };
    
    const result = await sendIPCRequest(daemonInfo.socket, request);
    
    // Update last access time
    await updateLastAccess(cwd);
    
    return result;
  }
  
  private async startDaemon(): Promise<void> {
    try {
      const daemon = await startDaemon(this.command, this.args, this.options);
      
      // Wait a moment for daemon to be fully ready
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (this.options.debug) {
        console.error('[DEBUG] Daemon started successfully');
      }
    } catch (error) {
      if (this.options.debug) {
        console.error('[DEBUG] Failed to start daemon:', error);
      }
      throw new Error(`Failed to start daemon: ${error instanceof Error ? error.message : error}`);
    }
  }
  
  private async fallbackListTools(): Promise<any> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      stderr: this.options.logs ? 'inherit' : 'ignore'
    });
    
    const client = new Client({
      name: 'mcpli',
      version: '1.0.0'
    }, {
      capabilities: {}
    });
    
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
  
  private async fallbackCallTool(params: { name: string; arguments: any }): Promise<any> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      stderr: this.options.logs ? 'inherit' : 'ignore'
    });
    
    const client = new Client({
      name: 'mcpli',
      version: '1.0.0'
    }, {
      capabilities: {}
    });
    
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

// Convenience function for one-off operations
export async function withDaemonClient<T>(
  command: string,
  args: string[],
  options: DaemonClientOptions,
  operation: (client: DaemonClient) => Promise<T>
): Promise<T> {
  const client = new DaemonClient(command, args, options);
  return await operation(client);
}