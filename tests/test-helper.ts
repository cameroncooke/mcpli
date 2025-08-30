import path from 'path';
import fs from 'fs/promises';
import { execa, ExecaChildProcess } from 'execa';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_CLI = path.resolve(PROJECT_ROOT, 'dist/mcpli.js');

export interface TestContext {
  cwd: string;
  cli: (...args: string[]) => ExecaChildProcess;
  cleanup: () => Promise<void>;
  pollForSocket: (id: string, timeout?: number) => Promise<string>;
  pollForSocketPath: (socketPath: string, timeout?: number) => Promise<string>;
  pollForDaemonReady: (command: string, args: string[], timeout?: number) => Promise<void>;
  getSocketPath: (id: string) => string;
  computeId: (command: string, args: string[], env?: Record<string, string>) => string;
}

/**
 * Creates an isolated test environment in a temporary directory.
 * This solves the test isolation and race condition issues identified in research.
 */
export async function createTestEnvironment(): Promise<TestContext> {
  // Create a unique temporary directory for the test
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpli-test-'));

  // Copy test servers to the temp directory
  await fs.copyFile(path.join(PROJECT_ROOT, 'test-server.js'), path.join(tempDir, 'test-server.js'));
  await fs.copyFile(path.join(PROJECT_ROOT, 'complex-test-server.js'), path.join(tempDir, 'complex-test-server.js'));
  await fs.copyFile(path.join(PROJECT_ROOT, 'weather-server.js'), path.join(tempDir, 'weather-server.js'));

  // Function to execute the mcpli CLI within the temp directory
  const cli = (...args: string[]): ExecaChildProcess => {
    return execa('node', [DIST_CLI, ...args], {
      cwd: tempDir,
      reject: false, // Don't throw on non-zero exit codes
      timeout: 20000, // 20s timeout for CLI commands
    });
  };

  // Hash function for cwd (must match runtime-launchd.ts hashCwd) 
  const hashCwd = (cwd: string): string => {
    const abs = path.resolve(cwd || process.cwd());
    return createHash('sha256').update(abs).digest('hex').slice(0, 8);
  };

  // Normalize functions matching src/daemon/runtime.ts
  const normalizeCommand = (command: string, args: string[] = []): { command: string; args: string[] } => {
    const trimmed = String(command || '').trim();
    const normCommand = path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : path.normalize(path.resolve(trimmed));

    const normArgs = (Array.isArray(args) ? args : [])
      .map((a) => String(a ?? '').trim())
      .filter((a) => a.length > 0);

    const normalizedCommand =
      process.platform === 'win32' ? normCommand.replace(/\\/g, '/').toLowerCase() : normCommand;
    const normalizedArgs =
      process.platform === 'win32' ? normArgs.map((a) => a.replace(/\\/g, '/')) : normArgs;

    return { command: normalizedCommand, args: normalizedArgs };
  };

  const normalizeEnv = (env: Record<string, string> = {}): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      const key = process.platform === 'win32' ? k.toUpperCase() : k;
      out[key] = String(v ?? '');
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };

  const computeId = (command: string, args: string[], env: Record<string, string> = {}): string => {
    // Match runtime.ts computeDaemonId exactly
    const norm = normalizeCommand(command, args);
    const normEnv = normalizeEnv(env);
    const input = JSON.stringify([norm.command, ...norm.args, { env: normEnv }]);
    const digest = createHash('sha256').update(input).digest('hex');
    return digest.slice(0, 8);
  };

  // Socket path must use the same cwd scope the CLI uses (project root), not tempDir
  const getSocketPath = (id: string): string => {
    if (os.platform() !== 'darwin') {
      throw new Error('Socket path calculation only supported on macOS');
    }
    const cwdHash = hashCwd(PROJECT_ROOT); // match launchd runtime scoping
    return path.join(os.tmpdir(), 'mcpli', cwdHash, `${id}.sock`);
  };

  // Poll for socket file existence (addresses race condition issues)
  const pollForSocket = async (id: string, timeout = 10000): Promise<string> => {
    const socketPath = getSocketPath(id);
    return pollForSocketPath(socketPath, timeout);
  };

  // Poll for socket file existence by direct path
  const pollForSocketPath = async (socketPath: string, timeout = 10000): Promise<string> => {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      try {
        const stats = await fs.stat(socketPath);
        if (stats.isSocket()) {
          return socketPath;
        }
      } catch {
        // Socket doesn't exist yet, continue polling
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error(`Socket ${socketPath} not ready after ${timeout}ms`);
  };

  // Poll for daemon to be ready for communication (addresses timing issues)
  const pollForDaemonReady = async (command: string, args: string[], timeout = 15000): Promise<void> => {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      try {
        const result = await cli('--help', '--', command, ...args);
        if (result.exitCode === 0 && result.stdout.includes('Available Tools:')) {
          return; // Daemon is ready and responding
        }
      } catch {
        // Not ready yet, continue polling
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    throw new Error(`Daemon not ready after ${timeout}ms`);
  };

  // Cleanup function
  const cleanup = async (): Promise<void> => {
    try {
      // Clean all daemons in this temp directory
      await cli('daemon', 'clean');
      
      // Remove temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Cleanup warning: ${error}`);
    }
  };

  return {
    cwd: tempDir,
    cli,
    cleanup,
    pollForSocket,
    pollForSocketPath,
    pollForDaemonReady,
    getSocketPath,
    computeId
  };
}