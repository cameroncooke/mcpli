import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __testGetIpcLimits,
  __testGetIpcServerTunables
} from '../../src/daemon/ipc.ts';

const envSnapshot = { ...process.env };

describe('IPC limits and tunables', () => {
  beforeEach(() => {
    process.env = { ...envSnapshot };
    delete process.env.MCPLI_IPC_MAX_FRAME_BYTES;
    delete process.env.MCPLI_IPC_MAX_CONNECTIONS;
    delete process.env.MCPLI_IPC_CONNECTION_IDLE_TIMEOUT_MS;
    delete process.env.MCPLI_IPC_LISTEN_BACKLOG;
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('defaults produce sane limits below hard kill threshold', () => {
    const { maxFrameBytes, killThresholdBytes } = __testGetIpcLimits();
    expect(maxFrameBytes).toBeGreaterThan(0);
    expect(killThresholdBytes).toBeGreaterThan(maxFrameBytes);
  });

  it('clamps soft limit below hard kill threshold', () => {
    const { killThresholdBytes } = __testGetIpcLimits();
    // Request a value at or above hard threshold; should clamp
    process.env.MCPLI_IPC_MAX_FRAME_BYTES = String(killThresholdBytes);
    const { maxFrameBytes } = __testGetIpcLimits();
    expect(maxFrameBytes).toBeLessThan(killThresholdBytes);
  });

  it('server tunables clamp to configured ranges', () => {
    // Overly large values should clamp down
    process.env.MCPLI_IPC_MAX_CONNECTIONS = '50000';
    process.env.MCPLI_IPC_CONNECTION_IDLE_TIMEOUT_MS = '9999999';
    process.env.MCPLI_IPC_LISTEN_BACKLOG = '999999';

    const t = __testGetIpcServerTunables();
    expect(t.maxConnections).toBeLessThanOrEqual(1000);
    expect(t.connectionIdleTimeoutMs).toBeLessThanOrEqual(600000);
    expect(t.listenBacklog).toBeLessThanOrEqual(2048);
  });

  it('server tunables accept valid configured values', () => {
    process.env.MCPLI_IPC_MAX_CONNECTIONS = '128';
    process.env.MCPLI_IPC_CONNECTION_IDLE_TIMEOUT_MS = '20000';
    process.env.MCPLI_IPC_LISTEN_BACKLOG = '256';

    const t = __testGetIpcServerTunables();
    expect(t.maxConnections).toBe(128);
    expect(t.connectionIdleTimeoutMs).toBe(20000);
    expect(t.listenBacklog).toBe(256);
  });
});