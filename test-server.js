#!/usr/bin/env node

/**
 * Simple Test MCP Server
 * 
 * A minimal MCP server with no external dependencies for testing
 * daemon lifecycle and IPC communication.
 * 
 * Tools:
 * - echo: Returns the input message
 * - fail: Intentionally throws an error
 * - delay: Waits for specified duration
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'simple-test-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the input message',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
    {
      name: 'fail',
      description: 'Intentionally throw an error',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
      },
    },
    {
      name: 'delay',
      description: 'Wait for duration_ms milliseconds (honors cancellation)',
      inputSchema: {
        type: 'object',
        properties: { duration_ms: { type: 'number' } },
        required: ['duration_ms'],
      },
    },
    {
      name: 'sleep',
      description: 'Sleep for N seconds (honors cancellation)',
      inputSchema: {
        type: 'object',
        properties: { seconds: { type: 'number' } },
        required: ['seconds'],
      },
    },
  ],
}));

function delayWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: argsRaw } = request.params ?? {};
  const args = argsRaw ?? {};

  if (name === 'echo') {
    if (typeof args.message !== 'string') throw new Error('echo.message must be a string');
    console.error(`[TOOL] echo: ${args.message}`);
    return { content: [{ type: 'text', text: args.message }] };
  }

  if (name === 'fail') {
    console.error(`[TOOL] fail: ${args.message ?? 'no message'}`);
    throw new Error(typeof args.message === 'string' ? args.message : 'This is an intentional failure.');
  }

  if (name === 'delay') {
    const ms = Number(args.duration_ms);
    if (!Number.isFinite(ms) || ms < 0 || ms > 300000) throw new Error('delay.duration_ms must be 0..300000');
    console.error(`[TOOL] delay start: ${ms}ms`);
    try {
      await delayWithAbort(ms, extra?.signal);
      console.error(`[TOOL] delay completed`);
      return { content: [{ type: 'text', text: `Delayed for ${ms}ms` }] };
    } catch {
      console.error(`[TOOL] delay cancelled`);
      return { content: [{ type: 'text', text: 'Cancelled' }], isError: true };
    }
  }

  if (name === 'sleep') {
    const secs = Number(args.seconds);
    if (!Number.isFinite(secs) || secs < 0 || secs > 3600) throw new Error('sleep.seconds must be 0..3600');
    const ms = Math.trunc(secs * 1000);
    console.error(`[TOOL] sleep start: ${secs}s`);
    try {
      await delayWithAbort(ms, extra?.signal);
      console.error(`[TOOL] sleep completed`);
      return { content: [{ type: 'text', text: `Slept ${secs}s` }] };
    } catch {
      console.error(`[TOOL] sleep cancelled`);
      return { content: [{ type: 'text', text: 'Cancelled' }], isError: true };
    }
  }

  console.error(`[TOOL] unknown tool: ${name}`);
  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[TEST] server running');
}

main().catch(console.error);
