import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnvironment, TestContext } from '../test-helper.ts';

const isDarwin = process.platform === 'darwin';

describe.skipIf(!isDarwin)('Test Helper Functionality (macOS only)', () => {
  let testCtx: TestContext;

  beforeEach(async () => {
    testCtx = await createTestEnvironment();
  });

  afterEach(async () => {
    await testCtx.cleanup();
  });

  it('creates isolated environment and executes CLI', async () => {
    // Test basic CLI execution in isolated environment
    const result = await testCtx.cli('--help');
    expect(result.exitCode).toBe(0); // Global help returns 0
    expect(result.stdout).toMatch(/Usage:/);
  });

  it('can start and check daemon status', async () => {
    const command = 'node';
    const args = ['test-server.js'];
    
    // Start daemon
    const startResult = await testCtx.cli('daemon', 'start', '--', command, ...args);
    expect(startResult.exitCode).toBe(0);
    
    // Check status
    const statusResult = await testCtx.cli('daemon', 'status');
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toMatch(/PID: \d+/);
  });
});