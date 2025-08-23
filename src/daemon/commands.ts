import { 
  isDaemonRunning, 
  getDaemonInfo, 
  stopDaemon, 
  cleanupStaleLock 
} from './lock.js';
import { startDaemon, DaemonOptions } from './spawn.js';
import { testIPCConnection } from './ipc.js';
import fs from 'fs/promises';
import path from 'path';

export interface DaemonCommandOptions extends DaemonOptions {
  force?: boolean;
}

export async function handleDaemonStart(
  command: string, 
  args: string[], 
  options: DaemonCommandOptions = {}
): Promise<void> {
  const cwd = options.cwd || process.cwd();
  
  // Check if daemon is already running
  if (await isDaemonRunning(cwd)) {
    const info = await getDaemonInfo(cwd);
    console.log(`Daemon is already running (PID ${info?.pid})`);
    return;
  }
  
  try {
    console.log(`Starting daemon: ${command} ${args.join(' ')}`);
    
    const daemon = await startDaemon(command, args, options);
    
    console.log(`Daemon started successfully (PID ${daemon.lock.info.pid})`);
    console.log(`Socket: ${daemon.lock.info.socket}`);
    
    if (options.debug) {
      console.log('Debug mode enabled - daemon will log to console');
    }
    
  } catch (error) {
    console.error(`Failed to start daemon: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

export async function handleDaemonStop(options: DaemonCommandOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  
  if (!(await isDaemonRunning(cwd))) {
    console.log('No daemon is running');
    return;
  }
  
  const info = await getDaemonInfo(cwd);
  if (!info) {
    console.log('No daemon information found');
    await cleanupStaleLock(cwd);
    return;
  }
  
  try {
    console.log(`Stopping daemon (PID ${info.pid})...`);
    
    const stopped = await stopDaemon(cwd, options.force);
    
    if (stopped) {
      console.log('Daemon stopped successfully');
    } else {
      console.log('Daemon may have already been stopped');
    }
    
  } catch (error) {
    console.error(`Failed to stop daemon: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

export async function handleDaemonStatus(options: DaemonCommandOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  
  const info = await getDaemonInfo(cwd);
  
  if (!info) {
    console.log('Status: Not running');
    return;
  }
  
  const isRunning = await isDaemonRunning(cwd);
  
  if (!isRunning) {
    console.log('Status: Not running (stale lock file cleaned up)');
    return;
  }
  
  // Test IPC connection
  const canConnect = await testIPCConnection(info);
  
  console.log('Status: Running');
  console.log(`PID: ${info.pid}`);
  console.log(`Command: ${info.command} ${info.args.join(' ')}`);
  console.log(`Started: ${new Date(info.started).toLocaleString()}`);
  console.log(`Last access: ${new Date(info.lastAccess).toLocaleString()}`);
  console.log(`Socket: ${info.socket}`);
  console.log(`IPC connection: ${canConnect ? 'OK' : 'FAILED'}`);
  console.log(`Working directory: ${info.cwd}`);
  
  // Calculate uptime
  const uptimeMs = Date.now() - new Date(info.started).getTime();
  const uptimeMinutes = Math.floor(uptimeMs / 60000);
  const uptimeHours = Math.floor(uptimeMinutes / 60);
  const uptimeDays = Math.floor(uptimeHours / 24);
  
  let uptimeStr = '';
  if (uptimeDays > 0) uptimeStr += `${uptimeDays}d `;
  if (uptimeHours > 0) uptimeStr += `${uptimeHours % 24}h `;
  uptimeStr += `${uptimeMinutes % 60}m`;
  
  console.log(`Uptime: ${uptimeStr}`);
  
  // Calculate idle time
  const idleMs = Date.now() - new Date(info.lastAccess).getTime();
  const idleMinutes = Math.floor(idleMs / 60000);
  const idleHours = Math.floor(idleMinutes / 60);
  
  let idleStr = '';
  if (idleHours > 0) idleStr += `${idleHours}h `;
  idleStr += `${idleMinutes % 60}m`;
  
  console.log(`Idle time: ${idleStr}`);
}

export async function handleDaemonRestart(
  command: string,
  args: string[],
  options: DaemonCommandOptions = {}
): Promise<void> {
  console.log('Restarting daemon...');
  
  // Stop existing daemon
  await handleDaemonStop(options);
  
  // Wait a moment for cleanup
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Start new daemon
  await handleDaemonStart(command, args, options);
}

export async function handleDaemonLogs(options: DaemonCommandOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const logPath = path.join(cwd, '.mcpli', 'daemon.log');
  
  try {
    const logContent = await fs.readFile(logPath, 'utf8');
    console.log(logContent);
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      console.log('No log file found. Daemon may not have been started with --logs flag.');
    } else {
      console.error(`Failed to read log file: ${error instanceof Error ? error.message : error}`);
    }
  }
}

export async function handleDaemonClean(options: DaemonCommandOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const mcpliDir = path.join(cwd, '.mcpli');
  
  try {
    // Stop daemon if running
    if (await isDaemonRunning(cwd)) {
      console.log('Stopping running daemon...');
      await stopDaemon(cwd, true); // Force stop
    }
    
    // Clean up all daemon files
    const files = [
      'daemon.lock',
      'daemon.sock',
      'daemon.log',
      'daemon.config.json'
    ];
    
    let cleaned = 0;
    for (const file of files) {
      try {
        await fs.unlink(path.join(mcpliDir, file));
        cleaned++;
      } catch {
        // File doesn't exist, which is fine
      }
    }
    
    console.log(`Cleaned up ${cleaned} daemon files`);
    
    // Remove .mcpli directory if empty
    try {
      await fs.rmdir(mcpliDir);
      console.log('Removed empty .mcpli directory');
    } catch {
      // Directory not empty or doesn't exist
    }
    
  } catch (error) {
    console.error(`Failed to clean daemon files: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

export function printDaemonHelp(): void {
  console.log('MCPLI Daemon Management');
  console.log('');
  console.log('Usage:');
  console.log('  mcpli daemon <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  start [-- command args...]  Start daemon with MCP server command');
  console.log('  stop                         Stop running daemon');
  console.log('  restart [-- command args...] Restart daemon');
  console.log('  status                       Show daemon status and info');
  console.log('  logs                         Show daemon log output');
  console.log('  clean                        Clean up all daemon files');
  console.log('');
  console.log('Options:');
  console.log('  --force                      Force stop daemon');
  console.log('  --logs                       Enable daemon logging');
  console.log('  --debug                      Enable debug output');
  console.log('  --timeout <ms>               Set daemon inactivity timeout');
  console.log('');
  console.log('Examples:');
  console.log('  mcpli daemon start -- node server.js');
  console.log('  mcpli daemon status');
  console.log('  mcpli daemon stop');
  console.log('  mcpli daemon clean');
}