import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnvironment, TestContext } from '../test-helper';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const isDarwin = process.platform === 'darwin';

describe.skipIf(!isDarwin)('IPC communication via launchd socket (macOS only)', () => {
  let env: TestContext;

  beforeAll(async () => {
    env = await createTestEnvironment();
    await env.cli('daemon', 'clean');
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('communicates successfully through launchd-managed daemon', async () => {
    const command = 'node';
    const args = [path.join(PROJECT_ROOT, 'test-server.js')]; // Use absolute path from project root

    // Ensure launchd job and sockets exist
    const startResult = await env.cli('daemon', 'start', '--', command, ...args);
    expect(startResult.exitCode).toBe(0);

    // Extract actual socket path and poll for readiness  
    const socketMatch = startResult.stdout.match(/Socket: (.+)/);
    if (!socketMatch) {
      throw new Error('Could not extract socket path from daemon start output');
    }
    await env.pollForSocketPath(socketMatch[1]);

    // Test IPC functionality (not start timing)
    const echoResult = await env.cli('echo', '--message', 'ipc-test', '--', command, ...args);
    expect(echoResult.exitCode).toBe(0);
    expect(echoResult.stdout.trim()).toBe('ipc-test');
  });
});