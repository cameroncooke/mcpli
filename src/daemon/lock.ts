import { lock, unlock } from 'proper-lockfile';
import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';

export interface DaemonInfo {
  pid: number;
  socket: string;
  command: string;
  args: string[];
  started: string;
  lastAccess: string;
  cwd: string;
}

export interface DaemonLock {
  info: DaemonInfo;
  release: () => Promise<void>;
}

const MCPLI_DIR = '.mcpli';
const LOCK_FILE = 'daemon.lock';

function getMcpliDir(cwd = process.cwd()): string {
  return path.join(cwd, MCPLI_DIR);
}

function getLockPath(cwd = process.cwd()): string {
  return path.join(getMcpliDir(cwd), LOCK_FILE);
}

async function ensureMcpliDir(cwd = process.cwd()): Promise<void> {
  const mcpliDir = getMcpliDir(cwd);
  if (!existsSync(mcpliDir)) {
    await fs.mkdir(mcpliDir, { recursive: true });
  }
}

export async function acquireDaemonLock(
  command: string,
  args: string[],
  cwd = process.cwd()
): Promise<DaemonLock> {
  await ensureMcpliDir(cwd);
  const lockPath = getLockPath(cwd);
  
  // Create empty lock file if it doesn't exist
  try {
    await fs.access(lockPath);
  } catch {
    await fs.writeFile(lockPath, '{}');
  }
  
  try {
    // Acquire exclusive lock - will throw if already locked
    const release = await lock(lockPath, { 
      retries: 0,
      stale: 60000 // Consider lock stale after 1 minute
    });
    
    const daemonInfo: DaemonInfo = {
      pid: process.pid,
      socket: path.join(getMcpliDir(cwd), 'daemon.sock'),
      command,
      args,
      started: new Date().toISOString(),
      lastAccess: new Date().toISOString(),
      cwd
    };
    
    // Write daemon info to the lock file
    await fs.writeFile(lockPath, JSON.stringify(daemonInfo, null, 2));
    
    return {
      info: daemonInfo,
      release: async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // File might already be deleted
        }
        await release();
      }
    };
  } catch (error) {
    throw new Error(`Cannot acquire daemon lock: ${error instanceof Error ? error.message : error}`);
  }
}

export async function getDaemonInfo(cwd = process.cwd()): Promise<DaemonInfo | null> {
  try {
    const lockPath = getLockPath(cwd);
    const data = await fs.readFile(lockPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function updateLastAccess(cwd = process.cwd()): Promise<void> {
  const info = await getDaemonInfo(cwd);
  if (!info) return;
  
  info.lastAccess = new Date().toISOString();
  const lockPath = getLockPath(cwd);
  
  try {
    await fs.writeFile(lockPath, JSON.stringify(info, null, 2));
  } catch {
    // Ignore write errors - daemon might be shutting down
  }
}

export async function isDaemonRunning(cwd = process.cwd()): Promise<boolean> {
  const info = await getDaemonInfo(cwd);
  if (!info) return false;
  
  try {
    // Send test signal - throws if process doesn't exist
    process.kill(info.pid, 0);
    return true;
  } catch {
    // Process not running, clean up stale lock
    await cleanupStaleLock(cwd);
    return false;
  }
}

export async function cleanupStaleLock(cwd = process.cwd()): Promise<void> {
  try {
    const lockPath = getLockPath(cwd);
    await fs.unlink(lockPath);
  } catch {
    // Lock file might not exist or already cleaned up
  }
}

export async function stopDaemon(cwd = process.cwd(), force = false): Promise<boolean> {
  const info = await getDaemonInfo(cwd);
  if (!info) return false;
  
  try {
    // Send termination signal
    process.kill(info.pid, force ? 'SIGKILL' : 'SIGTERM');
    
    // Wait for graceful shutdown
    if (!force) {
      // Wait up to 5 seconds for graceful shutdown
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(info.pid, 0);
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch {
          // Process has exited
          break;
        }
      }
      
      // Force kill if still running
      try {
        process.kill(info.pid, 0);
        process.kill(info.pid, 'SIGKILL');
      } catch {
        // Already exited
      }
    }
    
    // Clean up lock file
    await cleanupStaleLock(cwd);
    return true;
  } catch {
    // Process might already be dead
    await cleanupStaleLock(cwd);
    return false;
  }
}