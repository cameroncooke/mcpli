import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const envSnapshot = { ...process.env };

vi.mock('../../src/daemon/runtime.ts', () => {
  const orchestrator = {
    type: 'launchd',
    computeId: () => 'test-id',
    async ensure(_cmd: string, _args: string[], _opts: unknown) {
      return { id: 'test-id', socketPath: '/tmp/fake.sock', updateAction: 'unchanged' };
    },
    async stop() {},
    async status() {
      return [];
    },
    async clean() {},
  };
  return {
    resolveOrchestrator: async () => orchestrator,
    computeDaemonId: () => 'test-id',
    deriveIdentityEnv: (e: Record<string, string>) => e,
  };
});

let startResolve: () => void;
let sendIPCRequestStarted: Promise<void>;

const sendIPCRequestMock = vi.fn(
  (
    _socketPath: string,
    _request: unknown,
    _timeoutMs: number,
    _connectRetryBudgetMs?: number,
    signal?: AbortSignal,
  ) => {
    startResolve();
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('ipc aborted')), { once: true });
    });
  },
);

vi.mock('../../src/daemon/ipc.ts', () => ({
  generateRequestId: () => 'req-1',
  sendIPCRequest: sendIPCRequestMock,
}));

describe('DaemonClient mid-flight cancellation', () => {
  beforeEach(() => {
    process.env = { ...envSnapshot };
    sendIPCRequestMock.mockClear();
    sendIPCRequestStarted = new Promise((resolve) => {
      startResolve = resolve;
    });
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('rejects callTool promptly when signal aborts during request', async () => {
    const { DaemonClient } = await import('../../src/daemon/client.ts');
    const client = new DaemonClient('fake-server', [], {});
    const ac = new AbortController();
    const callPromise = client.callTool({ name: 'x' } as any, { signal: ac.signal });
    await sendIPCRequestStarted;
    ac.abort();
    await expect(callPromise).rejects.toThrow('Operation aborted');
  });
});
