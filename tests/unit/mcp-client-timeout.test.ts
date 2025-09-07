import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const envSnapshot = { ...process.env };

describe('MCP client default tool timeout', () => {
  beforeEach(() => {
    process.env = { ...envSnapshot };
    delete process.env.MCPLI_TOOL_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('uses 10 minutes (600000 ms) by default', async () => {
    const { getDefaultToolTimeoutMs } = await import('../../src/daemon/mcp-client-utils.ts');
    expect(getDefaultToolTimeoutMs()).toBe(600000);
  });

  it('honors MCPLI_TOOL_TIMEOUT_MS when set to a valid positive integer', async () => {
    process.env.MCPLI_TOOL_TIMEOUT_MS = '900000';
    const { getDefaultToolTimeoutMs } = await import('../../src/daemon/mcp-client-utils.ts');
    expect(getDefaultToolTimeoutMs()).toBe(900000);
  });

  it('falls back to default when MCPLI_TOOL_TIMEOUT_MS is invalid', async () => {
    process.env.MCPLI_TOOL_TIMEOUT_MS = 'not-a-number';
    const { getDefaultToolTimeoutMs } = await import('../../src/daemon/mcp-client-utils.ts');
    expect(getDefaultToolTimeoutMs()).toBe(600000);
  });

  it('applies default timeout when options are not provided', async () => {
    process.env.MCPLI_TOOL_TIMEOUT_MS = '700000';
    const { callToolWithDefaultTimeout } = await import('../../src/daemon/mcp-client-utils.ts');

    const captured: { options?: unknown } = {};
    const fakeClient = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async callTool(_params: unknown, _schema?: unknown, options?: unknown): Promise<unknown> {
        captured.options = options;
        return { ok: true };
      },
    } as unknown as import('@modelcontextprotocol/sdk/client/index.js').Client;

    const res = await callToolWithDefaultTimeout(fakeClient, { name: 'x' });
    expect(res).toEqual({ ok: true });
    const opts = captured.options as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(700000);
  });

  it('allows per-call override of timeout via options', async () => {
    process.env.MCPLI_TOOL_TIMEOUT_MS = '700000';
    const { callToolWithDefaultTimeout } = await import('../../src/daemon/mcp-client-utils.ts');

    const captured: { options?: unknown } = {};
    const fakeClient = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async callTool(_params: unknown, _schema?: unknown, options?: unknown): Promise<unknown> {
        captured.options = options;
        return { ok: true };
      },
    } as unknown as import('@modelcontextprotocol/sdk/client/index.js').Client;

    await callToolWithDefaultTimeout(fakeClient, { name: 'x' }, undefined, { timeout: 12345 });
    const opts = captured.options as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(12345);
  });
});
