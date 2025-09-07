import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const envSnapshot = { ...process.env };

// Mock the orchestrator to avoid touching the real platform runtime
vi.mock('../../src/daemon/runtime.ts', () => {
  const orchestrator = {
    type: 'launchd',
    computeId: () => 'test-id',
    async ensure(_cmd: string, _args: string[], _opts: unknown) {
      return { id: 'test-id', socketPath: '/tmp/fake.sock', updateAction: 'unchanged' };
    },
    async stop() {},
    async status() { return []; },
    async clean() {},
  };
  return {
    resolveOrchestrator: async () => orchestrator,
    computeDaemonId: () => 'test-id',
    deriveIdentityEnv: (e: Record<string, string>) => e,
  };
});

// Mock the IPC layer to capture the timeout value used
vi.mock('../../src/daemon/ipc.ts', () => {
  let lastTimeout = -1;
  return {
    generateRequestId: () => 'req-1',
    async sendIPCRequest(_socketPath: string, _request: unknown, timeoutMs: number) {
      lastTimeout = timeoutMs;
      return { ok: true };
    },
    __getLastTimeout: () => lastTimeout,
  };
});

describe('DaemonClient IPC timeout hierarchy', () => {
  beforeEach(() => {
    process.env = { ...envSnapshot };
    // Simulate misconfiguration: IPC < tool timeout
    process.env.MCPLI_IPC_TIMEOUT = '300000'; // 5 minutes
    process.env.MCPLI_TOOL_TIMEOUT_MS = '700000'; // 11m > 5m
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('enforces IPC timeout >= tool timeout + buffer for callTool', async () => {
    const { DaemonClient } = await import('../../src/daemon/client.ts');
    const ipc = (await import('../../src/daemon/ipc.ts')) as unknown as {
      __getLastTimeout: () => number;
    };

    const client = new DaemonClient('fake-server', [], {});
    await client.callTool({ name: 'x' } as any);

    // Tool timeout (700000) + 60000 buffer = 760000
    expect(ipc.__getLastTimeout()).toBe(760000);
  });

  it('uses configured IPC timeout for non-tool requests (listTools)', async () => {
    // Ensure no tool-timeout is present for this test case
    delete process.env.MCPLI_TOOL_TIMEOUT_MS;
    const { DaemonClient } = await import('../../src/daemon/client.ts');
    const ipc = (await import('../../src/daemon/ipc.ts')) as unknown as {
      __getLastTimeout: () => number;
    };

    const client = new DaemonClient('fake-server', [], { ipcTimeoutMs: 300000 });
    await client.listTools();

    // For non-tool methods, use MCPLI_IPC_TIMEOUT env (300000)
    expect(ipc.__getLastTimeout()).toBe(300000);
  });

  it('auto-buffers listTools IPC when tool timeout provided (via options.env)', async () => {
    const { DaemonClient } = await import('../../src/daemon/client.ts');
    const ipc = (await import('../../src/daemon/ipc.ts')) as unknown as {
      __getLastTimeout: () => number;
    };

    const client = new DaemonClient('fake-server', [], {
      env: { MCPLI_TOOL_TIMEOUT_MS: '820000' },
    });
    await client.listTools();

    // listTools should get buffered to toolTimeout+60s = 820000 + 60000 = 880000
    expect(ipc.__getLastTimeout()).toBe(880000);
  });

  it('autobuffers based on MCPLI_TOOL_TIMEOUT_MS provided via options.env', async () => {
    const { DaemonClient } = await import('../../src/daemon/client.ts');
    const ipc = (await import('../../src/daemon/ipc.ts')) as unknown as {
      __getLastTimeout: () => number;
    };

    const client = new DaemonClient('fake-server', [], {
      env: { MCPLI_TOOL_TIMEOUT_MS: '820000' },
    });
    await client.callTool({ name: 'x' } as any);

    // 820000 + 60000 = 880000
    expect(ipc.__getLastTimeout()).toBe(880000);
  });
});
