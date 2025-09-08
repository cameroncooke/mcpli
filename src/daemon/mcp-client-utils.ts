import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getConfig } from '../config.ts';

/**
 * Compute the default timeout (ms) for MCP tool calls.
 * Uses environment-driven config with a sane fallback (10 minutes).
 */
export function getDefaultToolTimeoutMs(): number {
  const cfg = getConfig();
  const n = Math.trunc(cfg.defaultToolTimeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.max(1000, n) : 600_000;
}

/**
 * Parse a value into a positive integer millisecond value.
 * Returns undefined when invalid or <= 0.
 */
export function parsePositiveIntMs(v: unknown): number | undefined {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Enforce a default timeout on MCP client tool calls unless explicitly overridden.
 * Callers can pass a per-call timeout via `options.timeout` to override the default.
 */
export async function callToolWithDefaultTimeout(
  client: Client,
  params: Parameters<Client['callTool']>[0],
  resultSchema?: Parameters<Client['callTool']>[1],
  options?: Parameters<Client['callTool']>[2],
): ReturnType<Client['callTool']> {
  const mergedOptions: Parameters<Client['callTool']>[2] = {
    timeout: getDefaultToolTimeoutMs(),
    ...(options ?? {}),
  };
  return client.callTool(
    params,
    resultSchema as Parameters<Client['callTool']>[1],
    mergedOptions,
  ) as ReturnType<Client['callTool']>;
}

// Test-only accessors
export const __testOnly = {
  getDefaultToolTimeoutMs,
  parsePositiveIntMs,
};
