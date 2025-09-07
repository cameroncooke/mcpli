import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const envSnapshot = { ...process.env };
let __capturedBudget: number | undefined;

// Mock orchestrator with mutable behavior flags
let __mockEnsureUpdateAction: 'loaded' | 'reloaded' | 'unchanged' = 'unchanged';
let __mockEnsureStarted = false;

vi.mock('../../src/daemon/runtime.ts', () => {
  const orchestrator = {
    type: 'launchd',
    computeId: () => 'test-id',
    async ensure(_cmd: string, _args: string[], _opts: unknown) {
      return {
        id: 'test-id',
        socketPath: '/tmp/fake.sock',
        updateAction: __mockEnsureUpdateAction,
        started: __mockEnsureStarted,
      };
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

describe('DaemonClient adaptive connect retry budget', () => {
  beforeEach(() => {
    process.env = { ...envSnapshot };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
    vi.clearAllMocks();
  });

  it('passes extended connect retry budget (8s) when job was loaded/reloaded/started', async () => {
    __mockEnsureUpdateAction = 'reloaded';
    __mockEnsureStarted = true;

    let capturedBudget: number | undefined;
    __capturedBudget = undefined;
    vi.mock('../../src/daemon/ipc.ts', () => ({
      generateRequestId: () => 'req-1',
      // Capture the 4th argument (connectRetryBudgetMs)
      async sendIPCRequest(_socketPath: string, _request: unknown, _timeoutMs: number, connectRetryBudgetMs?: number) {
        __capturedBudget = connectRetryBudgetMs;
        return { ok: true };
      },
    }));

    const { DaemonClient } = await import('../../src/daemon/client.ts');
    const client = new DaemonClient('fake-server', [], {});
    await client.callTool({ name: 'x' } as any);

    expect(__capturedBudget).toBe(8000);
  });

  it('uses default connect retry budget when updateAction is unchanged and not started', async () => {
    __mockEnsureUpdateAction = 'unchanged';
    __mockEnsureStarted = false;

    let capturedBudget: number | undefined;
    __capturedBudget = undefined;
    vi.mock('../../src/daemon/ipc.ts', () => ({
      generateRequestId: () => 'req-1',
      async sendIPCRequest(_socketPath: string, _request: unknown, _timeoutMs: number, connectRetryBudgetMs?: number) {
        __capturedBudget = connectRetryBudgetMs;
        return { ok: true };
      },
    }));

    const { DaemonClient } = await import('../../src/daemon/client.ts');
    const client = new DaemonClient('fake-server', [], {});
    await client.listTools();

    expect(__capturedBudget).toBeUndefined();
  });
});
