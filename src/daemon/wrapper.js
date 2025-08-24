#!/usr/bin/env node

/**
 * MCPLI Daemon Wrapper - Long-lived MCP server process
 * 
 * This script runs as a detached daemon process and manages
 * a connection to an MCP server while providing IPC interface
 * for MCPLI commands.
 */

import { createIPCServer } from './ipc.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { acquireDaemonLock } from './lock.js';

class MCPLIDaemon {
  constructor() {
    this.mcpClient = null;
    this.ipcServer = null;
    this.inactivityTimeout = null;
    this.isShuttingDown = false;
    this.daemonLock = null;
    
    // Read environment variables
    this.socketPath = process.env.MCPLI_SOCKET_PATH;
    this.cwd = process.env.MCPLI_CWD || process.cwd();
    this.debug = process.env.MCPLI_DEBUG === '1';
    this.logs = process.env.MCPLI_LOGS === '1';
    this.timeoutMs = parseInt(process.env.MCPLI_TIMEOUT || '1800000', 10); // 30 minutes
    this.mcpCommand = process.env.MCPLI_COMMAND;
    this.mcpArgs = JSON.parse(process.env.MCPLI_ARGS || '[]');
    this.daemonId = process.env.MCPLI_DAEMON_ID || undefined;
    
    if (!this.socketPath || !this.mcpCommand) {
      console.error('Missing required environment variables or arguments');
      process.exit(1);
    }
  }
  
  async start() {
    try {
      if (this.debug) {
        console.error(`[DAEMON] Starting with command: ${this.mcpCommand} ${this.mcpArgs.join(' ')}`);
        console.error(`[DAEMON] Socket path: ${this.socketPath}`);
        if (this.daemonId) {
          console.error(`[DAEMON] Daemon ID: ${this.daemonId}`);
        }
      }
      
      // Acquire daemon lock for this ID - writes correct PID and socket
      this.daemonLock = await acquireDaemonLock(this.mcpCommand, this.mcpArgs, this.cwd, this.daemonId);
      
      if (this.debug) {
        console.error(`[DAEMON] Lock acquired for PID ${this.daemonLock.info.pid}`);
      }
      
      // Start MCP client
      await this.startMCPClient();
      
      // Start IPC server
      await this.startIPCServer();
      
      // Set up cleanup handlers
      process.on('SIGTERM', this.gracefulShutdown.bind(this));
      process.on('SIGINT', this.gracefulShutdown.bind(this));
      process.on('uncaughtException', this.handleError.bind(this));
      process.on('unhandledRejection', this.handleError.bind(this));
      
      // Start inactivity timer
      this.resetInactivityTimer();
      
      if (this.debug) {
        console.error('[DAEMON] Started successfully');
      }
      
    } catch (error) {
      console.error('[DAEMON] Failed to start:', error);
      process.exit(1);
    }
  }
  
  async startMCPClient() {
    const serverEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('MCPLI_'))
    );

    const transport = new StdioClientTransport({
      command: this.mcpCommand,
      args: this.mcpArgs,
      env: serverEnv,
      stderr: (this.debug || this.logs) ? 'inherit' : 'ignore'
    });
    
    this.mcpClient = new Client({
      name: 'mcpli-daemon',
      version: '1.0.0'
    }, {
      capabilities: {}
    });
    
    await this.mcpClient.connect(transport);
    
    if (this.debug) {
      console.error('[DAEMON] MCP client connected');
    }
  }
  
  async startIPCServer() {
    this.ipcServer = await createIPCServer(
      this.socketPath,
      this.handleIPCRequest.bind(this)
    );
    
    if (this.debug) {
      console.error('[DAEMON] IPC server listening on:', this.socketPath);
    }
  }
  
  async handleIPCRequest(request) {
    this.resetInactivityTimer();
    
    if (this.debug) {
      console.error(`[DAEMON] Handling IPC request: ${request.method}`);
    }
    
    switch (request.method) {
      case 'ping':
        return 'pong';
        
      case 'listTools':
        if (!this.mcpClient) throw new Error('MCP client not connected');
        return await this.mcpClient.listTools();
        
      case 'callTool':
        if (!this.mcpClient) throw new Error('MCP client not connected');
        return await this.mcpClient.callTool(request.params);
        
      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }
  
  resetInactivityTimer() {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }
    
    this.inactivityTimeout = setTimeout(() => {
      if (this.debug) {
        console.error('[DAEMON] Shutting down due to inactivity');
      }
      this.gracefulShutdown();
    }, this.timeoutMs);
  }
  
  async gracefulShutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    
    if (this.debug) {
      console.error('[DAEMON] Starting graceful shutdown');
    }
    
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }
    
    try {
      if (this.ipcServer) {
        await this.ipcServer.close();
        if (this.debug) {
          console.error('[DAEMON] IPC server closed');
        }
      }
      
      if (this.mcpClient) {
        await this.mcpClient.close();
        if (this.debug) {
          console.error('[DAEMON] MCP client closed');
        }
      }
    } catch (error) {
      console.error('[DAEMON] Error during shutdown:', error);
    }
    
    // Release the daemon lock
    if (this.daemonLock) {
      await this.daemonLock.release();
      if (this.debug) {
        console.error('[DAEMON] Lock released');
      }
    }
    
    if (this.debug) {
      console.error('[DAEMON] Shutdown complete');
    }
    
    process.exit(0);
  }
  
  handleError(error) {
    console.error('[DAEMON] Unhandled error:', error);
    this.gracefulShutdown();
  }
}

// Start the daemon
const daemon = new MCPLIDaemon();
daemon.start().catch(error => {
  console.error('[DAEMON] Fatal error:', error);
  process.exit(1);
});