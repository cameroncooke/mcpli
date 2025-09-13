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

const sendIPCRequestMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../../src/daemon/ipc.ts', () => ({
  generateRequestId: () => 'req-1',
  sendIPCRequest: sendIPCRequestMock,
}));

describe('DaemonClient already-aborted signal', () => {
  beforeEach(() => {
    // Ensure a clean module registry so env and mocks apply fresh per test
    vi.resetModules();
    process.env = { ...envSnapshot };
    sendIPCRequestMock.mockClear();
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('short-circuits callTool when signal is already aborted', async () => {
    const { DaemonClient } = await import('../../src/daemon/client.ts');
    const client = new DaemonClient('fake-server', [], {});
    const ac = new AbortController();
    ac.abort();

    await expect(client.callTool({ name: 'x' } as any, { signal: ac.signal })).rejects.toThrow(
      'Operation aborted',
    );
    expect(sendIPCRequestMock).not.toHaveBeenCalled();
  });
});
