import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { execa } from 'execa';

const isDarwin = process.platform === 'darwin';

describe.skipIf(!isDarwin)('mcpli CLI e2e (macOS only)', () => {
  const distCli = path.resolve('dist/mcpli.js');
  const server = path.resolve('test-server.js');

  beforeAll(async () => {
    await execa('node', [distCli, 'daemon', 'clean'], { reject: false });
  });

  afterAll(async () => {
    await execa('node', [distCli, 'daemon', 'clean'], { reject: false });
  });

  it('shows help and lists tools for a given server', async () => {
    const helpResult = await execa('node', [distCli, '--help', '--', 'node', server], {
      reject: false,
      timeout: 15000
    });
    expect(helpResult.exitCode).toBe(0);
    expect(helpResult.stdout).toMatch(/Usage:/);
    expect(helpResult.stdout).toMatch(/Available Tools:/);
  });

  it('runs a tool successfully via launchd-managed daemon', async () => {
    const echoResult = await execa('node', [distCli, 'echo', '--message', 'hello', '--', 'node', server], {
      reject: false,
      timeout: 15000
    });
    expect(echoResult.exitCode).toBe(0);
    expect(echoResult.stdout.trim()).toBe('hello');
  });

  it('handles unknown tool with a clear error', async () => {
    const errorResult = await execa('node', [distCli, 'not_a_tool', '--', 'node', server], {
      reject: false,
      timeout: 15000
    });
    expect(errorResult.exitCode).toBe(1);
    expect(errorResult.stderr).toMatch(/No tool specified or tool not found/i);
  });
});