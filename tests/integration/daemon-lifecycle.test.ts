import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestEnvironment, TestContext } from '../test-helper';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const isDarwin = process.platform === 'darwin';

describe.skipIf(!isDarwin)('Launchd daemon lifecycle (macOS only)', () => {
  let env: TestContext;

  beforeAll(async () => {
    // Isolated temp directory per test suite and initial clean
    env = await createTestEnvironment();
    await env.cli('daemon', 'clean');
  });

  afterAll(async () => {
    // Cleanup temp directory and any daemons
    await env.cleanup();
  });

  it('starts daemon and makes basic tool call', async () => {
    const command = 'node';
    const args = [path.join(PROJECT_ROOT, 'test-server.js')]; // Use absolute path from project root

    // Start daemon via CLI (should return immediately after registering launchd job)
    const startResult = await env.cli('daemon', 'start', '--', command, ...args);
    expect(startResult.exitCode).toBe(0);

    // Extract actual socket path from output (follows industry pattern)
    const socketMatch = startResult.stdout.match(/Socket: (.+)/);
    let socketPath: string | undefined = socketMatch?.[1];
    if (!socketPath) {
      // Fallback to deterministic ID/path
      const id = env.computeId(command, args);
      socketPath = env.getSocketPath(id);
      // If this still fails, include diagnostics
      if (!socketPath) {
        throw new Error(
          `Could not determine socket path.\nstdout:\n${startResult.stdout}\nstderr:\n${startResult.stderr}`
        );
      }
    }
    
    // Poll for socket readiness using actual path
    await env.pollForSocketPath(socketPath);

    // Validate daemon functionality via IPC (echo)
    const echoResult = await env.cli('echo', '--message', 'hello', '--', command, ...args);
    expect(echoResult.exitCode).toBe(0);
    expect(echoResult.stdout.trim()).toBe('hello');
  });

  it('verifies daemon status command works', async () => {
    const statusResult = await env.cli('daemon', 'status');
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toMatch(/No daemons found|PID: \d+|Running: yes|Running: no/);
  });
});